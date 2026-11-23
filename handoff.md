# Handoff: Mastiska scaffold → you

This document covers what has been built, where everything lives, why it's shaped the way it is, and where your hand-coded work begins.

It complements two other files:
- `plan.md` is your learning plan, covering what to scaffold and what to hand-code.
- `HANDCODE.md` is a short index of every `// HAND-CODE` seam in the code.

---

## 1. Summary

**Done:** everything in `plan.md` §1 ("Safe to Scaffold"), backend only:
- Local JWT auth: register, login, `me`.
- CRUD for bookmarks, tags, collections, and notes, all scoped to the owning user.
- Pagination, sorting, and filtering on the bookmark list.
- Linking tags to bookmarks and bookmarks to collections. Both are idempotent.
- Postgres schema created via a TypeORM migration. `synchronize` is off.
- Runs against your local Postgres (pgvector) container.
- Swagger docs, a health check, and global request validation.
- 9 unit tests and 5 e2e tests, all passing. Lint and build are clean.

**Deliberately not done:** everything in `plan.md` §2 (A–G). Nothing was built for ingestion, jobs/BullMQ, processing state, canonical-URL identity, chunking, embeddings, retrieval, the agent, or observability. The places where that work plugs in are marked with `// HAND-CODE` comments.

**Decisions you made during planning:**
- Local JWT auth with access tokens only (no refresh tokens).
- No frontend yet.
- Real TypeORM migrations (instead of `synchronize: true`).

---

## 2. Getting it running

```bash
pnpm install
cp .env.example .env            # already done once; JWT_SECRET must be ≥ 32 chars
pnpm migration:run              # creates all tables
pnpm dev                        # http://localhost:3000
```

- Swagger UI: http://localhost:3000/docs. Use the **Authorize** button and paste the `accessToken` returned by `/auth/login`.
- Health check: `GET /health` returns `{ "status": "ok", "db": "up" }`.

Verification:
```bash
pnpm build && pnpm lint && pnpm test && pnpm test:e2e
```

> **Note on the database:** the app uses your existing `postgres` container (`pgvector/pgvector:pg18`) on **5432**, database `mastiskadb`. `DATABASE_URL` in `.env` points there.

---

## 3. Folder structure

