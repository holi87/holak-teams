import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBinaryBuffer, redactText, redactValue, validateRedactionPatterns } from './authorization.mjs';
import { compileJsonSchema } from './json-schema.mjs';

// Evidence content rules shared by the contract validator, the finding reconciler, and the
// engagement merge. This module must not import contracts.mjs or finding-quality.mjs: both
// import it, and an ESM cycle would observe uninitialized bindings.

const RUNTIME = dirname(fileURLToPath(import.meta.url));
const REDACTION_PATTERNS_PATH = join(RUNTIME, '..', 'policies', 'redaction-patterns.json');
const RUNNER_RESULT_SCHEMA_PATH = join(RUNTIME, '..', 'schemas', 'runner-result.schema.json');

// File signatures as [byte offset, hex bytes]; every entry must match.
const BINARY_SIGNATURES = Object.freeze({
  'image/png': [[0, '89504e470d0a1a0a']],
  'image/jpeg': [[0, 'ffd8ff']],
  'image/webp': [[0, '52494646'], [8, '57454250']],
  'video/webm': [[0, '1a45dfa3']],
  'video/mp4': [[4, '66747970']],
  'application/zip': [[0, '504b0304']],
});
const HTML_MEDIA_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const HAR_SECRET_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'x-auth-token', 'x-csrf-token', 'x-xsrf-token',
]);
const HAR_SECRET_QUERY_NAMES = new Set(['token', 'access_token', 'api_key', 'apikey', 'session']);
const REDACTION_PLACEHOLDER = /\[REDACTED[^\]]*\]/;
const INPUT_TAG = /<input\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const TAG_ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

let runnerResultValidator = null;

// Screenshots, videos, and zipped Playwright traces cannot pass through the text redactor, so
// they need masked or synthetic content, a second-agent review, and an audited grant.
export function isBinaryReference(ref) {
  return ref?.kind === 'screenshot' || ref?.kind === 'video' || (ref?.kind === 'trace' && ref.mediaType === 'application/zip');
}

// Review rules the schema subset cannot express (it has no `not` or `else`).
export function validateEvidenceReferences(document) {
  const errors = [];
  for (const ref of document.references ?? []) {
    const label = `evidence reference ${ref.id}`;
    const binary = isBinaryReference(ref);
    if (binary !== Boolean(ref.review)) {
      errors.push(binary ? `${label} is binary and requires a second-agent review` : `${label} is textual and must not carry a binary review`);
      continue;
    }
    if (!binary) continue;
    if (ref.review.reviewer === ref.collectedBy) errors.push(`${label} review must come from a lane other than its collector ${ref.collectedBy}`);
    const reviewed = compareInstants(ref.review.reviewedAt, ref.capturedAt);
    const audited = compareInstants(ref.review.auditTimestamp, ref.capturedAt);
    if (reviewed === null || audited === null) errors.push(`${label} review timestamps must be comparable RFC3339 instants`);
    else {
      if (reviewed < 0) errors.push(`${label} review must not precede its capture`);
      if (audited > 0) errors.push(`${label} binary-evidence authorization audit must not follow its capture`);
    }
  }
  return errors;
}

// The fragment that registers a binary reference is written under the reviewer's own lane
// lease, so the lease, not the self-declared reference, authenticates the review.
export function binaryRegistrationErrors(ref, lane) {
  if (!isBinaryReference(ref) || ref.review?.reviewer === lane) return [];
  return [`binary evidence ${ref.id} must be registered by its reviewer ${ref.review?.reviewer ?? '(none)'}, not ${lane}`];
}

// Parses an append-only authorization audit log. A line that is not a JSON object fails the
// whole log: a torn or edited audit cannot back a binary-evidence review.
export function parseAuditLog(text) {
  const events = [];
  for (const [index, line] of String(text).split('\n').entries()) {
    if (line.trim() === '') continue;
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Error(`authorization audit line ${index + 1} is not valid JSON`); }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) throw new Error(`authorization audit line ${index + 1} is not a JSON object`);
    events.push(event);
  }
  return events;
}

