import { Logger } from '@nestjs/common';

export interface GeneratorConfig {
  apiKey: string;
  models: string[];
  attemptsPerModel?: number;
  attemptTimeoutMs?: number;
  /** Hard cap for the whole call, so an HTTP request can't hang on the model. */
  deadlineMs?: number;
  baseDelayMs?: number;
}

export interface GenerateRequest {
  system: string;
  prompt: string;
  schema: object;
  maxOutputTokens?: number;
}

export interface GenerateResult<T> {
  value: T;
  model: string;
  latencyMs: number;
  usage: Record<string, unknown> | null;
}

export class GenerationError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /**
     * Overloaded (503), rate-limited (429) or timed out: move to the next
     * model, which has its own capacity and quota, instead of retrying.
     */
    readonly moveOn = false,
  ) {
    super(message);
    this.name = 'GenerationError';
  }
}

/** A Gemini content turn, kept raw so thought signatures survive round trips. */
export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: {
    id?: string;
    name: string;
    response: Record<string, unknown>;
  };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: {
    finishReason?: string;
    content?: { parts?: GeminiPart[] };
  }[];
  usageMetadata?: Record<string, unknown>;
}

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
// 503 "high demand" was common in testing; 429 is the free-tier rate limit.
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export class GeminiGenerator {
  private readonly logger = new Logger(GeminiGenerator.name);
  private readonly cfg: Required<GeneratorConfig>;

  constructor(cfg: GeneratorConfig) {
    this.cfg = {
      attemptsPerModel: 2,
      attemptTimeoutMs: 20_000,
      deadlineMs: 60_000,
      baseDelayMs: 1_000,
      ...cfg,
    };
  }

  /** Structured JSON answer (used by /ask). */
  generateJson<T>(req: GenerateRequest): Promise<GenerateResult<T>> {
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: req.maxOutputTokens ?? 1024,
        responseMimeType: 'application/json',
        responseSchema: req.schema,
        // Answering from given passages needs little reasoning; keeps latency down.
        thinkingConfig: { thinkingLevel: 'low' },
      },
    };
    return this.generate(body, (raw) => {
      const candidate = raw.candidates?.[0];
      const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('');
      if (!text) {
        // e.g. SAFETY or MAX_TOKENS with no output; another try may succeed.
        throw new GenerationError(
          `empty response (${candidate?.finishReason ?? 'no candidate'})`,
          true,
        );
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new GenerationError(
          `invalid JSON (${candidate?.finishReason ?? '?'})`,
          true,
        );
      }
    });
  }

  /**
   * Raw generateContent call (used by the assistant for function calling).
   * `models` pins the call to specific models, e.g. the one a run started on.
   */
  generateContent(
    body: object,
    opts: { models?: string[]; deadlineMs?: number } = {},
  ): Promise<GenerateResult<GeminiContent>> {
    return this.generate(
      body,
      (raw) => {
        const content = raw.candidates?.[0]?.content;
        if (!content?.parts?.length) {
          throw new GenerationError(
            `empty response (${raw.candidates?.[0]?.finishReason ?? 'no candidate'})`,
            true,
          );
        }
        return { role: 'model', parts: content.parts };
      },
      opts.models,
      opts.deadlineMs,
    );
  }

  /**
   * Tries each model in order. Transient errors retry the same model with
   * jittered backoff; every other failure falls through to the next model.
   */
  private async generate<T>(
    body: object,
    parse: (raw: GeminiResponse) => T,
    models: string[] = this.cfg.models,
    deadlineMs: number = this.cfg.deadlineMs,
  ): Promise<GenerateResult<T>> {
    if (!this.cfg.apiKey) {
      throw new GenerationError('GEMINI_API_KEY is not set', false);
    }
    const deadline = Date.now() + deadlineMs;
    let last: GenerationError | undefined;

    for (const model of models) {
      for (let attempt = 0; attempt < this.cfg.attemptsPerModel; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const started = Date.now();
        try {
          const raw = await this.call(
            model,
            body,
            Math.min(this.cfg.attemptTimeoutMs, remaining),
          );
          return {
            value: parse(raw),
            model,
            latencyMs: Date.now() - started,
            usage: raw.usageMetadata ?? null,
          };
        } catch (err) {
          last =
            err instanceof GenerationError
              ? err
              : new GenerationError(String(err), true);
          this.logger.warn(`${model} attempt ${attempt + 1}: ${last.message}`);
          // Only transient blips are retried on the same model; anything else
          // (overload, rate limit, timeout, 400 from a model-specific feature)
          // may still work on the next model.
          if (last.moveOn || !last.retryable) break;
          if (attempt + 1 < this.cfg.attemptsPerModel) {
            const max = this.cfg.baseDelayMs * 2 ** attempt;
            await sleep(max / 2 + Math.random() * (max / 2));
          }
        }
      }
    }
    throw last ?? new GenerationError('Generation deadline exceeded', true);
  }

  private async call(
    model: string,
    body: object,
    timeoutMs: number,
  ): Promise<GeminiResponse> {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/models/${model}:generateContent`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.cfg.apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      throw new GenerationError(
        name === 'TimeoutError'
          ? `timed out after ${timeoutMs}ms`
          : String(err),
        true,
        name === 'TimeoutError',
      );
    }

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      throw new GenerationError(
        `HTTP ${res.status}: ${detail}`,
        RETRYABLE.has(res.status),
        res.status === 503 || res.status === 429,
      );
    }
    return (await res.json()) as GeminiResponse;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
