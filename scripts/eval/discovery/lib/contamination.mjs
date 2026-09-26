// Post-run contamination scan of a hunter's artifact root. The Argus OS sandbox confines
// writes, not reads, so a hunter can read the evaluator repository. This scan detects the
// traces that reading private evaluator state leaves: the sealed canary, an absolute evaluator
// path, or a corpus source file name makes a run 'contaminated' (excluded from metrics); an
// exact seed ID or an unreadable entry makes it 'suspect' (flagged for review only).
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_SCAN_BYTES = 5 * 1024 * 1024;
export const MAX_RECORDED_HITS = 200;
const CONTAMINATING = new Set(['canary', 'forbidden-path', 'corpus-file']);
const SKIP_DIRECTORIES = new Set(['node_modules']);

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// A physical path plus its macOS '/private' alias (/private/var/... is also /var/...).
export function pathForms(path) {
  const forms = new Set([path]);
  if (path.startsWith('/private/')) {
    const alias = path.slice('/private'.length);
    try {
      if (existsSync(alias) && realpathSync(alias) === path) forms.add(alias);
    } catch {
      // An unresolvable alias is simply not a form of this path.
    }
  }
  return [...forms];
}

// Fingerprints of a corpus directory: every file qualified by the directory name (for example
// 'corpus/index.mjs', 'corpus/modules/orders.mjs'), plus the bare name of files whose stem is
// distinctive enough to stand alone (a hyphenated name such as 'tenant-authz.mjs').
export function corpusFileNames(directoryName, files) {
  const names = new Set();
  for (const file of files) {
    names.add(`${directoryName}/${file}`);
    const base = file.split('/').pop();
    if (base.replace(/\.[^.]*$/, '').includes('-')) names.add(base);
  }
  return [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function patterns({ canary, forbiddenPaths, corpusFileNames: names, seedIds }) {
  const list = [];
  if (canary) list.push({ kind: 'canary', match: 'canary', regex: new RegExp(escapeRegExp(canary)) });
  const forbidden = [...new Set(forbiddenPaths.flatMap(pathForms))].sort((left, right) => right.length - left.length);
  for (const path of forbidden) {
    // Path-bounded: '/repo' must not match '/repo-other' or '/x/repo', but does match '/repo/' and '/repo.'.
    list.push({ kind: 'forbidden-path', match: path, regex: new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(path)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`) });
  }
  for (const name of names) {
    list.push({ kind: 'corpus-file', match: name, regex: new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(name)}(?![A-Za-z0-9_])`) });
  }
  for (const id of seedIds) {
    list.push({ kind: 'seed-id', match: id, regex: new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(id)}(?![A-Za-z0-9_-])`) });
  }
  return list;
}

// Scans every regular file up to 5 MB under `root` (skipping node_modules and symbolic links),
// and every relative file path. Occurrences of `root` itself (the run's own artifact root,
// which Argus legitimately records) are removed before matching forbidden paths.
export function scanArtifacts(root, { canary = null, forbiddenPaths = [], corpusFileNames: names = [], seedIds = [] } = {}) {
  const checks = patterns({ canary, forbiddenPaths, corpusFileNames: names, seedIds });
  const allowed = pathForms(root).sort((left, right) => right.length - left.length);
  const hits = [];
  const seen = new Set();
  let totalHits = 0;
  let scannedFiles = 0;
  let skippedFiles = 0;
  let contaminated = false;
  const record = (kind, file, match) => {
    const key = `${kind}\0${file}\0${match}`;
    if (seen.has(key)) return;
    seen.add(key);
    totalHits += 1;
    if (CONTAMINATING.has(kind)) contaminated = true;
    if (hits.length < MAX_RECORDED_HITS) hits.push({ kind, file, match });
  };
  const match = (text, file) => {
    let cleaned = text;
    for (const form of allowed) cleaned = cleaned.split(form).join('\u0000');
    for (const check of checks) if (check.regex.test(cleaned)) record(check.kind, file, check.match);
  };
  const walk = relativeDir => {
    let entries;
    try {
      entries = readdirSync(relativeDir ? join(root, relativeDir) : root, { withFileTypes: true });
    } catch {
      record('unreadable', relativeDir || '.', null);
      return;
    }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      const file = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      match(file, file);
      let stat;
      try {
        stat = lstatSync(join(root, file));
      } catch {
        record('unreadable', file, null);
        continue;
      }
      if (stat.isSymbolicLink()) {
        skippedFiles += 1;
      } else if (stat.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) walk(file);
      } else if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) {
        skippedFiles += 1;
      } else {
        let text;
        try {
          text = readFileSync(join(root, file), 'utf8');
        } catch {
          record('unreadable', file, null);
          continue;
        }
        scannedFiles += 1;
        match(text, file);
      }
    }
  };
  walk('');
  const status = contaminated ? 'contaminated' : totalHits ? 'suspect' : 'clean';
  return { status, hits, totalHits, scannedFiles, skippedFiles };
}