// A binary reference is bound to the collector's allow decision for binary-evidence at the
// exact audit timestamp the reviewer copied into review.auditTimestamp.
export function binaryReviewAuditErrors(ref, events, engagementId) {
  if (!isBinaryReference(ref)) return [];
  const bound = events.some((event) => event.engagementId === engagementId && event.lane === ref.collectedBy &&
    event.action === 'binary-evidence' && event.decision === 'allow' && event.timestamp === ref.review?.auditTimestamp);
  return bound ? [] : [`binary evidence ${ref.id} has no allow binary-evidence audit event for ${ref.collectedBy} at ${ref.review?.auditTimestamp ?? '(none)'}`];
}

export function loadRedactionPatterns() {
  let patterns;
  try { patterns = JSON.parse(readFileSync(REDACTION_PATTERNS_PATH, 'utf8')); }
  catch (error) { throw new Error(`cannot load redaction patterns ${REDACTION_PATTERNS_PATH}: ${error.message}`); }
  const errors = validateRedactionPatterns(patterns);
  if (errors.length) throw new Error(`packaged redaction patterns are invalid: ${errors.join('; ')}`);
  return patterns;
}

export function validateRunnerResultSemantics(document) {
  const errors = [];
  if ((document.exitCode === 0) !== (document.status === 'pass')) errors.push('runner status must be pass exactly when exitCode is 0');
  for (const category of ['product', 'automation', 'infrastructure', 'skip', 'policy']) {
    const count = document.events.filter((event) => event.category === category).length;
    if (document.categories[category] !== count) errors.push(`runner category ${category} count differs from events`);
  }
  return errors;
}

// Re-validates retained evidence bytes against the reference that registers them. Binary
// media must carry the signature of its declared media type; text must already be a fixed
// point of the packaged redactor, applied the way `argus-assets redact` applies it.
export function validateEvidenceContent(ref, bytes, { patterns = loadRedactionPatterns() } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const label = `evidence ${ref.id}`;
  if (isBinaryReference(ref)) {
    const signature = BINARY_SIGNATURES[ref.mediaType];
    if (!signature) return [`${label} has no known binary signature for ${ref.mediaType}`];
    const matches = signature.every(([offset, hex]) => {
      const expected = Buffer.from(hex, 'hex');
      return buffer.length >= offset + expected.length && buffer.subarray(offset, offset + expected.length).equals(expected);
    });
    return matches ? [] : [`${label} content does not match the ${ref.mediaType} signature`];
  }
  const text = buffer.toString('utf8');
  if (isBinaryBuffer(buffer) || buffer.includes(0) || text.includes('�')) return [`${label} is textual ${ref.kind} evidence but its content is binary`];
  if (ref.mediaType === 'application/x-ndjson') return ndjsonErrors(text, label, patterns);
  let value;
  let parsed = false;
  try {
    value = JSON.parse(text);
    parsed = true;
  } catch {
    if (ref.mediaType === 'application/json') return [`${label} is not valid JSON`];
  }
  const errors = [];
  if (parsed) {
    if (stableJson(redactValue(value, patterns).value) !== stableJson(value)) errors.push(`${label} contains values the packaged redactor would change`);
  } else if (redactText(text, patterns).text !== text) {
    errors.push(`${label} contains text the packaged redactor would change`);
  }
  if (ref.kind === 'har') errors.push(...harErrors(parsed ? value : null, label, patterns));
  if (ref.kind === 'runner-result') errors.push(...runnerResultErrors(parsed ? value : null, label));
  if (ref.kind === 'dom-snapshot' && HTML_MEDIA_TYPES.has(ref.mediaType)) errors.push(...passwordInputErrors(text, label));
  return errors;
}

function ndjsonErrors(text, label, patterns) {
  const errors = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    let value;
    try { value = JSON.parse(line); }
    catch { errors.push(`${label} line ${index + 1} is not valid NDJSON`); continue; }
    if (stableJson(redactValue(value, patterns).value) !== stableJson(value)) errors.push(`${label} line ${index + 1} contains values the packaged redactor would change`);
  }
  return errors;
}

