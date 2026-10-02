import { createHmac } from 'node:crypto';
import { alertChannelSchema } from '@trace-pilot/shared';
import { describe, expect, it } from 'vitest';
import {
  buildChannelRequest,
  channelError,
  maskChannelUrl,
  type AlertMessage,
} from './alertChannels';

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

const message: AlertMessage = {
  trigger: 'new_issue',
  project: { id: 'demo-project', name: 'Shop' },
  issue: {
    id: 'issue-1',
    // 浏览器上报的文本谁都能伪造：这些写法在 Slack、飞书里会 @所有人。
    title:
      'TypeError: <!channel> <at id=all></at> [verify your account](https://evil.example) checkout failed',
    level: 'error',
    status: 'unresolved',
    eventCount: 1200,
    userCount: 87,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    release: '2.4.1',
  },
  detail: 'First seen in release 2.4.1.',
  url: 'http://localhost:4173/projects/demo-project/issues/issue-1',
};

describe('alert channel requests', () => {
  it('signs generic webhooks over the timestamp and body', () => {
    const request = buildChannelRequest(
      { type: 'webhook', url: 'https://hooks.example.com/tp', secret: 'top-secret' },
      message,
      'delivery-1',
      NOW,
    );
    const timestamp = request.headers['x-tracepilot-timestamp']!;
    expect(timestamp).toBe(String(NOW / 1000));
    // 接收方的验签：用同一个 secret 对「时间戳.原始请求体」做 HMAC-SHA256。
    const expected = createHmac('sha256', 'top-secret')
      .update(`${timestamp}.${request.body}`)
      .digest('hex');
    expect(request.headers['x-tracepilot-signature']).toBe(`sha256=${expected}`);
    expect(JSON.parse(request.body)).toMatchObject({
      type: 'tracepilot.alert',
      deliveryId: 'delivery-1',
      trigger: 'new_issue',
      issue: { id: 'issue-1', eventCount: 1200 },
    });

    const unsigned = buildChannelRequest(
      { type: 'webhook', url: 'https://hooks.example.com/tp' },
      message,
      'delivery-1',
      NOW,
    );
    expect(unsigned.headers['x-tracepilot-signature']).toBeUndefined();
  });

  it('escapes mention syntax from user-controlled text', () => {
    const slack = buildChannelRequest(
      { type: 'slack', url: 'https://hooks.slack.com/services/T0/B0/x' },
      message,
      'd',
      NOW,
    );
    expect(slack.body).not.toContain('<!channel>');
    expect(slack.body).toContain('&lt;!channel&gt;');
    expect(slack.body).toContain(`<${message.url}|`);

    const feishu = buildChannelRequest(
      { type: 'feishu', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' },
      message,
      'd',
      NOW,
    );
    expect(feishu.body).not.toContain('<at id=all>');
    expect(feishu.body).toContain('&lt;at id=all&gt;');
    // Markdown 链接被拆开，不会渲染成可点的链接。
    for (const request of [slack, feishu]) expect(request.body).not.toContain('](https://evil');
    const dingtalk = buildChannelRequest(
      { type: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send?access_token=a' },
      message,
      'd',
      NOW,
    );
    expect(dingtalk.body).not.toContain('](https://evil');
    expect(dingtalk.body).toContain('[Open in TracePilot](http://localhost:4173/');
  });

  it('signs Feishu cards with the timestamp-and-secret key over an empty string', () => {
    const request = buildChannelRequest(
      {
        type: 'feishu',
        url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x',
        secret: 'fs-secret',
      },
      message,
      'd',
      NOW,
    );
    const body = JSON.parse(request.body) as { timestamp: string; sign: string; msg_type: string };
    // 飞书文档的算法：HMAC 的密钥是「timestamp + "\n" + secret」，被签名的内容为空，结果 Base64。
    const expected = createHmac('sha256', `${NOW / 1000}\nfs-secret`).digest('base64');
    expect(body).toMatchObject({
      timestamp: String(NOW / 1000),
      sign: expected,
      msg_type: 'interactive',
    });
  });

  it('signs DingTalk robots in the query string with the secret as the key', () => {
    const request = buildChannelRequest(
      {
        type: 'dingtalk',
        url: 'https://oapi.dingtalk.com/robot/send?access_token=abc',
        secret: 'SEC123',
      },
      message,
      'd',
      NOW,
    );
    const url = new URL(request.url);
    // 钉钉文档的算法：HMAC 的密钥是 secret，被签名的是「timestamp + "\n" + secret」，时间戳是毫秒。
    const expected = createHmac('sha256', 'SEC123').update(`${NOW}\nSEC123`).digest('base64');
    expect(url.searchParams.get('access_token')).toBe('abc');
    expect(url.searchParams.get('timestamp')).toBe(String(NOW));
    expect(url.searchParams.get('sign')).toBe(expected);
    expect(JSON.parse(request.body)).toMatchObject({ msgtype: 'markdown' });
  });
});

describe('alert channel responses', () => {
  it('reads Feishu and DingTalk errors from the body even when the status is 200', () => {
    expect(channelError('feishu', 200, '{"code":0,"msg":"success","data":{}}')).toBeNull();
    expect(channelError('feishu', 200, '{"code":19021,"msg":"sign match fail"}')).toBe(
      'feishu error 19021: sign match fail',
    );
    expect(channelError('dingtalk', 200, '{"errcode":0,"errmsg":"ok"}')).toBeNull();
    expect(channelError('dingtalk', 200, '{"errcode":310000,"errmsg":"sign not match"}')).toBe(
      'dingtalk error 310000: sign not match',
    );
    expect(channelError('slack', 200, 'ok')).toBeNull();
    expect(channelError('webhook', 500, 'boom')).toBe('HTTP 500: boom');
    expect(channelError('webhook', 302, '')).toBe('HTTP 302');
  });

  it('never shows the token part of a channel URL', () => {
    expect(maskChannelUrl('https://hooks.slack.com/services/T0/B0/secret')).toBe(
      'https://hooks.slack.com/…',
    );
    expect(maskChannelUrl('https://oapi.dingtalk.com/robot/send?access_token=abc')).toBe(
      'https://oapi.dingtalk.com/…',
    );
    expect(maskChannelUrl('https://example.com')).toBe('https://example.com');
  });

  it('only accepts the official robot hosts for Slack, Feishu and DingTalk', () => {
    const valid = (channel: unknown) => alertChannelSchema.safeParse(channel).success;
    expect(valid({ type: 'slack', url: 'https://hooks.slack.com/services/T0/B0/x' })).toBe(true);
    expect(valid({ type: 'slack', url: 'http://10.0.0.5/services/x' })).toBe(false);
    expect(
      valid({ type: 'feishu', url: 'https://open.larksuite.com/open-apis/bot/v2/hook/x' }),
    ).toBe(true);
    expect(
      valid({ type: 'feishu', url: 'https://open.feishu.cn.evil.com/open-apis/bot/v2/hook/x' }),
    ).toBe(false);
    expect(
      valid({ type: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send?access_token=a' }),
    ).toBe(true);
    expect(valid({ type: 'webhook', url: 'ftp://example.com/x' })).toBe(false);
  });
});
