import { lookup as dnsLookup } from 'node:dns';
import http, { IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP, LookupFunction } from 'node:net';
import { pipeline, Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import {
  IngestionError,
  PermanentIngestionError,
  TransientIngestionError,
} from '../ingestion-errors';
import { isPublicAddress } from './public-address';

export interface FetchedPage {
  finalUrl: string;
  status: number;
  contentType: string;
  html: string;
  etag: string | null;
  lastModified: string | null;
}

/** Validators from a previous fetch, sent as If-None-Match / If-Modified-Since. */
export interface Validators {
  etag?: string | null;
  lastModified?: string | null;
}

export interface NotModified {
  notModified: true;
}

export interface SafeFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  /** null allows any port (tests only). */
  allowedPorts: readonly number[] | null;
  isAllowedAddress: (ip: string) => boolean;
  userAgent: string;
}

export const DEFAULT_SAFE_FETCH_OPTIONS: SafeFetchOptions = {
  timeoutMs: 15_000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
  allowedPorts: [80, 443],
  isAllowedAddress: isPublicAddress,
  userAgent: 'MastiskaBot/0.1 (+read-later ingestion)',
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TRANSIENT_STATUSES = new Set([408, 425, 429]);
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const PERMANENT_NET_CODES = new Set(['ENOTFOUND', 'ERR_INVALID_URL']);

export class BlockedAddressError extends PermanentIngestionError {
  constructor(host: string, ip: string) {
    super(`Blocked non-public address for ${host}: ${ip}`);
    this.name = 'BlockedAddressError';
  }
}

export class SafeFetcher {
  private readonly opts: SafeFetchOptions;

  constructor(opts: Partial<SafeFetchOptions> = {}) {
    this.opts = { ...DEFAULT_SAFE_FETCH_OPTIONS, ...opts };
  }

  async fetch(url: string): Promise<FetchedPage> {
    return (await this.fetchIfChanged(url, {})) as FetchedPage;
  }

  /** Like fetch, but returns { notModified } on HTTP 304 when validators are given. */
  async fetchIfChanged(
    url: string,
    validators: Validators,
  ): Promise<FetchedPage | NotModified> {
    // One deadline for the whole redirect chain and body.
    const signal = AbortSignal.timeout(this.opts.timeoutMs);
    try {
      return await this.follow(new URL(url), signal, validators);
    } catch (err) {
      throw this.classify(err, signal);
    }
  }

  private async follow(
    start: URL,
    signal: AbortSignal,
    validators: Validators,
  ): Promise<FetchedPage | NotModified> {
    let url = start;
    for (let hop = 0; ; hop++) {
      this.assertUrlAllowed(url);
      const res = await this.request(url, signal, validators);
      const status = res.statusCode ?? 0;

      if (status === 304 && (validators.etag || validators.lastModified)) {
        res.resume();
        return { notModified: true };
      }

      if (REDIRECT_STATUSES.has(status)) {
        res.resume();
        const location = res.headers.location;
        if (!location)
          throw new PermanentIngestionError('Redirect without Location');
        if (hop >= this.opts.maxRedirects) {
          throw new PermanentIngestionError('Too many redirects');
        }
        url = new URL(location, url);
        continue;
      }

      if (status < 200 || status >= 300) {
        res.resume();
        throw TRANSIENT_STATUSES.has(status) || status >= 500
          ? new TransientIngestionError(`HTTP ${status}`)
          : new PermanentIngestionError(`HTTP ${status}`);
      }

      const contentType = res.headers['content-type'] ?? '';
      const mime = contentType.split(';')[0].trim().toLowerCase();
      if (!HTML_TYPES.has(mime)) {
        res.resume();
        throw new PermanentIngestionError(
          `Unsupported content type: ${mime || 'none'}`,
        );
      }

      const body = await this.readBody(res);
      return {
        finalUrl: url.toString(),
        status,
        contentType,
        html: decodeHtml(body, contentType),
        etag: header(res, 'etag'),
        lastModified: header(res, 'last-modified'),
      };
    }
  }

  private assertUrlAllowed(url: URL): void {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new PermanentIngestionError(
        `Unsupported protocol: ${url.protocol}`,
      );
    }
    if (url.username || url.password) {
      throw new PermanentIngestionError(
        'URLs with credentials are not fetched',
      );
    }
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (this.opts.allowedPorts && !this.opts.allowedPorts.includes(port)) {
      throw new PermanentIngestionError(`Port ${port} is not allowed`);
    }
    // IP literals skip DNS lookup, so check them here.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !this.opts.isAllowedAddress(host)) {
      throw new BlockedAddressError(host, host);
    }
  }

  private request(
    url: URL,
    signal: AbortSignal,
    validators: Validators,
  ): Promise<IncomingMessage> {
    const client = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = client.request(
        url,
        {
          method: 'GET',
          signal,
          agent: false,
          lookup: this.lookup,
          headers: {
            'user-agent': this.opts.userAgent,
            accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
            'accept-encoding': 'gzip, deflate, br',
            ...(validators.etag && { 'if-none-match': validators.etag }),
            ...(validators.lastModified && {
              'if-modified-since': validators.lastModified,
            }),
          },
        },
        resolve,
      );
      req.on('error', reject);
      req.end();
    });
  }

  // Validates the address actually connected to, which closes the
  // resolve-then-fetch DNS rebinding gap.
  private readonly lookup: LookupFunction = (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = addresses;
      const blocked = list.find((a) => !this.opts.isAllowedAddress(a.address));
      if (blocked) {
        return callback(
          new BlockedAddressError(hostname, blocked.address),
          '',
          0,
        );
      }
      if (options.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };

  private async readBody(res: IncomingMessage): Promise<Buffer> {
    const declared = Number(res.headers['content-length']);
    if (declared > this.opts.maxBytes) {
      res.resume();
      throw new PermanentIngestionError('Response too large');
    }

    const stream = this.decompress(res);
    const chunks: Buffer[] = [];
    let total = 0;
    // Counts decompressed bytes, so compression bombs hit the cap too.
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > this.opts.maxBytes) {
        res.destroy();
        throw new PermanentIngestionError('Response too large');
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }

  private decompress(res: IncomingMessage): Readable {
    const encoding = (res.headers['content-encoding'] ?? 'identity')
      .trim()
      .toLowerCase();
    const noop = () => undefined;
    switch (encoding) {
      case 'identity':
      case '':
        return res;
      case 'gzip':
      case 'x-gzip':
        return pipeline(res, createGunzip(), noop);
      case 'deflate':
        return pipeline(res, createInflate(), noop);
      case 'br':
        return pipeline(res, createBrotliDecompress(), noop);
      default:
        res.resume();
        throw new PermanentIngestionError(`Unsupported encoding: ${encoding}`);
    }
  }

  private classify(err: unknown, signal: AbortSignal): IngestionError {
    if (err instanceof IngestionError) return err;
    if (signal.aborted) return new TransientIngestionError('Fetch timed out');
    const code = (err as { code?: string }).code ?? '';
    const message = err instanceof Error ? err.message : String(err);
    if (
      PERMANENT_NET_CODES.has(code) ||
      code.startsWith('ERR_TLS') ||
      code.includes('CERT')
    ) {
      return new PermanentIngestionError(`${code}: ${message}`);
    }
    return new TransientIngestionError(code ? `${code}: ${message}` : message);
  }
}

function header(res: IncomingMessage, name: string): string | null {
  const v = res.headers[name];
  return typeof v === 'string' && v.length <= 500 ? v : null;
}

function decodeHtml(body: Buffer, contentType: string): string {
  const label =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(
      body.subarray(0, 2048).toString('latin1'),
    )?.[1] ??
    'utf-8';
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}