```
mastiska-be/
├── plan.md                    Your learning plan (unchanged)
├── HANDCODE.md                Index of every HAND-CODE seam + scaffold decisions to review
├── handoff.md                 This file
├── README.md                  Short setup / scripts / API reference (replaced the Nest boilerplate)
├── .env.example               Template env vars (committed)
├── .env                       Your local env (git-ignored)
├── package.json               Scripts incl. migration:*
├── pnpm-workspace.yaml        pnpm build-script allowlist (see §8)
├── src/
│   ├── main.ts                Bootstraps Nest, applies configureApp(), mounts Swagger at /docs
│   ├── app.setup.ts           configureApp(): global ValidationPipe + shutdown hooks (shared with e2e)
│   ├── app.module.ts          Root module: wires Config, Database and all feature modules
│   │
│   ├── config/
│   │   └── env.validation.ts  Joi schema: app refuses to boot with missing/invalid env
│   │
│   ├── database/
│   │   ├── data-source.ts     Single source of TypeORM options, used by BOTH app and CLI
│   │   ├── database.module.ts TypeOrmModule.forRootAsync using ConfigService
│   │   └── migrations/
│   │       └── 1795458315470-InitialSchema.ts   All current tables, FKs, indexes
│   │
│   ├── common/                Cross-cutting, domain-free helpers
│   │   ├── db-errors.ts       isUniqueViolation(err) → Postgres error 23505 detection
│   │   ├── entities/base.entity.ts     uuid id + created_at + updated_at (timestamptz)
│   │   └── dto/
│   │       ├── pagination-query.dto.ts page / limit (≤100) / order + computed skip
│   │       └── paginated.dto.ts        Paginated<T> shape + paginate() helper
│   │
│   ├── health/
│   │   └── health.controller.ts   GET /health (public), runs SELECT 1
│   │
│   ├── users/                 User entity + lookup/create; no HTTP routes of its own
│   │   ├── user.entity.ts
│   │   ├── users.service.ts
│   │   └── users.module.ts
│   │
│   ├── auth/
│   │   ├── auth.module.ts     JwtModule config + registers JwtAuthGuard as GLOBAL guard
│   │   ├── auth.controller.ts POST /auth/register, POST /auth/login, GET /auth/me
│   │   ├── auth.service.ts    argon2 hash/verify, token issuing, 409 on duplicate email
│   │   ├── auth.service.spec.ts
│   │   ├── strategies/jwt.strategy.ts   Validates bearer token, re-checks user exists
│   │   ├── guards/jwt-auth.guard.ts     Global guard; skips routes marked @Public()
│   │   ├── decorators/public.decorator.ts       @Public()
│   │   ├── decorators/current-user.decorator.ts @CurrentUser() → { id, email }
│   │   └── dto/register.dto.ts, dto/login.dto.ts
│   │
│   ├── bookmarks/             The central domain module
│   │   ├── bookmark.entity.ts             Bookmark + ManyToMany join tables (tags, collections)
│   │   ├── bookmark-identity.service.ts   ★ HAND-CODE stub: canonicalize()
│   │   ├── bookmarks.service.ts           CRUD, list filters, ownership checks, attach/detach
│   │   ├── bookmarks.service.spec.ts
│   │   ├── bookmarks.controller.ts        /bookmarks + /bookmarks/:id/tags/:tagId
│   │   ├── collection-bookmarks.controller.ts  /collections/:collectionId/bookmarks/:bookmarkId
│   │   ├── bookmarks.module.ts            Imports TagsModule + CollectionsModule
│   │   └── dto/create-bookmark.dto.ts, update-bookmark.dto.ts, bookmark-query.dto.ts
│   │
│   ├── tags/                  tag.entity.ts, tags.service.ts, tags.controller.ts, dto/tag.dto.ts
│   ├── collections/           collection.entity.ts, collections.service.ts, ..., dto/collection.dto.ts
│   └── notes/                 note.entity.ts, notes.service.ts, notes.controller.ts, dto/note.dto.ts
│                              (notes depends on BookmarksModule for ownership checks)
└── test/
    ├── app.e2e-spec.ts        Full API flow against the real DB
    └── jest-e2e.json
```

### Module dependency graph

```
AppModule
 ├─ ConfigModule (global)
 ├─ DatabaseModule
 ├─ UsersModule ◄── AuthModule (provides global JwtAuthGuard)
 ├─ TagsModule ─────────┐
 ├─ CollectionsModule ──┤
 │                      ▼
 ├─ BookmarksModule (imports Tags + Collections; exports BookmarksService)
 │                      ▲
 └─ NotesModule ────────┘
```

**Why do the collection-membership routes live in `bookmarks/`?** `BookmarksService` owns both join tables and needs `TagsService` and `CollectionsService` to check ownership. If `CollectionsModule` also depended on `BookmarksService`, the two modules would form a circular dependency. Keeping `collection-bookmarks.controller.ts` inside the bookmarks module avoids that.

### Conventions used in every feature module

- **Shape:** `<name>.entity.ts`, `<name>s.service.ts`, `<name>s.controller.ts`, `<name>s.module.ts`, and DTOs in `dto/`.
- **User scoping:** every service method takes `userId` as its first argument, and every query filters on it. Controllers get the user from `@CurrentUser()`. Never trust a `userId` that arrives in a request body.
- **UUID params:** route IDs are validated with `ParseUUIDPipe`, so a malformed ID returns 400 before it reaches the DB.
- **Status codes:**
  - DELETE and attach/detach return **204**.
  - A missing resource, or one owned by someone else, returns **404**.
  - A unique-constraint conflict returns **409**.
  - A validation failure returns **400**.
