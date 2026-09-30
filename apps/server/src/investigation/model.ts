import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionFunctionTool,
} from 'openai/resources/chat/completions';
import type { ServerConfig } from '../config';

/**
 * Agent 循环与具体模型之间的最小接口（ModelClient）。真实模型、离线演示脚本和测试替身都实现它，
 * 循环本身因此不关心背后是谁，也能在没有密钥时被完整测试。
 * 这和前端里「组件依赖一个 API 接口，测试时传入 mock 实现」是同一个思路（依赖注入）。
 */

/** 对话里的一条消息，直接沿用 OpenAI SDK 的类型（system / user / assistant / tool）。 */
export type ChatMessage = ChatCompletionMessageParam;

/** 模型请求调用的一个工具。 */
export interface ModelToolCall {
  /** 调用 id，对应的 tool 结果消息要带上同一个 id（tool_call_id）。 */
  id: string;
  name: string;
  /** 模型给出的原始参数文本，可能不是合法 JSON，由工具层负责解析和报错。 */
  arguments: string;
}

/** 模型一轮的完整回复：一段文字（可能为空）加若干工具调用。 */
export interface ModelTurn {
  text: string;
  toolCalls: ModelToolCall[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface ModelRequest {
  messages: ChatMessage[];
  tools: ChatCompletionFunctionTool[];
  /** auto 由模型决定；指定名字时强制调用该工具（预算用尽时只允许 submit_report）。 */
  toolChoice: 'auto' | { name: string };
  signal: AbortSignal;
  /** 流式输出时每收到一小段文字就回调一次，用于实时推给界面。 */
  onTextDelta(text: string): void;
}

export interface ModelClient {
  /** model = 真实大模型；local = 离线脚本。写进运行记录，界面据此标注。 */
  readonly engine: 'model' | 'local';
  readonly model: string;
  complete(request: ModelRequest): Promise<ModelTurn>;
}

/** 模型接口调用失败（鉴权、限流、超时、5xx……），status 是上游返回的 HTTP 状态码。 */
export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * OpenAI 兼容的 chat/completions 流式客户端。
 *
 * 选 chat/completions 而不是 Responses API：工具调用在这条接口上被 DeepSeek、通义千问、
 * 豆包等国产端点普遍支持，换模型只需要改 MODEL_API_URL 和 MODEL_NAME。
 *
 * 流式（stream: true）：模型边生成边返回，响应是一连串小块（chunk），而不是最后一次性给出。
 * 好处是界面能像打字一样实时显示模型的思考，不用干等几十秒。
 * 代价是工具调用也被切碎了：同一个调用的 id、函数名和参数（一段 JSON 字符串）分散在多个 chunk 里，
 * 只能按 index 拼接归并；文本增量则边到边转发给前端。
 */
export class OpenAICompatibleClient implements ModelClient {
  readonly engine = 'model' as const;
  readonly model: string;
  private readonly client: OpenAI;

  constructor(config: Pick<ServerConfig, 'modelApiKey' | 'modelApiUrl' | 'modelName'>) {
    this.model = config.modelName;
    this.client = new OpenAI({
      apiKey: config.modelApiKey,
      // 去掉用户可能多填的接口路径，SDK 只需要基础地址（如 https://api.deepseek.com/v1）。
      baseURL: config.modelApiUrl?.replace(/\/(?:chat\/completions|responses)\/?$/, ''),
      timeout: 60_000,
      // 关闭 SDK 自动重试：一次调查的每次模型调用都计费，失败就如实失败。
      maxRetries: 0,
    });
  }

  async complete(request: ModelRequest): Promise<ModelTurn> {
    let stream;
    try {
      stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: request.messages,
          tools: request.tools,
          tool_choice:
            request.toolChoice === 'auto'
              ? 'auto'
              : { type: 'function', function: { name: request.toolChoice.name } },
          stream: true,
          // 流式模式默认不返回 token 用量；打开后最后一个 chunk 会带上 usage。
          stream_options: { include_usage: true },
        },
        // 取消信号传给 SDK：调查被取消时，正在进行的 HTTP 请求会被中断。
        { signal: request.signal },
      );
    } catch (error) {
      throw asModelError(error);
    }

    let text = '';
    const calls = new Map<number, ModelToolCall>();
    let usage: ModelTurn['usage'] | undefined;
    try {
      // for await：逐个消费异步到达的 chunk，直到流结束。
      for await (const chunk of stream) {
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          };
        }
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          text += delta.content;
          request.onTextDelta(delta.content);
        }
        for (const part of delta.tool_calls ?? []) {
          const current = calls.get(part.index) ?? { id: '', name: '', arguments: '' };
          if (part.id) current.id = part.id;
          if (part.function?.name) current.name += part.function.name;
          if (part.function?.arguments) current.arguments += part.function.arguments;
          calls.set(part.index, current);
        }
      }
    } catch (error) {
      throw asModelError(error);
    }

    const toolCalls = [...calls.entries()]
      .sort(([left], [right]) => left - right)
      // 个别端点不给 id：补一个全局唯一的，保证 tool 结果消息、界面上的工具调用卡片
      // 和报告里的证据都能对应到这次调用。
      .map(([index, call]) => ({
        ...call,
        id: call.id || `call_${randomUUID().slice(0, 8)}_${index}`,
      }));
    return {
      text,
      toolCalls,
      // 不返回 usage 的端点按字符数粗估，只用于预算，不作为计费依据。
      usage: usage ?? {
        inputTokens: Math.ceil(JSON.stringify(request.messages).length / 4),
        outputTokens: Math.ceil((text.length + JSON.stringify(toolCalls).length) / 4),
      },
    };
  }
}

/**
 * 统一错误类型：取消类错误统一成 name = 'AbortError'，上层据此区分「被取消」和「失败」；
 * 其余错误包装成 ModelCallError，消息截断到 300 字符，不把超长的上游响应原样往上传。
 * 运行记录不存这条消息，只存错误码和固定描述（见 service.ts）。
 */
function asModelError(error: unknown): Error {
  if (error instanceof Error && error.name === 'AbortError') return error;
  if (error instanceof OpenAI.APIUserAbortError) {
    return Object.assign(new Error('aborted'), { name: 'AbortError' });
  }
  const status = (error as { status?: number }).status;
  const message = error instanceof Error ? error.message : 'Model request failed';
  return new ModelCallError(message.slice(0, 300), status);
}
