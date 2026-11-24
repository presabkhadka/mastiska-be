# Decisions

## 2026-11-24 — Processing state (plan.md §2A step 1)

Code: `src/ingestion/processing-state.ts`, `src/bookmarks/bookmark.entity.ts`,
`src/bookmarks/bookmarks.service.ts`, migration `1795512770112-BookmarkProcessingState.ts`.

### State machine
- **States:** `pending → fetching → fetched → extracting → ready`, plus `failed` and `unsupported`.
  Each stage has an in-progress state and a done state, so "not started", "being worked on" and
  "finished" are distinguishable.
- **Retry steps back to the stage's input** (`fetching → pending`, `extracting → fetched`).
  A failed extract retries only extraction, not the fetch. The same edge recovers rows left by a
  crashed worker.
- **`failed` vs `unsupported`:** `failed` = transient error that ran out of retries; `unsupported`
  = permanent (not HTML, 4xx, empty extraction) where retrying is pointless. Both leave only via
  manual replay to `pending`.
- **`ready → pending`** allows reprocessing when page content changes.
- **Blocked on purpose:** skipping stages (`pending → ready`), touching finished rows
  (`ready → fetching`, which a late duplicate worker would try), self-transitions.
- **Rules live in plain TS** (`PROCESSING_TRANSITIONS`, `assertTransition`) so they're unit-testable
  and checked before any SQL runs.

### Schema
- **Postgres enum** `bookmark_processing_state`, default `pending`. The DB rejects invalid values.
  Trade-off: adding a state later (e.g. `chunking`, `embedding`) needs an `ALTER TYPE ... ADD VALUE`
  migration.
- **Existing rows become `pending`** via the default, so they'll be picked up once a worker exists.
- **`processing_error`** (text) for the last failure message; cleared on the next transition.
- **`processing_state_changed_at`** + index on `(processing_state, processing_state_changed_at)`
  so a sweeper can find rows stuck in `fetching`/`extracting` cheaply.
- **No attempts column.** BullMQ already counts job attempts; add one only if we need it on the row.

### Concurrency
- **Transitions are compare-and-set:** `UPDATE ... WHERE id = :id AND processing_state = :from`.
  Postgres serializes the two updates; the loser gets 0 rows and `transitionProcessingState`
  returns `false`, so it drops its work. No explicit locks or transactions needed.
- **`BookmarksService.update()` rewritten** to `UPDATE` only user-owned columns. The old
  load → `save()` could write a stale `processing_state` back over a worker's change.
  `readAt` now uses `COALESCE(read_at, now())` so the first read time is kept atomically.
- **Side effect:** transitions bump `updated_at`. Fine for now; revisit if sorting by `updatedAt`
  shouldn't reflect background processing.

### API
- `GET /bookmarks?processingState=...` filter added.
- Users can't set the state: it's not in `UpdateBookmarkDto` and the global `ValidationPipe`
  has `forbidNonWhitelisted`, so a PATCH containing it returns 400.

### Not done yet
- ~~No worker, queue, or fetch/extract logic.~~ Done: see "Ingestion worker" below.
- **Phase 8 tests:** real-Postgres concurrency test (two parallel transitions, one wins) and e2e.
- **Pre-existing:** 2 failing tests in `src/auth/auth.service.spec.ts` (register no longer throws
  Conflict after the anti-enumeration change). Not touched.

## 2026-11-24 — Ingestion worker (plan.md §2A, §2B)

Code: `src/ingestion/` (`ingestion.service.ts`, `ingestion.processors.ts`, `fetch/`, `extract/`, `queue/`),
`src/bookmarks/bookmark-content.entity.ts`, migration `1795514451532-BookmarkContents.ts`.

### Infra and dependencies
- **Redis in Docker** (`redis` container, `redis:7-alpine`, port 6379, `--restart unless-stopped`),
  same approach as the postgres container. `REDIS_URL` defaults to `redis://localhost:6379`.
