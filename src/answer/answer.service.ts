import { Injectable, Logger } from '@nestjs/common';
import { RetrievalService } from '../retrieval/retrieval.service';
import {
  ANSWER_SCHEMA,
  buildPrompt,
  checkAnswer,
  ModelAnswer,
  selectContext,
  Source,
  SYSTEM_PROMPT,
} from './context';
import { AskDto } from './dto/ask.dto';
import {
  GeminiGenerator,
  GenerateResult,
  GenerationError,
} from './gemini-generator';

/** Passages fetched from search before context selection. */
const RETRIEVE = 12;

export type Citation = Omit<Source, 'content'>;

export interface AskResponse {
  question: string;
  status: 'answered' | 'insufficient_evidence' | 'unavailable';
  answer: string | null;
  conflicts: string | null;
  /** Why there is no grounded answer, when status isn't "answered". */
  reason:
    | 'no_relevant_sources'
    | 'model_declined'
    | 'uncited_answer'
    | 'generation_failed'
    | null;
  /** Sources cited in the answer; numbers match the [n] markers. */
  citations: Citation[];
  /** Every passage given to the model. */
  sources: Citation[];
  model: string | null;
  /** Search ran keyword-only because query embedding failed. */
  degraded: boolean;
}

const cite = (s: Source): Citation => ({
  n: s.n,
  chunkId: s.chunkId,
  bookmarkId: s.bookmarkId,
  title: s.title,
  url: s.url,
  section: s.section,
  similarity: s.similarity,
});

@Injectable()
export class AnswerService {
  private readonly logger = new Logger(AnswerService.name);

  constructor(
    private readonly retrieval: RetrievalService,
    private readonly generator: GeminiGenerator,
  ) {}

  async ask(userId: string, dto: AskDto): Promise<AskResponse> {
    const { question, ...filters } = dto;
    const search = await this.retrieval.search(userId, {
      q: question,
      mode: 'hybrid',
      limit: RETRIEVE,
      ...filters,
    });

    const base = {
      question,
      answer: null,
      conflicts: null,
      citations: [],
      model: null,
      degraded: search.degraded,
    };

    const context = selectContext(search.results, search.degraded);
    if (!context.ok) {
      // Nothing relevant saved: don't spend a model call to say so.
      return {
        ...base,
        status: 'insufficient_evidence',
        reason: context.reason,
        sources: [],
      };
    }
    const sources = context.sources;

    let generated: GenerateResult<ModelAnswer>;
    try {
      generated = await this.generator.generateJson<ModelAnswer>({
        system: SYSTEM_PROMPT,
        prompt: buildPrompt(question, sources),
        schema: ANSWER_SCHEMA,
      });
    } catch (err) {
      this.logger.error(
        `Answer generation failed: ${err instanceof GenerationError ? err.message : String(err)}`,
      );
      // Still return the passages so the client can show them.
      return {
        ...base,
        status: 'unavailable',
        reason: 'generation_failed',
        sources: sources.map(cite),
      };
    }

    const checked = checkAnswer(generated.value, sources.length);
    this.logger.log(
      `ask: ${checked.status}${checked.reason ? ` (${checked.reason})` : ''} via ${generated.model} in ${generated.latencyMs}ms, ${sources.length} sources`,
    );
    return {
      ...base,
      status: checked.status,
      answer: checked.answer,
      conflicts: checked.conflicts,
      reason: checked.reason,
      citations: checked.cited.map((n) => cite(sources[n - 1])),
      sources: sources.map(cite),
      model: generated.model,
    };
  }
}
