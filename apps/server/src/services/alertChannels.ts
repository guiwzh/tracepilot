import { createHmac } from 'node:crypto';
import type {
  AlertChannel,
  AlertTestResult,
  AlertTrigger,
  IssueLevel,
  IssueStatus,
} from '@trace-pilot/shared';

/**
 * 把一条告警渲染成各渠道要的请求，并判断渠道是否真的收下了。
 *
 * - 通用 Webhook：JSON；配了 secret 时带 HMAC-SHA256 签名，签的是「时间戳.请求体」（和 Stripe 的做法相同），
 *   接收方用同一个 secret 验签，并拒绝时间戳太旧的请求，防止被截获的请求重放；
 * - Slack：Incoming Webhook，text + blocks；
 * - 飞书：自定义机器人，消息卡片；配了签名校验时带 timestamp 和 sign；
 * - 钉钉：自定义机器人，markdown；配了加签时 timestamp 和 sign 放在查询参数里。
 *
 * 飞书和钉钉出错时 HTTP 状态码照样是 200，错误在响应体里（code / errcode 不为 0，例如签名不对），
 * 只看状态码会把失败当成成功。
 *
 * 告警内容里有用户能控制的文本（错误消息来自浏览器，任何人都能伪造上报）。Slack 的 <!channel>、
 * 飞书卡片里的 <at id=all></at> 会 @所有人，Markdown 链接能伪装成可点的按钮，所以这些写法一律转义
 * （escapeMarkup）——和排障 Agent 把遥测当不可信数据是同一个原则。
 */

/** 渲染一条告警需要的全部信息：触发时的 Issue 快照，存在 alert_deliveries.payload_json 里。 */
export interface AlertMessage {
  /** investigation：自动调查结束后的跟进通知。 */
  trigger: AlertTrigger | 'test' | 'investigation';
  project: { id: string; name: string };
  issue: {
    id: string;
    title: string;
    level: IssueLevel;
    status: IssueStatus;
    eventCount: number;
    userCount: number;
    firstSeenAt: number;
    lastSeenAt: number;
    release: string | null;
  };
  /** 一句话说明为什么告警：首次出现在哪个版本、解决之后又出现、事件量是常态的几倍。 */
  detail: string;
  /** 工作台里这个 Issue 的地址。 */
  url: string;
  /** 告警顺带发起的调查（services/autoInvestigation.ts）：发起时为 started，跟进通知里是结局。 */
  investigation?: {
    id: string;
    status: 'started' | 'completed' | 'failed' | 'cancelled';
    /** 工作台里这次调查的地址。 */
    url: string;
  };
}

export interface ChannelRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

const TRIGGER_LABELS: Record<AlertMessage['trigger'], string> = {
  new_issue: 'New issue',
  regression: 'Regression',
  escalating: 'Escalating',
  test: 'Test notification',
  investigation: 'Investigation',
};

/** 消息的标题词：跟进通知按调查的结局区分。 */
function labelOf(message: AlertMessage): string {
  if (message.trigger !== 'investigation') return TRIGGER_LABELS[message.trigger];
  return message.investigation?.status === 'completed'
    ? 'Investigation finished'
    : 'Investigation stopped';
}

/** 调查那一行：发起时说「正在调查」，跟进时说「看报告」。没有调查时为 null。 */
function investigationLine(message: AlertMessage): { text: string; url: string } | null {
  if (!message.investigation) return null;
  return {
    text:
      message.investigation.status === 'started'
        ? 'TracePilot started an investigation'
        : 'Open the investigation report',
    url: message.investigation.url,
  };
}

/**
 * 用户文本放进消息之前的处理：尖括号和 & 转成实体，<!channel>、<at id=all> 不会变成 @所有人；
 * 在 Markdown 链接语法的 ]( 之间插一个零宽空格，[点这里](https://…) 不会变成一个可点的钓鱼链接。
 */
