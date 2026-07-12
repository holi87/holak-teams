import { createHash } from 'node:crypto';

export const READ_ONLY_ACTIONS = new Set([
  'browser-read',
  'database-read',
  'read',
  'security-passive',
]);

export const HIGH_RISK_ACTIONS = new Set([
  'binary-evidence',
  'browser-state-change',
  'chaos',
  'database-write',
  'destructive',
  'load',
  'persistent-mutation',
  'security-active',
]);

export const ALL_ACTIONS = new Set([...READ_ONLY_ACTIONS, ...HIGH_RISK_ACTIONS]);

const ACCOUNT_ACTIONS = new Set(['browser-state-change', 'database-write', 'destructive', 'persistent-mutation']);
const MUTATION_ACTIONS = new Set(['browser-state-change', 'database-write', 'destructive', 'persistent-mutation']);
const NAMESPACE_ACTIONS = new Set(['database-write', 'destructive', 'persistent-mutation']);
const TRAFFIC_ACTIONS = new Set(['chaos', 'load', 'security-active']);

export function createDefaultAuthorization({ template, target, environment = 'unknown', engagementId }) {
  const manifest = structuredClone(template);
  manifest.$schema = 'https://raw.githubusercontent.com/holi87/holak-teams/master/argus/schemas/authorization-manifest.schema.json';
  manifest.engagementId = engagementId ?? `argus-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  manifest.target.identifiers = [target];
  manifest.target.environment = environment;
  manifest.target.productionLike = null;
  return manifest;
}

export function validateAuthorizationManifest(manifest) {
  const errors = [];
  const requiredObjects = [
    'target', 'accounts', 'dataBoundaries', 'rateLimits', 'actionGrants',
    'redaction', 'untrustedContent', 'rollback', 'escalation', 'audit',
  ];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['manifest must be a JSON object'];
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!nonEmptyString(manifest.engagementId)) errors.push('engagementId is required');
  for (const key of requiredObjects) if (!plainObject(manifest[key])) errors.push(`${key} must be an object`);
  for (const key of ['allowedMutations', 'prohibitedActions', 'timeWindows']) if (!Array.isArray(manifest[key])) errors.push(`${key} must be an array`);
  if (errors.length > 0) return errors;

  if (!Array.isArray(manifest.target.identifiers) || manifest.target.identifiers.length === 0 || !manifest.target.identifiers.every(nonEmptyString)) {
    errors.push('target.identifiers must contain at least one non-empty string');
  }
  if (!['unknown', 'development', 'test', 'staging', 'production'].includes(manifest.target.environment)) {
    errors.push('target.environment is invalid');
  }
  if (![true, false, null].includes(manifest.target.productionLike)) errors.push('target.productionLike must be boolean or null');
  validateStringList(manifest.accounts.allowedAliases, 'accounts.allowedAliases', errors);
  if (typeof manifest.accounts.syntheticOnly !== 'boolean') errors.push('accounts.syntheticOnly must be boolean');
  validateStringList(manifest.dataBoundaries.allowedNamespaces, 'dataBoundaries.allowedNamespaces', errors);
  validateStringList(manifest.dataBoundaries.prohibitedClassifications, 'dataBoundaries.prohibitedClassifications', errors);
  if (typeof manifest.dataBoundaries.syntheticOnly !== 'boolean') errors.push('dataBoundaries.syntheticOnly must be boolean');
  validateStringList(manifest.allowedMutations, 'allowedMutations', errors);
  validateStringList(manifest.prohibitedActions, 'prohibitedActions', errors, { nonEmpty: true });

  for (const [key, integer] of [['requestsPerSecond', false], ['maxConcurrent', true], ['maxTotalRequests', true], ['maxDurationSeconds', true]]) {
    const value = manifest.rateLimits[key];
    if (typeof value !== 'number' || value <= 0 || (integer && !Number.isInteger(value))) errors.push(`rateLimits.${key} must be a positive ${integer ? 'integer' : 'number'}`);
  }

  for (const [index, window] of manifest.timeWindows.entries()) {
    if (!plainObject(window) || !validDate(window.startsAt) || !validDate(window.endsAt)) {
      errors.push(`timeWindows[${index}] must contain valid startsAt/endsAt timestamps`);
    } else if (Date.parse(window.startsAt) >= Date.parse(window.endsAt)) {
      errors.push(`timeWindows[${index}] must end after it starts`);
    }
  }

  for (const action of HIGH_RISK_ACTIONS) {
    const grant = manifest.actionGrants[action];
    if (!plainObject(grant)) {
      errors.push(`actionGrants.${action} is required`);
      continue;
    }
    for (const field of ['enabled', 'productionOverride']) if (typeof grant[field] !== 'boolean') errors.push(`actionGrants.${action}.${field} must be boolean`);
    for (const field of ['approvedBy', 'approvedAt', 'expiresAt', 'reason']) {
      if (!(grant[field] === null || typeof grant[field] === 'string')) errors.push(`actionGrants.${action}.${field} must be string or null`);
    }
  }

  validateStringList(manifest.redaction.requiredFor, 'redaction.requiredFor', errors, { nonEmpty: true });
  if (manifest.redaction.binaryEvidencePolicy !== 'deny-unless-reviewed') errors.push('redaction.binaryEvidencePolicy must be deny-unless-reviewed');
  if (!nonEmptyString(manifest.redaction.replacement)) errors.push('redaction.replacement is required');
  validateStringList(manifest.untrustedContent.sources, 'untrustedContent.sources', errors, { nonEmpty: true });
  if (manifest.untrustedContent.mayAuthorizeActions !== false || manifest.untrustedContent.mayModifyManifest !== false) {
    errors.push('untrusted content must not authorize actions or modify the manifest');
  }
  validateStringList(manifest.rollback.requiredFor, 'rollback.requiredFor', errors, { nonEmpty: true });
  for (const field of ['procedure', 'verification']) if (!(manifest.rollback[field] === null || typeof manifest.rollback[field] === 'string')) errors.push(`rollback.${field} must be string or null`);
  validateStringList(manifest.escalation.abortOn, 'escalation.abortOn', errors, { nonEmpty: true });
  if (!(manifest.escalation.contact === null || typeof manifest.escalation.contact === 'string')) errors.push('escalation.contact must be string or null');
  if (!nonEmptyString(manifest.audit.path) || manifest.audit.path.includes('/') || !manifest.audit.path.endsWith('.jsonl')) errors.push('audit.path must be a JSONL filename without directories');
  return errors;
}

export function evaluateAuthorization({ manifest, request, now = new Date().toISOString() }) {
  const errors = validateAuthorizationManifest(manifest);
  if (errors.length > 0) return deny('AUTH-MANIFEST-INVALID', errors.join('; '), false);
  if (!ALL_ACTIONS.has(request.action)) return deny('AUTH-MANIFEST-INVALID', `unknown action: ${request.action}`, false);
  if (!['manifest', 'user', 'untrusted'].includes(request.sourceTrust)) return deny('AUTH-MANIFEST-INVALID', 'sourceTrust must be manifest, user, or untrusted', false);

  const production = detectProductionLike(manifest.target, request.target);
  if (!matchesAny(request.target, manifest.target.identifiers)) {
    return deny('AUTH-TARGET-MISMATCH', 'requested target is outside target.identifiers', production.productionLike);
  }
  if (manifest.prohibitedActions.includes(request.action) || (request.mutation && manifest.prohibitedActions.includes(request.mutation))) {
    return deny('AUTH-PROHIBITED-ACTION', 'action or mutation is explicitly prohibited', production.productionLike);
  }
  if (request.classification && manifest.dataBoundaries.prohibitedClassifications.includes(request.classification)) {
    return deny('AUTH-DATA-BOUNDARY', `classification is prohibited: ${request.classification}`, production.productionLike);
  }
  if (request.sourceTrust === 'untrusted' && !READ_ONLY_ACTIONS.has(request.action)) {
    return deny('AUTH-UNTRUSTED-CONTENT', 'untrusted content cannot authorize a target-affecting action', production.productionLike);
  }

  if (READ_ONLY_ACTIONS.has(request.action)) {
    if (request.account && !matchesAny(request.account, manifest.accounts.allowedAliases)) {
      return deny('AUTH-ACCOUNT-BOUNDARY', 'account alias is outside accounts.allowedAliases', production.productionLike);
    }
    if (request.namespace && !matchesAny(request.namespace, manifest.dataBoundaries.allowedNamespaces)) {
      return deny('AUTH-DATA-BOUNDARY', 'namespace is outside dataBoundaries.allowedNamespaces', production.productionLike);
    }
    if (request.action === 'database-read' && (!request.namespace || !matchesAny(request.namespace, manifest.dataBoundaries.allowedNamespaces))) {
      return deny('AUTH-DATA-BOUNDARY', 'database-read requires an explicitly allowed data namespace', production.productionLike);
    }
    return allow('read-only action is within the manifest boundary', production.productionLike);
  }

  const grant = manifest.actionGrants[request.action];
  if (production.productionLike && (!grant.enabled || !grant.productionOverride)) {
    return deny('AUTH-PRODUCTION-READ-ONLY', `production-like target is read-only without an explicit ${request.action} production override`, true);
  }
  if (!grant.enabled || !nonEmptyString(grant.approvedBy) || !nonEmptyString(grant.reason) || !validDate(grant.approvedAt) || !validDate(grant.expiresAt)) {
    return deny('AUTH-EXPLICIT-OPT-IN', `${request.action} requires a complete enabled grant`, production.productionLike);
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs) || Date.parse(grant.approvedAt) > nowMs || Date.parse(grant.expiresAt) <= nowMs) {
    return deny('AUTH-AUTHORIZATION-EXPIRED', `${request.action} approval is not currently valid`, production.productionLike);
  }
  if (!manifest.timeWindows.some((window) => Date.parse(window.startsAt) <= nowMs && nowMs < Date.parse(window.endsAt))) {
    return deny('AUTH-TIME-WINDOW', 'current time is outside every approved time window', production.productionLike);
  }
  if (ACCOUNT_ACTIONS.has(request.action) && (!request.account || !matchesAny(request.account, manifest.accounts.allowedAliases))) {
    return deny('AUTH-ACCOUNT-BOUNDARY', 'action requires an explicitly allowed account alias', production.productionLike);
  }
  if (NAMESPACE_ACTIONS.has(request.action) && (!request.namespace || !matchesAny(request.namespace, manifest.dataBoundaries.allowedNamespaces))) {
    return deny('AUTH-DATA-BOUNDARY', 'action requires an explicitly allowed data namespace', production.productionLike);
  }
  if (MUTATION_ACTIONS.has(request.action) && (!request.mutation || !matchesAny(request.mutation, manifest.allowedMutations))) {
    return deny('AUTH-MUTATION-NOT-ALLOWED', 'mutation type is not explicitly allowlisted', production.productionLike);
  }
  if (TRAFFIC_ACTIONS.has(request.action)) {
    const missing = ['rate', 'concurrency', 'totalRequests', 'duration'].filter((field) => !positiveNumber(request[field]));
    if (missing.length > 0) return deny('AUTH-RATE-LIMIT', `traffic action requires explicit bounds: ${missing.join(', ')}`, production.productionLike);
  }
  if (request.action === 'binary-evidence' && request.binaryReviewed !== true) {
    return deny('AUTH-REDACTION-REQUIRED', 'binary evidence requires confirmed masking/synthetic content and independent review', production.productionLike);
  }
  const limitChecks = [
    ['rate', 'requestsPerSecond'],
    ['concurrency', 'maxConcurrent'],
    ['totalRequests', 'maxTotalRequests'],
    ['duration', 'maxDurationSeconds'],
  ];
  for (const [requestField, limitField] of limitChecks) {
    if (request[requestField] != null && (!positiveNumber(request[requestField]) || request[requestField] > manifest.rateLimits[limitField])) {
      return deny('AUTH-RATE-LIMIT', `${requestField} exceeds ${limitField}`, production.productionLike);
    }
  }
  if (manifest.rollback.requiredFor.includes(request.action) && (!nonEmptyString(manifest.rollback.procedure) || !nonEmptyString(manifest.rollback.verification))) {
    return deny('AUTH-ROLLBACK-REQUIRED', `${request.action} requires rollback procedure and verification`, production.productionLike);
  }
  return allow(`explicit ${request.action} grant is valid`, production.productionLike);
}

export function detectProductionLike(target, requestedTarget) {
  const environmentSignal = ['unknown', 'staging', 'production'].includes(target.environment);
  const candidate = `${requestedTarget ?? ''} ${target.identifiers.join(' ')}`.toLowerCase();
  const localOrTest = /(^|[\/.:-])(localhost|127\.0\.0\.1|0\.0\.0\.0|dev|development|test|testing|qa)([\/.:-]|$)/.test(candidate);
  const productionSignal = /(^|[\/.:-])(prod|production|live|customer|customers)([\/.:-]|$)/.test(candidate) ||
    (/^https?:\/\//.test(candidate.trim()) && !localOrTest);
  const productionLike = target.productionLike === true || environmentSignal || productionSignal;
  const signals = [];
  if (target.productionLike === true) signals.push('manifest-productionLike');
  if (environmentSignal) signals.push(`environment:${target.environment}`);
  if (productionSignal) signals.push('target-production-signal');
  return { productionLike, signals };
}

export function manifestSha256(manifest) {
  return createHash('sha256').update(stableJson(manifest)).digest('hex');
}

export function buildAuditEvent({ manifest, request, decision, timestamp, patterns }) {
  const event = {
    $schema: 'https://raw.githubusercontent.com/holi87/holak-teams/master/argus/schemas/authorization-audit.schema.json',
    schemaVersion: 1,
    timestamp,
    engagementId: manifest.engagementId,
    lane: request.lane,
    action: request.action,
    decision: decision.decision,
    ruleId: decision.ruleId,
    reason: decision.reason,
    target: request.target,
    resource: request.resource ?? null,
    account: request.account ?? null,
    namespace: request.namespace ?? null,
    mutation: request.mutation ?? null,
    manifestSha256: manifestSha256(manifest),
    sourceTrust: ['manifest', 'user', 'untrusted'].includes(request.sourceTrust)
      ? request.sourceTrust
      : 'invalid',
  };
  return redactValue(event, patterns).value;
}

export function validateRedactionPatterns(patterns) {
  const errors = [];
  if (!patterns || patterns.schemaVersion !== 1) errors.push('redaction patterns schemaVersion must be 1');
  if (!Array.isArray(patterns?.sensitiveKeys) || patterns.sensitiveKeys.length === 0) errors.push('sensitiveKeys must be a non-empty array');
  if (!Array.isArray(patterns?.patterns) || patterns.patterns.length === 0) errors.push('patterns must be a non-empty array');
  for (const [index, pattern] of (patterns?.patterns ?? []).entries()) {
    try {
      new RegExp(pattern.expression, pattern.flags);
    } catch (error) {
      errors.push(`patterns[${index}] is invalid: ${error.message}`);
    }
  }
  return errors;
}

export function redactText(text, patterns) {
  const errors = validateRedactionPatterns(patterns);
  if (errors.length > 0) throw new Error(errors.join('; '));
  let value = String(text);
  const findings = new Set();
  for (const pattern of patterns.patterns) {
    const regex = new RegExp(pattern.expression, pattern.flags);
    if (regex.test(value)) {
      findings.add(pattern.id);
      regex.lastIndex = 0;
      value = value.replace(regex, pattern.replacement);
    }
  }
  for (const key of patterns.sensitiveKeys) {
    const escaped = escapeRegex(key);
    const regex = new RegExp(`(\\b${escaped}\\b\\s*[:=]\\s*)([^\\s,;]+)`, 'gi');
    if (regex.test(value)) {
      findings.add(`key:${key}`);
      regex.lastIndex = 0;
      value = value.replace(regex, '$1[REDACTED]');
    }
  }
  return { text: value, findings: [...findings].sort() };
}

export function redactValue(input, patterns) {
  const sensitive = new Set(patterns.sensitiveKeys.map(normalizeKey));
  const findings = new Set();
  function walk(value, key = '') {
    if (sensitive.has(normalizeKey(key))) {
      findings.add(`key:${normalizeKey(key)}`);
      return '[REDACTED]';
    }
    if (typeof value === 'string') {
      const result = redactText(value, patterns);
      for (const finding of result.findings) findings.add(finding);
      return result.text;
    }
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (plainObject(value)) return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, walk(child, childKey)]));
    return value;
  }
  return { value: walk(input), findings: [...findings].sort() };
}

export function isBinaryBuffer(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return true;
  const decoded = sample.toString('utf8');
  return decoded.includes('\uFFFD');
}

function allow(reason, productionLike) {
  return { decision: 'allow', ruleId: 'AUTH-ALLOW', reason, productionLike };
}

function deny(ruleId, reason, productionLike) {
  return { decision: 'deny', ruleId, reason, productionLike };
}

function matchesAny(value, patterns) {
  if (!nonEmptyString(value) || !Array.isArray(patterns)) return false;
  return patterns.some((pattern) => {
    if (globRegex(pattern).test(value)) return true;
    return !pattern.includes('*') && normalizeHttpUrl(pattern) === normalizeHttpUrl(value);
  });
}

function normalizeHttpUrl(value) {
  if (!/^https?:\/\//i.test(value)) return value;
  try { return new URL(value).toString(); }
  catch { return value; }
}

function globRegex(pattern) {
  return new RegExp(`^${escapeRegex(pattern).replace(/\\\*/g, '.*')}$`);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (plainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function normalizeKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function validateStringList(value, name, errors, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0) || !value.every(nonEmptyString)) errors.push(`${name} must be ${nonEmpty ? 'a non-empty' : 'an'} array of strings`);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function plainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function validDate(value) {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
