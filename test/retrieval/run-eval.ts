import { ConsoleLogger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import 'dotenv/config';
import { getDataSourceToken } from '@nestjs/typeorm';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { BookmarksService } from '../../src/bookmarks/bookmarks.service';
import { GeminiEmbedder } from '../../src/embedding/gemini-embedder';
import {
  SearchMode,
  SEARCH_MODES,
} from '../../src/retrieval/dto/search-query.dto';
import { RetrievalService } from '../../src/retrieval/retrieval.service';
import { UsersService } from '../../src/users/users.service';

interface Expected {
  url: string;
  contains: string;
}
interface Question {
  q: string;
  kind: string;
  expected: Expected[];
}
interface EvalSet {
  urls: string[];
  questions: Question[];
}

const EVAL_EMAIL = 'retrieval-eval@mastiska.local';
const READY_TIMEOUT_MS = 180_000;
const K = [1, 5, 10];
// Query vectors are cached across runs so tuning doesn't burn Gemini quota.
const QUERY_CACHE = join(__dirname, '.query-cache.json');
const RATE_LIMIT_WAIT_MS = 30_000;

/** Real embedder for documents; cached + 429-tolerant for queries. */
class EvalEmbedder {
  private readonly cache: Record<string, number[]> = existsSync(QUERY_CACHE)
    ? (JSON.parse(readFileSync(QUERY_CACHE, 'utf8')) as Record<
        string,
        number[]
      >)
    : {};

  constructor(private readonly real: GeminiEmbedder) {}

  get model() {
    return this.real.model;
  }

  embedDocuments(...args: Parameters<GeminiEmbedder['embedDocuments']>) {
    return this.real.embedDocuments(...args);
  }

  async embedQuery(text: string): Promise<number[]> {
    const key = `${this.real.model}\n${text}`;
    if (this.cache[key]) return this.cache[key];
    for (let attempt = 1; ; attempt++) {
      try {
        const vector = await this.real.embedQuery(text);
        this.cache[key] = vector;
        writeFileSync(QUERY_CACHE, JSON.stringify(this.cache));
        return vector;
      } catch (err) {
        if (attempt >= 5 || !String(err).includes('HTTP 429')) throw err;
        console.warn(
          `Gemini rate limit; retrying in ${RATE_LIMIT_WAIT_MS / 1000}s`,
        );
        await new Promise((r) => setTimeout(r, RATE_LIMIT_WAIT_MS));
      }
    }
  }
}

async function main() {
  const set = JSON.parse(
    readFileSync(join(__dirname, 'eval-set.json'), 'utf8'),
  ) as EvalSet;
  const verbose = process.argv.includes('--verbose');

  const real = new GeminiEmbedder({
    apiKey: process.env.GEMINI_API_KEY ?? '',
    model: process.env.EMBEDDING_MODEL ?? 'gemini-embedding-001',
    dimensions: 768,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GeminiEmbedder)
    .useValue(new EvalEmbedder(real))
    .setLogger(new ConsoleLogger({ logLevels: ['error', 'warn'] }))
    .compile();
  const app = await moduleRef.init();
  try {
    const userId = await evalUser(app.get(UsersService));
    await ensureReady(
      userId,
      set.urls,
      app.get(BookmarksService),
      app.get<DataSource>(getDataSourceToken()),
    );

    const retrieval = app.get(RetrievalService);
    const rows: Record<string, string | number>[] = [];
    const byKind: Record<string, Record<string, string | number>> = {};
    for (const mode of SEARCH_MODES) {
      const ranks: (number | null)[] = [];
      for (const question of set.questions) {
        const { results, degraded } = await retrieval.search(userId, {
          q: question.q,
          mode,
          limit: Math.max(...K),
        });
        if (degraded) throw new Error(`Search degraded in ${mode} mode`);
        const rank = results.findIndex((r) =>
          question.expected.some(
            (e) => r.url.includes(e.url) && r.content.includes(e.contains),
          ),
        );
        ranks.push(rank === -1 ? null : rank + 1);
        if (verbose && (rank === -1 || rank > 0)) {
          console.log(
            `[${mode}] ${rank === -1 ? 'MISS' : `rank ${rank + 1}`}: ${question.q}`,
          );
        }
      }
      rows.push(summarize(mode, ranks));
      set.questions.forEach((q, i) => {
        const row = (byKind[q.kind] ??= { kind: q.kind, n: 0 });
        if (mode === SEARCH_MODES[0]) row.n = Number(row.n) + 1;
        const hit = ranks[i] !== null && ranks[i] <= 5 ? 1 : 0;
        row[`${mode}@5`] = Number(row[`${mode}@5`] ?? 0) + hit;
      });
    }
    console.table(rows);

    if (process.argv.includes('--sweep')) {
      const sweep: Record<string, string | number>[] = [];
      for (const text of [1, 0.7, 0.5, 0.3, 0.2]) {
        for (const k of [20, 60]) {
          const ranks: (number | null)[] = [];
          for (const question of set.questions) {
            const { results } = await retrieval.search(
              userId,
              { q: question.q, mode: 'hybrid', limit: Math.max(...K) },
              { k, weights: { vector: 1, text } },
            );
            const rank = results.findIndex((r) =>
              question.expected.some(
                (e) => r.url.includes(e.url) && r.content.includes(e.contains),
              ),
            );
            ranks.push(rank === -1 ? null : rank + 1);
          }
          sweep.push({ ...summarize('hybrid', ranks), textWeight: text, k });
        }
      }
      console.log('hybrid sweep (text weight × RRF k):');
      console.table(sweep);
    }
    console.log('hits in top 5 by question kind:');
    console.table(Object.values(byKind));
  } finally {
    await app.close();
  }
}

function summarize(mode: SearchMode, ranks: (number | null)[]) {
  const n = ranks.length;
  const row: Record<string, string | number> = { mode };
  for (const k of K) {
    row[`recall@${k}`] = fmt(
      ranks.filter((r) => r !== null && r <= k).length / n,
    );
  }
  row.MRR = fmt(ranks.reduce<number>((s, r) => s + (r ? 1 / r : 0), 0) / n);
  row.misses = ranks.filter((r) => r === null).length;
  return row;
}

const fmt = (x: number) => Number(x.toFixed(3));

async function evalUser(users: UsersService): Promise<string> {
  const existing = await users.findByEmailWithPassword(EVAL_EMAIL);
  if (existing) return existing.id;
  const passwordHash = await argon2.hash(randomBytes(32).toString('hex'));
  return (await users.create({ email: EVAL_EMAIL, passwordHash })).id;
}

/** Saves the eval URLs for the eval user (idempotent) and waits for ingestion. */
async function ensureReady(
  userId: string,
  urls: string[],
  bookmarks: BookmarksService,
  db: DataSource,
) {
  const ids = await Promise.all(
    urls.map(async (url) => (await bookmarks.create(userId, { url })).id),
  );
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const states: { state: string; url: string }[] = await db.query(
      `SELECT processing_state AS state, original_url AS url FROM bookmarks WHERE id = ANY($1)`,
      [ids],
    );
    const broken = states.filter((s) =>
      ['failed', 'unsupported'].includes(s.state),
    );
    if (broken.length) {
      throw new Error(
        `Eval bookmarks not ingestible: ${broken.map((b) => `${b.url} (${b.state})`).join(', ')}`,
      );
    }
    if (states.every((s) => s.state === 'ready')) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ingestion: ${states.map((s) => `${s.url}=${s.state}`).join(', ')}`,
      );
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
