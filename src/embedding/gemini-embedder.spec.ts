import {
  PermanentIngestionError,
  TransientIngestionError,
} from '../ingestion/ingestion-errors';
import { GeminiEmbedder, MAX_BATCH, normalize } from './gemini-embedder';

describe('GeminiEmbedder', () => {
  const fetchMock = jest.fn<Promise<Response>, Parameters<typeof fetch>>();
  const embedder = new GeminiEmbedder({
    apiKey: 'k',
    model: 'gemini-embedding-001',
    dimensions: 3,
  });

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  const json = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  it('sends a RETRIEVAL_DOCUMENT batch and returns normalized vectors', async () => {
    fetchMock.mockReturnValue(
      json(200, {
        embeddings: [{ values: [3, 0, 4] }, { values: [0, 2, 0] }],
      }),
    );
    const out = await embedder.embedDocuments([
      { title: 'T', text: 'a' },
      { title: null, text: 'b' },
    ]);
    expect(out).toEqual([
      [0.6, 0, 0.8],
      [0, 1, 0],
    ]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('models/gemini-embedding-001:batchEmbedContents');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(
      'k',
    );
    const body = JSON.parse(init.body as string) as {
      requests: Record<string, unknown>[];
    };
    expect(body.requests[0]).toEqual({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text: 'a' }] },
      taskType: 'RETRIEVAL_DOCUMENT',
      title: 'T',
      outputDimensionality: 3,
    });
    expect(body.requests[1]).not.toHaveProperty('title');
  });

  it('embeds a query with the RETRIEVAL_QUERY task type and no title', async () => {
    fetchMock.mockReturnValue(
      json(200, { embeddings: [{ values: [0, 0, 2] }] }),
    );
    await expect(embedder.embedQuery('q')).resolves.toEqual([0, 0, 1]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      requests: Record<string, unknown>[];
    };
    expect(body.requests[0]).toMatchObject({ taskType: 'RETRIEVAL_QUERY' });
    expect(body.requests[0]).not.toHaveProperty('title');
  });

  it.each([
    [429, TransientIngestionError],
    [500, TransientIngestionError],
    [403, TransientIngestionError],
    [400, PermanentIngestionError],
  ])('HTTP %i -> %p', async (status, type) => {
    fetchMock.mockReturnValue(json(status, { error: { message: 'x' } }));
    await expect(
      embedder.embedDocuments([{ title: null, text: 'a' }]),
    ).rejects.toBeInstanceOf(type);
  });

  it('treats network errors and malformed responses as transient', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(
      embedder.embedDocuments([{ title: null, text: 'a' }]),
    ).rejects.toBeInstanceOf(TransientIngestionError);

    fetchMock.mockReturnValueOnce(json(200, { embeddings: [{ values: [1] }] }));
    await expect(
      embedder.embedDocuments([{ title: null, text: 'a' }]),
    ).rejects.toThrow('Unexpected embedding response');
  });

  it('fails transiently without a key and never calls the API', async () => {
    const noKey = new GeminiEmbedder({ apiKey: '', model: 'm', dimensions: 3 });
    await expect(
      noKey.embedDocuments([{ title: null, text: 'a' }]),
    ).rejects.toBeInstanceOf(TransientIngestionError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects batches over the API cap', async () => {
    const inputs = Array.from({ length: MAX_BATCH + 1 }, () => ({
      title: null,
      text: 'a',
    }));
    await expect(embedder.embedDocuments(inputs)).rejects.toThrow('exceeds');
  });

  it('normalize leaves a zero vector alone', () => {
    expect(normalize([0, 0])).toEqual([0, 0]);
  });
});
