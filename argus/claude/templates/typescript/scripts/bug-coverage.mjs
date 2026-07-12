#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE = process.env.SMOKE === '1';
const ledgerPath = join(ROOT, 'solution', 'bug-ledger.json');
const summaryPath = join(ROOT, 'reports', 'summary.json');

const result = {
  status: 'pass',
  smoke: SMOKE,
  total_confirmed: 0,
  wired_confirmed: 0,
  uncovered: [],
  errors: [],
};

if (!existsSync(ledgerPath)) {
  fail(`missing ${rel(ledgerPath)}; Minos must create it from solution/bug-ledger.example.json`);
} else {
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  } catch (err) {
    fail(`${rel(ledgerPath)} is not valid JSON: ${err.message}`);
  }

  const entries = Array.isArray(ledger) ? ledger : ledger?.bugs;
  if (!Array.isArray(entries)) {
    fail(`${rel(ledgerPath)} must be an argus/bug-ledger@1 document with a bugs array`);
  } else {
    if (!Array.isArray(ledger)) {
      if (ledger.$schema !== 'argus/bug-ledger@1' || ledger.schemaVersion !== 1) fail(`${rel(ledgerPath)} has an unsupported schema version`);
    } else {
      result.errors.push(`${rel(ledgerPath)} uses the legacy array shape; migrate it to argus/bug-ledger@1`);
    }
    const confirmed = entries.filter((entry) => String(entry.status ?? 'confirmed').toLowerCase() !== 'suspected' && entry.confirmed !== false);
    result.total_confirmed = confirmed.length;

    const { linkedTags: tags, unselectedTags } = collectBugTags(join(ROOT, 'tests'));
    if (unselectedTags.size > 0) {
      fail(`bug provenance without @regression selection marker: ${[...unselectedTags].sort().join(', ')}`);
    }
    for (const entry of confirmed) {
      const ids = [entry.id, ...(Array.isArray(entry.origin) ? entry.origin : [])].filter(Boolean).map(String);
      if (!ids.length) {
        result.uncovered.push('(entry missing id/origin)');
        continue;
      }
      if (ids.some((id) => tags.has(id))) {
        result.wired_confirmed += 1;
      } else {
        result.uncovered.push(ids[0]);
      }
    }

    if (result.uncovered.length) {
      fail(`uncovered confirmed bugs: ${result.uncovered.join(', ')}`);
    }
  }
}

if (result.errors.length) result.status = SMOKE ? 'warning' : 'fail';
writeSummary({ bug_coverage: result });

const line = `bug_coverage: ${result.wired_confirmed}/${result.total_confirmed} wired` +
  (result.uncovered.length ? `; uncovered: ${result.uncovered.join(', ')}` : '; uncovered: none');
console.log(`${SMOKE && result.errors.length ? 'WARNING' : result.status.toUpperCase()}: ${line}`);
if (result.errors.length) {
  for (const error of result.errors) console.error(`bug-coverage: ${error}`);
}
process.exit(result.errors.length && !SMOKE ? 1 : 0);

function fail(message) {
  result.errors.push(message);
}

function collectBugTags(dir) {
  const linkedTags = new Set();
  const unselectedTags = new Set();
  if (!existsSync(dir)) return { linkedTags, unselectedTags };
  for (const file of walk(dir)) {
    const ext = extname(file);
    if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) continue;
    const text = readFileSync(file, 'utf8');
    const tokens = tokenize(text);
    const testBindings = importedTestBindings(tokens, file);
    for (const declaration of playwrightTests(tokens, testBindings)) {
      const tags = [declaration.title, ...declaration.detailTags].join(' ');
      for (const match of tags.matchAll(/@bug:([A-Za-z]+-\d{3,4}|BUG-\d{4})/g)) {
        if (/@regression\b/.test(tags)) linkedTags.add(match[1]);
        else unselectedTags.add(match[1]);
      }
    }
  }
  return { linkedTags, unselectedTags };
}

