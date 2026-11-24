import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { GeminiEmbedder } from '../embedding/gemini-embedder';
import { RetrievalService } from './retrieval.service';

const row = (chunkId: string, extra: Record<string, unknown> = {}) => ({
  chunkId,
  bookmarkId: `bm-${chunkId}`,
  position: 0,
  section: null,
  content: `content ${chunkId}`,
  contentHash: chunkId,
  title: 'T',
  url: 'https://x.dev/a',
  ...extra,
});

describe('RetrievalService', () => {
  let service: RetrievalService;
  const txQuery = jest.fn<Promise<unknown>, [string, unknown[]?]>();
  const dataSource = {
    query: jest.fn<Promise<unknown>, [string, unknown[]]>(),
    transaction: jest.fn(
      (cb: (m: { query: typeof txQuery }) => Promise<unknown>) =>
        cb({ query: txQuery }),
    ),
  };
  const embedder = { model: 'm', embedQuery: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    dataSource.transaction.mockImplementation((cb) => cb({ query: txQuery }));
    embedder.embedQuery.mockResolvedValue([0.6, 0.8]);
    txQuery.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.startsWith('SET') ? [] : [row('v1', { distance: '0.2' })],
      ),
    );
    dataSource.query.mockResolvedValue([row('t1')]);
    const mod = await Test.createTestingModule({
      providers: [
        RetrievalService,
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: GeminiEmbedder, useValue: embedder },
      ],
    }).compile();
    service = mod.get(RetrievalService);
  });

  const vectorCall = () =>
    txQuery.mock.calls.find(([sql]) => sql.includes('<=>'))!;

  it('hybrid: merges both legs and reports similarity for vector hits', async () => {
    const res = await service.search('u1', {
      q: 'turnstile',
      mode: 'hybrid',
      limit: 10,
    });
    expect(res.degraded).toBe(false);
    expect(res.results.map((r) => r.chunkId)).toEqual(['v1', 't1']);
    expect(res.results[0]).toMatchObject({
      similarity: 0.8,
      matchedBy: ['vector'],
    });
    expect(res.results[1]).toMatchObject({
      similarity: null,
      matchedBy: ['text'],
    });
  });

  it('scopes both legs to the user and to ready bookmarks', async () => {
    await service.search('u1', { q: 'x', mode: 'hybrid', limit: 10 });
    const [vectorSql, vectorParams] = vectorCall();
    const [textSql, textParams] = dataSource.query.mock.calls[0];
    for (const [sql, params] of [
      [vectorSql, vectorParams],
      [textSql, textParams],
    ] as [string, unknown[]][]) {
      expect(sql).toContain('b.user_id = $2');
      expect(sql).toContain(`b.processing_state = 'ready'`);
      expect(params[1]).toBe('u1');
    }
    expect(txQuery).toHaveBeenCalledWith(
      'SET LOCAL hnsw.iterative_scan = relaxed_order',
    );
  });

  it('adds filters as bound parameters', async () => {
    await service.search('u1', {
      q: 'x',
      mode: 'text',
      limit: 10,
      collectionId: 'c-1',
      tagId: 't-1',
      domain: 'wikipedia.org',
      savedAfter: new Date('2026-01-01'),
    });
    const [sql, params] = dataSource.query.mock.calls[0];
    expect(sql).toContain('bookmark_collections');
    expect(sql).toContain('bookmark_tags');
    expect(sql).toContain('b.created_at >=');
    expect(sql).toContain(`LIKE '%.' ||`);
    expect(params).toEqual(
      expect.arrayContaining(['c-1', 't-1', 'wikipedia.org']),
    );
    expect(sql).not.toContain('wikipedia.org');
  });

  it('text mode never calls the embedder', async () => {
    await service.search('u1', { q: 'x', mode: 'text', limit: 10 });
    expect(embedder.embedQuery).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('hybrid degrades to keyword results when embedding fails', async () => {
    embedder.embedQuery.mockRejectedValue(new Error('Gemini HTTP 429'));
    const res = await service.search('u1', {
      q: 'x',
      mode: 'hybrid',
      limit: 10,
    });
    expect(res.degraded).toBe(true);
    expect(res.results.map((r) => r.chunkId)).toEqual(['t1']);
  });

  it('vector mode returns 503 when embedding fails', async () => {
    embedder.embedQuery.mockRejectedValue(new Error('down'));
    await expect(
      service.search('u1', { q: 'x', mode: 'vector', limit: 10 }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('caches query embeddings', async () => {
    await service.search('u1', { q: 'same', mode: 'vector', limit: 10 });
    await service.search('u1', { q: 'same', mode: 'vector', limit: 10 });
    expect(embedder.embedQuery).toHaveBeenCalledTimes(1);
  });
});
