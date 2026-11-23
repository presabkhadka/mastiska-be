# Hand-code map

The routine plumbing from `plan.md` §1 is scaffolded. This file lists every place
where the scaffold stops on purpose and the decision belongs to you.
Search the code for `HAND-CODE` to find each one.

## Seams in existing code

| Where | What to decide | plan.md |
|---|---|---|
| `src/bookmarks/bookmark-identity.service.ts` | URL normalization rules. `canonicalize()` currently returns its input unchanged. | §2A, §2C |
| `src/bookmarks/bookmark.entity.ts` | Identity model (per-user vs shared resource), the unique constraint on `canonical_url`, and the processing-state column with its legal transitions. | §2A, §2C |
| `BookmarksService.create` | What a duplicate save means and how to enforce it under concurrent requests. Also where ingestion gets enqueued. | §2A, §2B |
| `BookmarksService.update` | Plain read-modify-write today. Decide versioning or column ownership once ingestion also writes to the row. | §2C |
| `NotesService.update` | Last-write-wins. Optionally add an optimistic version check. | §2C |
| `src/collections/collection.entity.ts` | Name uniqueness, and whether the DB (not only the service) guarantees that a bookmark and its collection or tag share an owner. Today the service checks ownership and then inserts; a concurrent delete in between surfaces as an FK error (500). | §2C, §3 |

## Not started (nothing scaffolded)

- **Ingestion pipeline** (§2A): safe fetching (SSRF, size, timeouts, redirects), extraction, metadata.
- **Jobs** (§2B): Redis isn't provisioned yet; BullMQ isn't installed or registered.
- **Chunking and embeddings** (§2D): your Postgres container uses the `pgvector/pgvector:pg18` image. Run `CREATE EXTENSION vector` in your first migration that needs it.
- **Retrieval and RAG** (§2E), **tool orchestration** (§2F), **observability** (§2G).

## Things already decided in the scaffold (review them)

- A bookmark owned by another user returns **404**, not 403, so existence isn't leaked.
- Emails are stored lower-cased and are unique at the DB level. Register relies on the constraint rather than a check-then-insert.
- Tag/collection attach is `PUT` and idempotent: a unique violation on the join-table PK counts as success.
- `originalUrl` is immutable. `UpdateBookmarkDto` does not accept a URL.
- Notes have no `user_id`. Ownership comes from the parent bookmark.
- Deleting a user cascades to everything they own. Deleting a bookmark cascades to its notes and join rows.
