#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const DEFAULT_ALLOWED = [
  'tests/',
  'bugs/',
  'solution/',
  'reports/',
  'ai_agents_internal/',
  'src/',
  'scripts/',
  '.claude/',
  '.auth/',
  'README.md',
  'index.html',
  'run-tests.sh',
  'package.json',
  'package-lock.json',
  'playwright.config.ts',
  'tsconfig.json',
  'openapi.json',
];

const raw = readStdin();
if (!raw.trim()) process.exit(0);

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  // If Claude's hook payload format changes, fail closed for write tools.
  console.error('Argus QA app-source guard: could not parse PreToolUse JSON payload');
  process.exit(2);
}

const toolInput = payload.tool_input ?? payload.input ?? {};
const cwd = resolve(payload.cwd ?? process.cwd());
const allowed = (process.env.ARGUS_ALLOWED_WRITE_ROOTS ?? DEFAULT_ALLOWED.join(','))
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const touched = collectPaths(toolInput);
if (isWriteTool(payload.tool_name ?? payload.tool ?? '') && touched.length === 0) {
  console.error('Argus QA app-source guard: write tool payload did not include a recognized file path');
  process.exit(2);
}

const blocked = touched.filter((filePath) => !isAllowed(filePath, cwd, allowed));

if (blocked.length) {
  console.error('Argus QA app-source guard blocked write outside deliverables:');
  for (const filePath of blocked) console.error(`- ${toRelative(filePath, cwd)}`);
  console.error(`Allowed roots/files: ${allowed.join(', ')}`);
  console.error('Set ARGUS_ALLOWED_WRITE_ROOTS to override after Kalchas/Atlas confirm the harness layout.');
  process.exit(2);
}

process.exit(0);

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function collectPaths(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && /(^file_path$|path$|_path$|file$|target$)/i.test(key)) {
      out.push(child);
    } else if (Array.isArray(child)) {
      for (const item of child) collectPaths(item, out);
    } else if (child && typeof child === 'object') {
      collectPaths(child, out);
    }
  }
  return out;
}

function isWriteTool(toolName) {
  return /^(Write|Edit|MultiEdit)$/i.test(String(toolName));
}

function isAllowed(filePath, cwd, allowed) {
  const absolute = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
  const rel = toRelative(absolute, cwd);
  if (rel.startsWith('..') || rel === '') return false;
  if (rel.includes(`${sep}.git${sep}`) || rel === '.git') return false;
  const normalized = rel.split(sep).join('/');
  return allowed.some((entry) => {
    const clean = entry.replace(/^.\//, '');
    if (clean.endsWith('/')) return normalized.startsWith(clean);
    return normalized === clean;
  });
}

function toRelative(filePath, cwd) {
  const absolute = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
  return relative(cwd, absolute) || '.';
}
