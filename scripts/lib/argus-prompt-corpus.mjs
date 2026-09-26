// Shared prompt-corpus measurement for the Argus prompt gate and its maintainer approval tool.
// One implementation of word counting and corpus hashing keeps the check, the approval tool,
// and a historical revision's baseline hash on the same encoding.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const AGENTS_DIR = 'argus/claude/agents';
export const CODEX_DIR = 'argus/codex';
export const SHARED_SKILLS_DIR = 'argus/shared-skills';
export const CAPABILITY_MATRIX = 'argus/capabilities/capability-matrix.json';
export const PLUGIN_MANIFEST = 'argus/claude/.claude-plugin/plugin.json';
export const BENCHMARK_METRICS = ['meanRecall', 'meanCriticalRecall', 'meanPrecision'];

const METRIC_TOLERANCE = {
  meanRecall: 'recallTolerance',
  meanCriticalRecall: 'criticalRecallTolerance',
  meanPrecision: 'precisionTolerance',
};
// Absorbs binary floating-point noise in `baseline - tolerance`; far below any meaningful metric step.
const FLOAT_EPSILON = 1e-12;

export function words(value) {
  return value.trim() ? value.trim().split(/\s+/u).length : 0;
}

export function frontmatter(content) {
  return content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
}

export function frontmatterList(block, field) {
  const list = block.match(new RegExp(`^${field}:\\s*\\n((?:\\s+-\\s+[^\\n]+\\n?)*)`, 'm'))?.[1] ?? '';
  return [...list.matchAll(/^\s+-\s+([^\s#]+)\s*$/gm)].map((match) => match[1]);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Digest over every Claude agent file in sorted name order, then every doctrine profile in
// sorted name order. The agent encoding is unchanged from schema v1; profiles are appended so
// a doctrine rewrite can no longer pass under an unchanged agent corpus.
export function hashPromptCorpus({ agents, profiles }) {
  const hash = createHash('sha256');
  for (const file of [...agents.keys()].sort()) hash.update(`${file}\0${agents.get(file)}`);
  for (const name of [...profiles.keys()].sort()) hash.update(`profile:${name}\0${profiles.get(name)}`);
  return hash.digest('hex');
}

export function doctrineProfileNames(matrix) {
  const profiles = matrix?.doctrineProfiles;
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
    throw new Error('capability matrix declares no doctrineProfiles object');
  }
  return Object.keys(profiles).sort();
}

export function computePromptCorpus(root) {
  const read = (path) => readFileSync(join(root, path), 'utf8');
  const matrix = JSON.parse(read(CAPABILITY_MATRIX));
  const profileText = new Map();
  const loadProfile = (name) => {
    if (!profileText.has(name)) profileText.set(name, read(`${SHARED_SKILLS_DIR}/${name}/SKILL.md`));
    return profileText.get(name);
  };
  const doctrine = new Map(doctrineProfileNames(matrix).map((name) => [name, loadProfile(name)]));

  const agentFiles = new Map();
  const agents = {};
  let totalWords = 0;
  let effectiveWords = 0;
  for (const file of readdirSync(join(root, AGENTS_DIR)).filter((name) => name.endsWith('.md')).sort()) {
    const content = read(`${AGENTS_DIR}/${file}`);
    agentFiles.set(file, content);
    const count = words(content);
    agents[file.slice(0, -3)] = count;
    totalWords += count;
    const preloaded = frontmatterList(frontmatter(content), 'skills');
    effectiveWords += count + preloaded.reduce((sum, name) => sum + words(loadProfile(name)), 0);
  }

  let codexCharacters = 0;
  for (const file of readdirSync(join(root, CODEX_DIR)).filter((name) => name.endsWith('.toml')).sort()) {
    codexCharacters += read(`${CODEX_DIR}/${file}`).length;
  }

  return {
    sha256: hashPromptCorpus({ agents: agentFiles, profiles: doctrine }),
    words: totalWords,
    effectiveWords,
    codexEstimatedTokens: Math.ceil(codexCharacters / 4),
    agents,
    profiles: Object.fromEntries([...doctrine].map(([name, text]) => [name, words(text)])),
  };
}

export function readArgusPluginVersion(root) {
  const version = JSON.parse(readFileSync(join(root, PLUGIN_MANIFEST), 'utf8')).version;
  if (typeof version !== 'string' || !version) throw new Error(`${PLUGIN_MANIFEST} has no version`);
  return version;
}

// Non-regression of a candidate corpus against an adjudicated baseline. The caller separately
// binds `evidence.candidate.corpusSha256` to the corpus being approved.
export function evaluateNonRegression(evidence, nonRegression) {
  const errors = [];
  if (!nonRegression || typeof nonRegression !== 'object') return ['nonRegression tolerances are missing'];
  const minRepeats = nonRegression.minRepeats;
  if (!Number.isInteger(minRepeats) || minRepeats < 1) errors.push('nonRegression.minRepeats must be a positive integer');
  for (const key of Object.values(METRIC_TOLERANCE)) {
    if (!isUnitInterval(nonRegression[key])) errors.push(`nonRegression.${key} must be a number in [0,1]`);
  }
  const { baseline, candidate } = evidence ?? {};
  for (const [side, record] of [['baseline', baseline], ['candidate', candidate]]) {
    if (!record || typeof record !== 'object') {
      errors.push(`benchmark ${side} evidence is missing`);
      continue;
    }
    if (!/^[0-9a-f]{64}$/.test(record.corpusSha256 ?? '')) errors.push(`benchmark ${side}.corpusSha256 must be a sha256 digest`);
    if (!Number.isInteger(record.runs) || record.runs < 1) errors.push(`benchmark ${side}.runs must be a positive integer`);
    else if (Number.isInteger(minRepeats) && record.runs < minRepeats) {
      errors.push(`benchmark ${side} has ${record.runs} runs; nonRegression.minRepeats is ${minRepeats}`);
    }
    for (const metric of BENCHMARK_METRICS) {
      const value = record[metric];
      if (metric === 'meanCriticalRecall' && value === null) continue;
      if (!isUnitInterval(value)) errors.push(`benchmark ${side}.${metric} must be a number in [0,1]`);
    }
  }
  if (errors.length > 0) return errors;
  if (baseline.corpusSha256 === candidate.corpusSha256) {
    errors.push('benchmark baseline and candidate share one corpus sha256; the comparison measures no prompt change');
  }
  for (const metric of BENCHMARK_METRICS) {
    const base = baseline[metric];
    const cand = candidate[metric];
    if (base === null || cand === null) continue;
    const tolerance = nonRegression[METRIC_TOLERANCE[metric]];
    if (cand + FLOAT_EPSILON < base - tolerance) errors.push(`benchmark regression: ${metric} ${cand} < ${base} - ${tolerance}`);
  }
  return errors;
}

function isUnitInterval(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
