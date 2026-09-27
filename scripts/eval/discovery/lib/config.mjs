// Loads and normalizes an argus-eval/comparison-config@2 document. The JSON Schema carries the
// structural rules; the checks the runtime validator cannot express (distinct variant names,
// an absolute adapter executable, seeds matching repeats, the smoke-only testMode, a physical
// workRoot, and regression replay only with Mode A) are enforced here.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { assertEval } from './schemas.mjs';

export const CONFIG_SCHEMA = 'argus-eval/comparison-config@2';
export const MODES = Object.freeze(['A', 'B']);
export const BUILDS = Object.freeze(['faulty', 'corrected']);
// Realistic defaults: Mode A (hunt plus regression automation) 8 h, Mode B (hunt) 4 h.
export const DEFAULT_SECONDS = Object.freeze({ A: 28800, B: 14400 });
export const MIN_SECONDS = 1800;
// Always passed to the adapter with unchanged values, so they may not be listed again.
export const BASE_ENV = Object.freeze(['PATH', 'HOME', 'TMPDIR']);
// Mode A regression replay: repeats of the all-on and all-off cases, the per-seed matrix, and
// the wall-clock budget of one generated-suite run (the adapter group is killed 60 s later).
export const REPLAY_DEFAULTS = Object.freeze({ repeats: 2, perSeedMatrix: true, secondsPerRunner: 1800 });
export const MIN_REPLAY_SECONDS = 60;

// Returns the path when it is an existing, non-aliased directory whose realpath equals itself.
export function physicalDirectory(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  let stat;
  try { stat = lstatSync(path); } catch { throw new Error(`${label} ${path} does not exist`); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} ${path} must be a directory, not a symbolic link`);
  const physical = realpathSync(path);
  if (physical !== path) throw new Error(`${label} must use its physical normalized path: ${physical}`);
  return path;
}

export function loadConfig(configPath, { env = process.env } = {}) {
  const path = resolve(configPath);
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`comparison config ${path} is not readable JSON: ${error.message}`);
  }
  return normalizeConfig(raw, { baseDir: dirname(path), env });
}

// `baseDir` resolves a relative corpusModule (the configuration file's directory).
export function normalizeConfig(raw, { baseDir, env = process.env } = {}) {
  if (Array.isArray(raw?.adapterEnv)) {
    const reserved = raw.adapterEnv.filter(name => BASE_ENV.includes(name));
    if (reserved.length) throw new Error(`adapterEnv must not list ${reserved.join(', ')}: PATH, HOME and TMPDIR are always passed with unchanged values`);
  }
  if (raw?.testMode === true && env.ARGUS_EVAL_SMOKE !== '1') throw new Error('testMode is reserved for the evaluator smoke tests (requires ARGUS_EVAL_SMOKE=1)');
  assertEval('comparison-config', raw, 'comparison config');
  const testMode = raw.testMode === true;
  const names = raw.variants.map(variant => variant.name);
  if (new Set(names).size !== names.length) throw new Error('variant names must be distinct');
  for (const variant of raw.variants) {
    if (!isAbsolute(variant.command[0])) throw new Error(`variant ${variant.name}: command[0] must be an absolute executable path`);
  }
  if (raw.seeds !== undefined && raw.seeds.length !== raw.repeats) throw new Error(`seeds must list exactly one seed per repeat (${raw.repeats})`);
  const secondsByMode = { ...DEFAULT_SECONDS, ...raw.secondsByMode };
  const minimum = testMode ? 1 : MIN_SECONDS;
  for (const mode of MODES) {
    if (secondsByMode[mode] < minimum) throw new Error(`secondsByMode.${mode} must be at least ${minimum}`);
  }
  const modes = [...(raw.modes ?? ['B'])];
  const replay = normalizeReplay(raw.replay, { modes, testMode });
  const workRoot = physicalDirectory(raw.workRoot ?? realpathSync(tmpdir()), 'workRoot');
  let corpusModule = null;
  if (raw.corpusModule !== undefined) {
    if (!isAbsolute(raw.corpusModule) && !baseDir) throw new Error('a relative corpusModule needs the configuration directory');
    corpusModule = isAbsolute(raw.corpusModule) ? resolve(raw.corpusModule) : resolve(baseDir, raw.corpusModule);
  }
  return {
    schema: CONFIG_SCHEMA,
    variants: raw.variants.map(({ name, revision, command }) => ({ name, revision, command: [...command] })),
    modes,
    builds: [...(raw.builds ?? BUILDS)],
    repeats: raw.repeats,
    seeds: raw.seeds ? [...raw.seeds] : null,
    secondsByMode,
    tokens: raw.tokens ?? null,
    workRoot,
    adapterEnv: [...(raw.adapterEnv ?? [])],
    replay,
    corpusModule,
    testMode,
  };
}

// Replay is on by default whenever Mode A runs. A disabled replay normalizes to exactly
// {enabled: false}: it has no settings, because nothing is replayed.
function normalizeReplay(raw = {}, { modes, testMode }) {
  const enabled = raw.enabled ?? modes.includes('A');
  if (!enabled) return { enabled: false };
  if (!modes.includes('A')) throw new Error('replay.enabled requires mode A in modes: regression replay runs the Mode A regression suite');
  const replay = { enabled: true, ...REPLAY_DEFAULTS };
  for (const name of Object.keys(REPLAY_DEFAULTS)) if (raw[name] !== undefined) replay[name] = raw[name];
  const minimum = testMode ? 1 : MIN_REPLAY_SECONDS;
  if (replay.secondsPerRunner < minimum) throw new Error(`replay.secondsPerRunner must be at least ${minimum}`);
  return replay;
}
