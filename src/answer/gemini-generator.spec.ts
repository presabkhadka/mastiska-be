import { GeminiGenerator, GenerationError } from './gemini-generator';

describe('GeminiGenerator', () => {
  const fetchMock = jest.fn<Promise<Response>, Parameters<typeof fetch>>();
  const req = { system: 's', prompt: 'p', schema: {} };
  const make = (models: string[]) =>
    new GeminiGenerator({ apiKey: 'k', models, baseDelayMs: 1 });

  const ok = (text: string) =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text }] } }],
          usageMetadata: { totalTokenCount: 3 },
        }),
        { status: 200 },
      ),
    );
  const status = (code: number) =>
    Promise.resolve(new Response('{"error":{}}', { status: code }));
  const modelsCalled = () =>
    (fetchMock.mock.calls as [string, RequestInit][]).map(([url]) =>
      url.replace(/^.*models\/([^:]+):.*$/, '$1'),
    );

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  it('returns parsed JSON from the first model', async () => {
    fetchMock.mockReturnValueOnce(ok('{"a":1}'));
    const res = await make(['m1', 'm2']).generateJson<{ a: number }>(req);
    expect(res).toMatchObject({ value: { a: 1 }, model: 'm1' });
  });

  it.each([400, 403, 404, 429, 503])(
    'HTTP %i from one model falls through to the next',
    async (code) => {
      fetchMock.mockReturnValueOnce(status(code)).mockReturnValueOnce(ok('{}'));
      const res = await make(['m1', 'm2']).generateJson(req);
      expect(res.model).toBe('m2');
      expect(modelsCalled()).toEqual(['m1', 'm2']);
    },
  );

  it('retries a transient 500 on the same model before moving on', async () => {
    fetchMock.mockReturnValueOnce(status(500)).mockReturnValueOnce(ok('{}'));
    const res = await make(['m1', 'm2']).generateJson(req);
    expect(res.model).toBe('m1');
    expect(modelsCalled()).toEqual(['m1', 'm1']);
  });

  it('retries invalid JSON on the same model', async () => {
    fetchMock.mockReturnValueOnce(ok('not json')).mockReturnValueOnce(ok('{}'));
    expect((await make(['m1']).generateJson(req)).model).toBe('m1');
  });

  it('throws the last error when every model fails', async () => {
    fetchMock.mockImplementation(() => status(503));
    await expect(make(['m1', 'm2']).generateJson(req)).rejects.toThrow(
      'HTTP 503',
    );
    expect(modelsCalled()).toEqual(['m1', 'm2']);
  });

  it('fails immediately without an API key', async () => {
    const g = new GeminiGenerator({ apiKey: '', models: ['m1'] });
    await expect(g.generateJson(req)).rejects.toBeInstanceOf(GenerationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
