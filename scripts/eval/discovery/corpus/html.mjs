import { RequestError, readBody } from './http.mjs';

// HTML helpers shared by the corpus pages. Server side: escaping, the page shell and
// urlencoded form bodies. Probe side: a redirect-preserving page client and regex tag and
// attribute extraction over the corpus's own generated markup. There is no DOM dependency, so
// the extraction assumes what the corpus guarantees: attribute values never contain '>' and
// elements whose content a probe reads are never nested inside an element of the same name.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ESCAPES[char]);

// An HTML5 document. `head` adds markup such as a <style> block; `header` renders before <main>.
export function page({ title, lang = 'en', body, head = '', header = '' }) {
  return `<!doctype html>\n<html lang="${escapeHtml(lang)}">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(title)}</title>\n${head ? `${head}\n` : ''}</head>\n<body>\n${header ? `${header}\n` : ''}<main>\n${body}\n</main>\n</body>\n</html>\n`;
}

const FORM_TYPE = 'application/x-www-form-urlencoded';

// Reads an application/x-www-form-urlencoded request body as URLSearchParams. Any other
// content type is answered 415 without buffering the body.
export async function readForm(req, limit) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== FORM_TYPE) {
    req.resume();
    throw new RequestError(415, { error: 'form-body-required' });
  }
  return new URLSearchParams(await readBody(req, limit));
}

// Probe-side client: redirects are returned as-is, so a 303 and its Location stay observable.
export async function getPage(baseUrl, path) {
  const response = await fetch(new URL(path, baseUrl), { redirect: 'manual' });
  return { status: response.status, location: response.headers.get('location'), text: await response.text() };
}

export async function submitForm(baseUrl, path, fields) {
  const response = await fetch(new URL(path, baseUrl), {
    method: 'POST', redirect: 'manual', headers: { 'content-type': FORM_TYPE }, body: new URLSearchParams(fields).toString() });
  return { status: response.status, location: response.headers.get('location'), text: await response.text() };
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, body) => {
    if (body[0] !== '#') return NAMED[body.toLowerCase()] ?? entity;
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

const OPEN_TAG = /<([a-z][a-z0-9-]*)(?=[\s/>])[^>]*>/gi;
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function toElement(html, lowerHtml, match) {
  const name = match[1].toLowerCase();
  if (VOID_ELEMENTS.has(name) || match[0].endsWith('/>')) return { name, tag: match[0], inner: '' };
  const start = match.index + match[0].length;
  const end = lowerHtml.indexOf(`</${name}>`, start);
  return { name, tag: match[0], inner: end < 0 ? '' : html.slice(start, end) };
}

// Elements named `name` in document order: {name, tag (the opening tag), inner (the content up
// to the first matching closing tag; empty for void elements)}.
export function tagsByName(html, name) {
  const wanted = name.toLowerCase();
  const lowerHtml = html.toLowerCase();
  return [...html.matchAll(OPEN_TAG)].filter(match => match[1].toLowerCase() === wanted).map(match => toElement(html, lowerHtml, match));
}

// Decoded attribute value of an element or opening tag: '' for a boolean attribute, null when absent.
export function attr(element, name) {
  const tag = typeof element === 'string' ? element : element?.tag ?? '';
  const inside = tag.replace(/^<[^\s/>]+/, '').replace(/\/?>$/, '');
  const wanted = name.toLowerCase();
  for (const match of inside.matchAll(ATTRIBUTE)) {
    if (match[1].toLowerCase() === wanted) return decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return null;
}

export const hasClass = (element, className) => (attr(element, 'class') ?? '').split(/\s+/).includes(className);

// The first element whose id attribute equals `id`, or null.
export function elementById(html, id) {
  const lowerHtml = html.toLowerCase();
  for (const match of html.matchAll(OPEN_TAG)) if (attr(match[0], 'id') === id) return toElement(html, lowerHtml, match);
  return null;
}

// Visible-text approximation of a fragment or element: tags removed, entities decoded, whitespace collapsed.
export function textOf(fragment) {
  const html = typeof fragment === 'string' ? fragment : fragment?.inner ?? '';
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
