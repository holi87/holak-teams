#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import * as builtInCorpus from './corpus/index.mjs';
// Usage: node scripts/eval/discovery/run.mjs <comparison-config.json> <new-output-directory>
// Each host adapter receives ONLY a public request path, and returns findings/usage.
const [configPath, outputPath] = process.argv.slice(2);
if (!configPath || !outputPath) throw new Error('comparison config and new output directory required');
const config = JSON.parse(readFileSync(resolve(configPath)));
if (!Array.isArray(config.variants) || config.variants.length !== 2 || !Number.isInteger(config.repeats) || config.repeats < 2 || !Number.isInteger(config.seconds) || config.seconds < 1 || !Number.isInteger(config.tokens) || config.tokens < 1) throw new Error('two variants, repeats>=2, and positive equal time/token budgets required');
for (const variant of config.variants) if (!variant.name || !/^[a-f0-9]{40}$/.test(variant.revision ?? '') || !Array.isArray(variant.command) || !variant.command.length || !isAbsolute(variant.command[0])) throw new Error('variant requires name, immutable revision, and command argv');
if (new Set(config.variants.map(variant => variant.name)).size !== 2) throw new Error('variant names must be distinct');
// A corpus v2 module (built-in or private) is one composite application: the faulty build
// enables every seed, the corrected build none.
const source = config.corpusModule ? await import(pathToFileURL(resolve(dirname(resolve(configPath)), config.corpusModule)))
  : builtInCorpus;
if (!Array.isArray(source.seedIds) || !source.seedIds.length || typeof source.startApplication !== 'function' || typeof source.truthFor !== 'function') throw new Error('invalid private corpus module');
const corpus = {
  families: ['suite'],
  startApplication: async ({ seed, faulty }) => {
    const enabledSeeds = faulty ? [...source.seedIds] : [];
    const app = await source.startApplication({ seed, enabledSeeds });
    return { url: app.url, truth: source.truthFor(enabledSeeds), close: app.close };
  },
};
const output = resolve(outputPath); mkdirSync(output, { mode: 0o700 });
const runs = [];
for (let repeat = 0; repeat < config.repeats; repeat++) {
  const seed = randomInt(1, 1000000);
  for (const family of corpus.families) for (const faulty of [false, true]) {
    // Alternate execution order to reduce systematic warm-up effects.
    const variants = repeat % 2 ? [...config.variants].reverse() : config.variants;
    for (const variant of variants) {
      const app = await corpus.startApplication({ family, faulty, seed });
      const work = mkdtempSync(join(tmpdir(), 'argus-blind-hunt-'));
      const requestPath = join(work, 'request.json');
      writeFileSync(requestPath, JSON.stringify({ target: app.url, mode: 'B', artifactRoot: work,
        contractUrl: `${app.url}/contract`, budget: { seconds: config.seconds, tokens: config.tokens },
        resultPath: join(work, 'result.json') }), { mode: 0o600 });
      const started = Date.now(); let outcome;
      try {
        outcome = await new Promise((done, reject) => {
          const child = spawn(variant.command[0], [...variant.command.slice(1), requestPath], {
            cwd: work, detached: true, stdio: ['ignore', 'ignore', 'inherit'],
            env: Object.fromEntries(['PATH', 'HOME', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]])) });
          const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, config.seconds * 1000);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('close', (code, signal) => { clearTimeout(timer); done({ code, signal }); });
        });
        const result = JSON.parse(readFileSync(join(work, 'result.json')));
        if (outcome.code !== 0 || !Array.isArray(result.findings) || !Number.isFinite(result.tokens) || result.tokens < 0 || result.tokens > config.tokens || !Number.isFinite(result.cost) || result.cost < 0) throw new Error('adapter failed or violated measured usage contract');
        runs.push({ variant: variant.name, revision: variant.revision, repeat, family, seed, faulty,
          truth: app.truth, elapsedMs: Date.now() - started, findings: result.findings, tokens: result.tokens, cost: result.cost, work, status: 'awaiting-adjudication' });
      } catch (error) { runs.push({ variant: variant.name, repeat, family, seed, faulty, work, status: 'invalid-run', reason: error.message }); }
      finally { await app.close(); }
      writeFileSync(join(output, 'private-runs.json'), JSON.stringify({ config, runs }, null, 2), { mode: 0o600 });
    }
  }
}
console.log(JSON.stringify({ runs: runs.length, status: 'UNSCORED', privateResults: join(output, 'private-runs.json') }));
if (runs.some(run => run.status === 'invalid-run')) process.exitCode = 1;
