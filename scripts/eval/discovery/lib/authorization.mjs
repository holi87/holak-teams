// The per-run authorization manifest of a discovery hunt. The evaluator is the operator of its
// own synthetic, loopback-only corpus application, which it starts for one run and discards
// afterwards. Without an operator manifest argus-launch installs the default-deny manifest
// (environment unknown), under which the authorization evaluator denies every high-risk action,
// so a hunter that follows doctrine could never prove a seed that needs a write, a form submit,
// actor switching, or concurrent load, and the comparison would measure a read-only Argus.
//
// run.mjs writes this manifest to active/<publicId>/authorization.json (0600, outside the
// artifact root) and names it in the hunt request; the adapter passes it to
// `argus-launch --authorization`, which verifies it and copies it into the artifact root. It is
// built from the packaged default-deny template and changes only what the evaluation needs:
// environment development; the exact launch target and the paths under it; every account,
// data namespace, and mutation type of the corpus, all synthetic (`*`); per-action ceilings that
// allow the corpus latency budget's concurrency; one time window covering the mode budget; and
// complete, time-boxed grants for the configured high-risk actions (default: browser-state-change,
// load, persistent-mutation, security-active). Every other default stays: prohibited actions
// and data classifications, rollback and redaction requirements, no production override, and
// the untrusted-content rules. The evaluator still decides every action.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultAuthorization, evaluateAuthorization, HIGH_RISK_ACTIONS, manifestSha256, validateAuthorizationManifest }
  from '../../../../argus/runtime/authorization.mjs';
import { formatSchemaErrors, validateArgus } from './schemas.mjs';

export { HIGH_RISK_ACTIONS, manifestSha256 };
export const DEFAULT_GRANTS = Object.freeze(['browser-state-change', 'load', 'persistent-mutation', 'security-active']);
// Per-action ceilings: the corpus perf module publishes a p95 budget at up to 10 concurrent requests.
export const EVALUATION_RATE_LIMITS = Object.freeze({ requestsPerSecond: 50, maxConcurrent: 20, maxTotalRequests: 5000, maxDurationSeconds: 900 });
// The grants and the window outlast the mode budget (after which the adapter group is killed) by this.
export const GRANT_GRACE_SECONDS = 600;
// Where argus-launch installs the operator manifest inside the artifact root.
export const INSTALLED_MANIFEST = 'ai_agents_internal/authorization.json';
const MAX_MANIFEST_BYTES = 256 * 1024;
const TEMPLATE_PATH = fileURLToPath(new URL('../../../../argus/policies/authorization.template.json', import.meta.url));
const APPROVER = 'argus-eval comparison operator';
const REASON = 'Discovery evaluation against a synthetic, loopback-only application that the evaluator starts for this run and discards afterwards.';
const ROLLBACK_PROCEDURE = 'Restore changed synthetic objects through the public interface when a later probe needs their original state; no other state exists.';
const ROLLBACK_VERIFICATION = 'The evaluator discards the application after the run and starts a fresh instance for every run and replay case.';

// Sorted, distinct high-risk actions; throws on anything else.
export function normalizeGrants(grants = DEFAULT_GRANTS) {
  const unknown = grants.filter(action => !HIGH_RISK_ACTIONS.has(action));
  if (unknown.length) throw new Error(`authorization.grants names actions that are not high-risk actions: ${unknown.join(', ')}`);
  return [...new Set(grants)].sort();
}

// The manifest for one hunt: bound to the engagement ID the adapter launches with and to the
// launch target, valid from `now` for the mode budget plus the grace period. Throws unless it
// satisfies the packaged schema and validator and allows the launcher's boundary read.
export function buildRunAuthorization({ engagementId, target, seconds, grants = DEFAULT_GRANTS, now = new Date() }) {
  const targetIdentity = new URL(target).toString();
  const manifest = createDefaultAuthorization({
    template: JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8')), target: targetIdentity, environment: 'development', engagementId,
  });
  const startsAt = new Date(now.getTime()).toISOString();
  const endsAt = new Date(now.getTime() + (seconds + GRANT_GRACE_SECONDS) * 1000).toISOString();
  manifest.target.identifiers = [targetIdentity, `${targetIdentity}*`];
  manifest.target.productionLike = false;
  manifest.accounts.allowedAliases = ['*'];
  manifest.dataBoundaries.allowedNamespaces = ['*'];
  manifest.allowedMutations = ['*'];
  manifest.rateLimits = { ...EVALUATION_RATE_LIMITS };
  manifest.timeWindows = [{ startsAt, endsAt }];
  for (const action of normalizeGrants(grants)) {
    manifest.actionGrants[action] = { enabled: true, productionOverride: false, approvedBy: APPROVER, approvedAt: startsAt, expiresAt: endsAt, reason: REASON };
  }
  manifest.rollback.procedure = ROLLBACK_PROCEDURE;
  manifest.rollback.verification = ROLLBACK_VERIFICATION;
  const schemaErrors = validateArgus('authorization-manifest', manifest);
  if (schemaErrors.length) throw new Error(`evaluation authorization manifest violates its schema: ${formatSchemaErrors(schemaErrors)}`);
  const errors = validateAuthorizationManifest(manifest);
  if (errors.length) throw new Error(`evaluation authorization manifest is invalid: ${errors.join('; ')}`);
  const boundary = evaluateAuthorization({ manifest, request: { lane: 'odysseus', action: 'read', target: targetIdentity, sourceTrust: 'manifest' }, now: startsAt });
  if (boundary.decision !== 'allow') throw new Error(`evaluation authorization manifest denies the boundary read (${boundary.ruleId})`);
  return manifest;
}

// Whether the artifact root holds the manifest the evaluator wrote, compared by the canonical
// digest argus-launch reports: 'match', 'missing', 'mismatch' (another manifest, for example the
// default-deny one preflight creates when the launcher ignored the operator manifest), or
// 'invalid' (a symbolic link on the path, not a regular file within 256 KB, or not JSON).
export function installedAuthorization(artifactRoot, expectedSha256) {
  let path = artifactRoot;
  for (const [index, part] of INSTALLED_MANIFEST.split('/').entries()) {
    path = join(path, part);
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      return ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'invalid';
    }
    const last = index === INSTALLED_MANIFEST.split('/').length - 1;
    if (stat.isSymbolicLink() || (last ? !stat.isFile() || stat.size > MAX_MANIFEST_BYTES : !stat.isDirectory())) return 'invalid';
  }
  try {
    return manifestSha256(JSON.parse(readFileSync(path, 'utf8'))) === expectedSha256 ? 'match' : 'mismatch';
  } catch {
    return 'invalid';
  }
}
