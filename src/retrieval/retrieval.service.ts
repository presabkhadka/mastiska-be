import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { GeminiEmbedder } from '../embedding/gemini-embedder';
import { errorMessage } from '../ingestion/ingestion-errors';
import { SearchMode, SearchQueryDto } from './dto/search-query.dto';
import { DEFAULT_FUSE_OPTIONS, fuse, FuseOptions, MatchSource } from './fusion';

/** Candidates taken from each leg before fusion. */
const CANDIDATES = 50;
const QUERY_CACHE_SIZE = 500;

export type SearchFilters = Pick<
  SearchQueryDto,
  'collectionId' | 'tagId' | 'domain' | 'savedAfter' | 'savedBefore'
>;

interface ChunkRow {
  chunkId: string;
  bookmarkId: string;
  position: number;
  section: string | null;
  content: string;
  contentHash: string;
  title: string | null;
  url: string;
  distance?: number;
}

export interface SearchResult {
  chunkId: string;
  bookmarkId: string;
  title: string | null;
  url: string;
  section: string | null;
  position: number;
  content: string;
  /** Fused RRF score; only meaningful for ordering. */
  score: number;
  /** Cosine similarity to the query, when matched by the vector leg. */
  similarity: number | null;
  matchedBy: MatchSource[];
}

export interface SearchResponse {
  query: string;
  mode: SearchMode;
  /** True when semantic search failed and results are keyword-only. */
  degraded: boolean;
  results: SearchResult[];
}

const COLUMNS = `
  c.id AS "chunkId", c.bookmark_id AS "bookmarkId", c.position, c.section,
  c.content, c.content_hash AS "contentHash", b.title, b.original_url AS url`;

@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);
  private readonly queryCache = new Map<string, number[]>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly embedder: GeminiEmbedder,
  ) {}

  /** `fuseOptions` is for evaluation/tuning; the API uses the defaults. */
  async search(
    userId: string,
    dto: SearchQueryDto,
    fuseOptions: Partial<FuseOptions> = {},
  ): Promise<SearchResponse> {
    const mode = dto.mode ?? 'hybrid';
    const textLeg =
      mode !== 'vector' ? this.textSearch(userId, dto.q, dto) : undefined;

    let vectorRows: ChunkRow[] | undefined;
    let degraded = false;
    if (mode !== 'text') {
      let queryVector: number[] | undefined;
      try {
        queryVector = await this.queryEmbedding(dto.q);
      } catch (err) {
        if (mode === 'vector') {
          throw new ServiceUnavailableException(
            'Semantic search is unavailable',
          );
        }
        degraded = true;
        this.logger.warn(`Query embedding failed: ${errorMessage(err)}`);
      }
      if (queryVector) {
        vectorRows = await this.vectorSearch(userId, queryVector, dto);
      }
    }
    const textRows = await textLeg;

    const distances = new Map(
      (vectorRows ?? []).map((r) => [r.chunkId, r.distance!]),
    );
    const fused = fuse(
      { vector: vectorRows, text: textRows },
      { ...DEFAULT_FUSE_OPTIONS, ...fuseOptions, limit: dto.limit ?? 10 },
    );

    return {
      query: dto.q,
      mode,
      degraded,
      results: fused.map(({ item, score, matchedBy }) => ({
        chunkId: item.chunkId,
        bookmarkId: item.bookmarkId,
        title: item.title,
        url: item.url,
        section: item.section,
        position: item.position,
        content: item.content,
        score,
        similarity: distances.has(item.chunkId)
          ? 1 - distances.get(item.chunkId)!
          : null,
        matchedBy,
      })),
    };
  }

  private async queryEmbedding(q: string): Promise<number[]> {
    const key = `${this.embedder.model}\n${q}`;
    const cached = this.queryCache.get(key);
    if (cached) return cached;
    const vector = await this.embedder.embedQuery(q);
    // Map keeps insertion order, so the first key is the oldest.
    const oldest = this.queryCache.keys().next();
    if (this.queryCache.size >= QUERY_CACHE_SIZE && !oldest.done) {
      this.queryCache.delete(oldest.value);
    }
    this.queryCache.set(key, vector);
    return vector;
  }

  private vectorSearch(
    userId: string,
    vector: number[],
    filters: SearchFilters,
  ): Promise<ChunkRow[]> {
    return this.dataSource.transaction(async (m: EntityManager) => {
      // Keep scanning the HNSW graph until enough rows pass the filters
      // (pgvector 0.8); otherwise filtered searches can return too few rows.
      await m.query(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      const params: unknown[] = [`[${vector.join(',')}]`];
      const where = this.where(userId, filters, params);
      const rows: ChunkRow[] = await m.query(
        `SELECT ${COLUMNS}, c.embedding <=> $1::vector AS distance
         FROM bookmark_chunks c JOIN bookmarks b ON b.id = c.bookmark_id
         WHERE c.embedding IS NOT NULL AND ${where}
         ORDER BY c.embedding <=> $1::vector
         LIMIT ${CANDIDATES}`,
        params,
      );
      // relaxed_order may return rows slightly out of order.
      return rows
        .map((r) => ({ ...r, distance: Number(r.distance) }))
        .sort((a, b) => a.distance - b.distance);
    });
  }

  // Passages containing every query word rank first, then any-word matches.
  // ts_rank_cd has no IDF, so with OR alone a passage repeating a common word
  // ("machine") outranks the one containing the rare word ("Medvedev").
  private textSearch(
    userId: string,
    q: string,
    filters: SearchFilters,
  ): Promise<ChunkRow[]> {
    const params: unknown[] = [q];
    const where = this.where(userId, filters, params);
    return this.dataSource.query(
      `WITH lexemes AS (
         SELECT quote_literal(lexeme) AS l
         FROM unnest(tsvector_to_array(to_tsvector('english', $1))) AS lexeme
       ), query AS (
         SELECT to_tsquery('simple', string_agg(l, ' | ')) AS any_q,
                to_tsquery('simple', string_agg(l, ' & ')) AS all_q
         FROM lexemes
       )
       SELECT ${COLUMNS}
       FROM bookmark_chunks c
       JOIN bookmarks b ON b.id = c.bookmark_id
       CROSS JOIN query
       WHERE c.search_vector @@ query.any_q AND ${where}
       ORDER BY (c.search_vector @@ query.all_q) DESC,
                ts_rank_cd(c.search_vector, query.any_q) DESC, c.id
       LIMIT ${CANDIDATES}`,
      params,
    );
  }

  private where(userId: string, f: SearchFilters, params: unknown[]): string {
    const p = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const clauses = [
      `b.user_id = ${p(userId)}`,
      `b.processing_state = 'ready'`,
    ];
    if (f.collectionId) {
      clauses.push(
        `EXISTS (SELECT 1 FROM bookmark_collections bc WHERE bc.bookmark_id = b.id AND bc.collection_id = ${p(f.collectionId)})`,
      );
    }
    if (f.tagId) {
      clauses.push(
        `EXISTS (SELECT 1 FROM bookmark_tags bt WHERE bt.bookmark_id = b.id AND bt.tag_id = ${p(f.tagId)})`,
      );
    }
    if (f.savedAfter) clauses.push(`b.created_at >= ${p(f.savedAfter)}`);
    if (f.savedBefore) clauses.push(`b.created_at < ${p(f.savedBefore)}`);
    if (f.domain) {
      const host = `lower(substring(b.original_url from '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/:?#]+)'))`;
      const d = p(f.domain);
      clauses.push(`(${host} = ${d} OR ${host} LIKE '%.' || ${d})`);
    }
    return clauses.join(' AND ');
  }
}
