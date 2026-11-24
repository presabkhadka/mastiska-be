// Rate limits would otherwise cap how many turns a test user can send.
import './support/no-assistant-rate-limit';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import {
  GeminiContent,
  GeminiGenerator,
  GenerateResult,
} from '../src/answer/gemini-generator';
import { AppModule } from '../src/app.module';
import type { TurnView } from '../src/assistant/assistant.service';
import { configureApp } from '../src/app.setup';
import { GeminiEmbedder } from '../src/embedding/gemini-embedder';
import { UsersService } from '../src/users/users.service';

type Body = {
  contents: GeminiContent[];
  toolConfig: { functionCallingConfig: { mode: string } };
};
type Opts = { models?: string[] };
type Step = (body: Body, opts: Opts) => GeminiContent;

/** Scripted stand-in for Gemini: each call consumes the next step. */
class FakeGenerator {
  steps: Step[] = [];
  calls: { body: Body; opts: Opts }[] = [];

  script(...steps: Step[]) {
    this.steps = steps;
    this.calls = [];
  }

  generateContent(
    body: Body,
    opts: Opts = {},
  ): Promise<GenerateResult<GeminiContent>> {
    this.calls.push({ body: structuredClone(body), opts });
    const step = this.steps.shift();
    if (!step)
      return Promise.reject(new Error('fake generator: no scripted step left'));
    try {
      return Promise.resolve({
        value: step(body, opts),
        model: opts.models?.[0] ?? 'fake-model',
        latencyMs: 1,
        usage: { totalTokenCount: 100 },
      });
    } catch (err) {
      return Promise.reject(err as Error);
    }
  }
}

const text =
  (t: string): Step =>
  () => ({ role: 'model', parts: [{ text: t }] });
const callTool =
  (
    name: string,
    args: Record<string, unknown>,
    id = `call-${randomUUID()}`,
  ): Step =>
  () => ({
    role: 'model',
    parts: [{ functionCall: { id, name, args }, thoughtSignature: 'sig' }],
  });