function importedTestBindings(tokens, file) {
  const bindings = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value !== 'import' || tokens[index + 1]?.value !== '{') continue;
    const close = matchingPunctuation(tokens, index + 1, '{', '}');
    if (close === -1 || tokens[close + 1]?.value !== 'from' || tokens[close + 2]?.kind !== 'string') continue;
    if (!isApprovedTestModule(tokens[close + 2].value, file)) continue;

    for (let cursor = index + 2; cursor < close;) {
      if (tokens[cursor]?.value === ',') {
        cursor += 1;
        continue;
      }
      const imported = tokens[cursor];
      if (imported?.kind !== 'identifier') break;
      let local = imported.value;
      if (tokens[cursor + 1]?.value === 'as' && tokens[cursor + 2]?.kind === 'identifier') {
        local = tokens[cursor + 2].value;
        cursor += 3;
      } else {
        cursor += 1;
      }
      if (imported.value === 'test') bindings.add(local);
      while (cursor < close && tokens[cursor]?.value !== ',') cursor += 1;
    }
    index = close + 2;
  }
  return bindings;
}

function isApprovedTestModule(specifier, importingFile) {
  if (specifier === '@playwright/test') return true;
  if (!/^\.{1,2}\//.test(specifier)) return false;
  const imported = withoutModuleExtension(resolve(dirname(importingFile), specifier));
  const canonicalFixture = resolve(ROOT, 'src', 'fixtures', 'fixtures');
  return imported === canonicalFixture;
}

function withoutModuleExtension(path) {
  return path.replace(/\.(?:[cm]?[jt]sx?)$/i, '');
}

function matchingPunctuation(tokens, start, open, close) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].value === open) depth += 1;
    else if (tokens[index].value === close && --depth === 0) return index;
  }
  return -1;
}

function* playwrightTests(tokens, testBindings) {
  const disabledModifiers = new Set(['skip', 'fixme', 'fail']);
  const tokenScopes = testBindingScopes(tokens, testBindings);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== 'identifier' || !testBindings.has(token.value)) continue;
    if (bindingIsShadowed(tokenScopes[index], token.value)) continue;
    if (tokens[index - 1]?.value === '.') continue;

    let cursor = index + 1;
    if (tokens[cursor]?.value === '.') {
      const modifier = tokens[cursor + 1]?.value;
      if (disabledModifiers.has(modifier)) continue;
      if (modifier !== 'only') continue;
      cursor += 2;
    }
    if (tokens[cursor]?.value !== '(' || tokens[cursor + 1]?.kind !== 'string') continue;
    const title = tokens[cursor + 1].value;
    cursor += 2;
    if (tokens[cursor]?.value !== ',') continue;
    cursor += 1;

    let detailTags = [];
    if (tokens[cursor]?.value === '{') {
      const details = parseDetailsObject(tokens, cursor);
      if (details && tokens[details.end + 1]?.value === ',') detailTags = details.tags;
    }
    yield { title, detailTags };
  }
}

function testBindingScopes(tokens, testBindings) {
  const root = { parent: null, shadows: new Set() };
  const tokenScopes = Array(tokens.length).fill(root);
  const stack = [root];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value === '{') {
      const scope = { parent: stack.at(-1), shadows: parameterShadowsForBody(tokens, index, testBindings) };
      stack.push(scope);
      tokenScopes[index] = scope;
      continue;
    }
    tokenScopes[index] = stack.at(-1);
    if (tokens[index].value === '}' && stack.length > 1) stack.pop();
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const keyword = tokens[index].value;
    if (['const', 'let', 'var'].includes(keyword)) {
      collectVariableShadows(tokens, index + 1, tokenScopes[index].shadows, testBindings);
    } else if (['function', 'class'].includes(keyword)) {
      let cursor = index + 1;
      if (tokens[cursor]?.value === '*') cursor += 1;
      if (tokens[cursor]?.kind === 'identifier' && testBindings.has(tokens[cursor].value)) {
        tokenScopes[index].shadows.add(tokens[cursor].value);
      }
    }
  }
  return tokenScopes;
}