- **Swagger:** DTOs use `@nestjs/swagger` decorators. `PartialType` is imported from `@nestjs/swagger`, not `@nestjs/mapped-types`, so the docs stay accurate.
- **Unique errors:** these are handled with `isUniqueViolation()` from `src/common/db-errors.ts`. Rely on DB constraints, not check-then-insert.

---

## 4. Database schema (current)

All tables have `id uuid PK`, `created_at timestamptz` and `updated_at timestamptz` (inherited from `BaseEntity`).

| Table | Columns | Constraints / indexes |
|---|---|---|
| `users` | `email`, `password_hash` (never selected by default), `display_name` | `UNIQUE(email)` (stored lower-cased) |
| `bookmarks` | `user_id`, `original_url` (text), `canonical_url` (text, nullable), `title` (≤500), `is_favorite`, `is_archived`, `read_at` | FK user ON DELETE CASCADE; `idx_bookmarks_user_created (user_id, created_at)`. **`canonical_url` has no unique constraint (left for you).** |
| `tags` | `user_id`, `name` (≤50) | FK user CASCADE; `uq_tags_user_name UNIQUE(user_id, name)` |
| `collections` | `user_id`, `name` (≤100), `description` | FK user CASCADE; `idx_collections_user_created` |
| `notes` | `bookmark_id`, `body` | FK bookmark CASCADE; `idx_notes_bookmark_created`. No `user_id`: ownership comes from the parent bookmark. |
| `bookmark_tags` | `bookmark_id`, `tag_id` | composite PK; both FKs CASCADE |
| `bookmark_collections` | `bookmark_id`, `collection_id` | composite PK; both FKs CASCADE |
| `migrations` | TypeORM bookkeeping | |

- **Cascades:** deleting a user removes all of their data. Deleting a bookmark removes its notes and join rows. Deleting a tag or collection removes only the join rows.
- **Not in the schema yet:** processing/ingestion state, extracted content, source metadata, chunks, embeddings, jobs, conversations, and tool calls.

### Migration workflow

```bash
# after changing an entity:
pnpm migration:generate src/database/migrations/AddSomething
# for hand-written SQL (e.g. CREATE EXTENSION vector, partial indexes, CHECK constraints):
pnpm migration:create src/database/migrations/AddSomething
pnpm migration:run
pnpm migration:revert
```

- **Always read generated migrations.** TypeORM sometimes emits redundant indexes. For example, the initial migration has single-column indexes on `bookmark_tags.bookmark_id`, which the composite PK already covers. Removing that is your call.
- **Shared config:** `src/database/data-source.ts` is used by both the Nest app and the CLI, so the entity and migration globs live in one place.
- **pgvector:** the extension is available in your container image but **not enabled**. Add `CREATE EXTENSION IF NOT EXISTS vector` in the first migration that needs it.

---

## 5. API reference

All routes require `Authorization: Bearer <token>` except those marked *public*.

| Method & path | Notes |
|---|---|
| `GET /health` | *public* |
| `POST /auth/register` | *public*. `{ email, password (8–128), displayName? }` → `{ accessToken, user }`. 409 if the email exists (case-insensitive). |
| `POST /auth/login` | *public*. Returns 200 `{ accessToken, user }`. Same 401 for an unknown email or a wrong password. |
| `GET /auth/me` | `{ id, email }` |
| `GET /bookmarks` | Query params: `page`, `limit`, `order`, `sortBy` (`createdAt`/`updatedAt`/`title`), `tagId`, `collectionId`, `isArchived`, `isFavorite`, `savedAfter`, `savedBefore`. Returns `{ items, meta }`, and items include `tags`. |
| `GET /bookmarks/:id` | Includes `tags` and `collections` |
| `POST /bookmarks` | `{ url (http/https), title? }` |
| `PATCH /bookmarks/:id` | `{ title?, isFavorite?, isArchived?, isRead? }`. The URL cannot be changed. |
| `DELETE /bookmarks/:id` | 204 |
| `PUT` / `DELETE /bookmarks/:id/tags/:tagId` | Idempotent attach/detach; both must be yours |
| `GET` / `POST /tags`, `GET` / `PATCH` / `DELETE /tags/:id` | 409 on a duplicate name per user |
| `GET` / `POST /collections`, `GET` / `PATCH` / `DELETE /collections/:id` | List is paginated |
| `PUT` / `DELETE /collections/:collectionId/bookmarks/:bookmarkId` | Idempotent. To list a collection's bookmarks, use `GET /bookmarks?collectionId=` |
| `GET` / `POST /bookmarks/:bookmarkId/notes`, `PATCH` / `DELETE .../notes/:id` | |

