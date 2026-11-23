# Read Later

A read-it-later service with an AI research assistant. NestJS 11, TypeORM 1.x, PostgreSQL (pgvector), Redis.

See `plan.md` for the build plan and `HANDCODE.md` for what is scaffolded versus left to implement by hand.

## Setup

```bash
pnpm install
cp .env.example .env          # set JWT_SECRET (≥32 chars)
pnpm db:up                    # Postgres on :5433, Redis on :6379
pnpm migration:run
pnpm dev                      # http://localhost:3000, Swagger at /docs
```

## Scripts

| Command | |
|---|---|
| `pnpm test` | Unit tests (mocked repositories) |
| `pnpm test:e2e` | API tests against the real DB from `.env` (needs `db:up` + `migration:run`) |
| `pnpm migration:generate src/database/migrations/<Name>` | Diff entities against the DB and write a migration |
| `pnpm migration:create src/database/migrations/<Name>` | Empty migration (for hand-written SQL) |
| `pnpm migration:run` / `migration:revert` | Apply / roll back |

`synchronize` is off. Every schema change goes through a migration.

## API

All routes need `Authorization: Bearer <token>` except `/auth/register`, `/auth/login` and `/health`.

- `POST /auth/register`, `POST /auth/login`, `GET /auth/me`
- `/bookmarks`: CRUD. List filters: `tagId`, `collectionId`, `isArchived`, `isFavorite`, `savedAfter`, `savedBefore`, `sortBy`, `order`, `page`, `limit`
- `PUT|DELETE /bookmarks/:id/tags/:tagId`
- `/tags`: CRUD
- `/collections`: CRUD. `PUT|DELETE /collections/:id/bookmarks/:bookmarkId`
- `/bookmarks/:bookmarkId/notes`: CRUD