function parameterShadowsForBody(tokens, bodyStart, testBindings) {
  let close = -1;
  if (tokens[bodyStart - 1]?.value === '>' && tokens[bodyStart - 2]?.value === '=') {
    close = bodyStart - 3;
    if (tokens[close]?.kind === 'identifier') {
      return testBindings.has(tokens[close].value) ? new Set([tokens[close].value]) : new Set();
    }
  } else if (tokens[bodyStart - 1]?.value === ')') {
    close = bodyStart - 1;
  }
  if (close < 0 || tokens[close]?.value !== ')') return new Set();
  const open = matchingPunctuationBackward(tokens, close, '(', ')');
  if (open === -1) return new Set();

  const arrow = tokens[bodyStart - 1]?.value === '>' && tokens[bodyStart - 2]?.value === '=';
  const prefix = tokens.slice(Math.max(0, open - 5), open).map(({ value }) => value);
  const callableBody = arrow || prefix.includes('function') || tokens[open - 1]?.value === 'catch';
  return callableBody ? parameterBindingNames(tokens, open + 1, close, testBindings) : new Set();
}

function matchingPunctuationBackward(tokens, start, open, close) {
  let depth = 0;
  for (let index = start; index >= 0; index -= 1) {
    if (tokens[index].value === close) depth += 1;
    else if (tokens[index].value === open && --depth === 0) return index;
  }
  return -1;
}

function parameterBindingNames(tokens, start, end, testBindings) {
  const shadows = new Set();
  let segmentStart = start;
  let depth = 0;
  for (let index = start; index <= end; index += 1) {
    const value = tokens[index]?.value;
    if (index === end || (value === ',' && depth === 0)) {
      collectParameterSegment(tokens, segmentStart, index, shadows, testBindings);
      segmentStart = index + 1;
      continue;
    }
    if (['(', '[', '{'].includes(value)) depth += 1;
    else if ([')', ']', '}'].includes(value)) depth -= 1;
  }
  return shadows;
}

function collectParameterSegment(tokens, start, end, shadows, testBindings) {
  const first = tokens.slice(start, end).find((token) => token.kind === 'identifier');
  if (first && testBindings.has(first.value)) shadows.add(first.value);
}

function collectVariableShadows(tokens, start, shadows, testBindings) {
  let expectBinding = true;
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (depth === 0 && [';', ')'].includes(token.value)) return;
    if (depth === 0 && token.value === ',') {
      expectBinding = true;
      continue;
    }
    if (expectBinding && token.kind === 'identifier') {
      if (testBindings.has(token.value)) shadows.add(token.value);
      expectBinding = false;
    }
    if (['(', '[', '{'].includes(token.value)) depth += 1;
    else if ([')', ']', '}'].includes(token.value)) depth -= 1;
  }
}

function bindingIsShadowed(scope, binding) {
  for (let current = scope; current; current = current.parent) {
    if (current.shadows.has(binding)) return true;
  }
  return false;
}

function parseDetailsObject(tokens, start) {
  let braces = 1;
  let brackets = 0;
  let parentheses = 0;
  const tagProperties = [];
  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === '{') {
      braces += 1;
      continue;
    }
    if (token.value === '}') {
      braces -= 1;
      if (braces === 0) {
        const tags = tagProperties.length === 1 && tagProperties[0].valid ? tagProperties[0].tags : [];
        return { end: index, tags };
      }
      continue;
    }
    if (token.value === '[') {
      brackets += 1;
      continue;
    }
    if (token.value === ']') {
      brackets -= 1;
      continue;
    }
    if (token.value === '(') {
      parentheses += 1;
      continue;
    }
    if (token.value === ')') {
      parentheses -= 1;
      continue;
    }
    if (braces !== 1 || brackets !== 0 || parentheses !== 0) continue;
    if (!['{', ','].includes(tokens[index - 1]?.value)) continue;
    if (!['identifier', 'string'].includes(token.kind) || token.value !== 'tag') continue;
    if (tokens[index + 1]?.value !== ':') continue;
    tagProperties.push(parseStaticTags(tokens, index + 2));
  }
  return null;
}

