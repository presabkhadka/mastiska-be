import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { PermanentIngestionError } from '../ingestion-errors';

export interface ExtractedContent {
  title: string | null;
  byline: string | null;
  siteName: string | null;
  lang: string | null;
  excerpt: string | null;
  publishedTime: string | null;
  sourceCanonicalUrl: string | null;
  /** Readability output. Not sanitized: sanitize before rendering. */
  contentHtml: string;
  textContent: string;
  wordCount: number;
}

export const MIN_WORDS = 25;
const TITLE_MAX = 500;

export class ContentExtractor {
  extract(html: string, pageUrl: string): ExtractedContent {
    let { document } = parseHTML(html);
    // linkedom makes a bare fragment the root, and has no root for non-HTML.
    if (document.documentElement?.tagName.toUpperCase() !== 'HTML') {
      ({ document } = parseHTML(
        `<!doctype html><html><head></head><body>${html}</body></html>`,
      ));
    }

    // Readability resolves relative links against baseURI, which linkedom
    // only derives from a <base> element.
    if (!document.querySelector('base[href]')) {
      const base = document.createElement('base');
      base.setAttribute('href', pageUrl);
      (document.head ?? document.documentElement).prepend(base);
    }

    // Read before Readability mutates the document.
    const metaTitle =
      attr(document, 'meta[property="og:title"]', 'content') ??
      clean(document.title);
    const canonical = absolute(
      attr(document, 'link[rel="canonical"]', 'href'),
      pageUrl,
    );

    const article = new Readability(document).parse();
    const textContent = clean(article?.textContent ?? null, false) ?? '';
    const wordCount = textContent.split(/\s+/).filter(Boolean).length;
    if (!article?.content || wordCount < MIN_WORDS) {
      throw new PermanentIngestionError('No readable content');
    }

    return {
      title: truncate(clean(article.title) ?? metaTitle, TITLE_MAX),
      byline: clean(article.byline),
      siteName: clean(article.siteName),
      lang: clean(article.lang)?.slice(0, 35) ?? null,
      excerpt: clean(article.excerpt),
      publishedTime: clean(article.publishedTime),
      sourceCanonicalUrl: canonical,
      contentHtml: stripNul(article.content),
      textContent,
      wordCount,
    };
  }
}

function attr(doc: Document, selector: string, name: string): string | null {
  return clean(doc.querySelector(selector)?.getAttribute(name) ?? null);
}

// Postgres text can't hold NUL bytes.
export function stripNul(s: string): string {
  return s.replaceAll('\0', '');
}

function clean(s: string | null | undefined, collapse = true): string | null {
  if (!s) return null;
  const out = stripNul(collapse ? s.replace(/\s+/g, ' ') : s).trim();
  return out || null;
}

function truncate(s: string | null, max: number): string | null {
  return s && s.length > max ? s.slice(0, max) : s;
}

function absolute(href: string | null, base: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, base);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