**Validation:** the global `ValidationPipe` runs with `whitelist + forbidNonWhitelisted + transform`. Unknown body fields such as `userId` cause a 400; they are not silently dropped.

---

## 6. Request lifecycle (how a call flows)

1. **Global guard.** `JwtAuthGuard` (registered in `auth.module.ts` via `APP_GUARD`) runs on every route. A route marked `@Public()` skips it. Otherwise `JwtStrategy.validate()` verifies the token, loads the user, and puts `{ id, email }` on `req.user`.
2. **Validation.** The global `ValidationPipe` (in `app.setup.ts`) validates the DTOs and converts values: query strings become numbers, booleans, and dates.
3. **Controller.** It reads `@CurrentUser()` and calls the service with `user.id`.
4. **Service.** It queries through TypeORM repositories, always with `userId` in the `WHERE` clause. It throws Nest HTTP exceptions such as `NotFoundException` and `ConflictException`.

### How ownership works for nested and linked resources
- **Notes:** `BookmarksService.assertOwned(userId, bookmarkId)` runs first, and then the note is looked up by `(id, bookmarkId)`.
- **Tag/collection links:** the service checks that both sides belong to the user, then inserts the join row.

This check happens in the service only. The DB does not enforce that a bookmark and its tag share an owner, so a concurrent delete between the check and the insert gives an FK error (500). The fix is yours to decide; see `HANDCODE.md`.

---

## 7. Tests

| Suite | Location | What it covers |
|---|---|---|
| Unit | `src/bookmarks/bookmarks.service.spec.ts` | `create` keeps `originalUrl` and calls `canonicalize`; `findOne` is user-scoped and returns 404; `readAt` set/keep/clear; `remove` returns 404; `addTag` is idempotent on a unique violation; a foreign tag is rejected |
| Unit | `src/auth/auth.service.spec.ts` | Password is hashed with argon2; duplicate email returns 409; unknown email and wrong password both return 401 |
| E2E | `test/app.e2e-spec.ts` | Health, 401 without a token, 409 on a duplicate email (case-insensitive), 400 on a bad URL or an extra field, the full bookmark/tag/collection/note flow, filters and pagination, cross-user 404s, delete cascades |

- **E2E database:** the e2e suite uses the **real DB from `.env`** and registers fresh random users each run, so it doesn't need a clean database. It does leave rows behind.
- **Mocking:** the unit tests mock repositories, so the e2e suite is the only real check of SQL behaviour.
- **Your tests:** the race-condition and failure tests from §2G haven't been started.

---

## 8. Dependencies and version notes

**Added:**
- `@nestjs/config`, `@nestjs/jwt`, `@nestjs/passport`, `@nestjs/swagger`
- `passport`, `passport-jwt`, `argon2`
- `class-validator`, `class-transformer`, `joi`
- `pg`, `dotenv`
- `@types/passport-jwt` and `@types/pg` (dev dependencies)

**Version pins to know about:**
- **NestJS add-on packages are pinned to v11-compatible majors** (`config@4`, `jwt@11`, `passport@11`, `swagger@11`). By default `pnpm add` picked v12 releases, which require `@nestjs/core@12`, and your core is 11.
- **`@nestjs/typeorm` was downgraded from 12 to 11.0.3.** v12 is ESM-only, and Jest couldn't load it. v11 officially supports TypeORM 1.x (`^1.0.0-dev` peer).
- **TypeORM is 1.1.3.** The API used here (`Repository`, `QueryBuilder`, `.relation().of().add()`, `existsBy`) behaves like 0.3.x.
- **`pnpm-workspace.yaml` `allowBuilds`:**
  - `@parcel/watcher: true` (the Nest CLI watcher)
  - `argon2: true` (native addon)
  - `@scarf/scarf: false` (a telemetry postinstall script pulled in by swagger-ui; deliberately blocked)

