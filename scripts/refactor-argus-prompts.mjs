#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? '--check';
if (!['--check', '--write'].includes(mode)) fail('usage: refactor-argus-prompts.mjs [--check|--write]');

const agentDir = join(ROOT, 'argus/claude/agents');
const files = readdirSync(agentDir).filter((file) => file.endsWith('.md')).sort();
const sharedHeadings = [
  'Authorization Gate (mandatory)',
  'Evidence Safety (mandatory)',
  'Engagement Lease and Write Guard (mandatory)',
  'Deep-QA Hardening (mandatory)',
  'Adopt-or-Build Gate (mandatory before writing tests/strategy/framework)',
  'Identity & Naming',
  'Working With The Team',
  'Lessons',
  'Heartbeat — progress signal (mandatory)',
  'Token Economy',
  'Artifact Language',
  'Parallel Lanes & Engineering Standards (mandatory, all agents)',
];

let changed = 0;
for (const file of files) {
  const path = join(agentDir, file);
  const original = readFileSync(path, 'utf8');
  let content = original;

  if (mode === '--write') {
    content = preloadSkill(content);
    for (const heading of sharedHeadings) content = removeSection(content, heading);
    content = rewriteLegacyReferences(content);
    content = content.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
    if (content !== original) {
      writeFileSync(path, content);
      changed += 1;
    }
  } else {
    assert(hasPreloadedSkill(content), `${file}: qa-doctrine is not preloaded`);
    for (const heading of sharedHeadings) {
      assert(!content.includes(`## ${heading}`), `${file}: legacy shared section remains: ${heading}`);
    }
  }
}

console.log(`${mode === '--write' ? 'WROTE' : 'PASS '} Argus prompt refactor: ${files.length} agents${mode === '--write' ? `, ${changed} changed` : ''}`);

function preloadSkill(content) {
  if (hasPreloadedSkill(content)) return content;
  const end = content.indexOf('\n---', 4);
  assert(end > 0, 'frontmatter closing delimiter missing');
  return `${content.slice(0, end)}\nskills:\n  - qa-doctrine${content.slice(end)}`;
}

function hasPreloadedSkill(content) {
  const end = content.indexOf('\n---', 4);
  const frontmatter = end > 0 ? content.slice(0, end) : '';
  return /^skills:\s*\n(?:\s+-\s+[^\n]+\n)*\s+-\s+qa-doctrine\s*$/m.test(frontmatter);
}

function removeSection(content, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\n## ${escaped}\\s*\\n[\\s\\S]*?(?=\\n## (?!#)|\\n<!-- Author:|$)`, 'g');
  return content.replace(pattern, '');
}

function rewriteLegacyReferences(content) {
  const generic = content
    .replace(/\*\*\(See "Deep-QA Hardening[^\n]*\)\*\*/g, '**The preloaded `qa-doctrine` hard bans apply.**')
    .replace(/from §Deep-QA Hardening/g, 'listed in this workflow')
    .replace(/per the header-oracle rule in §Deep-QA Hardening/g, 'with the header oracle below')
    .replace(/the §Deep-QA grid/g, 'the preloaded `qa-doctrine` coverage grid')
    .replace(/§Deep-QA oracle 3/g, 'the single-request clamp oracle')
    .replace(/§BROWSER ISOLATION/g, 'the preloaded `qa-doctrine` browser-isolation contract')
    .replace(/BROWSER ISOLATION below/g, 'the preloaded `qa-doctrine` browser-isolation contract')
    .replace(/Deep-QA Hardening below/g, 'the preloaded `qa-doctrine`')
    .replace(/see Deep-QA Hardening/g, 'see the preloaded `qa-doctrine`')
    .replace(/in Deep-QA Hardening/g, 'in the preloaded `qa-doctrine`')
    .replace(/Deep-QA Hardening mandate/g, 'preloaded `qa-doctrine` mandate')
    .replace(/brilliant unwritten bug scores zero/gi, 'strong unwritten bug is not delivered')
    .replace(/half-committed ([^.]+?) scores nothing/gi, 'half-committed $1 is not delivered')
    .replace(/A non-running suite scores near zero on the criterion you serve\./g, 'A non-running suite does not satisfy the criterion you serve.')
    .replace(/A non-running suite, or one that green-encodes a known vuln, scores near zero on the criterion you own\./g, 'A non-running suite, or one that green-encodes a known vulnerability, does not satisfy the criterion you own.')
    .replace(/budget mode is cheap and scores/g, 'budget mode is cheap and contract-relevant')
    .replace(/most score-damaging, cheapest-to-fix gaps/g, 'highest-impact, cheapest-to-fix gaps');
  return generic
    .replace(/\bcourses\b/gi, 'resources')
    .replace(/\bcourse\b/gi, 'resource')
    .replace(/\bworkshops\b/gi, 'cross-feature workflows')
    .replace(/\bworkshop\b/gi, 'cross-feature workflow')
    .replace(/\bquizzes\b/gi, 'assessments')
    .replace(/\bquiz\b/gi, 'assessment')
    .replace(/\bcertificates\b/gi, 'credentials')
    .replace(/\bcertificate\b/gi, 'credential')
    .replace(/\bXP\b/g, 'reward')
    .replace(/\bstudents\b/gi, 'participants')
    .replace(/\bstudent\b/gi, 'participant')
    .replace(/\binstructors\b/gi, 'operators')
    .replace(/\binstructor\b/gi, 'operator')
    .replace(/\bgrading\/scoring\b/gi, 'evaluation')
    .replace(/\bgrading\b/gi, 'evaluation')
    .replace(/\banswer-key\b/gi, 'protected solution');
}

function assert(value, message) {
  if (!value) fail(message);
}

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}
