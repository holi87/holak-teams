import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertSchema } from '../oracles/schema';
import type { StubExchange, StubResponse } from './stub-server';

// Counterfactual fixtures (TEMPLATE-CONTRACT.md SD-10). A fixture proves that a regression
// distinguishes correct from defective behaviour without contacting the target: the
// cf-correct pass serves the subject exchange as specified, and each cf-tamper-<k> pass
// replaces the subject response with tampers[k-1]. The outcome adapter loads this module
// for the inventory plan and for cf-* passes; the fixtures in src/fixtures/fixtures.ts load
// it inside the workers.

export const FIXTURE_SCHEMA = 'argus/counterfactual-fixture@1';
export const REQUIRED_TAMPER = 'observed-defect';
export const EXEMPTION_REASONS = ['front-end-logic', 'timing-or-load', 'data-layer', 'fault-injection', 'non-http-protocol'] as const;
export const ORACLE_KINDS = ['requirement', 'contract', 'justified-invariant'] as const;
/** Skip description for a test that has no applicable variant in this pass (SD-6: no event). */
export const NOT_APPLICABLE = 'argus-counterfactual-not-applicable';
/** Skip description prefix for an exempt bug in cf-correct, followed by the exemption reason. */
export const EXEMPT_PREFIX = 'argus-counterfactual-exempt:';

export type ExemptionReason = (typeof EXEMPTION_REASONS)[number];
export type InvalidReason = 'schema-invalid' | 'missing-observed-defect' | 'correct-violates-contract';
export type CounterfactualTamper = { id: string; response: StubResponse };
export type CounterfactualFixture = {
  kind: 'fixture';
  oracle: { kind: (typeof ORACLE_KINDS)[number]; sourceRef: string };
  contract?: { operationId: string; status: number };
  exchanges: StubExchange[];
  subject: string;
  tampers: CounterfactualTamper[];
};
export type LoadedFixture =
  | CounterfactualFixture
  | { kind: 'exempt'; reason: ExemptionReason }
  | { kind: 'invalid'; reason: InvalidReason }
  | { kind: 'missing' };
/** The response served for the subject exchange; `id` is 'correct' or the tamper id. */
export type CounterfactualVariant = { id: string; response: StubResponse };
export type PlanRow = { bugId: string; status: 'fixture' | 'exempt' | 'missing' | 'invalid'; tamperIds: string[]; reason: string };

type Json = Record<string, unknown>;

const PASS = /^cf-(correct|tamper-([1-9][0-9]*))$/;
const CANONICAL_BUG = /^BUG-[0-9]{4}$/;
const PROVENANCE_TOKEN = /^(BUG-[0-9]{4}|[A-Z]{3}-[0-9]{3,4})$/;
const VARIANT_ID = /^[a-z0-9-]{1,40}$/;
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
const LEDGER_SCHEMAS = new Map([['argus/bug-ledger@1', 1], ['argus/bug-ledger@2', 2]]);
const COMMON_KEYS = ['$schema', 'schemaVersion', 'bugId'];
const MAX_FIXTURE_BYTES = 1024 * 1024;

/** True for cf-correct and cf-tamper-<k> (k >= 1). */
export function isCounterfactualPass(pass: string | undefined): boolean {
  return PASS.test(pass ?? '');
}

/**
 * Read and validate solution/counterfactual/<bugId>.json against SD-10 without the contract
 * check. A structurally valid fixture that lacks the observed-defect tamper is invalid with
 * `missing-observed-defect`; any other deviation is `schema-invalid`.
 */
export function readFixture(root: string, bugId: string): LoadedFixture {
  if (!CANONICAL_BUG.test(bugId)) throw new TypeError(`counterfactual fixtures are keyed by a canonical BUG-NNNN id, got ${JSON.stringify(bugId)}`);
  const path = join(root, 'solution', 'counterfactual', `${bugId}.json`);
  let size: number;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return invalid('schema-invalid');
    size = stat.size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'missing' } : invalid('schema-invalid');
  }
  if (size > MAX_FIXTURE_BYTES) return invalid('schema-invalid');
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return invalid('schema-invalid');
  }
  return validateFixture(document, bugId);
}

/**
 * readFixture plus the contract check: when `contract` is present, the subject response must
 * have exactly contract.status and satisfy assertSchema for contract.operationId, otherwise
 * the fixture is invalid with `correct-violates-contract` (an operationId the OpenAPI document
 * does not define included). A missing OpenAPI document is ArgusPrerequisiteError and throws.
 */
