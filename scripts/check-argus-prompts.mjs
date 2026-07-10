#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS = join(ROOT, 'argus/claude/agents');
const budget = readJson('argus/prompt-budgets.json');
const comparison = readJson('argus/prompt-engagement-contract.json');
const doctrine = read('argus/shared-skills/qa-doctrine/SKILL.md');
const packagedDoctrine = read('argus/claude/skills/qa-doctrine/SKILL.md');
const competition = read('argus/shared-skills/competition-profile/SKILL.md');
const packagedCompetition = read('argus/claude/skills/competition-profile/SKILL.md');
const files = readdirSync(AGENTS).filter((file) => file.endsWith('.md')).sort();

assert(files.length === 27, `expected 27 Claude agents, found ${files.length}`);
assert(doctrine === packagedDoctrine, 'packaged qa-doctrine differs from its canonical source');
assert(competition === packagedCompetition, 'packaged competition-profile differs from its canonical source');
assert(/disable-model-invocation:\s*true/.test(competition), 'competition-profile must require explicit invocation');

const agents = new Map();
let totalWords = 0;
for (const file of files) {
  const slug = file.slice(0, -3);
  const content = readFileSync(join(AGENTS, file), 'utf8');
  agents.set(slug, content);
  const count = words(content);
  totalWords += count;
  assert(count <= budget.budgets.maxAgentWords, `${slug}: ${count} words exceeds ${budget.budgets.maxAgentWords}`);
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1] ?? '';
  assert(description, `${slug}: description missing`);
  assert(words(description) <= budget.budgets.maxDescriptionWords, `${slug}: description exceeds ${budget.budgets.maxDescriptionWords} words`);
  assert(/^skills:\s*\n(?:\s+-\s+[^\n]+\n)*\s+-\s+qa-doctrine\s*$/m.test(frontmatter), `${slug}: qa-doctrine is not preloaded`);
  assert(!/^\s+-\s+competition-profile\s*$/m.test(frontmatter), `${slug}: optional competition-profile is preloaded`);
}

const reduction = 1 - totalWords / budget.baseline.claudeAgentWords;
assert(totalWords <= budget.budgets.maxClaudeAgentWords, `Claude prompt corpus ${totalWords} exceeds ${budget.budgets.maxClaudeAgentWords}`);
assert(reduction >= 0.35, `Claude prompt corpus reduction ${(reduction * 100).toFixed(2)}% is below 35%`);

const duplicates = duplicatedParagraphs(agents, budget.budgets.duplicateParagraphMinWords);
assert(duplicates.length <= budget.budgets.maxDuplicatedDoctrineInstances,
  `found ${duplicates.length} duplicated doctrine paragraphs: ${duplicates.map((item) => `${item.files.join(',')} (${item.words} words)`).join('; ')}`);

const forbiddenDefaultProfile = [
  /\bcompetition\b/i,
  /\bcontest\b/i,
  /\brubric\b/i,
  /score-damaging/i,
  /scores?\s+(?:near\s+)?zero/i,
  /scores?\s+nothing/i,
  /\b(?:course|workshop|quiz|certificate|xp|student|instructor|grading|answer-key)s?\b/i,
];
for (const [slug, content] of agents) {
  for (const pattern of forbiddenDefaultProfile) {
    assert(!pattern.test(content), `${slug}: default prompt contains competition/scoring directive ${pattern}`);
  }
}

for (const requirement of comparison.representativeEngagement.requirements) {
  const source = requirement.source === 'qa-doctrine' ? doctrine : agents.get(requirement.source);
  assert(source, `${requirement.id}: unknown source ${requirement.source}`);
  for (const marker of requirement.markers) {
    assert(source.toLowerCase().includes(marker.toLowerCase()), `${requirement.id}: missing marker ${JSON.stringify(marker)} in ${requirement.source}`);
  }
}

console.log(`PASS  Argus prompt budget: ${totalWords}/${budget.budgets.maxClaudeAgentWords} words (${(reduction * 100).toFixed(2)}% reduction from ${budget.baseline.claudeAgentWords})`);
console.log(`PASS  Shared doctrine: ${files.length} preloads, ${duplicates.length} duplicated doctrine paragraphs, competition profile opt-in`);
console.log(`PASS  Representative Mode ${comparison.representativeEngagement.mode} engagement: ${comparison.representativeEngagement.requirements.length} output and quality requirements preserved`);

function duplicatedParagraphs(agentMap, minWords) {
  const paragraphs = new Map();
  for (const [slug, raw] of agentMap) {
    const content = raw
      .replace(/^---[\s\S]*?---\s*/, '')
      .replace(/<!-- RACI_CONTRACT_START -->[\s\S]*?<!-- RACI_CONTRACT_END -->/g, '');
    for (const paragraph of content.split(/\n\s*\n/)) {
      const normalized = paragraph.replace(/\s+/g, ' ').trim();
      const count = words(normalized);
      if (count < minWords) continue;
      const digest = createHash('sha256').update(normalized).digest('hex');
      const record = paragraphs.get(digest) ?? { words: count, files: new Set() };
      record.files.add(slug);
      paragraphs.set(digest, record);
    }
  }
  return [...paragraphs.values()]
    .filter((item) => item.files.size > 1)
    .map((item) => ({ ...item, files: [...item.files].sort() }));
}

function words(value) {
  return value.trim() ? value.trim().split(/\s+/).length : 0;
}

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

function readJson(path) {
  return JSON.parse(read(path));
}

function assert(value, message) {
  if (!value) {
    console.error(`FAIL  ${message}`);
    process.exit(1);
  }
}
