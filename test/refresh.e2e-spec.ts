import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { GeminiEmbedder } from '../src/embedding/gemini-embedder';
import { SafeFetcher } from '../src/ingestion/fetch/safe-fetcher';
import { IngestionService } from '../src/ingestion/ingestion.service';
import { IngestionQueue } from '../src/ingestion/queue/ingestion-queue.service';
import { UsersService } from '../src/users/users.service';

interface Page {
  status: number;
  body: string;
  etag?: string;
}

const article = (text: string) =>
  `<html><head><title>Refresh test</title></head><body><article><h1>Refresh test</h1>
   <p>${text} ${'This paragraph adds enough words for readability to treat it as an article. '.repeat(6)}</p>
   </article></body></html>`;

const unitVector = () => {
  const v = Array.from({ length: 768 }, () => Math.random() - 0.5);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

describe('Content refresh (e2e, local pages)', () => {
  jest.setTimeout(30_000);

  let app: INestApplication<App>;
  let db: DataSource;
  let server: Server;
  let base: string;
  const pages = new Map<string, Page>();
  const requests: { path: string; ifNoneMatch?: string }[] = [];
  const users: string[] = [];
  let tokenA: string;
  let tokenB: string;
  let userA: string;
  let userB: string;

  const http = () => request(app.getHttpServer());
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function user() {
    const u = await app.get(UsersService).create({
      email: `refresh-e2e-${randomUUID()}@example.com`,
      passwordHash: 'x',
    });
    users.push(u.id);
    const token = await app
      .get(JwtService)
      .signAsync({ sub: u.id, email: u.email });
    return { id: u.id, token };
  }

  async function waitFor<T>(
    read: () => Promise<T>,
    done: (v: T) => boolean,
    what: string,
  ): Promise<T> {
    for (let i = 0; i < 100; i++) {
      const v = await read();
      if (done(v)) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  const bookmark = (token: string, id: string) =>
    http()
      .get(`/bookmarks/${id}`)
      .set(auth(token))
      .then((r) => r.body as { processingState: string; autoRefresh: boolean });
  const content = (token: string, id: string) =>
    http()
      .get(`/bookmarks/${id}/content`)
      .set(auth(token))
      .then(
        (r) =>
          r.body as {
            textContent: string;
            checkedAt: string | null;
            nextCheckAt: string | null;
            contentChangedAt: string | null;
            refreshIntervalHours: number;
            lastRefreshError: string | null;
          },
      );

  async function save(token: string, path: string, page: Page) {
    pages.set(path, page);
    const res = await http()
      .post('/bookmarks')
      .set(auth(token))
      .send({ url: `${base}${path}` })
      .expect(201);
    const id = (res.body as { id: string }).id;
    await waitFor(
      () => bookmark(token, id),
      (b) => ['ready', 'unsupported', 'failed'].includes(b.processingState),
      `${path} to finish ingestion`,
    );
    return id;
  }

  const chunkIds = (id: string) =>
    db
      .query<{ id: string; embedded: boolean }[]>(
        'SELECT id, embedding IS NOT NULL AS embedded FROM bookmark_chunks WHERE bookmark_id = $1 ORDER BY position',
        [id],
      )
      .then((rows) => rows);

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = req.url ?? '/';
      requests.push({
        path,
        ifNoneMatch: req.headers['if-none-match'],
      });
      const page = pages.get(path) ?? { status: 404, body: 'gone' };
      if (page.etag && req.headers['if-none-match'] === page.etag) {
        res.writeHead(304).end();
        return;
      }
      res
        .writeHead(page.status, {
          'content-type': 'text/html; charset=utf-8',
          ...(page.etag && { etag: page.etag }),
        })
        .end(page.body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SafeFetcher)
      .useValue(
        new SafeFetcher({ allowedPorts: null, isAllowedAddress: () => true }),
      )
      .overrideProvider(GeminiEmbedder)
      .useValue({
        model: 'fake-embedder',
        embedDocuments: (inputs: unknown[]) =>
          Promise.resolve(inputs.map(unitVector)),
        embedQuery: () => Promise.resolve(unitVector()),
      })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get<DataSource>(getDataSourceToken());
    ({ id: userA, token: tokenA } = await user());
    ({ id: userB, token: tokenB } = await user());
  });

  afterAll(async () => {
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [users]);
    await app.close();
    server.close();
  });

  it('auto refresh is off by default and turning it on makes the bookmark due', async () => {
    const id = await save(tokenA, '/default', {
      status: 200,
      body: article('Default.'),
    });
    expect(await bookmark(tokenA, id)).toMatchObject({
      processingState: 'ready',
      autoRefresh: false,
    });
    const before = await content(tokenA, id);
    expect(before.checkedAt).not.toBeNull();
    expect(new Date(before.nextCheckAt!).getTime()).toBeGreaterThan(
      Date.now() + 11 * 3_600_000,
    );

    await http()
      .patch(`/bookmarks/${id}`)
      .set(auth(tokenA))
      .send({ autoRefresh: true })
      .expect(200);
    const after = await content(tokenA, id);
    // Due now (DB clock), not 12h out.
    expect(new Date(after.nextCheckAt!).getTime()).toBeLessThan(
      Date.now() + 60_000,
    );
  });

  it('refresh now: unchanged (304), changed (swapped, stays searchable), and gone (keeps old copy)', async () => {
    const path = '/post';
    const id = await save(tokenA, path, {
      status: 200,
      body: article('Version one.'),
      etag: '"v1"',
    });
    const originalChunks = await chunkIds(id);
    expect(originalChunks.length).toBeGreaterThan(0);
    const refresh = () =>
      http().post(`/bookmarks/${id}/refresh`).set(auth(tokenA)).expect(202);
    const checkedAfter = async (prev: string | null) =>
      waitFor(
        () => content(tokenA, id),
        (c) => c.checkedAt !== prev,
        'refresh to record a check',
      );

    // Unchanged: the server answers 304 to the stored ETag.
    let c = await content(tokenA, id);
    await refresh();
    c = await checkedAfter(c.checkedAt);
    expect(requests.at(-1)).toEqual({ path, ifNoneMatch: '"v1"' });
    expect(c).toMatchObject({
      refreshIntervalHours: 24,
      contentChangedAt: null,
      lastRefreshError: null,
    });
    expect(await chunkIds(id)).toEqual(originalChunks);

    // Changed: new content and chunks, bookmark never leaves ready.
    pages.set(path, {
      status: 200,
      body: article('Version two has new facts.'),
      etag: '"v2"',
    });
    await refresh();
    c = await checkedAfter(c.checkedAt);
    expect(c.textContent).toContain('Version two has new facts.');
    expect(c.contentChangedAt).not.toBeNull();
    expect(c.refreshIntervalHours).toBe(12);
    expect((await bookmark(tokenA, id)).processingState).toBe('ready');
    const embedded = await waitFor(
      () => chunkIds(id),
      (rows) => rows.every((r) => r.embedded),
      'new chunks to be embedded',
    );
    expect(embedded.map((r) => r.id)).not.toEqual(
      originalChunks.map((r) => r.id),
    );

    // Page deleted: old content stays, error recorded, still ready.
    pages.delete(path);
    await refresh();
    c = await checkedAfter(c.checkedAt);
    expect(c.lastRefreshError).toBe('HTTP 404');
    expect(c.textContent).toContain('Version two has new facts.');
    expect((await bookmark(tokenA, id)).processingState).toBe('ready');
  });

  it('refresh is only for ready bookmarks the user owns', async () => {
    const pdf = await save(tokenA, '/doc.pdf', {
      status: 200,
      body: '%PDF',
    });
    expect((await bookmark(tokenA, pdf)).processingState).toBe('unsupported');
    await http()
      .post(`/bookmarks/${pdf}/refresh`)
      .set(auth(tokenA))
      .expect(409);
    const ready = await save(tokenA, '/mine', {
      status: 200,
      body: article('Mine.'),
    });
    await http()
      .post(`/bookmarks/${ready}/refresh`)
      .set(auth(tokenB))
      .expect(404);
  });

  it('the planner takes only due auto-refresh bookmarks, capped per user and per run, round-robin', async () => {
    const make = async (token: string, n: number, auto: boolean) => {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const id = await save(token, `/plan-${randomUUID()}`, {
          status: 200,
          body: article(`Plan page ${i}.`),
        });
        if (auto) {
          await http()
            .patch(`/bookmarks/${id}`)
            .set(auth(token))
            .send({ autoRefresh: true })
            .expect(200);
        }
        ids.push(id);
      }
      return ids;
    };
    // Earlier tests' bookmarks are pushed out of the due window.
    await db.query(
      `UPDATE bookmark_contents c SET next_check_at = now() + interval '1 day'
       FROM bookmarks b WHERE b.id = c.bookmark_id AND b.user_id = ANY($1)`,
      [[userA, userB]],
    );
    const aDue = await make(tokenA, 3, true);
    const [bDue] = await make(tokenB, 1, true);
    const [off] = await make(tokenB, 1, false);
    await db.query(
      `UPDATE bookmark_contents SET next_check_at = now() - interval '1 minute' WHERE bookmark_id = $1`,
      [off],
    );

    const queued: string[][] = [];
    const spy = jest
      .spyOn(app.get(IngestionQueue), 'enqueueScheduledRefreshes')
      .mockImplementation((ids) => {
        queued.push(ids);
        return Promise.resolve();
      });
    try {
      // Other users' due rows may be picked too (shared DB); assertions look only at ours.
      await app.get(IngestionService).planRefreshes(10_000, 2);
      const all = queued.flat();
      expect(all).toContain(bDue);
      expect(all).not.toContain(off);
      const aPicked = all.filter((id) => aDue.includes(id));
      expect(aPicked).toHaveLength(2);
      // Round-robin: every user's first due bookmark comes before anyone's second.
      expect(all.indexOf(bDue)).toBeLessThan(all.indexOf(aPicked[1]));
    } finally {
      spy.mockRestore();
    }
  });
});