export async function loadFixture(root: string, bugId: string): Promise<LoadedFixture> {
  const fixture = readFixture(root, bugId);
  if (fixture.kind !== 'fixture' || !fixture.contract) return fixture;
  const { operationId, status } = fixture.contract;
  const correct = subjectResponse(fixture);
  if (correct.status !== status) return invalid('correct-violates-contract');
  try {
    await assertSchema({ status: correct.status, headers: correct.headers ?? {}, body: correct.body }, operationId);
  } catch (error) {
    if ((error as Error)?.name === 'ArgusPrerequisiteError') throw error;
    return invalid('correct-violates-contract');
  }
  return fixture;
}

/** cf-correct serves the subject response; cf-tamper-<k> serves tampers[k-1] or is not applicable. */
export function variantFor(fixture: CounterfactualFixture, pass: string): CounterfactualVariant | 'not-applicable' {
  const match = PASS.exec(pass);
  if (!match) throw new TypeError(`not a counterfactual pass: ${JSON.stringify(pass)}`);
  if (match[1] === 'correct') return { id: 'correct', response: structuredClone(subjectResponse(fixture)) };
  const tamper = fixture.tampers[Number(match[2]) - 1];
  return tamper ? { id: tamper.id, response: structuredClone(tamper.response) } : 'not-applicable';
}

/** The fixture's exchanges with the subject response replaced entirely by the variant. */
export function variantExchanges(fixture: CounterfactualFixture, variant: CounterfactualVariant): StubExchange[] {
  return fixture.exchanges.map((exchange) => (exchange.id === fixture.subject
    ? { ...structuredClone(exchange), response: structuredClone(variant.response) }
    : structuredClone(exchange)));
}

/** One SD-10 plan row per expected bug, in the given order. */
export async function plan(root: string, expectedBugs: readonly string[]): Promise<PlanRow[]> {
  const rows: PlanRow[] = [];
  for (const bugId of expectedBugs) {
    const fixture = await loadFixture(root, bugId);
    if (fixture.kind === 'fixture') rows.push({ bugId, status: 'fixture', tamperIds: fixture.tampers.map((tamper) => tamper.id), reason: '-' });
    else if (fixture.kind === 'missing') rows.push({ bugId, status: 'missing', tamperIds: [], reason: '-' });
    else rows.push({ bugId, status: fixture.kind, tamperIds: [], reason: fixture.reason });
  }
  return rows;
}

/** reports/counterfactual-plan.tsv line: bug_id, status, tamper_ids, reason. */
export function planLine(row: PlanRow): string {
  return [row.bugId, row.status, row.tamperIds.length ? row.tamperIds.join(',') : '-', row.reason].join('\t');
}

/**
 * The canonical bug a regression is bound to (SD-4, SD-11): the test carries @regression and
 * exactly one @bug:<token>, and the token resolves through the id or origin[] of a valid
 * solution/bug-ledger.json. Mirrors the outcome adapter's join; null when unbound.
 */
export function boundBug(root: string, tags: readonly string[]): string | null {
  if (!tags.includes('@regression')) return null;
  const tokens = tags.filter((tag) => tag.startsWith('@bug:') && tag.length > '@bug:'.length).map((tag) => tag.slice('@bug:'.length));
  if (tokens.length !== 1 || !PROVENANCE_TOKEN.test(tokens[0])) return null;
  return ledgerTokens(root)?.get(tokens[0]) ?? null;
}