export function escapeMarkup(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\]\(/g, ']\u200b(');
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function facts(message: AlertMessage): string {
  const { issue } = message;
  return [
    `${issue.eventCount.toLocaleString('en-US')} events`,
    `${issue.userCount.toLocaleString('en-US')} users`,
    issue.release ? `release ${issue.release}` : null,
    issue.level,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** 通用 Webhook 的签名：HMAC-SHA256(secret, `${timestamp}.${body}`)，十六进制。 */
export function webhookSignature(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** 飞书：以「时间戳 + 换行 + 密钥」为 HMAC 的密钥，对空串签名，再 Base64。时间戳单位是秒。 */
export function feishuSignature(secret: string, timestampSeconds: number): string {
  return createHmac('sha256', `${timestampSeconds}\n${secret}`).update('').digest('base64');
}

/** 钉钉：以密钥为 HMAC 的密钥，对「时间戳 + 换行 + 密钥」签名，再 Base64。时间戳单位是毫秒。 */
export function dingtalkSignature(secret: string, timestampMs: number): string {
  return createHmac('sha256', secret).update(`${timestampMs}\n${secret}`).digest('base64');
}

/** 渠道地址打码：机器人地址里的 token 就是凭据，接口和界面只显示域名。 */
export function maskChannelUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.length > 1 || parsed.search ? '/…' : ''}`;
  } catch {
    return '…';
  }
}

export function buildChannelRequest(
  channel: AlertChannel,
  message: AlertMessage,
  deliveryId: string,
  now: number,
): ChannelRequest {
  const label = labelOf(message);
  const title = oneLine(message.issue.title);
  const investigation = investigationLine(message);
  const json = { 'content-type': 'application/json' };

  if (channel.type === 'webhook') {
    const body = JSON.stringify({
      type: 'tracepilot.alert',
      version: 1,
      deliveryId,
      trigger: message.trigger,
      project: message.project,
      issue: message.issue,
      detail: message.detail,
      url: message.url,
      investigation: message.investigation ?? null,
      sentAt: now,
    });
    const timestamp = Math.floor(now / 1000);
    return {
      url: channel.url,
      headers: {
        ...json,
        'user-agent': 'TracePilot-Alerts/1',
        'x-tracepilot-delivery': deliveryId,
        ...(channel.secret
          ? {
              'x-tracepilot-timestamp': String(timestamp),
              'x-tracepilot-signature': `sha256=${webhookSignature(channel.secret, timestamp, body)}`,
            }
          : {}),
      },
      body,
    };
  }

  if (channel.type === 'slack') {
    const text = `${label} · ${escapeMarkup(message.project.name)}: ${escapeMarkup(title)}`;
    return {
      url: channel.url,
      headers: json,
      body: JSON.stringify({
        text,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${label}* · ${escapeMarkup(message.project.name)}\n<${message.url}|${escapeMarkup(title).replace(/\|/g, '¦')}>\n${escapeMarkup(message.detail)}`,
            },
          },
          { type: 'context', elements: [{ type: 'mrkdwn', text: escapeMarkup(facts(message)) }] },
          ...(investigation
            ? [
                {
                  type: 'section',
                  text: { type: 'mrkdwn', text: `<${investigation.url}|${investigation.text}>` },
                },
              ]
            : []),
        ],
      }),
    };
  }

  if (channel.type === 'feishu') {
    const seconds = Math.floor(now / 1000);
    return {
      url: channel.url,
      headers: json,
      body: JSON.stringify({
        ...(channel.secret
          ? { timestamp: String(seconds), sign: feishuSignature(channel.secret, seconds) }
          : {}),
        msg_type: 'interactive',
        card: {
          config: { wide_screen_mode: true },
          header: {
            template:
              message.trigger === 'investigation'
                ? 'blue'
                : message.trigger === 'new_issue'
                  ? 'orange'
                  : 'red',
            title: {
              tag: 'plain_text',
              content: `${label} · ${oneLine(message.project.name, 60)}`,
            },
          },
          elements: [
            {
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: `**${escapeMarkup(title)}**\n${escapeMarkup(message.detail)}`,
              },
            },
            { tag: 'div', text: { tag: 'lark_md', content: escapeMarkup(facts(message)) } },
            {
              tag: 'action',
              actions: [
                {
                  tag: 'button',
                  type: 'primary',
                  text: { tag: 'plain_text', content: 'Open in TracePilot' },
                  url: message.url,
                },
                ...(investigation
                  ? [
                      {
                        tag: 'button',
                        type: 'default',
                        text: { tag: 'plain_text', content: investigation.text },
                        url: investigation.url,
                      },
                    ]
                  : []),
              ],
            },
          ],
        },
      }),
    };
  }

  // 钉钉
  let url = channel.url;
  if (channel.secret) {
    url += `&timestamp=${now}&sign=${encodeURIComponent(dingtalkSignature(channel.secret, now))}`;
  }
  return {
    url,
    headers: json,
    body: JSON.stringify({
      msgtype: 'markdown',
      markdown: {
        // 标题只用在通知预览里（纯文本），只拆开链接语法。
        title: oneLine(`${label}: ${title}`, 100).replace(/\]\(/g, ']\u200b('),
        text: [
          `### ${label} · ${escapeMarkup(message.project.name)}`,
          `**${escapeMarkup(title)}**`,
          escapeMarkup(message.detail),
          escapeMarkup(facts(message)),
          `[Open in TracePilot](${message.url})`,
          ...(investigation ? [`[${investigation.text}](${investigation.url})`] : []),
        ].join('\n\n'),
      },
    }),
  };
}

/** 渠道是否收下了：2xx，且飞书的 code、钉钉的 errcode 为 0。返回 null 表示成功，否则是原因。 */
export function channelError(
  type: AlertChannel['type'],
  status: number,
  body: string,
): string | null {
  if (status < 200 || status >= 300)
    return `HTTP ${status}${body ? `: ${oneLine(body, 120)}` : ''}`;
  if (type !== 'feishu' && type !== 'dingtalk') return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return `Unexpected response: ${oneLine(body, 120)}`;
  }
  const code = type === 'feishu' ? (parsed.code ?? parsed.StatusCode) : parsed.errcode;
  if (Number(code) === 0) return null;
  const reason = type === 'feishu' ? (parsed.msg ?? parsed.StatusMessage) : parsed.errmsg;
  return `${type} error ${String(code)}: ${oneLine(String(reason ?? ''), 120)}`;
}

export interface SendOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * 发一条告警。不跟随重定向（redirect: manual）：允许跟随的话，一个看似无害的地址可以把请求转到内网。
 * 响应体只读前 2 KB。不抛错，失败时返回原因。
 */
export async function sendToChannel(
  channel: AlertChannel,
  message: AlertMessage,
  deliveryId: string,
  now: number,
  options: SendOptions = {},
): Promise<AlertTestResult> {
  const request = buildChannelRequest(channel, message, deliveryId, now);
  try {
    const response = await (options.fetch ?? fetch)(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    const body = (await response.text()).slice(0, 2_048);
    const error = channelError(channel.type, response.status, body);
    return { ok: error === null, status: response.status, error };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'TimeoutError'
        ? 'Timed out'
        : error instanceof Error
          ? oneLine(
              `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ''}`,
              160,
            )
          : 'Request failed';
    return { ok: false, status: null, error: reason };
  }
}
