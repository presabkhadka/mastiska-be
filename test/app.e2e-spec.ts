import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

/**
 * Runs against the real database from .env (run `pnpm migration:run` first).
 * Each run registers fresh users, so it doesn't need a clean DB.
 */
describe('Mastiska API (e2e)', () => {
  let app: INestApplication<App>;
  let http: () => ReturnType<typeof request>;
  let tokenA: string;
  let tokenB: string;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function register(): Promise<string> {
    const email = `e2e-${randomUUID()}@example.com`;
    await http()
      .post('/auth/register')
      .send({ email, password: 'password123' })
      .expect(201);
    const res = await http()
      .post('/auth/login')
      .send({ email, password: 'password123' })
      .expect(200);
    return (res.body as { accessToken: string }).accessToken;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    http = () => request(app.getHttpServer());
    tokenA = await register();
    tokenB = await register();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health is public', () =>
    http().get('/health').expect(200, { status: 'ok', db: 'up' }));

  it('rejects unauthenticated requests', () =>
    http().get('/bookmarks').expect(401));

  it('rejects duplicate registration with 409', async () => {
    const email = `e2e-${randomUUID()}@example.com`;
    const body = { email, password: 'password123' };
    await http().post('/auth/register').send(body).expect(201);
    await http()
      .post('/auth/register')
      .send({ ...body, email: email.toUpperCase() })
      .expect(409);
  });

  it('validates input and strips unknown fields', async () => {
    await http()
      .post('/bookmarks')
      .set(auth(tokenA))
      .send({ url: 'not-a-url' })
      .expect(400);
    await http()
      .post('/bookmarks')
      .set(auth(tokenA))
      .send({ url: 'https://example.com', userId: randomUUID() })
      .expect(400);
  });

  it('full bookmark / tag / collection / note flow with ownership checks', async () => {
    const bm = await http()
      .post('/bookmarks')
      .set(auth(tokenA))
      .send({ url: 'https://example.com/post', title: 'A post' })
      .expect(201);
    const bookmarkId = (bm.body as { id: string }).id;
    await http()
      .post('/bookmarks')
      .set(auth(tokenA))
      .send({ url: 'https://example.com/other' })
      .expect(201);

    const tag = await http()
      .post('/tags')
      .set(auth(tokenA))
      .send({ name: 'postgres' })
      .expect(201);
    const tagId = (tag.body as { id: string }).id;
    await http()
      .post('/tags')
      .set(auth(tokenA))
      .send({ name: 'postgres' })
      .expect(409);

    // Idempotent attach
    await http()
      .put(`/bookmarks/${bookmarkId}/tags/${tagId}`)
      .set(auth(tokenA))
      .expect(204);
    await http()
      .put(`/bookmarks/${bookmarkId}/tags/${tagId}`)
      .set(auth(tokenA))
      .expect(204);

    const col = await http()
      .post('/collections')
      .set(auth(tokenA))
      .send({ name: 'Reading list' })
      .expect(201);
    const collectionId = (col.body as { id: string }).id;
    await http()
      .put(`/collections/${collectionId}/bookmarks/${bookmarkId}`)
      .set(auth(tokenA))
      .expect(204);

    await http()
      .post(`/bookmarks/${bookmarkId}/notes`)
      .set(auth(tokenA))
      .send({ body: 'Great section on MVCC' })
      .expect(201);

    // Filters
    const byTag = await http()
      .get('/bookmarks')
      .query({ tagId })
      .set(auth(tokenA))
      .expect(200);
    expect(byTag.body).toMatchObject({
      meta: { total: 1, page: 1 },
      items: [{ id: bookmarkId, tags: [{ id: tagId }] }],
    });
    const byCollection = await http()
      .get('/bookmarks')
      .query({ collectionId, limit: 1 })
      .set(auth(tokenA))
      .expect(200);
    expect(byCollection.body).toMatchObject({ meta: { total: 1, limit: 1 } });

    const all = await http()
      .get('/bookmarks')
      .query({ limit: 1, sortBy: 'createdAt', order: 'ASC' })
      .set(auth(tokenA))
      .expect(200);
    expect(all.body).toMatchObject({
      meta: { total: 2, totalPages: 2 },
      items: [{ id: bookmarkId }],
    });

    // Mark read
    const upd = await http()
      .patch(`/bookmarks/${bookmarkId}`)
      .set(auth(tokenA))
      .send({ isRead: true, isFavorite: true })
      .expect(200);
    expect(upd.body).toMatchObject({ isFavorite: true });
    expect((upd.body as { readAt: string | null }).readAt).not.toBeNull();

    // User B can't see or touch user A's data
    await http().get(`/bookmarks/${bookmarkId}`).set(auth(tokenB)).expect(404);
    await http()
      .get(`/bookmarks/${bookmarkId}/notes`)
      .set(auth(tokenB))
      .expect(404);
    await http()
      .patch(`/bookmarks/${bookmarkId}`)
      .set(auth(tokenB))
      .send({ title: 'hijack' })
      .expect(404);
    const listB = await http().get('/bookmarks').set(auth(tokenB)).expect(200);
    expect(listB.body).toMatchObject({ meta: { total: 0 } });

    // B can't attach A's tag to B's bookmark
    const bmB = await http()
      .post('/bookmarks')
      .set(auth(tokenB))
      .send({ url: 'https://example.com/b' })
      .expect(201);
    await http()
      .put(`/bookmarks/${(bmB.body as { id: string }).id}/tags/${tagId}`)
      .set(auth(tokenB))
      .expect(404);

    // Delete cascades notes
    await http()
      .delete(`/bookmarks/${bookmarkId}`)
      .set(auth(tokenA))
      .expect(204);
    await http()
      .get(`/bookmarks/${bookmarkId}/notes`)
      .set(auth(tokenA))
      .expect(404);
  });

  it('enforces collection names, note versions and link ownership', async () => {
    const created = await http()
      .post('/collections')
      .set(auth(tokenA))
      .send({ name: 'Postgres internals' })
      .expect(201);
    await http()
      .post('/collections')
      .set(auth(tokenA))
      .send({ name: '  postgres INTERNALS ' })
      .expect(409);
    const other = await http()
      .post('/collections')
      .set(auth(tokenA))
      .send({ name: 'Queues' })
      .expect(201);
    await http()
      .patch(`/collections/${(other.body as { id: string }).id}`)
      .set(auth(tokenA))
      .send({ name: 'POSTGRES internals' })
      .expect(409);
    // Another user may reuse the name.
    await http()
      .post('/collections')
      .set(auth(tokenB))
      .send({ name: 'Postgres internals' })
      .expect(201);

    const bm = await http()
      .post('/bookmarks')
      .set(auth(tokenA))
      .send({ url: `https://example.com/${randomUUID()}` })
      .expect(201);
    const bookmarkId = (bm.body as { id: string }).id;
    const note = await http()
      .post(`/bookmarks/${bookmarkId}/notes`)
      .set(auth(tokenA))
      .send({ body: 'v1' })
      .expect(201);
    const noteId = (note.body as { id: string; version: number }).id;
    expect(note.body).toMatchObject({ version: 1 });
    const notePath = `/bookmarks/${bookmarkId}/notes/${noteId}`;
    const v2 = await http()
      .patch(notePath)
      .set(auth(tokenA))
      .send({ body: 'v2', version: 1 })
      .expect(200);
    expect(v2.body).toMatchObject({ body: 'v2', version: 2 });
    await http()
      .patch(notePath)
      .set(auth(tokenA))
      .send({ body: 'stale edit', version: 1 })
      .expect(409);
    await http()
      .patch(notePath)
      .set(auth(tokenA))
      .send({ body: 'no version' })
      .expect(400);
    await http()
      .patch(`/bookmarks/${bookmarkId}/notes/${randomUUID()}`)
      .set(auth(tokenA))
      .send({ body: 'x', version: 1 })
      .expect(404);
    const notes = await http()
      .get(`/bookmarks/${bookmarkId}/notes`)
      .set(auth(tokenA))
      .expect(200);
    expect(notes.body).toMatchObject([{ body: 'v2', version: 2 }]);

    // The DB itself rejects a link between different owners' rows.
    const tagB = await http()
      .post('/tags')
      .set(auth(tokenB))
      .send({ name: `t-${randomUUID().slice(0, 8)}` })
      .expect(201);
    const tagBId = (tagB.body as { id: string }).id;
    const db = app.get(DataSource);
    const [{ user_id: ownerA }] = await db.query<{ user_id: string }[]>(
      'SELECT user_id FROM bookmarks WHERE id = $1',
      [bookmarkId],
    );
    for (const owner of [ownerA, null]) {
      await expect(
        db.query(
          'INSERT INTO bookmark_tags (bookmark_id, tag_id, user_id) VALUES ($1, $2, $3)',
          [bookmarkId, tagBId, owner],
        ),
      ).rejects.toThrow(/foreign key|null value/);
    }
    await expect(
      db.query(
        'INSERT INTO bookmark_collections (bookmark_id, collection_id, user_id) SELECT $1, id, user_id FROM collections WHERE id = $2',
        [bookmarkId, (created.body as { id: string }).id],
      ),
    ).resolves.toBeDefined();
  });
});
