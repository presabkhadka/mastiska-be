import { parseHTML } from 'linkedom';

// Output is rebuilt from an allowlist (never the input string), so anything not listed
// here (scripts, event handlers, styles, iframes, forms) can't survive.
// prettier-ignore
const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'article', 'aside', 'b', 'blockquote', 'br', 'caption', 'cite',
  'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt',
  'em', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main', 'mark', 'ol', 'p',
  'pre', 'q', 's', 'samp', 'section', 'small', 'span', 'strong', 'sub',
  'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time',
  'tr', 'u', 'ul', 'var',
]);

// Removed with their content; any other unknown tag is unwrapped (its text is kept).
// prettier-ignore
const DROPPED_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'applet', 'form', 'input', 'button', 'textarea', 'select',
  'option', 'svg', 'math', 'link', 'meta', 'base', 'head', 'title', 'video',
  'audio', 'canvas', 'dialog',
]);

const VOID_TAGS = new Set(['br', 'hr', 'img', 'col']);

const ALLOWED_ATTRS: Record<string, readonly string[]> = {
  '*': ['title', 'lang', 'dir'],
  a: ['href'],
  img: ['src', 'alt', 'width', 'height'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  col: ['span'],
  colgroup: ['span'],
  ol: ['start', 'reversed'],
  time: ['datetime'],
  blockquote: ['cite'],
  q: ['cite'],
  del: ['cite', 'datetime'],
  ins: ['cite', 'datetime'],
};

const URL_ATTRS = new Set(['href', 'src', 'cite']);
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const SRC_PROTOCOLS = new Set(['http:', 'https:']);

const ELEMENT = 1;
const TEXT = 3;

/** Allowlist sanitizer for Readability output, safe to render as HTML. */
export function sanitizeHtml(html: string): string {
  const { document } = parseHTML(
    `<!doctype html><html><head></head><body>${html}</body></html>`,
  );
  return serializeChildren(document.body);
}

function serializeChildren(node: Node): string {
  let out = '';
  for (const child of Array.from(node.childNodes)) out += serialize(child);
  return out;
}

function serialize(node: Node): string {
  if (node.nodeType === TEXT) return escapeText(node.textContent ?? '');
  if (node.nodeType !== ELEMENT) return ''; // comments, processing instructions

  const el = node as Element;
  const tag = el.localName.toLowerCase();
  if (DROPPED_TAGS.has(tag)) return '';
  if (!ALLOWED_TAGS.has(tag)) return serializeChildren(el);

  let attrs = '';
  for (const name of [...ALLOWED_ATTRS['*'], ...(ALLOWED_ATTRS[tag] ?? [])]) {
    const value = el.getAttribute(name);
    if (value === null) continue;
    const safe = URL_ATTRS.has(name) ? safeUrl(value, name === 'src') : value;
    if (safe !== null) attrs += ` ${name}="${escapeAttr(safe)}"`;
  }
  if (tag === 'a' && attrs.includes(' href=')) {
    attrs += ' rel="noopener noreferrer nofollow"';
  }

  if (VOID_TAGS.has(tag)) return `<${tag}${attrs}>`;
  return `<${tag}${attrs}>${serializeChildren(el)}</${tag}>`;
}

// Fragment links (#x) are kept; everything else must be absolute with an allowed scheme.
function safeUrl(value: string, isSrc: boolean): string | null {
  const v = value.trim();
  if (!isSrc && v.startsWith('#')) return v;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  return (isSrc ? SRC_PROTOCOLS : LINK_PROTOCOLS).has(url.protocol)
    ? url.toString()
    : null;
}

function escapeText(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeAttr(s: string): string {
  return escapeText(s).replaceAll('"', '&quot;');
}