describe('Assistant (e2e, scripted model)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  const fake = new FakeGenerator();
  const users: string[] = [];
  let tokenA: string;
  let tokenB: string;
  let bookmarkA1: string;
  let bookmarkA2: string;
  let bookmarkB: string;
  let userAId: string;

  const http = () => request(app.getHttpServer());
  const turn = (res: request.Response) => res.body as TurnView;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function user(): Promise<{ id: string; token: string }> {
    const u = await app.get(UsersService).create({
      email: `assistant-e2e-${randomUUID()}@example.com`,
      passwordHash: 'x',
    });
    users.push(u.id);
    const token = await app
      .get(JwtService)
      .signAsync({ sub: u.id, email: u.email });
    return { id: u.id, token };
  }

  async function bookmark(userId: string, title: string): Promise<string> {
    const url = `https://example.com/${randomUUID()}`;
    const [row] = await db.query<{ id: string }[]>(
      `INSERT INTO bookmarks (user_id, original_url, canonical_url, title, processing_state)
       VALUES ($1, $2, $2, $3, 'ready') RETURNING id`,
      [userId, url, title],
    );
    return row.id;
  }

  async function conversation(token: string): Promise<string> {
    const res = await http()
      .post('/conversations')
      .set(auth(token))
      .send({})
      .expect(201);
    return (res.body as { id: string }).id;
  }

  const send = (
    token: string,
    conv: string,
    content: string,
    clientMessageId?: string,
  ) =>
    http()
      .post(`/conversations/${conv}/messages`)
      .set(auth(token))
      .send({ content, ...(clientMessageId ? { clientMessageId } : {}) });

  const collectionsNamed = async (userId: string, name: string) =>
    db.query<{ id: string; n: number }[]>(
      `SELECT c.id, count(bc.bookmark_id)::int AS n FROM collections c
       LEFT JOIN bookmark_collections bc ON bc.collection_id = c.id
       WHERE c.user_id = $1 AND c.name = $2 GROUP BY c.id`,
      [userId, name],
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GeminiGenerator)
      .useValue(fake)
      // searchLibrary falls back to keyword search; no embedding quota used.
      .overrideProvider(GeminiEmbedder)
      .useValue({
        model: 'fake',
        embedQuery: () => Promise.reject(new Error('offline')),
      })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get<DataSource>(getDataSourceToken());

    const a = await user();
    const b = await user();
    tokenA = a.token;
    tokenB = b.token;
    bookmarkA1 = await bookmark(a.id, 'Idempotence');
    bookmarkA2 = await bookmark(a.id, 'Finite-state machine');
    bookmarkB = await bookmark(b.id, 'Someone else');
    userAId = a.id;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [users]);
    await app.close();
  });

  it('answers directly when the model needs no tools', async () => {
    fake.script(text('Hello!'));
    const conv = await conversation(tokenA);
    const res = await send(tokenA, conv, 'hi').expect(200);
    expect(turn(res)).toMatchObject({
      run: { status: 'completed', steps: 1, toolCallCount: 0 },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'Hello!' },
      ],
    });
  });

  it('runs a read tool and returns its result to the model with the call id', async () => {
    fake.script(
      callTool('getResource', { bookmarkId: bookmarkA1 }, 'call-1'),
      text('It is about idempotence.'),
    );
    const conv = await conversation(tokenA);
    const res = await send(tokenA, conv, 'tell me about it').expect(200);

    expect(turn(res).toolCalls).toEqual([
      expect.objectContaining({ name: 'getResource', status: 'succeeded' }),
    ]);
    const second = fake.calls[1].body.contents;
    expect(second.at(-2)?.parts[0].thoughtSignature).toBe('sig');
    expect(second.at(-1)?.parts[0].functionResponse).toMatchObject({
      id: 'call-1',
      name: 'getResource',
      response: { result: { title: 'Idempotence' } },
    });
  });

  it('rejects invalid arguments and reports the error to the model', async () => {
    fake.script(
      callTool('getResource', { bookmarkId: 'nope', userId: 'x' }),
      text('Sorry.'),
    );
    const conv = await conversation(tokenA);
    const res = await send(tokenA, conv, 'q').expect(200);
    const [call] = turn(res).toolCalls as { status: string; error: string }[];
    expect(call.status).toBe('invalid');
    expect(call.error).toContain('property userId should not exist');
    expect(call.error).toContain('bookmarkId must be a UUID');
    expect(
      fake.calls[1].body.contents.at(-1)?.parts[0].functionResponse?.response,
    ).toHaveProperty('error');
  });

  it("can't read another user's bookmark through a tool", async () => {
    fake.script(
      callTool('getResource', { bookmarkId: bookmarkB }),
      text('Not found.'),
    );
    const conv = await conversation(tokenA);
    const res = await send(tokenA, conv, 'q').expect(200);
    expect(turn(res).toolCalls[0]).toMatchObject({
      status: 'failed',
      error: 'Bookmark not found',
    });
  });

  it('pauses writes for approval, runs them once, and continues', async () => {
    const name = `Approved ${randomUUID()}`;
    fake.script(
      callTool('createCollection', {
        name,
        bookmarkIds: [bookmarkA1, bookmarkA2],
      }),
      text('Done.'),
    );
    const conv = await conversation(tokenA);
    const paused = await send(tokenA, conv, 'make a collection').expect(200);
    expect(turn(paused).run.status).toBe('awaiting_approval');
    expect(turn(paused).pendingApprovals[0].summary).toContain('"Idempotence"');
    expect(await collectionsNamed(userAId, name)).toHaveLength(0);

    await send(tokenA, conv, 'another message').expect(409);

    const callId = turn(paused).pendingApprovals[0].toolCallId;
    const approve = () =>
      http()
        .post(`/conversations/${conv}/tool-calls/${callId}/approve`)
        .set(auth(tokenA));
    const [r1, r2] = await Promise.all([approve(), approve()]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    await approve().expect(200);

    const resumed =
      fake.calls[1].body.contents.at(-1)?.parts[0].functionResponse;
    expect(resumed?.response).toMatchObject({
      outcome: expect.stringContaining('approved') as unknown,
    });

    const created = await collectionsNamed(userAId, name);
    expect(created).toEqual([{ id: expect.any(String) as unknown, n: 2 }]);
    const done = await http()
      .get(`/conversations/${conv}`)
      .set(auth(tokenA))
      .expect(200);
    expect(
      (done.body as { messages: TurnView['messages'] }).messages.at(-1),
    ).toMatchObject({
      role: 'assistant',
      content: 'Done.',
    });
  });

  it('a rejected write never runs and the model is told', async () => {
    const name = `Rejected ${randomUUID()}`;
    fake.script(
      callTool('createCollection', { name }),
      text('Okay, not created.'),
    );
    const conv = await conversation(tokenA);
    const paused = await send(tokenA, conv, 'make one').expect(200);
    const callId = turn(paused).pendingApprovals[0].toolCallId;

    const res = await http()
      .post(`/conversations/${conv}/tool-calls/${callId}/reject`)
      .set(auth(tokenA))
      .expect(200);
    expect(turn(res).run.status).toBe('completed');
    expect(await collectionsNamed(userAId, name)).toHaveLength(0);
    expect(JSON.stringify(fake.calls[1].body.contents.at(-1))).toContain(
      'rejected',
    );
    await http()
      .post(`/conversations/${conv}/tool-calls/${callId}/approve`)
      .set(auth(tokenA))
      .expect(409);
  });

  it('reuses a write the model repeats within the same turn', async () => {
    const name = `Repeated ${randomUUID()}`;
    fake.script(
      callTool('createCollection', { name }),
      callTool('createCollection', { name }),
      text('Done.'),
    );
    const conv = await conversation(tokenA);
    const paused = await send(tokenA, conv, 'make one').expect(200);
    const callId = turn(paused).pendingApprovals[0].toolCallId;
    const res = await http()
      .post(`/conversations/${conv}/tool-calls/${callId}/approve`)
      .set(auth(tokenA))
      .expect(200);
    expect(turn(res).run.status).toBe('completed');
    expect(turn(res).toolCalls[1]).toMatchObject({
      status: 'succeeded',
      result: { note: expect.any(String) as unknown },
    });
    expect(await collectionsNamed(userAId, name)).toHaveLength(1);
  });

  it('returns the original run for a retried clientMessageId', async () => {
    fake.script(text('Once.'));
    const conv = await conversation(tokenA);
    const first = await send(tokenA, conv, 'hi', 'client-1').expect(200);
    const again = await send(tokenA, conv, 'hi', 'client-1').expect(200);
    expect(turn(again).run.id).toBe(turn(first).run.id);
    expect(fake.calls).toHaveLength(1);
  });

  it('forces a final answer at the step limit and stops a model that ignores it', async () => {
    fake.script(
      ...Array.from({ length: 6 }, () =>
        callTool('searchLibrary', { query: 'x' }),
      ),
    );
    const conv = await conversation(tokenA);
    const res = await send(tokenA, conv, 'loop forever').expect(200);
    expect(turn(res).run).toMatchObject({ status: 'limit_exceeded', steps: 6 });
    expect(
      fake.calls.map((c) => c.body.toolConfig.functionCallingConfig.mode),
    ).toEqual(['AUTO', 'AUTO', 'AUTO', 'AUTO', 'AUTO', 'NONE']);
  });

  it('continues on another model as plain text when the pinned model fails mid-run', async () => {
    fake.script(
      callTool('getResource', { bookmarkId: bookmarkA1 }),
      () => {
        throw new Error('HTTP 503');
      },
      text('Recovered.'),
    );
    const conv = await conversation(tokenA);
    const res = await send(tokenA, conv, 'q').expect(200);
    expect(turn(res).run.status).toBe('completed');
    expect(fake.calls[1].opts.models).toEqual(['fake-model']);
    expect(fake.calls[2].opts.models).toBeUndefined();
    const parts = fake.calls[2].body.contents.flatMap((c) => c.parts);
    expect(
      parts.some(
        (p) => p.functionCall || p.functionResponse || p.thoughtSignature,
      ),
    ).toBe(false);
    expect(JSON.stringify(parts)).toContain('[called getResource');
  });

  it("hides other users' conversations", async () => {
    fake.script(text('mine'));
    const conv = await conversation(tokenA);
    await send(tokenA, conv, 'hi').expect(200);
    await http().get(`/conversations/${conv}`).set(auth(tokenB)).expect(404);
    await send(tokenB, conv, 'hi').expect(404);
  });
});
