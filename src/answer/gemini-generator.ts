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

  /**
   * Tries each model in order. Transient errors retry the same model with
   * jittered backoff; every other failure falls through to the next model.
   */
  async generateJson<T>(req: GenerateRequest): Promise<GenerateResult<T>> {
    if (!this.cfg.apiKey) {
      throw new GenerationError('GEMINI_API_KEY is not set', false);
    }
    const deadline = Date.now() + this.cfg.deadlineMs;
    let last: GenerationError | undefined;

    for (const model of this.cfg.models) {
      for (let attempt = 0; attempt < this.cfg.attemptsPerModel; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        try {
          return await this.call<T>(
            model,
            req,
            Math.min(this.cfg.attemptTimeoutMs, remaining),
          );
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

  private async call<T>(
    model: string,
    req: GenerateRequest,
    timeoutMs: number,
  ): Promise<GenerateResult<T>> {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/models/${model}:generateContent`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.cfg.apiKey,
        },
        body: JSON.stringify({
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
        }),
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

    const body = (await res.json()) as {
      candidates?: {
        finishReason?: string;
        content?: { parts?: { text?: string }[] };
      }[];
      usageMetadata?: Record<string, unknown>;
    };
    const candidate = body.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('');
    if (!text) {
      // e.g. SAFETY or MAX_TOKENS with no output; another try may succeed.
      throw new GenerationError(
        `empty response (${candidate?.finishReason ?? 'no candidate'})`,
        true,
      );
    }
    try {
      return {
        value: JSON.parse(text) as T,
        model,
        latencyMs: Date.now() - started,
        usage: body.usageMetadata ?? null,
      };
    } catch {
      throw new GenerationError(
        `invalid JSON (${candidate?.finishReason ?? '?'})`,
        true,
      );
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