function parseStaticTags(tokens, start) {
  if (tokens[start]?.kind === 'string') return { valid: true, tags: [tokens[start].value] };
  if (tokens[start]?.value !== '[') return { valid: false, tags: [] };
  const tags = [];
  let expectValue = true;
  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === ']') return { valid: expectValue ? tags.length === 0 || tokens[index - 1]?.value === ',' : true, tags };
    if (expectValue && token.kind === 'string') {
      tags.push(token.value);
      expectValue = false;
      continue;
    }
    if (!expectValue && token.value === ',') {
      expectValue = true;
      continue;
    }
    return { valid: false, tags: [] };
  }
  return { valid: false, tags: [] };
}

function tokenize(text) {
  const tokens = [];
  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index + 2);
      index = newline < 0 ? text.length : newline + 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 2;
      continue;
    }
    if (char === '\'' || char === '"') {
      const literal = readQuotedString(text, index, char);
      tokens.push({ kind: 'string', value: literal.value });
      index = literal.end;
      continue;
    }
    if (char === '`') {
      const literal = readTemplate(text, index);
      if (literal.static) tokens.push({ kind: 'string', value: literal.value });
      index = literal.end;
      continue;
    }
    if (isIdentifierStart(char)) {
      let end = index + 1;
      while (isIdentifierPart(text[end] ?? '')) end += 1;
      tokens.push({ kind: 'identifier', value: text.slice(index, end) });
      index = end;
      continue;
    }
    if (/\d/.test(char)) {
      let end = index + 1;
      while (/[\w.]/.test(text[end] ?? '')) end += 1;
      tokens.push({ kind: 'number', value: text.slice(index, end) });
      index = end;
      continue;
    }
    if (char === '/' && canStartRegex(tokens.at(-1))) {
      index = regexEnd(text, index);
      continue;
    }
    tokens.push({ kind: 'punctuation', value: char });
    index += 1;
  }
  return tokens;
}

function readQuotedString(text, start, quote) {
  let value = '';
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') {
      const escaped = text[index + 1];
      if (escaped === '\n' || escaped === '\r') index += escaped === '\r' && text[index + 2] === '\n' ? 2 : 1;
      else {
        value += escaped ?? '';
        index += 1;
      }
      continue;
    }
    if (char === quote) return { value, end: index + 1 };
    value += char;
  }
  return { value, end: text.length };
}

function readTemplate(text, start) {
  let value = '';
  let dynamic = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') {
      value += text[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (char === '`') return { static: !dynamic, value, end: index + 1 };
    if (char === '$' && text[index + 1] === '{') {
      dynamic = true;
      index = templateExpressionEnd(text, index + 2) - 1;
      continue;
    }
    value += char;
  }
  return { static: false, value: '', end: text.length };
}

function templateExpressionEnd(text, start) {
  let depth = 1;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\'' || char === '"') {
      index = readQuotedString(text, index, char).end - 1;
      continue;
    }
    if (char === '`') {
      index = readTemplate(text, index).end - 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index + 2);
      index = newline < 0 ? text.length : newline;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return index + 1;
  }
  return text.length;
}

function regexEnd(text, start) {
  let characterClass = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '[') characterClass = true;
    else if (char === ']') characterClass = false;
    else if (char === '/' && !characterClass) {
      index += 1;
      while (/[A-Za-z]/.test(text[index] ?? '')) index += 1;
      return index;
    }
    if (char === '\n' || char === '\r') return index;
  }
  return text.length;
}

function canStartRegex(previous) {
  if (!previous) return true;
  if (previous.kind === 'identifier') return ['return', 'throw', 'case', 'yield', 'await', 'else', 'do'].includes(previous.value);
  return ['(', '[', '{', ',', ':', ';', '=', '!', '?', '&', '|', '+', '-', '*', '%', '^', '~', '<', '>'].includes(previous.value);
}

function isIdentifierStart(char) {
  return /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char) {
  return /[A-Za-z0-9_$]/.test(char);
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (st.isFile()) yield p;
  }
}

function writeSummary(fragment) {
  mkdirSync(dirname(summaryPath), { recursive: true });
  let summary = {};
  if (existsSync(summaryPath)) {
    try {
      summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    } catch {
      summary = {};
    }
  }
  writeFileSync(summaryPath, JSON.stringify({ ...summary, ...fragment, generated_at: new Date().toISOString() }, null, 2) + '\n');
}

function rel(path) {
  return path.replace(`${ROOT}/`, '');
}