function ledgerTokens(root: string): Map<string, string> | null {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(join(root, 'solution', 'bug-ledger.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!isObject(document) || !Array.isArray(document.bugs)) return null;
  const version = LEDGER_SCHEMAS.get(String(document.$schema));
  if (!version || document.schemaVersion !== version) return null;
  const owners = new Map<string, Set<string>>();
  const ids = new Set<string>();
  for (const bug of document.bugs) {
    if (!isObject(bug) || typeof bug.id !== 'string' || !CANONICAL_BUG.test(bug.id) || ids.has(bug.id)) return null;
    ids.add(bug.id);
    const origin = bug.origin ?? [];
    if (!Array.isArray(origin) || origin.some((alias) => typeof alias !== 'string')) return null;
    for (const token of new Set([bug.id, ...(origin as string[])])) {
      if (!owners.has(token)) owners.set(token, new Set());
      owners.get(token)?.add(bug.id);
    }
  }
  const tokens = new Map<string, string>();
  for (const [token, bugs] of owners) {
    if (bugs.size !== 1) return null;
    tokens.set(token, [...bugs][0]);
  }
  return tokens;
}

function validateFixture(document: unknown, bugId: string): LoadedFixture {
  const schemaInvalid = invalid('schema-invalid');
  if (!isObject(document) || document.$schema !== FIXTURE_SCHEMA || document.schemaVersion !== 1 || document.bugId !== bugId) return schemaInvalid;
  if ('exemption' in document) {
    const exemption = document.exemption;
    if (!hasExactKeys(document, [...COMMON_KEYS, 'exemption']) || !isObject(exemption) || !hasExactKeys(exemption, ['reason', 'justification'])) return schemaInvalid;
    const { reason, justification } = exemption;
    const justified = typeof justification === 'string' && justification.trim() !== '' && justification.length <= 500;
    if (!EXEMPTION_REASONS.includes(reason as ExemptionReason) || !justified) return schemaInvalid;
    return { kind: 'exempt', reason: reason as ExemptionReason };
  }
  if (!hasExactKeys(document, [...COMMON_KEYS, 'oracle', 'exchanges', 'subject', 'tampers'], ['contract'])) return schemaInvalid;
  const { oracle, contract, exchanges, subject, tampers } = document;
  if (!isObject(oracle) || !hasExactKeys(oracle, ['kind', 'sourceRef'])
    || !ORACLE_KINDS.includes(oracle.kind as (typeof ORACLE_KINDS)[number]) || !isText(oracle.sourceRef)) return schemaInvalid;
  if (contract !== undefined && (!isObject(contract) || !hasExactKeys(contract, ['operationId', 'status'])
    || !isText(contract.operationId) || !isStatus(contract.status))) return schemaInvalid;
  if (!Array.isArray(exchanges) || exchanges.length === 0 || !exchanges.every(isExchange) || !uniqueIds(exchanges)) return schemaInvalid;
  if (typeof subject !== 'string' || !exchanges.some((exchange) => exchange.id === subject)) return schemaInvalid;
  // 'correct' is reserved: the cf-correct pass already uses the case suffix '.cf-correct'.
  const isTamper = (value: unknown): value is CounterfactualTamper => isObject(value) && hasExactKeys(value, ['id', 'response'])
    && typeof value.id === 'string' && VARIANT_ID.test(value.id) && value.id !== 'correct' && isResponse(value.response);
  if (!Array.isArray(tampers) || tampers.length === 0 || !tampers.every(isTamper) || !uniqueIds(tampers)) return schemaInvalid;
  if (!tampers.some((tamper) => tamper.id === REQUIRED_TAMPER)) return invalid('missing-observed-defect');
  return structuredClone({
    kind: 'fixture',
    oracle: oracle as CounterfactualFixture['oracle'],
    ...(contract === undefined ? {} : { contract: contract as CounterfactualFixture['contract'] }),
    exchanges,
    subject,
    tampers,
  });
}

function isExchange(value: unknown): value is StubExchange {
  if (!isObject(value) || !hasExactKeys(value, ['id', 'request', 'response'])) return false;
  if (typeof value.id !== 'string' || !VARIANT_ID.test(value.id)) return false;
  const { request } = value;
  if (!isObject(request) || !hasExactKeys(request, ['method', 'path'], ['query'])) return false;
  if (typeof request.method !== 'string' || !/^[A-Z]+$/.test(request.method)) return false;
  if (typeof request.path !== 'string' || !request.path.startsWith('/') || /[?#]/.test(request.path)) return false;
  const { query } = request;
  if (query !== undefined && (!isObject(query) || Object.values(query).some((item) => typeof item !== 'string'))) return false;
  return isResponse(value.response);
}

function isResponse(value: unknown): value is StubResponse {
  if (!isObject(value) || !hasExactKeys(value, ['status'], ['headers', 'body']) || !isStatus(value.status)) return false;
  const { headers } = value;
  if (headers === undefined) return true;
  return isObject(headers) && Object.entries(headers).every(([name, item]) => HEADER_NAME.test(name) && typeof item === 'string');
}

function subjectResponse(fixture: CounterfactualFixture): StubResponse {
  const subject = fixture.exchanges.find((exchange) => exchange.id === fixture.subject);
  if (!subject) throw new TypeError(`counterfactual subject ${fixture.subject} is not an exchange`);
  return subject.response;
}

function hasExactKeys(value: Json, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}

function uniqueIds(values: { id: string }[]): boolean {
  return new Set(values.map((value) => value.id)).size === values.length;
}

function isStatus(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(reason: InvalidReason): LoadedFixture {
  return { kind: 'invalid', reason };
}