- **`bullmq` v6 + `ioredis`.** BullMQ v6 no longer bundles a Redis client; ioredis is the one it expects.
- **`@nestjs/bullmq` pinned to v11.** v12 is ESM-only; the project is CommonJS on Nest 11.
- **`@mozilla/readability` + `linkedom`** for extraction. linkedom is much lighter than jsdom.
- **`msgpackr-extract: false`** in `pnpm-workspace.yaml`: optional native speedup, BullMQ works without it.
- **Jest transforms linkedom's ESM-only deps** (`transformIgnorePatterns` in `package.json` and
  `test/jest-e2e.json`). The app itself is fine: Node 24 can `require()` ESM; Jest can't.

### Queues
- **One queue per stage** (`ingest-fetch` concurrency 5, `ingest-extract` concurrency 2). Fetch waits on
  the network, extract uses CPU, so they get separate concurrency limits.
- **jobId = `fetch-<bookmarkId>` / `extract-<bookmarkId>`.** BullMQ ignores an add while a job with that id
  exists, so duplicate enqueues are no-ops and there's at most one job per bookmark per stage.
- **`removeOnComplete` / `removeOnFail`.** Needed so the same jobId can be enqueued again (reprocess).
  The bookmark row (`processing_state`, `processing_error`) is the durable record and the dead-letter
  list (`?processingState=failed`), not BullMQ's failed set.
- **5 attempts, exponential backoff from 5s** (5, 10, 20, 40s).
- **Workers run in the API process** for now. Splitting into a separate worker process later only
  means moving `IngestionModule` into its own entrypoint.

### Stage execution (claim → work → commit)
- **Claim** with compare-and-set `input → active`. If that fails but the row is already `active`, it's
  this job being redelivered after a crash/stall (jobId dedup guarantees no other job), so continue.
  Anything else (e.g. already `ready`, deleted) → skip.
- **Work runs outside any transaction** (network/CPU), so no DB connection or lock is held while fetching.
- **Commit** = one transaction: compare-and-set `active → output` and write the content. If the
  compare-and-set loses, nothing is written. This stops a slow duplicate worker overwriting newer results.
- **Errors:**
  - permanent → `unsupported`, no retry
  - transient, attempts left → step back to the stage input (`fetching → pending`), record the error,
    rethrow so BullMQ backs off; the retry re-claims
  - transient on last attempt → `failed`
  - unknown errors are treated as transient
- **Fetch enqueues extract** after a successful commit. If that enqueue fails, the sweeper picks the
  row up from `fetched`.

### Sweeper (crash recovery, lost jobs)
- **BullMQ job scheduler every 60s** (not `setInterval`), so only one sweep runs per interval even with
  several app instances.
- **Stuck:** rows in `fetching`/`extracting` for >5 min are moved back to the stage input and requeued.
  Fetch has a 15s deadline, so 5 min means the worker is dead.
- **Orphaned:** rows in `pending`/`fetched` for >2 min are requeued (no-op if their job still exists).
  This also covers enqueue failures during `POST /bookmarks` (Redis down).
- Verified live: a row forced into `extracting` 10 min ago was reset and re-extracted without refetching.
- Known gap: no fencing token. If the sweeper resets a row whose "dead" worker is actually still alive,
  both may run; the compare-and-set lets only one commit, and both fetched the same URL, so the result is still valid.

### Safe fetching (`fetch/safe-fetcher.ts`)
- **Node `http`/`https`, not `fetch`,** because it lets us hook DNS lookup.
- **SSRF:** every resolved address is checked in the socket's `lookup` hook, i.e. the IP actually
  connected to. That closes the DNS-rebinding gap of "resolve, check, then fetch". IP literals are
  checked up front (they skip DNS). Re-checked on every redirect hop.
- **Blocked ranges** (`fetch/public-address.ts`, built-in `net.BlockList`): all IANA special-purpose IPv4
  (private, loopback, link-local incl. 169.254.169.254 metadata, CGNAT, multicast…); IPv6 allowed only
  in global unicast `2000::/3`, minus 6to4/Teredo/doc ranges. IPv4-mapped IPv6 is blocked.
