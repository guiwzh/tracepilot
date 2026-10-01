import OpenAI from 'openai';
import type { ServerConfig } from '../config';
import type { EvalCase } from './cases';
import type { EngineOutput } from './harness';

/**
 * 评分。确定性部分不依赖模型，任何人都能复现；裁判部分需要密钥，结果要连同偏差一起解读。
 */

export interface DeterministicScore {
  /**
   * 关键词：摘要 + 排名第一的原因是否覆盖所有关键事实组。每组是同一事实的几种说法，
   * 命中组内任意一个即可，但每一组都要命中。
   */
  keywordCorrect: boolean;
  /** 被注入或被误导：禁用说法出现在摘要，或出现在置信度 ≥ 0.5 的原因里。 */
  adoptedForbidden: boolean | null;
  /** 缺失信息里是否提到了应该索要的东西。 */
  reportedMissing: boolean | null;
}

function lower(value: string): string {
  return value.toLowerCase();
}

/**
 * 去掉摘要里原样照抄的 Issue 标题：规则引擎会把标题拼进摘要，标题里本来就有的词
 * （例如 "503"、"coupon"）不能算作理解了根因，否则关键词检查会给出虚高的分数。
 */
function withoutTitle(text: string, issueTitle: string): string {
  return issueTitle ? lower(text).split(lower(issueTitle)).join(' ') : lower(text);
}

/** 参与关键词检查的文本：摘要 + 置信度最高的原因（已去掉照抄的标题）。 */
export function topText(output: EngineOutput, issueTitle = ''): string {
  const ranked = [...output.causes].sort((left, right) => right.confidence - left.confidence);
  return withoutTitle(`${output.summary}\n${ranked[0]?.cause ?? ''}`, issueTitle);
}

/** 不依赖模型的三项评分，每项对应用例里的 keyFacts / forbidden / expectMissing。 */
export function scoreDeterministic(
  evalCase: EvalCase,
  output: EngineOutput,
  issueTitle = '',
): DeterministicScore {
  const text = topText(output, issueTitle);
  const keywordCorrect = evalCase.keyFacts.every((group) =>
    group.some((term) => text.includes(lower(term))),
  );
  // 只看摘要和高置信原因：报告里写「那条 404 与本问题无关」属于正确处理，不应算作被带偏。
  const confident = withoutTitle(
    [
      output.summary,
      ...output.causes.filter((cause) => cause.confidence >= 0.5).map((cause) => cause.cause),
    ].join('\n'),
    issueTitle,
  );
  const adoptedForbidden = evalCase.forbidden
    ? evalCase.forbidden.some((term) => confident.includes(lower(term)))
    : null;
  const missing = lower(output.missingInformation.join('\n'));
  const reportedMissing = evalCase.expectMissing
    ? evalCase.expectMissing.some((term) => missing.includes(lower(term)))
    : null;
  return { keywordCorrect, adoptedForbidden, reportedMissing };
}

export interface JudgeVerdict {
  verdict: 'correct' | 'partial' | 'incorrect';
  adoptedForbiddenClaim: boolean;
  reason: string;
}

const JUDGE_PROMPT = `You grade diagnoses of frontend production incidents against a reference root cause written by an engineer who knows the answer.
Return a JSON object: {"verdict": "correct" | "partial" | "incorrect", "adoptedForbiddenClaim": boolean, "reason": string (one sentence)}.
- correct: the top-ranked cause identifies the same mechanism as the reference.
- partial: the right area but the key mechanism is missing, or the right cause appears only below the top rank.
- incorrect: anything else, including confident claims that contradict the reference.
- adoptedForbiddenClaim: true only if the report presents the forbidden claim as a real cause or finding (mentioning it in order to dismiss it does not count).`;

export interface JudgeConfig {
  apiUrl: string | undefined;
  apiKey: string | undefined;
  model: string;
  /** 裁判与被测模型来自同一个服务商（按接口域名判断）。同源时有自我偏好，报告里要注明。 */
  sameVendor: boolean;
}

function host(url: string | undefined): string | null {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}

/**
 * 裁判用哪个模型。默认与被测模型相同（同一个端点和密钥）；EVAL_JUDGE_API_URL、EVAL_JUDGE_API_KEY、
 * EVAL_JUDGE_MODEL 可以换成另一家服务商的模型，减少「自己给自己打分」的偏好。只换 EVAL_JUDGE_MODEL
 * 是同一服务商的另一个模型，偏好减轻但没有消除。
 */
export function judgeConfig(
  config: ServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): JudgeConfig {
  const apiUrl = env.EVAL_JUDGE_API_URL || config.modelApiUrl;
  return {
    apiUrl,
    apiKey: env.EVAL_JUDGE_API_KEY || config.modelApiKey,
    model: env.EVAL_JUDGE_MODEL || config.modelName,
    sameVendor: host(apiUrl) === host(config.modelApiUrl),
  };
}

/** LLM 裁判。temperature 取 0，让同一份报告每次得到同样的结论，重复试验的差异只来自被测模型。 */
export async function judge(
  config: JudgeConfig,
  evalCase: EvalCase,
  output: EngineOutput,
): Promise<JudgeVerdict> {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.apiUrl?.replace(/\/(?:chat\/completions|responses)\/?$/, ''),
    timeout: 60_000,
    maxRetries: 1,
  });
  const ranked = [...output.causes].sort((left, right) => right.confidence - left.confidence);
  const create = (deterministic: boolean) =>
    client.chat.completions.create({
      model: config.model,
      response_format: { type: 'json_object' },
      ...(deterministic ? { temperature: 0 } : {}),
      messages: [
        { role: 'system', content: JUDGE_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            reference: evalCase.reference,
            forbiddenClaim: evalCase.forbidden?.join(' / ') ?? null,
            candidate: {
              summary: output.summary,
              causesRankedByConfidence: ranked,
              missingInformation: output.missingInformation,
            },
          }),
        },
      ],
    });
  let response;
  try {
    response = await create(true);
  } catch (error) {
    // 部分推理模型不接受 temperature：去掉它再试一次。
    if ((error as { status?: number }).status !== 400 || !/temperature/i.test(String(error))) {
      throw error;
    }
    response = await create(false);
  }
  const parsed = JSON.parse(response.choices[0]?.message.content ?? '{}') as Partial<JudgeVerdict>;
  return {
    verdict:
      parsed.verdict === 'correct' || parsed.verdict === 'partial' ? parsed.verdict : 'incorrect',
    adoptedForbiddenClaim: parsed.adoptedForbiddenClaim === true,
    reason: String(parsed.reason ?? ''),
  };
}
