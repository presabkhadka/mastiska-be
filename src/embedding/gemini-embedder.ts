import {
  PermanentIngestionError,
  TransientIngestionError,
} from '../ingestion/ingestion-errors';

export interface EmbedderConfig {
  apiKey: string;
  model: string;
  dimensions: number;
  timeoutMs?: number;
}

export interface DocumentInput {
  title: string | null;
  text: string;
}

/** Gemini's per-request cap for batchEmbedContents. */
export const MAX_BATCH = 100;

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiEmbedder {
  constructor(private readonly cfg: EmbedderConfig) {}

  get model(): string {
    return this.cfg.model;
  }

  embedDocuments(inputs: DocumentInput[]): Promise<number[][]> {
    return this.embedBatch(inputs, 'RETRIEVAL_DOCUMENT');
  }

  /** Queries use a different task type than the documents they search. */
  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch(
      [{ title: null, text }],
      'RETRIEVAL_QUERY',
    );
    return vector;
  }

  private async embedBatch(
    inputs: DocumentInput[],
    taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY',
  ): Promise<number[][]> {
    if (inputs.length === 0) return [];
    if (inputs.length > MAX_BATCH) {
      throw new Error(`Batch of ${inputs.length} exceeds ${MAX_BATCH}`);
    }
    // Missing or rejected key is a config problem, not the bookmark's fault:
    // transient, so the bookmark ends up failed (replayable), not unsupported.
    if (!this.cfg.apiKey) {
      throw new TransientIngestionError('GEMINI_API_KEY is not set');
    }

    const body = {
      requests: inputs.map((i) => ({
        model: `models/${this.cfg.model}`,
        content: { parts: [{ text: i.text }] },
        taskType,
        ...(i.title ? { title: i.title } : {}),
        outputDimensionality: this.cfg.dimensions,
      })),
    };

    let res: Response;
    try {
      res = await fetch(
        `${BASE_URL}/models/${this.cfg.model}:batchEmbedContents`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': this.cfg.apiKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
        },
      );
    } catch (err) {
      throw new TransientIngestionError(
        `Embedding request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      const message = `Gemini HTTP ${res.status}: ${detail}`;
      // 400 = this input can't be embedded; everything else may recover.
      throw res.status === 400
        ? new PermanentIngestionError(message)
        : new TransientIngestionError(message);
    }

    const json = (await res.json()) as {
      embeddings?: { values?: number[] }[];
    };
    const vectors = (json.embeddings ?? []).map((e) => e.values ?? []);
    if (
      vectors.length !== inputs.length ||
      vectors.some((v) => v.length !== this.cfg.dimensions)
    ) {
      throw new TransientIngestionError(
        `Unexpected embedding response: ${vectors.length} vectors for ${inputs.length} inputs`,
      );
    }
    // Gemini only normalizes 3072-dim output; normalize so cosine == dot product.
    return vectors.map(normalize);
  }
}

export function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}
