import { chunkArticle, chunkHash, embeddingText } from './chunker';

const sentence = (i: number) =>
  `Sentence number ${i} talks about finite state machines in detail.`;
const para = (from: number, n: number) =>
  `<p>${Array.from({ length: n }, (_, i) => sentence(from + i)).join(' ')}</p>`;

describe('chunkArticle', () => {
  it('keeps a short article in one chunk without a section', () => {
    const chunks = chunkArticle('<p>Hello world.</p><p>Second para.</p>');
    expect(chunks).toEqual([
      {
        position: 0,
        section: null,
        content: 'Hello world.\n\nSecond para.',
        tokenEstimate: 7,
      },
    ]);
  });

  it('labels chunks with the heading path', () => {
    const html = `<h2>Intro</h2>${para(0, 10)}<h3>Detail</h3>${para(10, 10)}<h2>Other</h2>${para(20, 10)}`;
    const sections = chunkArticle(html).map((c) => c.section);
    expect(sections).toEqual(['Intro', 'Intro > Detail', 'Other']);
  });

  it('merges a tiny section into the next instead of making a stub chunk', () => {
    const html = `<h2>Tiny</h2><p>Short.</p><h2>Big</h2>${para(0, 10)}`;
    const chunks = chunkArticle(html);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].section).toBe('Tiny');
    expect(chunks[0].content).toContain('Short.');
  });

  it('splits long sections near the target size with sentence overlap', () => {
    const chunks = chunkArticle(`<h2>Long</h2>${para(0, 120)}`);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(2400);
    // The next chunk opens with the closing sentences of the previous one.
    const lastSentence = chunks[0].content.split(/(?<=\.)\s+/).pop()!;
    expect(chunks[1].content.slice(0, 250)).toContain(lastSentence);
  });

  it('keeps table rows on one line and drops wiki link noise', () => {
    const html =
      '<h2>Table [edit]</h2><table><tr><th>State</th><th>Input</th></tr><tr><td>Locked</td><td>coin</td></tr></table><p>See note[1].</p>';
    const [chunk] = chunkArticle(html);
    expect(chunk.section).toBe('Table');
    expect(chunk.content).toBe('State | Input\n\nLocked | coin\n\nSee note.');
  });

  it('numbers positions consecutively', () => {
    const chunks = chunkArticle(para(0, 150));
    expect(chunks.map((c) => c.position)).toEqual(chunks.map((_, i) => i));
  });

  it('returns nothing for empty content', () => {
    expect(chunkArticle('<div> </div>')).toEqual([]);
  });
});

describe('chunk hashing', () => {
  it('changes when title, section or content change', () => {
    const base = chunkHash('T', 'S', 'body');
    expect(chunkHash('T', 'S', 'body')).toBe(base);
    expect(chunkHash('T2', 'S', 'body')).not.toBe(base);
    expect(chunkHash('T', 'S2', 'body')).not.toBe(base);
    expect(chunkHash('T', 'S', 'body2')).not.toBe(base);
  });

  it('prefixes the section into the embedding text', () => {
    expect(embeddingText('A > B', 'text')).toBe('A > B\n\ntext');
    expect(embeddingText(null, 'text')).toBe('text');
  });
});