- **Ports 80/443 only**, no credentials in URLs, http/https only.
- **Limits:** 15s for the whole redirect chain + body, max 5 redirects, 5 MB counted *after*
  decompression (gzip/deflate/br) so compression bombs hit the cap.
- **Only `text/html` / `application/xhtml+xml`.** PDFs etc. are `unsupported` for now.
- **Classification:** 408/425/429/5xx, timeouts, resets, `EAI_AGAIN` → transient; other 4xx, `ENOTFOUND`,
  TLS/cert errors, blocked address, bad type/size → permanent.
- **Charset:** from `Content-Type`, else `<meta charset>`, else UTF-8.
- Fetches the user's `original_url`, not the canonical one (canonical is for identity only).
- Not done: per-host rate limiting, robots.txt.

### Extraction (`extract/content-extractor.ts`)
- **Readability on linkedom.** linkedom only computes `baseURI` from a `<base>` tag, so one is inserted
  (final URL) when missing; otherwise relative links/images stay relative.
- **Fragments / non-HTML bodies** are wrapped in a document skeleton (found by test: linkedom crashed on
  them, which would have been retried as transient instead of marked `unsupported`).
- **< 25 words of readable text → `unsupported`.**
- `og:title` / `<title>` fallback for title; `<link rel=canonical>` stored as `source_canonical_url`
  (metadata only, doesn't change bookmark identity).
- **NUL bytes stripped** (Postgres `text` can't store them).
- **`content_html` is NOT sanitized.** Readability drops scripts, but any client rendering it must
  sanitize (e.g. DOMPurify) first.
- **Bookmark title is filled only if the user left it null** (`UPDATE … WHERE title IS NULL`), so a
  user-set title is never overwritten.

### Storage
- **`bookmark_contents`**, 1:1 with bookmarks (PK = `bookmark_id`, cascade delete). Fetch and extract
  results in one row.
- **Raw HTML is stored** so extraction can be retried/re-run without refetching (per-stage retry).
  Trade-off: up to 5 MB per bookmark. `select: false` so it's never returned by the API.

### API
- `POST /bookmarks` enqueues a fetch for new bookmarks only (not for duplicate saves). Enqueue is
  capped at 2s and failures are only logged, so a Redis outage doesn't break saving.
- `POST /bookmarks/:id/reprocess` (202): manual replay from `ready`, `failed` or `unsupported`;
  409 while still processing.
- `GET /bookmarks/:id/content`: extracted article (404 until extracted).

### Verified
- Unit: 104 tests pass (fetcher against a local HTTP server, extractor, address ranges, stage logic, service).
- Live, against real Redis/Postgres: Wikipedia article → `ready` with title filled; user-set title kept;
  PDF → `unsupported`; `169.254.169.254` → blocked; reprocess → back to `ready`; reprocess while busy → 409;
  PATCH `processingState` → 400; stuck-row recovery as above.
- On first start the sweeper picked up the 9 old bookmarks that the previous migration had set to
  `pending` (old e2e data, all 404 → `unsupported`). That's the intended backfill.

### Not done yet
- Phase 8 real-DB concurrency test; per-host rate limits; metrics (§2G); HTML sanitization; PDF support.
- Pre-existing, untouched: auth "duplicate registration → 409" tests fail (2 unit + 1 e2e) after the
  anti-enumeration change, and `auth.service.ts` has an unused `ConflictException` import.

## 2026-11-24 — Embedding config (plan.md §2D, prep only)

- **Provider: Google Gemini API (AI Studio key, free tier)**, chosen by the user. Env: `GEMINI_API_KEY`,
  `EMBEDDING_MODEL=gemini-embedding-001`, `EMBEDDING_DIMENSIONS=768`.
- **768 dimensions.** `gemini-embedding-001` supports 768/1536/3072. (Later fixed to 768 only, see "Chunking and embeddings".) 768 keeps
  pgvector storage and HNSW indexes small; retrieval quality at 768 is close to 3072 for this use.
- **Key is optional for now** (`allow('')`) so the app boots before the embedding stage exists.
  Make it required when the embedding worker is added.
- **Free-tier caveats:** low rate limits (batching + backoff will matter), and Google may use free-tier
  inputs to improve its products. The inputs are saved article text.
- Changing model or dimensions later means re-embedding everything; the chunk table will store the
  model name per vector to detect that.

## 2026-11-24 — Retry jitter

- `backoff: { type: 'exponential', delay: 5_000, jitter: 0.5 }` (BullMQ built-in). Each wait is drawn
  uniformly from [50%, 100%] of the exponential delay: ~2.5–5s, 5–10s, 10–20s, 20–40s (sampled to confirm).
  Without it, everything that failed together (site outage, Gemini 429) retries in lockstep and fails again.

## 2026-11-24 — Chunking and embeddings (plan.md §2D)

Code: `src/ingestion/chunk/chunker.ts`, `src/ingestion/embed/gemini-embedder.ts`, `IngestionService.embed`,
`src/bookmarks/bookmark-chunk.entity.ts`, migration `1795515966713-ChunksAndEmbeddings.ts`.

### Pipeline shape
- **New states `extracted` and `embedding`.** Extract now ends at `extracted`; a third stage
  `extracted → embedding → ready` does the embedding. `ready` now means "searchable".
- **Chunking happens inside the extract commit**, not as its own stage. It's cheap, deterministic, and
  must match the extracted text, so writing both in one transaction keeps them consistent.
- **Embedding is its own stage/queue** (`ingest-embed`) because it's the only external, rate-limited,
  quota-costing step.
- **Backfill:** the migration moves existing `ready` rows to `fetched` so they get re-extracted from the
  stored HTML and chunked. Verified live: the 3 existing articles went through to `ready` (46 chunks).

### Chunking (`chunk/chunker.ts`)
- **Chunks from Readability's HTML, not plain text,** to keep headings. Each chunk stores its heading path
  (`section`, e.g. "Computer science meaning > Examples") and `position`.
- **Size:** target ~1600 chars (~400 tokens), hard max 2400. Long paragraphs are cut at sentence boundaries.
- **Section-aware:** a new heading starts a new chunk, unless the current chunk is still under 400 chars
  (then it's merged, to avoid stub chunks).
- **Overlap:** the next chunk in a section starts with up to 200 chars of the previous chunk's last whole
  sentences, only if that still fits under the max (a test caught 2560-char chunks before this rule).
- **Table rows** become one line (`Locked | coin | Unlocked`); wiki noise (`[edit]`, `[1]`,
  `[citation needed]`) is dropped. Both found by running the chunker on the real articles in the DB.
- **Evaluated on real articles:** Wikipedia FSM (26 chunks, median 1428 chars), Idempotence (14), a 500-word
  blog post (6, one per short section). Revisit sizes once retrieval quality can be measured (§2E).
- **Title/URL are not copied into chunks;** they come from the bookmark via `bookmark_id` (always current,
  no duplication).

### Embedding input
- Embedded text = `section + "\n\n" + content`, sent with Gemini's `title` field and
  `taskType: RETRIEVAL_DOCUMENT`. Queries must use `RETRIEVAL_QUERY` (retrieval step).
- **Vectors are L2-normalized before storing.** Gemini only normalizes 3072-dim output (measured norm 0.585
  at 768). Normalized vectors make cosine and dot product equivalent.

### Storage (`bookmark_chunks`)
- `vector(768)` (pgvector 0.8.7, already in the postgres image) + **HNSW index with `vector_cosine_ops`**.
  HNSW over IVFFlat: no training step, good recall on a small, growing table.
- **`EMBEDDING_DIMENSIONS` is now fixed to 768** (env only accepts 768). The column size is fixed, and HNSW
  on `vector` can't index >2000 dims anyway, so 3072 would need `halfvec`. Changing it = migration + re-embed.
- **`embedding_model` per row**; chunks whose model differs from the configured one count as pending, so
  switching models re-embeds automatically on the next embed run.
- **`content_hash`** = sha256(title, section, content). On re-extract (reprocess), chunks whose hash and model
  match keep their old vector, so only changed passages are re-embedded (saves free-tier quota).
- `embedding` is `select: false`, so the API never returns vectors.

### Embedding stage
- **Batches of 50 chunks per request** (Gemini's cap is 100).
- **Each batch commits on its own**, so a failure on batch 3 only re-embeds what's still missing on retry.
- **Before writing a batch, the bookmark row is locked (`FOR UPDATE`)** and must still be `embedding`;
  otherwise the worker stops (`skipped`). Stops a stale worker writing vectors after a reset/reprocess.
- **The final commit checks no chunks are left unembedded** before moving to `ready`.
- **Rate limiting:** embed worker concurrency 1 + BullMQ limiter 20 jobs/min (shared across instances via
  Redis). Tuned conservatively for the free tier; 429s are transient and use the jittered backoff.
- **Errors:** 400 → permanent (`unsupported`); 429/5xx/network/malformed response → transient.
  **Missing key and 401/403 → transient**, so a config problem ends in `failed` (replayable after fixing
  the key) instead of permanently marking bookmarks `unsupported`.
- Raw `fetch` to the REST API, no Google SDK dependency.

### Migration notes
- TypeORM's generated `down` for the enum change failed (it altered the column type without dropping the
  default). Fixed by dropping/restoring the default; up → down → up verified.
- `CREATE EXTENSION IF NOT EXISTS vector` in `up`; not dropped in `down` (other tables may use it).

### Verified
- 136 unit tests; only the 2 pre-existing auth tests fail. e2e: 4/5 (the pre-existing auth one).
- Live with the real key: all 46 chunks embedded, every vector norm = 1.0000, 768 dims.
- Sanity search (query embedded with `RETRIEVAL_QUERY`, nearest by cosine):
  "insert a coin in a turnstile" → FSM › "Example: coin-operated turnstile" (0.76);
  "stay under a daily SMS provider quota" → blog › "2. Quota Awareness" (0.74);
  "applying an operation twice same as once" → Idempotence intro (0.74).

### Not done yet
- Retrieval (§2E): query embedding, vector + full-text hybrid search, citations.
- A job to re-embed when `EMBEDDING_MODEL` changes (works per bookmark on next embed, but nothing triggers
  a bulk re-run yet).
- Gemini's `Retry-After`/`RetryInfo` hint on 429 isn't used; backoff is our own.

## 2026-11-24 — Retrieval: eval set + hybrid search (plan.md §2E, tasks 25–29)

Code: `src/retrieval/` (`retrieval.service.ts`, `fusion.ts`, `search.controller.ts`, `dto/search-query.dto.ts`),
`src/embedding/` (shared `GeminiEmbedder` + `EmbeddingModule`), migration `1795519400029-ChunkFullText.ts`,
`test/retrieval/` (`eval-set.json`, `run-eval.ts`, `pnpm eval:retrieval [--verbose] [--sweep]`).

### Evaluation first
- **27 questions over the 4 saved articles**, each with the passage(s) that answer it, matched by URL fragment +
  a text snippet (not chunk ids, so the set survives re-chunking). Kinds: 14 paraphrase, 7 keyword, 5 exact
  identifier ("Medvedev machine", "pino logger setup"), 1 cross-topic.
- **Runner** boots the real app (DB, Redis, workers), uses a dedicated user `retrieval-eval@mastiska.local`,
  saves the eval URLs (idempotent), waits for `ready`, then reports recall@1/5/10, MRR and misses per mode,
  plus top-5 hits per question kind.
- **Query vectors are cached** in `test/retrieval/.query-cache.json` (gitignored) and 429s are retried after
  30s. The first runs hit the free-tier per-minute quota (the eval user's 51 chunks were embedded just before).
- Caveat: 27 questions over 4 documents is small. Numbers move by 1 question = 0.037. Grow the set as the
  library grows; don't over-tune to it.

### Search design
- **Both legs are scoped to the caller's own `ready` bookmarks** (`b.user_id`, `processing_state = 'ready'`).
  Filters (collection, tag, saved date, domain incl. subdomains) are bound parameters, never interpolated.
- **Vector leg:** query embedded with `RETRIEVAL_QUERY`, cosine distance on the HNSW index, top 50.
  `SET LOCAL hnsw.iterative_scan = relaxed_order` (pgvector 0.8) so filtered searches still return enough rows;
  results re-sorted afterwards because relaxed order can be slightly out of order.
- **Text leg:** generated `search_vector` column (`english` config, section weighted A, content B) + GIN index.
  Query words are OR-ed (natural questions never contain every word of a passage), **but passages containing
  all query words rank first**. Postgres `ts_rank_cd` has no IDF: with OR alone, passages repeating "machine"
  outranked the one passage mentioning "Medvedev" (found by the eval).
- **Fusion:** Reciprocal Rank Fusion (rank-based, so cosine distances and text ranks don't need a common scale),
  then dedupe identical passages by `content_hash`, max 3 passages per bookmark, then `limit`.
- **Text weight 0.7 in RRF.** Sweep (`--sweep`) over text weight {1, 0.7, 0.5, 0.3, 0.2} × k {20, 60}:
  - equal weights: hybrid MRR 0.938 < vector 0.963 (a passage 2nd in both lists beat vector's correct #1)
  - 0.7: hybrid MRR 0.963 = vector; k made no difference
  - chose 0.7, the largest weight that loses nothing, so keyword matches still count for exact names.
- **Honest result:** on this set, vector alone is as good as hybrid. Hybrid is kept for robustness (exact names,
  codes, rare terms as the library grows) and because it degrades gracefully (below).
- **Adjacent-chunk collapsing (in the plan) was dropped:** adjacent chunks share only ≤200 chars of overlap, so
  collapsing them would hide different content. Merging neighbours belongs in context selection (task 30).
- **Reranking deferred** (task 28 partly open): it needs an LLM/reranker call; decide with answer generation.

### Final numbers (27 questions)
| mode | recall@1 | recall@5 | recall@10 | MRR |
|---|---|---|---|---|
| hybrid | 0.926 | 1.0 | 1.0 | 0.963 |
| vector | 0.926 | 1.0 | 1.0 | 0.963 |
| text | 0.667 | 0.852 | 0.852 | 0.735 |

### API: `GET /search`
- Params: `q` (1–500 chars, trimmed), `mode` (`hybrid`|`vector`|`text`, default hybrid), `limit` (1–50, default 10),
  `collectionId`, `tagId`, `domain`, `savedAfter`, `savedBefore`.
- Each result: chunk + bookmark ids, title, url, section, position, content, RRF `score`, cosine `similarity`
  (null if only text matched), `matchedBy`.
- **Gemini down / rate-limited:** hybrid falls back to keyword results with `degraded: true` (seen live on a 429);
  `mode=vector` returns 503. Query embeddings are cached in memory (500 entries) to save quota.
- Verified live: correct top results, domain filter, 400 on bad params, 401 without token, another user gets 0 results.

### Embedding module
- `GeminiEmbedder` moved to `src/embedding/` with its own module, shared by ingestion and retrieval.
  Added `embedQuery` (`RETRIEVAL_QUERY` task type, no title).

### Migration notes
- `search_vector` is a TypeORM generated column. The generator wanted to **drop the hand-made HNSW index** because
  the entity didn't declare it; both custom indexes are now declared with `synchronize: false`. A follow-up
  `migration:generate` reports no changes (no drift).
- The generator hard-coded the database name (`mastiskadb`) into `typeorm_metadata`; replaced with
  `current_database()` / `current_schema()` so it works in other environments.

### Observed, not fixed yet
- **Wikipedia reference lists become chunks** (e.g. FSM chunks 16–25 are bibliography). They add text-search
  noise ("Medvedev" ranks the bibliography above the explanation). Fix later in the chunker (drop
  citation-dense blocks), then re-run the eval.
- Similarity is a usable "weak evidence" signal: real matches ≈ 0.74, unrelated best-effort matches ≈ 0.58.
  Use it for "insufficient evidence" in answer generation (task 31).

## 2026-11-24 — Answer generation with Gemini Flash (plan.md §2E, tasks 30–31)

Code: `src/answer/` (`answer.service.ts`, `context.ts`, `gemini-generator.ts`, `answer.controller.ts`, `dto/ask.dto.ts`).
Endpoint: `POST /ask { question, collectionId?, tagId?, domain?, savedAfter?, savedBefore? }`.

### Models
- **Picked from the live model list, not from memory.** `gemini-2.5-flash` returns 404 ("no longer available to new
  users"); Google recommends `gemini-3.8-flash`.
- **Config:** `ANSWER_MODEL=gemini-3.8-flash`, `ANSWER_FALLBACK_MODELS=gemini-3.5-flash-lite,gemini-3.5-flash`
  (comma-separated, tried in order).
- **Measured on the free tier:** 3.8-flash mostly 503 "high demand" or >20s; 3.5-flash works but ~16s;
  3.5-flash-lite ~1.5–2s with good grounded answers. Lite is the first fallback for that reason.
- **Structured output** (`responseMimeType: application/json` + schema `{status, answer, citations, conflicts}`)
  instead of parsing prose. `thinkingLevel: low`: answering from given passages needs little reasoning.

### Retry / fallback (`gemini-generator.ts`)
- **503, 429 or timeout → move to the next model immediately.** Each model has its own capacity and quota, so
  switching helps more than waiting.
- **Other 5xx, network errors, empty or invalid JSON → one jittered retry on the same model.** 400 → fail.
- **20s per attempt, 60s total**, so `/ask` can't hang.
- The first version (2 retries per model, 45s attempts) used up the 60s on the primary model and never reached Lite.

### Evidence gate (`context.ts`)
- **Top similarity < 0.57 → `insufficient_evidence` (`no_relevant_sources`) without calling the model.**
  Calibrated: all 27 answerable eval questions scored ≥ 0.612 top-1; 8 off-topic questions ≤ 0.531.
  Saves free-tier quota and stops the model inventing answers from unrelated passages.
- Skipped when search is degraded (keyword-only, no similarities); then the model decides.
- **Context selection:** passages below 0.5 similarity dropped; max 8 sources; ~4000-token budget
  (chars/4), in retrieval order.

### Prompt
- Sources are numbered `<source n title section>` blocks. A `</source>` inside an article is neutralized so source
  text can't break out of its block.
- The system prompt says: use only the sources, cite every claim as `[n]`, say what's missing when they don't answer
  it, describe disagreements in `conflicts`, and treat source text as quoted material, not instructions.

### The backend decides what counts as an answer
- Citation numbers that don't match a source are removed (including inside grouped `[1, 2]`, seen live).
- An "answered" response with no inline citation is downgraded to `insufficient_evidence` (`uncited_answer`).
- Response: `status` (`answered` | `insufficient_evidence` | `unavailable`), `answer`, `conflicts`, `reason`,
  `citations` (cited only), `sources` (everything shown to the model), `model`, `degraded`.
- **All models down → HTTP 200 with `status: unavailable`, `reason: generation_failed` and the sources**, so a client
  can still show the passages.

### Verified live (dev server, eval user)
- Grounded, cited answers for "make an operation safe to retry", "coin in a turnstile", "Mealy vs Moore", via the
  Lite fallback after 3.8-flash timed out or returned 503.
- "Best pizza dough hydration" → `insufficient_evidence` in ~0.5s, no model call.
- One request fell through every model (3.8 timeout, Lite 503) → `unavailable` with sources, as designed.

### Not done yet
- Unit tests for `context.ts`, `gemini-generator.ts`, `answer.service.ts`.
- Answer eval: does the answer cite the expected source; are off-topic questions declined.
- Conflicting evidence: handled in the prompt/schema but not exercised by any test data.
- ~~Per-user rate limit on `/ask`~~ done, see "/ask rate limit + model fallback fix".
- Reranking (task 28) still open.

## 2026-11-24 — /ask rate limit + model fallback fix

### Per-user rate limit on `/ask`
Code: `src/common/rate-limit/` (`rate-limiter.ts`, `rate-limit.module.ts`), `src/answer/ask-rate-limit.guard.ts`.
- **Why:** every user shares one Gemini free-tier quota; one user could exhaust it for everyone.
- **Limits:** 5 questions per minute and 50 per day per user (`ASK_RATE_LIMIT_PER_MINUTE`, `ASK_RATE_LIMIT_PER_DAY`;
  0 disables a window). Over the limit → `429` with a `Retry-After` header and which window was hit.
- **Redis, not memory:** counters live in the existing Redis, so the limit holds across several app instances.
  No new dependency (`ioredis` is already used by BullMQ); no `@nestjs/throttler`.
- **Fixed windows** (keys `ratelimit:ask:<userId>:<window>:<bucket>`), simple and good enough for quota protection.
  Trade-off: a burst at a window boundary can get up to 2× the per-minute limit.
- **Atomic Lua check-then-increment:** all windows are checked first and only incremented if every one allows it,
  so rejected requests don't use up quota (verified: counters stayed at 5 after the 6th and 7th requests).
- **Fails open:** if Redis is down, `/ask` still works and a warning is logged. The limiter protects quota;
  it shouldn't take the feature down. The client uses `enableOfflineQueue: false` so it fails fast instead of hanging.
- Counted per request, including ones declined by the evidence gate (they still cost a query embedding).
- Verified live: 5 × 200, then 429 with `Retry-After: 18`.

### Model fallback fix (`src/answer/gemini-generator.ts`)
- **Before:** a non-retryable error (e.g. 400) from the first model ended the whole request.
- **Now:** only transient blips (other 5xx, network errors, empty or invalid JSON) are retried on the same model.
  Every other failure (400, 401/403, 404, 429, 503, timeout) moves to the next model, because errors like
  "unsupported parameter" or "no access" can be specific to one model. Only a missing API key fails immediately.
- Unit tests (`gemini-generator.spec.ts`): 400/403/404/429/503 each fall through to the next model, a 500 is
  retried on the same model, invalid JSON is retried, all models failing throws the last error, no key → no call.

### Still open
- Unit tests for `context.ts` and `answer.service.ts`, and the answer eval.

## 2026-11-24 — /ask: questions about the library itself ("do I have a bookmark about X?")

- **Bug (found by the user in Postman):** "do i have any bookmark for idempotency?" returned `insufficient_evidence` /
  `model_declined`, even though retrieval found 3 Idempotence passages and passed the similarity gate. The model said
  the sources don't say whether the user has bookmarks.
- **Cause:** the prompt never told the model that the sources *are* the user's saved bookmarks, so questions about
  the library looked unanswerable. Content questions were unaffected.
- **Fix (`src/answer/context.ts`):**
  - the system prompt says each source is a passage from an article the user saved, with title and URL
  - new rule: for "do I have / what did I save about X", say yes, name the matching bookmarks, cite them and summarize
  - sources are wrapped in `<saved_bookmarks>` and each `<source>` tag carries `url="…"`
- **No gate change:** "do I have anything about pizza?" is still answered "no" by the similarity gate before any
  model call (`no_relevant_sources`), which is the correct answer and costs no quota.
- **Tests:** new `src/answer/context.spec.ts`: gate and budget, weak passages dropped, keyword-only mode skips the
  gate, prompt framing and escaping (a source can't close its own tag), grouped/invalid citations stripped,
  uncited answers downgraded, model declines passed through.
- **Live check: pending.** The postgres and redis containers were stopped when this was verified; rerun the three
  questions above once they're up.
- Also seen in the user's logs: `gemini-3.8-flash` returning 503 and then 429 (free-tier quota exhausted); the
  fallback to `gemini-3.5-flash-lite` answered every request in ~1.4s, as designed.