**TypeScript gotcha:** the tsconfig enables `isolatedModules` and `emitDecoratorMetadata`. A type-only import used in a decorated parameter must therefore be written `import { type AuthUser }`, or the build fails with TS1272. Every controller already does this.

---

## 9. Choices already made in the scaffold (review these)

None of these are from `plan.md` §2, but each is a decision. Change any you disagree with.

1. **404, not 403, for other users' resources.** This avoids leaking that a resource exists.
2. **Emails are lower-cased** in `UsersService` before storage and lookup. Uniqueness is enforced by the DB constraint (register catches 23505 and returns 409) rather than by a check-then-insert.
3. **Login errors don't reveal which part was wrong.** The same 401 is returned for an unknown email or a wrong password. There is no rate limiting or lockout yet.
4. **The JWT strategy loads the user on every request.** This rejects tokens for users that have been deleted, at the cost of one DB hit per request.
5. **`originalUrl` is immutable.** It is stored exactly as submitted and is not accepted by `PATCH`.
6. **URL validation only checks shape:** http/https and at most 2048 characters. It does **no** SSRF or private-IP protection. That belongs to your ingestion fetcher (§2A).
7. **Attach is `PUT` and idempotent.** A duplicate PK on the join table counts as success.
8. **`isRead: true` sets `readAt` only if it is null**, so it keeps the original read time. `isRead: false` clears it.
9. **List pagination:**
   - Offset-based, with `limit ≤ 100`.
   - `b.id` is a tiebreaker in the sort, so pages are stable.
   - `tagId` and `collectionId` filters use `EXISTS` subqueries, so the joined `tags` array on each item stays complete.
10. **Tag and collection names are trimmed.** Tag names are case-sensitive, so "Postgres" and "postgres" are different tags.
11. **No collection-name uniqueness.**

---

## 10. Where your hand-coded work starts

Search the code for `HAND-CODE`. Each seam is listed here in the order of `plan.md` §4:

| Step (plan.md §4) | Start here |
|---|---|
| 1. Domain & invariants | `src/bookmarks/bookmark.entity.ts` (doc comment). Decide on the resource identity model, the processing-state column, and the content/metadata tables. |
| 3. URL ingestion | Create a new `src/ingestion/` module. Hook it up in `BookmarksService.create` (HAND-CODE comment). Implement `BookmarkIdentityService.canonicalize()` and add the `canonical_url` unique constraint. |
| 4. Async processing | Redis isn't provisioned yet: run one locally, then install `bullmq` / `@nestjs/bullmq` and register queues; the business rules are yours. |
| 2C. Concurrency | `BookmarksService.update` and `NotesService.update` (both read-modify-write today). Collection and tag ownership integrity is in `collection.entity.ts`. |
| 5. Chunking/embeddings | Enable `vector` in a migration and add chunk tables. |
| 6–8. Retrieval, agent, reliability | Nothing exists yet. |

**Suggested new modules** (same conventions as §3):
- `src/ingestion/`
- `src/jobs/` (or `src/queue/`)
- `src/indexing/` (chunking + embeddings)
- `src/retrieval/`
- `src/assistant/` (tools + conversations)

---

## 11. Current state of the repo

- **Git:** nothing is committed. Everything is untracked on `main`, which has no commits yet.
- **Local DB:** the `mastiskadb` database in your `postgres` container (port 5432). The migration has been applied, and the DB contains test users and bookmarks left by the e2e runs.
- **Clean slate:** drop and recreate `mastiskadb`, then run `pnpm migration:run`.
- **Ignored files:** `.env` is git-ignored. `.env.example` is safe to commit.
