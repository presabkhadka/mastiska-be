import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';

export interface ChunkDraft {
  position: number;
  section: string | null;
  content: string;
  tokenEstimate: number;
}

export interface ChunkOptions {
  targetChars: number;
  maxChars: number;
  overlapChars: number;
  minChars: number;
}

// ~4 chars per token: target ≈ 400 tokens, hard max ≈ 600.
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  targetChars: 1600,
  maxChars: 2400,
  overlapChars: 200,
  minChars: 400,
};

const HEADINGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const BLOCKS = new Set([
  ...HEADINGS,
  'P',
  'LI',
  'UL',
  'OL',
  'PRE',
  'BLOCKQUOTE',
  'TABLE',
  'THEAD',
  'TBODY',
  'TR',
  'TD',
  'TH',
  'FIGURE',
  'FIGCAPTION',
  'DL',
  'DT',
  'DD',
  'DIV',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
  'ASIDE',
]);

interface Block {
  section: string | null;
  text: string;
}

/**
 * Splits article HTML into passages. Chunks never cross a heading unless the
 * current one is still tiny, and consecutive chunks in a section overlap.
 */
export function chunkArticle(
  html: string,
  opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): ChunkDraft[] {
  const blocks = extractBlocks(html);
  const out: { section: string | null; content: string }[] = [];
  let current: string[] = [];
  let currentLen = 0;
  let currentSection: string | null = null;
  let chunkSection: string | null = null;

  const flush = () => {
    const content = current.join('\n\n').trim();
    if (content) out.push({ section: chunkSection, content });
    current = [];
    currentLen = 0;
  };

  // Overlap is carried only if the next chunk still fits under maxChars.
  const startNext = (nextLen: number) => {
    const prev = current.join('\n\n');
    flush();
    const tail = overlapTail(prev, opts.overlapChars);
    if (tail && tail.length + 2 + nextLen <= opts.maxChars) {
      current = [tail];
      currentLen = tail.length;
    }
  };

  for (const block of blocks) {
    if (block.section !== currentSection) {
      if (currentLen >= opts.minChars) flush();
      currentSection = block.section;
    }
    for (const piece of splitLong(block.text, opts.targetChars)) {
      if (currentLen > 0 && currentLen + piece.length > opts.targetChars) {
        startNext(piece.length);
      }
      if (current.length === 0) chunkSection = block.section;
      current.push(piece);
      currentLen += piece.length + 2;
    }
  }
  flush();

  return out.map((c, position) => ({
    position,
    section: c.section,
    content: c.content,
    tokenEstimate: Math.ceil(c.content.length / 4),
  }));
}

/** What gets embedded. Also the input to the reuse hash. */
export function embeddingText(section: string | null, content: string): string {
  return section ? `${section}\n\n${content}` : content;
}

export function chunkHash(
  title: string | null,
  section: string | null,
  content: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([title ?? '', embeddingText(section, content)]))
    .digest('hex');
}

function extractBlocks(html: string): Block[] {
  const { document } = parseHTML(
    `<!doctype html><html><head></head><body>${html}</body></html>`,
  );
  const blocks: Block[] = [];
  const headings: string[] = [];

  const visit = (el: Element) => {
    if (HEADINGS.has(el.tagName)) {
      const level = Number(el.tagName[1]);
      const text = normalize(el.textContent);
      if (text) {
        headings.length = Math.min(headings.length, level - 1);
        headings[level - 1] = text;
      }
      return;
    }
    if (el.tagName === 'TR') {
      const cells = Array.from(el.children).map((c) =>
        normalize(c.textContent),
      );
      const text = cells.filter(Boolean).join(' | ');
      if (text) blocks.push({ section: sectionOf(headings), text });
      return;
    }
    const hasBlockChild = Array.from(el.children).some((c) =>
      BLOCKS.has(c.tagName),
    );
    if (!hasBlockChild) {
      const text = normalize(el.textContent);
      if (text) blocks.push({ section: sectionOf(headings), text });
      return;
    }
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 1) {
        visit(node as Element);
      } else if (node.nodeType === 3) {
        const text = normalize(node.textContent);
        if (text) blocks.push({ section: sectionOf(headings), text });
      }
    }
  };

  visit(document.body);
  return blocks;
}

function sectionOf(headings: string[]): string | null {
  const path = headings.filter(Boolean);
  return path.length ? path.join(' > ') : null;
}

// Drops wiki-style "[edit]" / "[1]" link text.
function normalize(s: string | null): string {
  return (s ?? '')
    .replace(/\[(edit|\d+|citation needed)\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits text longer than max at sentence boundaries, then hard-cuts. */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let buf = '';
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    for (let i = 0; i < sentence.length; i += max) {
      const part = sentence.slice(i, i + max);
      if (buf && buf.length + part.length + 1 > max) {
        out.push(buf);
        buf = '';
      }
      buf = buf ? `${buf} ${part}` : part;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Last whole sentences of `text` that fit in `max` chars. */
function overlapTail(text: string, max: number): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  let tail = '';
  for (let i = sentences.length - 1; i >= 0; i--) {
    const next = tail ? `${sentences[i]} ${tail}` : sentences[i];
    if (next.length > max) break;
    tail = next;
  }
  return tail.trim();
}
