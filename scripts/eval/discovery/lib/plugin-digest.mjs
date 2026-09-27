// Content identity of an installed Argus plugin root, shared by the reference adapter (the
// `subject` of every adapter result) and the recorded-baseline gate. The digest is the SHA-256
// of the bytewise-sorted lines `<relative path>\0<sha256 of the content>\n`, one per regular
// file. Excluded: `.claude-plugin/plugin.json` (its version is reported separately, so a
// release bump alone keeps the digest), every `node_modules/` directory, and `.DS_Store`
// files. Symbolic links are never followed; a symbolic link or any other non-regular entry
// makes the digest fail, because content reached through it would not be identified.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const PLUGIN_MANIFEST = '.claude-plugin/plugin.json';
const sha256 = value => createHash('sha256').update(value).digest('hex');

function collect(root, relative, lines) {
  const entries = readdirSync(relative ? join(root, relative) : root, { withFileTypes: true });
  for (const entry of entries) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.name === '.DS_Store' || path === PLUGIN_MANIFEST) continue;
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') collect(root, path, lines);
    } else if (entry.isFile()) {
      lines.push(Buffer.from(`${path}\0${sha256(readFileSync(join(root, path)))}\n`, 'utf8'));
    } else {
      throw new Error(`plugin tree entry ${path} is not a regular file or directory`);
    }
  }
}

// The hex SHA-256 content digest of the plugin tree at `root` (relative paths resolve against
// the working directory; the root itself may be reached through a symbolic link).
export function pluginDigest(root) {
  const base = realpathSync(resolve(root));
  if (!lstatSync(base).isDirectory()) throw new Error(`plugin root ${base} is not a directory`);
  const lines = [];
  collect(base, '', lines);
  lines.sort(Buffer.compare);
  const hash = createHash('sha256');
  for (const line of lines) hash.update(line);
  return hash.digest('hex');
}

// {pluginVersion, pluginDigest} of an Argus plugin root. Throws unless its manifest is a
// regular JSON file that names the plugin `argus`.
export function pluginSubject(root) {
  const base = realpathSync(resolve(root));
  const manifestPath = join(base, PLUGIN_MANIFEST);
  const stat = lstatSync(manifestPath, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`${manifestPath} is not a regular file`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`${manifestPath} is not valid JSON: ${error.message}`);
  }
  if (manifest?.name !== 'argus') throw new Error(`${manifestPath} does not name the plugin argus`);
  const version = typeof manifest.version === 'string' && manifest.version ? manifest.version : null;
  return { pluginVersion: version, pluginDigest: pluginDigest(base) };
}
