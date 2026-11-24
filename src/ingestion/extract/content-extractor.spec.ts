import { PermanentIngestionError } from '../ingestion-errors';
import { ContentExtractor } from './content-extractor';

const paragraph =
  '<p>' +
  'The quick brown fox jumps over the lazy dog near the riverbank. '.repeat(
    15,
  ) +
  '<a href="/related">related</a> <img src="pic.png"></p>';

const page = `<!doctype html><html lang="en"><head>
  <title>  Fox   Article | Example </title>
  <meta property="og:site_name" content="Example">
  <link rel="canonical" href="/articles/fox">
</head><body>
  <nav>Home About Contact</nav>
  <article><h1>Fox Article</h1>${paragraph.repeat(3)}</article>
  <script>alert(1)</script>
</body></html>`;

describe('ContentExtractor', () => {
  const extractor = new ContentExtractor();

  it('extracts the article, metadata and absolute links', () => {
    const out = extractor.extract(page, 'https://example.com/a/b');
    expect(out.title).toBe('Fox Article | Example');
    expect(out.siteName).toBe('Example');
    expect(out.lang).toBe('en');
    expect(out.sourceCanonicalUrl).toBe('https://example.com/articles/fox');
    expect(out.wordCount).toBeGreaterThan(300);
    expect(out.textContent).toContain('quick brown fox');
    expect(out.textContent).not.toContain('Home About Contact');
    expect(out.contentHtml).toContain('href="https://example.com/related"');
    expect(out.contentHtml).toContain('src="https://example.com/a/pic.png"');
    expect(out.contentHtml).not.toContain('<script');
  });

  it('strips NUL bytes', () => {
    const out = extractor.extract(
      page.replace('quick', 'qu\0ick'),
      'https://example.com/',
    );
    expect(out.textContent).not.toContain('\0');
    expect(out.contentHtml).not.toContain('\0');
  });

  it('handles an HTML fragment without <html>', () => {
    const out = extractor.extract(paragraph.repeat(3), 'https://example.com/');
    expect(out.wordCount).toBeGreaterThan(300);
  });

  it.each([
    ['empty body', '<html><body></body></html>'],
    [
      'too short',
      '<html><body><article><p>Just a few words.</p></article></body></html>',
    ],
    ['not html at all', '%PDF-1.4 binary junk'],
  ])('rejects %s as unsupported', (_, html) => {
    expect(() => extractor.extract(html, 'https://example.com/')).toThrow(
      PermanentIngestionError,
    );
  });
});
