#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootIndex = process.argv.indexOf('--root');
const ROOT = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1] ?? '') : defaultRoot;
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
const agentWords = {};
let totalWords = 0;
let boundedWorkers = 0;
const corpusHash = createHash('sha256');
for (const file of files) {
  const slug = file.slice(0, -3);
  const content = readFileSync(join(AGENTS, file), 'utf8');
  agents.set(slug, content);
  const count = words(content);
  agentWords[slug] = count;
  totalWords += count;
  corpusHash.update(`${file}\0${content}`);
  assert(count <= budget.budgets.maxAgentWords, `${slug}: ${count} words exceeds ${budget.budgets.maxAgentWords}`);
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1] ?? '';
  assert(description, `${slug}: description missing`);
  assert(words(description) <= budget.budgets.maxDescriptionWords, `${slug}: description exceeds ${budget.budgets.maxDescriptionWords} words`);
  assert(/^skills:\s*\n(?:\s+-\s+[^\n]+\n)*\s+-\s+qa-doctrine\s*$/m.test(frontmatter), `${slug}: qa-doctrine is not preloaded`);
  assert(!/^\s+-\s+competition-profile\s*$/m.test(frontmatter), `${slug}: optional competition-profile is preloaded`);
  const body = content.replace(/^---[\s\S]*?---\s*/, '');
  if (slug === 'odysseus') {
    assert(body.includes('<!-- MODEL_CONTROLLER_START -->'), 'odysseus: model-controller block missing');
    assert(body.includes('argus-assets model route --manifest'), 'odysseus: capability-bound model route missing');
    assert(body.includes('argus-assets model telemetry --manifest'), 'odysseus: decision-bound model telemetry missing');
  } else {
    boundedWorkers += 1;
    assert(body.includes('<!-- MODEL_ESCALATION_START -->'), `${slug}: neutral model-escalation block missing`);
    assert(body.includes('"kind": "MODEL_ESCALATION_REQUEST"'), `${slug}: exact escalation envelope missing`);
    assert(!/\b(?:opus|sonnet|haiku|sol|terra|luna)\b/i.test(body), `${slug}: provider model token leaked into worker instructions`);
    assert(!/\bCodex\b/.test(body), `${slug}: opposite runtime leaked into worker instructions`);
    assert(!body.includes('argus-assets model route'), `${slug}: worker can invoke model routing`);
    assert(!body.includes('argus-assets model telemetry'), `${slug}: worker can invoke model telemetry`);
    assert(!body.includes('MODEL_POLICY_START'), `${slug}: legacy cross-runtime model policy remains`);
  }
}
assert(boundedWorkers === 26, `expected 26 bounded workers, found ${boundedWorkers}`);

const corpusSha256 = corpusHash.digest('hex');
const approvedAgents = budget.approvedCorpus.agents;
assert(Object.keys(approvedAgents).sort().join(',') === [...agents.keys()].sort().join(','),
  'approved prompt corpus roster differs from the current 27-agent roster');
const increases = Object.fromEntries(Object.entries(agentWords)
  .filter(([slug, count]) => count > approvedAgents[slug])
  .map(([slug, count]) => [slug, count - approvedAgents[slug]]));
if (Object.keys(increases).length > 0 || totalWords > budget.approvedCorpus.words) {
  const approval = budget.regressionApproval;
  assert(approval, `prompt regression requires explicit regressionApproval: ${JSON.stringify(increases)}`);
  assert(approval.corpusSha256 === corpusSha256, 'regressionApproval does not match the current prompt corpus SHA-256');
  assert(/^#[0-9]+$/.test(approval.issue) && approval.approvedBy && approval.reason,
    'regressionApproval requires an issue, approver, and reason');
  assert(JSON.stringify(approval.allowedAgentIncreases) === JSON.stringify(increases),
    `regressionApproval must exactly enumerate agent increases: ${JSON.stringify(increases)}`);
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
console.log(`PASS  Prompt regression gate: ${Object.keys(increases).length} agent increases, corpus ${corpusSha256.slice(0, 12)}, explicit approval ${Object.keys(increases).length ? 'verified' : 'not required'}`);
console.log(`PASS  Shared doctrine: ${files.length} preloads, ${duplicates.length} duplicated doctrine paragraphs, competition profile opt-in`);
console.log(`PASS  Model-control boundary: ${boundedWorkers} neutral workers, one routing/telemetry controller`);
console.log(`PASS  Representative Mode ${comparison.representativeEngagement.mode} engagement: ${comparison.representativeEngagement.requirements.length} output and quality requirements preserved`);

function duplicatedParagraphs(agentMap, minWords) {
  const paragraphs = new Map();
  for (const [slug, raw] of agentMap) {
    const content = raw
      .replace(/^---[\s\S]*?---\s*/, '')
      .replace(/<!-- RACI_CONTRACT_START -->[\s\S]*?<!-- RACI_CONTRACT_END -->/g, '')
      .replace(/<!-- MODEL_ESCALATION_START -->[\s\S]*?<!-- MODEL_ESCALATION_END -->/g, '');
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