// HAR stores headers, cookies, query parameters, and form parameters as name/value pairs,
// which key-based redaction never sees, so each secret-bearing pair must hold a redaction
// placeholder. Body text (postData.text, content.text) is a string the redactor already sees.
function harErrors(har, label, patterns) {
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) return [`${label} HAR must contain a log.entries array`];
  const secretNames = new Set([...HAR_SECRET_QUERY_NAMES, ...patterns.sensitiveKeys].map(pairName));
  const errors = [];
  entries.forEach((entry, index) => {
    for (const side of ['request', 'response']) {
      const message = entry?.[side];
      for (const header of arrayOf(message?.headers)) {
        if (HAR_SECRET_HEADERS.has(String(header?.name).toLowerCase()) && !isMasked(header?.value)) errors.push(`${label} entries[${index}].${side} header ${header.name} is not masked`);
      }
      for (const cookie of arrayOf(message?.cookies)) {
        if (!isMasked(cookie?.value)) errors.push(`${label} entries[${index}].${side} cookie ${String(cookie?.name)} is not masked`);
      }
    }
    for (const query of arrayOf(entry?.request?.queryString)) {
      if (secretNames.has(pairName(query?.name)) && !isMasked(query?.value)) errors.push(`${label} entries[${index}].request query parameter ${query.name} is not masked`);
    }
    for (const param of arrayOf(entry?.request?.postData?.params)) {
      if (secretNames.has(pairName(param?.name)) && !isMasked(param?.value)) errors.push(`${label} entries[${index}].request form parameter ${param.name} is not masked`);
    }
  });
  return errors;
}

// Compares pair names the way redactValue compares JSON keys.
function pairName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function runnerResultErrors(document, label) {
  if (document === null) return [`${label} runner result is not valid JSON`];
  if (!runnerResultValidator) {
    let schema;
    try { schema = JSON.parse(readFileSync(RUNNER_RESULT_SCHEMA_PATH, 'utf8')); }
    catch (error) { throw new Error(`cannot load runner result schema ${RUNNER_RESULT_SCHEMA_PATH}: ${error.message}`); }
    runnerResultValidator = compileJsonSchema(schema);
  }
  const schemaErrors = runnerResultValidator(document);
  if (schemaErrors.length) return schemaErrors.map((error) => `${label} runner result ${error.instancePath || '/'} ${error.message}`);
  return validateRunnerResultSemantics(document).map((error) => `${label} ${error}`);
}

function passwordInputErrors(html, label) {
  const errors = [];
  for (const [, source] of html.matchAll(INPUT_TAG)) {
    const attributes = new Map();
    for (const match of source.matchAll(TAG_ATTRIBUTE)) {
      const name = match[1].toLowerCase();
      if (!attributes.has(name)) attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '');
    }
    if (attributes.get('type')?.trim().toLowerCase() === 'password' && (attributes.get('value') ?? '') !== '') {
      errors.push(`${label} contains a password input with a value`);
    }
  }
  return errors;
}

// Orders two RFC3339 instants exactly, including leap seconds and sub-millisecond fractions.
// Returns null when either value is not comparable, so callers fail closed.
function compareInstants(left, right) {
  const a = parseInstant(left);
  const b = parseInstant(right);
  if (!a || !b) return null;
  if (a.second !== b.second) return a.second < b.second ? -1 : 1;
  const width = Math.max(a.fraction.length, b.fraction.length);
  const [x, y] = [a.fraction.padEnd(width, '0'), b.fraction.padEnd(width, '0')];
  return x < y ? -1 : x > y ? 1 : 0;
}

function parseInstant(value) {
  const match = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}:)(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}(?::?\d{2})?)$/.exec(String(value));
  if (!match) return null;
  const leap = match[3] === '60';
  const zone = /^z$/i.test(match[5]) ? 'Z' : /^[+-]\d{2}$/.test(match[5]) ? `${match[5]}:00` : /^[+-]\d{4}$/.test(match[5]) ? `${match[5].slice(0, 3)}:${match[5].slice(3)}` : match[5];
  const base = Date.parse(`${match[1]}T${match[2]}${leap ? '59' : match[3]}${zone}`);
  if (!Number.isFinite(base)) return null;
  return { second: (base / 1000) * 2 + (leap ? 1 : 0), fraction: match[4] ?? '' };
}

function isMasked(value) {
  return typeof value === 'string' && REDACTION_PLACEHOLDER.test(value);
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
