import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import {
  PermanentIngestionError,
  TransientIngestionError,
} from '../ingestion-errors';
import { BlockedAddressError, SafeFetcher } from './safe-fetcher';

const HTML = '<html><body><p>hello</p></body></html>';

describe('SafeFetcher', () => {
  let server: Server;
  let base: string;
  // Test server is on loopback, so allow it explicitly.
  const fetcher = new SafeFetcher({
    allowedPorts: null,
    isAllowedAddress: (ip) => ip === '127.0.0.1',
    timeoutMs: 500,
    maxBytes: 1024,
    maxRedirects: 2,
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = req.url ?? '/';
      const html = { 'content-type': 'text/html; charset=utf-8' };
      if (path === '/ok') return res.writeHead(200, html).end(HTML);
      if (path === '/latin1') {
        res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
        return res.end(Buffer.from('<p>caf\xe9</p>', 'latin1'));
      }
      if (path === '/gzip') {
        res.writeHead(200, { ...html, 'content-encoding': 'gzip' });
        return res.end(gzipSync(HTML));
      }
      if (path === '/bomb') {
        res.writeHead(200, { ...html, 'content-encoding': 'gzip' });
        return res.end(gzipSync(Buffer.alloc(100_000, 'a')));
      }
      if (path === '/big') {
        res.writeHead(200, html);
        return res.end('x'.repeat(5000));
      }
      if (path.startsWith('/redirect/')) {
        const n = Number(path.split('/')[2]);
        const to = n > 0 ? `/redirect/${n - 1}` : '/ok';
        return res.writeHead(302, { location: to }).end();
      }
      if (path === '/to-private') {
        return res.writeHead(301, { location: 'http://10.0.0.1/' }).end();
      }
      if (path === '/pdf') {
        return res.writeHead(200, { 'content-type': 'application/pdf' }).end();
      }
      if (path === '/404') return res.writeHead(404).end();
      if (path === '/429') return res.writeHead(429).end();
      if (path === '/503') return res.writeHead(503).end();
      if (path === '/hang') return; // never responds
      res.writeHead(500).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });

  it('fetches and decodes HTML', async () => {
    const page = await fetcher.fetch(`${base}/ok`);
    expect(page).toMatchObject({ status: 200, html: HTML });
  });

  it('decodes the declared charset', async () => {
    const page = await fetcher.fetch(`${base}/latin1`);
    expect(page.html).toBe('<p>café</p>');
  });

  it('decompresses gzip', async () => {
    expect((await fetcher.fetch(`${base}/gzip`)).html).toBe(HTML);
  });

  it('follows redirects and reports the final URL', async () => {
    const page = await fetcher.fetch(`${base}/redirect/1`);
    expect(page.finalUrl).toBe(`${base}/ok`);
  });

  it.each([
    ['/redirect/2', 'Too many redirects'],
    ['/to-private', 'Blocked'],
    ['/pdf', 'Unsupported content type'],
    ['/404', 'HTTP 404'],
    ['/big', 'too large'],
    ['/bomb', 'too large'],
  ])('%s is a permanent failure', async (path, message) => {
    const err = await fetcher.fetch(`${base}${path}`).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PermanentIngestionError);
    expect((err as Error).message).toContain(message);
  });

  it.each([
    ['/429', 'HTTP 429'],
    ['/503', 'HTTP 503'],
    ['/hang', 'timed out'],
  ])('%s is a transient failure', async (path, message) => {
    const err = await fetcher.fetch(`${base}${path}`).catch((e: Error) => e);
    expect(err).toBeInstanceOf(TransientIngestionError);
    expect((err as Error).message).toContain(message);
  });

  describe('default policy', () => {
    const strict = new SafeFetcher({ timeoutMs: 1000 });

    it.each([
      'http://127.0.0.1/',
      'http://[::1]/',
      'http://2130706433/',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost/',
    ])('blocks %s', async (url) => {
      await expect(strict.fetch(url)).rejects.toBeInstanceOf(
        BlockedAddressError,
      );
    });

    it.each([
      ['ftp://example.com/', 'protocol'],
      ['http://user:pw@example.com/', 'credentials'],
      ['http://example.com:8080/', 'Port 8080'],
    ])('rejects %s', async (url, message) => {
      const err = await strict.fetch(url).catch((e: Error) => e);
      expect(err).toBeInstanceOf(PermanentIngestionError);
      expect((err as Error).message).toContain(message);
    });
  });
});
