import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionFunctionTool,
} from 'openai/resources/chat/completions';
import type { ServerConfig } from '../config';

/**
 * Agent 循环与具体模型之间的最小接口。真实模型、离线演示脚本和测试替身都实现它，
 * 循环本身因此不关心背后是谁，也能在没有密钥时被完整测试。
 */
export type ChatMessage = ChatCompletionMessageParam;

export interface ModelToolCall {
  id: string;
  name: string;
  /** 模型给出的原始参数文本，可能不是合法 JSON，由工具层负责解析和报错。 */
  arguments: string;
}

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
  onTextDelta(text: string): void;
}

export interface ModelClient {
  readonly engine: 'model' | 'local';
  readonly model: string;
  complete(request: ModelRequest): Promise<ModelTurn>;
}

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
 * 流式返回里，工具调用是被切碎的：同一个调用的 id、函数名和参数分散在多个 chunk 里，
 * 只能按 index 归并；文本增量则边到边转发给前端。
 */
export class OpenAICompatibleClient implements ModelClient {
  readonly engine = 'model' as const;
  readonly model: string;
  private readonly client: OpenAI;

  constructor(config: Pick<ServerConfig, 'modelApiKey' | 'modelApiUrl' | 'modelName'>) {
    this.model = config.modelName;
    this.client = new OpenAI({
      apiKey: config.modelApiKey,
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
          stream_options: { include_usage: true },
        },
        { signal: request.signal },
      );
    } catch (error) {
      throw asModelError(error);
    }

    let text = '';
    const calls = new Map<number, ModelToolCall>();
    let usage: ModelTurn['usage'] | undefined;
    try {
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
      // 个别端点不给 id：补一个全局唯一的，保证 tool 消息和引用校验都能一一对应到这次调用。
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

function asModelError(error: unknown): Error {
  if (error instanceof Error && error.name === 'AbortError') return error;
  if (error instanceof OpenAI.APIUserAbortError) {
    return Object.assign(new Error('aborted'), { name: 'AbortError' });
  }
  const status = (error as { status?: number }).status;
  const message = error instanceof Error ? error.message : 'Model request failed';
  return new ModelCallError(message.slice(0, 300), status);
}
