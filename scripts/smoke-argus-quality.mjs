#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { redactText, redactValue, validateRedactionPatterns } from '../argus/runtime/authorization.mjs';
import { validateCanonicalDocument, renderFinalSummary } from '../argus/runtime/contracts.mjs';
import { calculateCoverage, validateCasePlan } from '../argus/runtime/coverage.mjs';
import { binaryRegistrationErrors, binaryReviewAuditErrors, isBinaryReference, loadRedactionPatterns, parseAuditLog, validateEvidenceContent } from '../argus/runtime/evidence.mjs';
import { ledgerEvidenceIds, quarantineFindings, reconcileCoverageEvidence, reconcileFindings } from '../argus/runtime/finding-quality.mjs';
const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const copy = value => structuredClone(value);
const valid = read('./fixtures/argus-schemas/valid/bug-ledger.json');
const rejects = (mutate, reason) => { const document = copy(valid); mutate(document.bugs[0]); const errors = validateCanonicalDocument('bug-ledger', document); assert(errors.length); if (reason) assert(errors.some(error => reason.test(error)), errors.join('; ')); };
assert.deepEqual(validateCanonicalDocument('bug-ledger', valid), []);
rejects(bug => { bug.evidenceIds = []; });
rejects(bug => { delete bug.verification; });
rejects(bug => { bug.verification.oracle.kind = 'hypothesis'; });
rejects(bug => { bug.verification.oracle.applicability = ''; });
rejects(bug => { bug.verification.reproduction.occurrences = 3; });
rejects(bug => { bug.severity = 'Critical'; });
rejects(bug => { bug.origin.push('ORI-002'); });
const unavailable = { status: 'unavailable', executor: null, evidenceIds: [], reason: 'No second authorized executor was available for a fresh-state reproduction.' };
const needsIndependence = /intermittent or single-attempt confirmation requires independent reproduction/;
const intermittent = copy(valid); intermittent.bugs[0].verification.reproduction.attempts = 10; intermittent.bugs[0].verification.independent = copy(unavailable);
assert.deepEqual(validateCanonicalDocument('bug-ledger', intermittent), []);
rejects(bug => { bug.verification.reproduction.attempts = 10; }, needsIndependence);
const rare = copy(valid); Object.assign(rare.bugs[0].verification.reproduction, { attempts: 5, occurrences: 1 }); rare.bugs[0].verification.independent = copy(unavailable);
assert.deepEqual(validateCanonicalDocument('bug-ledger', rare), []);
rejects(bug => { Object.assign(bug.verification.reproduction, { attempts: 1, occurrences: 1 }); }, needsIndependence);
const semantic = (document, reason) => { const errors = validateCanonicalDocument('bug-ledger', document); assert(errors.some(error => reason.test(error)), errors.join('; ') || 'document unexpectedly valid'); };
const row = (document, id) => document.bugs.find(bug => bug.id === id);
// bug-ledger@2 status blocks: exclusivity rules the schema subset cannot express are semantic.
rejects(bug => { bug.verification.oracle.kind = 'justified-invariant'; }, /invariantClass/);
const invariant = copy(valid); Object.assign(invariant.bugs[0].verification.oracle, { kind: 'justified-invariant', invariantClass: 'server-error' });
assert.deepEqual(validateCanonicalDocument('bug-ledger', invariant), []);
rejects(bug => { bug.verification.oracle.invariantClass = 'crash'; }, /invariantClass requires a justified-invariant oracle/);
rejects(bug => { bug.quarantine = { reasons: ['stale capture'] }; }, /quarantine is only valid for quarantined status/);
rejects(bug => { bug.repair = { round: 1, missing: ['reproduction'], assignedTo: 'atalanta' }; }, /repair is not valid on a confirmed entry/);
const chain = copy(valid); chain.bugs.push({ ...copy(row(valid, 'BUG-0004')), id: 'BUG-0008', origin: ['TAL-008'], duplicateOf: 'BUG-0004', merge: { rationale: 'Same failure as the duplicate row.', causalEvidence: [{ ref: 'TAL-008', evidenceIds: ['EVD-0003'] }, { ref: 'BUG-0004', evidenceIds: ['EVD-0002'] }] } });
semantic(chain, /BUG-0008: duplicateOf target BUG-0004 is duplicate/);
const sharedOrigin = copy(valid); row(sharedOrigin, 'BUG-0003').origin = ['ATA-001'];
semantic(sharedOrigin, /BUG-0003: origin ATA-001 is already assigned to BUG-0001/);
const missingOrigin = copy(valid); row(missingOrigin, 'BUG-0002').merge.causalEvidence[1].ref = 'ORI-009';
semantic(missingOrigin, /BUG-0002: merge causalEvidence must cite each origin exactly once/);
const unmergedDuplicate = copy(valid); delete row(unmergedDuplicate, 'BUG-0004').merge;
assert(validateCanonicalDocument('bug-ledger', unmergedDuplicate).length, 'a duplicate without a causal merge passed');
const unproven = copy(valid); row(unproven, 'BUG-0005').rejection.evidenceIds = [];
semantic(unproven, /BUG-0005: rejection requires evidence unless the reason is out-of-scope/);
row(unproven, 'BUG-0005').rejection.reason = 'out-of-scope';
assert.deepEqual(validateCanonicalDocument('bug-ledger', unproven), []);
const oracleGap = copy(valid); row(oracleGap, 'BUG-0003').missingProof.elements = ['evidence'];
semantic(oracleGap, /BUG-0003: needs-oracle requires an oracle gap in missingProof/);
const wiredSuspect = copy(valid); Object.assign(row(wiredSuspect, 'BUG-0002'), { wired: true, testId: 'REG-0002' });
semantic(wiredSuspect, /BUG-0002: only a confirmed entry can be wired/);

// Reconciliation checks every row's evidence; failures are per bug, never a global abort.
const bytes = Buffer.from('synthetic requirement and reproduction');
const digest = createHash('sha256').update(bytes).digest('hex');
const reference = (id, collectedBy) => ({ id, kind: 'text', mediaType: 'text/plain', source: `reports/${id}.txt`, sha256: digest, capturedAt: new Date().toISOString(), collectedBy, redaction: 'synthetic', relatedBugIds: [], relatedSurfaceIds: ['SRF-API-ORDER'] });
const registry = { engagementId: valid.engagementId, references: [reference('EVD-0001', 'atalanta'), reference('EVD-0002', 'talos')] };
assert.deepEqual(reconcileFindings(valid, registry, () => bytes), { errors: [], byBug: {} });
assert.deepEqual(reconcileFindings(valid, { ...registry, engagementId: 'foreign' }, () => bytes), { errors: ['evidence engagementId does not match ledger'], byBug: {} });
const unresolved = reconcileFindings(valid, { ...registry, references: [] }, () => bytes);
assert.deepEqual(unresolved.errors, []);
assert.deepEqual(Object.keys(unresolved.byBug).sort(), valid.bugs.filter(bug => bug.evidenceIds.length || bug.verification).map(bug => bug.id).sort());
assert(reconcileFindings(valid, registry, () => Buffer.from('modified')).byBug['BUG-0001'].some(error => /evidence digest drift EVD-0001/.test(error)));
assert(reconcileFindings(valid, registry, () => { throw new Error('missing'); }).byBug['BUG-0005'].some(error => /missing or unsafe evidence EVD-0002/.test(error)));
const oneCollector = { ...registry, references: [reference('EVD-0001', 'atalanta'), reference('EVD-0002', 'atalanta')] };
assert.deepEqual(reconcileFindings(valid, oneCollector, () => bytes).byBug, { 'BUG-0002': ['BUG-0002: merge must cite evidence collected by each merged lane'] });
const independent = copy(valid); independent.bugs[0].verification.independent = { status: 'reproduced', executor: 'atalanta', evidenceIds: ['EVD-0001'], reason: 'Fresh independent reproduction' };
assert(reconcileFindings(independent, registry, () => bytes).byBug['BUG-0001'].some(error => /independent reproduction reuses original evidence/.test(error)));
// An independent executor must not be the collector of the evidence it claims to reproduce.
const selfCheck = copy(valid); selfCheck.bugs[0].verification.independent = { status: 'reproduced', executor: 'ariadne', evidenceIds: ['EVD-0003'], reason: 'Fresh-state reproduction from a second lane' };
const ariadneRegistry = { ...registry, references: [reference('EVD-0001', 'ariadne'), reference('EVD-0002', 'talos'), reference('EVD-0003', 'ariadne')] };
assert.deepEqual(reconcileFindings(selfCheck, ariadneRegistry, () => bytes).byBug['BUG-0001'], ['BUG-0001: independent executor collected the original reproduction evidence']);
const trueIndependence = { ...registry, references: [...registry.references, reference('EVD-0003', 'ariadne')] };
assert.deepEqual(reconcileFindings(selfCheck, trueIndependence, () => bytes), { errors: [], byBug: {} });
// A co-finder of a merged row is an origin lane, never its independent reproducer: its filing
// prefix (ORI files as orion) or the collector of its causal evidence names it, and the merge
// quarantines the row.
const coFound = copy(valid);
Object.assign(coFound.bugs[0], { origin: ['ATA-001', 'ORI-001'], severity: 'Critical', merge: { rationale: 'One authorization defect reached from the API and the UI.', causalEvidence: [{ ref: 'ATA-001', evidenceIds: ['EVD-0001'] }, { ref: 'ORI-001', evidenceIds: ['EVD-0004'] }] } });
coFound.bugs[0].verification.independent = { status: 'reproduced', executor: 'orion', evidenceIds: ['EVD-0003'], reason: 'Fresh-state reproduction from a second lane' };
assert.deepEqual(validateCanonicalDocument('bug-ledger', coFound), []);
const coFinderRefs = (executorCollector, causalCollector) => ({ ...registry, references: [...registry.references, reference('EVD-0003', executorCollector), reference('EVD-0004', causalCollector)] });
const coFinder = reconcileFindings(coFound, coFinderRefs('orion', 'orion'), () => bytes).byBug;
assert.deepEqual(coFinder, { 'BUG-0001': ['BUG-0001: independent executor orion is an origin lane'] });
const coFoundLedger = copy(coFound);
assert.deepEqual(quarantineFindings(coFoundLedger, coFinder), ['BUG-0001']);
assert(row(coFoundLedger, 'BUG-0001').status === 'quarantined' && row(coFoundLedger, 'BUG-0001').quarantine.reasons.includes('independent executor orion is an origin lane'));
assert.deepEqual(reconcileFindings(coFound, coFinderRefs('orion', 'talos'), () => bytes).byBug, { 'BUG-0001': ['BUG-0001: independent executor orion is an origin lane'] }, 'the ORI filing prefix did not name orion');
const coTalos = copy(coFound);
Object.assign(coTalos.bugs[0], { origin: ['ATA-001', 'TAL-001'], merge: { ...coTalos.bugs[0].merge, causalEvidence: [{ ref: 'ATA-001', evidenceIds: ['EVD-0001'] }, { ref: 'TAL-001', evidenceIds: ['EVD-0004'] }] } });
coTalos.bugs[0].verification.independent.executor = 'talos';
assert.deepEqual(reconcileFindings(coTalos, coFinderRefs('talos', 'talos'), () => bytes).byBug, { 'BUG-0001': ['BUG-0001: independent executor talos is an origin lane'] }, 'a causal-evidence collector reproduced independently');
const thirdLane = copy(coFound); thirdLane.bugs[0].verification.independent.executor = 'perseus';
assert.deepEqual(reconcileFindings(thirdLane, coFinderRefs('perseus', 'orion'), () => bytes), { errors: [], byBug: {} });

// A quarantined row keeps its submitted blocks, never counts as confirmed, and stays valid.
const drifted = copy(valid);
const failures = reconcileFindings(drifted, registry, source => (source === 'reports/EVD-0001.txt' ? Buffer.from('replaced') : bytes)).byBug;
assert.deepEqual(quarantineFindings(drifted, failures), ['BUG-0001', 'BUG-0002', 'BUG-0004', 'BUG-0007']);
assert.deepEqual(validateCanonicalDocument('bug-ledger', drifted), []);
assert(row(drifted, 'BUG-0001').status === 'quarantined' && row(drifted, 'BUG-0001').quarantine.reasons.includes('evidence digest drift EVD-0001'));
assert(row(drifted, 'BUG-0007').quarantine.reasons.length === 2, 'a re-quarantined row lost its earlier reason');
assert(!drifted.bugs.some(bug => bug.status === 'confirmed'), 'a drifted confirmed row still counts as confirmed');
assert.deepEqual(ledgerEvidenceIds(row(valid, 'BUG-0004')), ['EVD-0001', 'EVD-0002']);

// evidence-reference@3: retained bytes are re-validated against the reference that registers them.
const patterns = loadRedactionPatterns();
const content = (ref, value) => validateEvidenceContent(ref, Buffer.isBuffer(value) ? value : Buffer.from(value), { patterns });
const textRef = (kind, mediaType, extra = {}) => ({ ...reference('EVD-0009', 'atalanta'), kind, mediaType, ...extra });
const binaryReview = { reviewer: 'minos', reviewedAt: '2026-07-10T00:04:00.000Z', method: 'region-mask', auditTimestamp: '2026-07-10T00:02:30.000Z' };
const binaryRef = (kind, mediaType) => ({ ...reference('EVD-0010', 'atalanta'), kind, mediaType, redaction: 'masked', capturedAt: '2026-07-10T00:03:00.000Z', review: binaryReview });
assert(content(textRef('http', 'text/plain'), 'GET /api/orders/1\nAuthorization: Bearer abc.def\n').some(error => /redactor would change/.test(error)), 'an unredacted bearer token passed');
assert.deepEqual(content(textRef('http', 'text/plain'), 'GET /api/orders/1\nAuthorization: [REDACTED]\n'), []);
assert(content(textRef('http', 'application/json'), '{"status": 201').some(error => /is not valid JSON/.test(error)), 'malformed JSON http evidence passed');
assert(content(textRef('http', 'application/json'), JSON.stringify({ headers: { authorization: 'abc' } })).some(error => /values the packaged redactor would change/.test(error)), 'a sensitive JSON key passed');
assert(content(textRef('log', 'application/x-ndjson'), '{"level":"info"}\n{"password":"hunter2"}\n').some(error => /line 2 contains values/.test(error)), 'an NDJSON secret passed');
assert.deepEqual(content(textRef('log', 'application/x-ndjson'), '{"level":"info"}\n{"password":"[REDACTED]"}\n'), []);
const har = cookie => JSON.stringify({ log: { entries: [{ request: { method: 'GET', url: 'https://app.test/api/orders', headers: [{ name: 'Cookie', value: `sid=${cookie}` }], cookies: [{ name: 'sid', value: cookie }], queryString: [{ name: 'access_token', value: cookie }] }, response: { status: 200, headers: [{ name: 'Set-Cookie', value: `sid=${cookie}` }], cookies: [] } }] } });
const rawHar = content(textRef('har', 'application/json'), har('raw-cookie-value'));
for (const pattern of [/request header Cookie is not masked/, /request cookie sid is not masked/, /query parameter access_token is not masked/, /response header Set-Cookie is not masked/]) assert(rawHar.some(error => pattern.test(error)), `raw HAR was not rejected for ${pattern}: ${rawHar.join('; ')}`);
assert.deepEqual(content(textRef('har', 'application/json'), har('[REDACTED]')), []);
// Credentials in JSON bodies: quoted keys in text captures, escaped JSON in log lines, and
// HAR bodies and form parameters. One redact pass yields a fixed point that stays JSON.
const redactOnce = text => redactText(text, patterns).text;
const loginBody = '{"username":"qa","password":"hunter2"}';
for (const [kind, mediaType, capture] of [
  ['http', 'text/plain', `POST /api/login HTTP/1.1\nContent-Type: application/json\n\n${loginBody}\n`],
  ['http', 'message/http', `POST /api/login HTTP/1.1\nContent-Type: application/json\n\n${loginBody}\n`],
  ['log', 'text/plain', `INFO login request body={\\"username\\":\\"qa\\",\\"password\\":\\"hunter2\\"}\n`],
  ['text', 'text/plain', "{'username': 'qa', 'password': 'hunter2'}\n"],
]) {
  assert(content(textRef(kind, mediaType), capture).some(error => /redactor would change/.test(error)), `a ${mediaType} ${kind} body credential passed`);
  const safe = redactOnce(capture);
  assert(!safe.includes('hunter2'), `the redactor kept a ${mediaType} ${kind} body credential: ${safe}`);
  assert.equal(redactOnce(safe), safe, `redaction of a ${mediaType} ${kind} body is not a fixed point`);
  assert.deepEqual(content(textRef(kind, mediaType), safe), []);
}
assert.equal(redactOnce(`body ${loginBody}`), 'body {"username":"qa","password":"[REDACTED]"}');
assert.deepEqual(JSON.parse(redactOnce(loginBody)), { username: 'qa', password: '[REDACTED]' });
const bodyHar = ({ postData, content: responseContent = { mimeType: 'application/json', text: '{"id":7}' }, queryString = [] }) => ({ log: { entries: [{
  request: { method: 'POST', url: 'https://app.test/api/login', headers: [], cookies: [], queryString, postData },
  response: { status: 200, headers: [], cookies: [], content: responseContent },
}] } });
const jsonPost = { mimeType: 'application/json', text: loginBody };
assert(content(textRef('har', 'application/json'), JSON.stringify(bodyHar({ postData: jsonPost }))).some(error => /values the packaged redactor would change/.test(error)), 'a HAR postData.text credential passed');
assert(content(textRef('har', 'application/json'), JSON.stringify(bodyHar({ postData: { mimeType: 'text/plain', text: 'ok' }, content: { mimeType: 'application/json', text: '{"token":"opaque-session-value"}' } }))).some(error => /values the packaged redactor would change/.test(error)), 'a HAR response content.text token passed');
const safeHar = redactValue(bodyHar({ postData: jsonPost }), patterns).value;
assert.equal(safeHar.log.entries[0].request.postData.text, '{"username":"qa","password":"[REDACTED]"}');
assert.deepEqual(content(textRef('har', 'application/json'), JSON.stringify(safeHar)), []);
const formPost = secret => ({ mimeType: 'application/x-www-form-urlencoded', text: `username=qa&password=${secret}`, params: [{ name: 'username', value: 'qa' }, { name: 'password', value: secret }] });
const formErrors = content(textRef('har', 'application/json'), JSON.stringify(bodyHar({ postData: formPost('hunter2'), queryString: [{ name: 'Password', value: 'hunter2' }] })));
for (const pattern of [/request form parameter password is not masked/, /request query parameter Password is not masked/]) assert(formErrors.some(error => pattern.test(error)), `raw HAR pair was not rejected for ${pattern}: ${formErrors.join('; ')}`);
assert.deepEqual(content(textRef('har', 'application/json'), JSON.stringify(bodyHar({ postData: formPost('[REDACTED]'), queryString: [{ name: 'page', value: '2' }] }))), []);
// The numbers that prove a defect (totals, IDs, epoch timestamps, log times) stay visible:
// a card is a Luhn-valid run with a card-network leading digit, and a phone number needs a
// leading +, a (555) 123-4567 layout, a phone label in text, or a phone JSON key.
// 1759000000000 passes Luhn, so only the leading digit keeps it; 5234567890123 has one and
// fails Luhn.
const numericProof = [
  ['http', 'text/plain', 'HTTP/1.1 200 OK\n\n{"orderId":"1234567890","total":"123456.78","expected":"123457.00","createdAt":"1759000000000"}\n'],
  ['http', 'application/json', JSON.stringify({ orderId: '1234567890', total: '123456.78', createdAt: '2026-09-27 16:33:13', id: '5234567890123', seq: '1234567890123456789' })],
  ['log', 'text/plain', '2026-09-27 16:33:13 ERROR order 1234567890 total 123456.78 != 123457.00 at 1759000000000 offset +02:00 delta +1234.56\n'],
];
for (const [kind, mediaType, capture] of numericProof) assert.deepEqual(content(textRef(kind, mediaType), capture), [], `numeric proof was masked in ${mediaType} ${kind}: ${redactOnce(capture)}`);
for (const [raw, leaked] of [
  ['card 4111 1111 1111 1111 exp', '4111'], ['card 4242-4242-4242-4242', '4242'], ['amex 378282246310005', '378282'],
  ['call +48 600 700 800', '600 700'], ['call +1 (555) 123-4567', '123-4567'], ['office (555) 123-4567', '123-4567'], ['desk 555.123.4567', '123.4567'],
  ['Phone: 600 700 800', '700 800'], ['<a href="tel:600700800">', '600700800'], ['{"mobile":"600 700 800"}', '700 800'],
]) {
  const safe = redactOnce(raw);
  assert(!safe.includes(leaked), `the redactor kept ${leaked}: ${safe}`);
  assert.equal(redactOnce(safe), safe, `PII redaction is not a fixed point: ${safe}`);
  assert(content(textRef('text', 'text/plain'), raw).some(error => /redactor would change/.test(error)), `unmasked PII passed: ${raw}`);
}
// A phone key masks the number in its value, not a flag or an invalid input the defect needs.
assert.deepEqual(redactValue({ phone: '600 700 800', phoneNumber: 'ext 600700800', contact: { telephone: ['600 700 800'] }, mobile: true, fax: 'not-a-number', total: '123456.78', note: '600 700 800' }, patterns).value,
  { phone: '[REDACTED:PHONE]', phoneNumber: 'ext [REDACTED:PHONE]', contact: { telephone: ['[REDACTED:PHONE]'] }, mobile: true, fax: 'not-a-number', total: '123456.78', note: '600 700 800' });
const checkedPattern = extra => ({ ...patterns, patterns: [{ id: 'card', expression: '\\d{13}', flags: 'g', replacement: '[REDACTED:CARD]', check: 'luhn', ...extra }] });
assert.deepEqual(validateRedactionPatterns(checkedPattern({})), []);
assert(validateRedactionPatterns(checkedPattern({ check: 'mod97' })).some(error => /check must be one of luhn/.test(error)), 'an unknown match check was accepted');
assert(validateRedactionPatterns(checkedPattern({ replacement: '$1' })).some(error => /literal replacement/.test(error)), 'a checked pattern accepted a group reference');
assert(validateRedactionPatterns(checkedPattern({ keys: [] })).some(error => /keys must be a non-empty array/.test(error)), 'a keyed pattern accepted an empty key list');
assert(content(textRef('har', 'application/json'), '{"log":{}}').some(error => /log\.entries/.test(error)), 'a HAR without entries passed');
assert(content(textRef('dom-snapshot', 'text/html'), '<form><input name="p" type="password" value="hunter2"></form>').some(error => /password input with a value/.test(error)), 'a DOM snapshot with a password value passed');
assert(content(textRef('dom-snapshot', 'text/html'), "<input value='x>y' TYPE=Password>").some(error => /password input with a value/.test(error)), 'a quoted > hid a password value');
assert.deepEqual(content(textRef('dom-snapshot', 'text/html'), '<form><input name="p" type="password" value=""><input type="text" value="visible"></form>'), []);
const runnerResult = read('./fixtures/argus-schemas/valid/runner-result.json');
assert.deepEqual(content(textRef('runner-result', 'application/json'), JSON.stringify(runnerResult)), []);
assert(content(textRef('runner-result', 'application/json'), readFileSync(new URL('./fixtures/argus-schemas/invalid/runner-result.json', import.meta.url))).some(error => /runner result/.test(error)), 'a schema-invalid runner result passed');
assert(content(textRef('runner-result', 'application/json'), JSON.stringify({ ...runnerResult, status: 'fail' })).some(error => /pass exactly when exitCode is 0/.test(error)), 'a runner result with inconsistent semantics passed');
assert(content(textRef('runner-result', 'application/json'), '{"$schema":').some(error => /is not valid JSON/.test(error)), 'a malformed runner result passed');
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
assert(isBinaryReference(binaryRef('screenshot', 'image/png')) && isBinaryReference(binaryRef('trace', 'application/zip')) && !isBinaryReference(textRef('trace', 'application/json')));
assert.deepEqual(content(binaryRef('screenshot', 'image/png'), png), []);
assert(content(binaryRef('screenshot', 'image/jpeg'), png).some(error => /does not match the image\/jpeg signature/.test(error)), 'a PNG registered as image/jpeg passed');
assert(content(binaryRef('screenshot', 'image/png'), 'Synthetic evidence EVD-0010\n').some(error => /image\/png signature/.test(error)), 'a text file registered as a screenshot passed');
assert(content(textRef('text', 'text/plain'), png).some(error => /content is binary/.test(error)), 'binary bytes registered as text passed');
assert.deepEqual(content(binaryRef('screenshot', 'image/webp'), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), []);
assert.deepEqual(content(binaryRef('video', 'video/mp4'), Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom')])), []);
assert.deepEqual(content(binaryRef('video', 'video/webm'), Buffer.from('1a45dfa39f4286', 'hex')), []);
assert.deepEqual(content(binaryRef('trace', 'application/zip'), Buffer.from('504b030414000000', 'hex')), []);
assert(content(binaryRef('trace', 'application/zip'), Buffer.from('504b03', 'hex')).length, 'a truncated zip signature passed');
// The review binding: registration by the reviewer's own lease and the audited allow decision.
const screenshot = binaryRef('screenshot', 'image/png');
assert.deepEqual(binaryRegistrationErrors(screenshot, 'minos'), []);
assert.deepEqual(binaryRegistrationErrors(screenshot, 'atalanta'), ['binary evidence EVD-0010 must be registered by its reviewer minos, not atalanta']);
assert.deepEqual(binaryRegistrationErrors(textRef('http', 'text/plain'), 'kleio'), []);
const allowEvent = { engagementId: 'fixture-1', lane: 'atalanta', action: 'binary-evidence', decision: 'allow', timestamp: binaryReview.auditTimestamp };
assert.deepEqual(binaryReviewAuditErrors(screenshot, [allowEvent], 'fixture-1'), []);
for (const drift of [{ engagementId: 'foreign' }, { lane: 'minos' }, { action: 'browser-read' }, { decision: 'deny' }, { timestamp: '2026-07-10T00:02:31.000Z' }]) {
  assert.equal(binaryReviewAuditErrors(screenshot, [{ ...allowEvent, ...drift }], 'fixture-1').length, 1, `audit drift ${JSON.stringify(drift)} still bound the review`);
}
assert.deepEqual(parseAuditLog(`${JSON.stringify(allowEvent)}\n\n`), [allowEvent]);
assert.throws(() => parseAuditLog(`${JSON.stringify(allowEvent)}\n{"torn":`), /line 2 is not valid JSON/);
const evidenceDocument = read('./fixtures/argus-schemas/valid/evidence-reference.json');
const lateAudit = copy(evidenceDocument); lateAudit.references[2].review.auditTimestamp = '2026-07-10T00:03:00.001Z';
assert(validateCanonicalDocument('evidence-reference', lateAudit).some(error => /audit must not follow its capture/.test(error)), 'an audit decision after capture bound the review');
const leap = copy(evidenceDocument); Object.assign(leap.references[2], { capturedAt: '2016-12-31T23:59:60Z' }); Object.assign(leap.references[2].review, { auditTimestamp: '2016-12-31T23:59:59.5Z', reviewedAt: '2017-01-01T00:00:00Z' });
assert.deepEqual(validateCanonicalDocument('evidence-reference', leap), []);
leap.references[2].review.reviewedAt = '2016-12-31T23:59:59.999Z';
assert(validateCanonicalDocument('evidence-reference', leap).some(error => /review must not precede its capture/.test(error)), 'a review before a leap-second capture passed');
// Reconciliation quarantines a row whose cited evidence fails content or caller-bound checks.
const secret = Buffer.from('Authorization: Bearer abc.def\n');
const secretRegistry = { ...registry, references: [{ ...reference('EVD-0001', 'atalanta'), sha256: createHash('sha256').update(secret).digest('hex') }, reference('EVD-0002', 'talos')] };
const leaked = reconcileFindings(valid, secretRegistry, source => (source === 'reports/EVD-0001.txt' ? secret : bytes), { patterns });
assert(leaked.byBug['BUG-0001'].includes('BUG-0001: evidence EVD-0001 contains text the packaged redactor would change'), JSON.stringify(leaked.byBug));
const hooked = reconcileFindings(valid, registry, () => bytes, { verifyReference: ref => (ref.id === 'EVD-0002' ? ['audit binding missing'] : []) });
assert(hooked.byBug['BUG-0005'].includes('BUG-0005: audit binding missing'), JSON.stringify(hooked.byBug));
const throwing = reconcileFindings(valid, registry, () => bytes, { verifyReference: () => { throw new Error('audit unreadable'); } });
assert(throwing.byBug['BUG-0001'].includes('BUG-0001: evidence EVD-0001 cannot be verified: audit unreadable'), JSON.stringify(throwing.byBug));
// Case depth counts an obligation only on a surface whose execution resolves to registered
// evidence, and only with distinct assertion-control evidence.
const inventory = read('./fixtures/argus-coverage/surface-inventory.json');
const observations = read('./fixtures/argus-coverage/coverage-observations.json');
const coverageRegistry = read('./fixtures/argus-coverage/evidence-reference.json');
const readCoverage = source => readFileSync(new URL(`./fixtures/argus-coverage/${source}`, import.meta.url));
const coverageContext = { evidence: coverageRegistry, ledger: null, readArtifact: readCoverage };
const depthOf = document => calculateCoverage(inventory, document, coverageContext).overall.caseDepth;
const surface = inventory.items.find(item => item.id === 'SRF-UI-CHECKOUT');
const obs = observations.observations.find(item => item.surfaceId === surface.id);
inventory.items = [surface]; observations.observations = [obs];
assert.equal(depthOf(observations).coverage, null);
surface.obligations = ['OWNER', 'OTHER'].map(role => ({ id: `CASE-${role}`, dimensions: { operation: 'read', role, state: 'active', boundary: 'owned-object' }, weight: 5, oracleId: 'ORC-ACCESS', applicability: 'Two authorized synthetic accounts' }));
obs.cases = [{ obligationId: 'CASE-OWNER', oracleId: 'ORC-ACCESS', outcome: 'passed', evidenceIds: ['EVD-0101'], controlEvidenceIds: ['EVD-0103'] }];
let depth = depthOf(observations);
assert.equal(depth.coverage, 0.5); assert.equal(depth.gaps[0].obligationId, 'CASE-OTHER');
obs.cases[0].controlEvidenceIds = []; assert.equal(depthOf(observations).coverage, 0);
obs.cases[0].controlEvidenceIds = ['EVD-0101']; assert(validateCasePlan(inventory, observations).length);
obs.cases[0].controlEvidenceIds = ['EVD-0103'];
const unexecuted = copy(observations); unexecuted.observations[0].executions = [];
assert.throws(() => calculateCoverage(inventory, unexecuted, coverageContext), /CASE-OWNER: executed case on an unexecuted surface/);
assert.deepEqual(reconcileCoverageEvidence(inventory, observations, coverageRegistry, readCoverage), []);
const withoutControl = { ...coverageRegistry, references: coverageRegistry.references.filter(ref => ref.id !== 'EVD-0103') };
assert(reconcileCoverageEvidence(inventory, observations, withoutControl, readCoverage).includes('orion:SRF-UI-CHECKOUT: case CASE-OWNER control evidence: unresolved evidence EVD-0103'), 'unregistered case control evidence reconciled');
const leakedRegistry = copy(coverageRegistry);
leakedRegistry.references.find(ref => ref.id === 'EVD-0101').sha256 = createHash('sha256').update(secret).digest('hex');
const leakedCase = reconcileCoverageEvidence(inventory, observations, leakedRegistry, source => (source.endsWith('ui-checkout.dom.html') ? secret : readCoverage(source)));
assert(leakedCase.some(error => /case CASE-OWNER evidence: evidence EVD-0101 contains text the packaged redactor would change/.test(error)), 'case evidence skipped content validation');
assert.deepEqual(reconcileCoverageEvidence(inventory, { ...observations, engagementId: 'foreign' }, coverageRegistry, readCoverage), ['coverage evidence engagement mismatch']);
obs.cases.push({ ...obs.cases[0], obligationId: 'CASE-OTHER', outcome: 'failed' });
assert.equal(depthOf(observations).coverage, 1);
obs.cases[1].oracleId = 'invented'; assert(validateCasePlan(inventory, observations).length);
const finalSummary = read('./fixtures/argus-schemas/valid/final-summary.json');
const rendered = renderFinalSummary(finalSummary).split('\n');
const statusAt = rendered.indexOf('Status: degraded');
assert.deepEqual(rendered.slice(statusAt, statusAt + 4), ['Status: degraded', 'Status reason: case-depth-gaps', 'Status reason: critical-surface-unexecuted', 'Status reason: unresolved-proof-residuals']);
for (const line of ['- Defect headline (confirmed + suspected): 2', '- Needs oracle: 1', '- Bounced: 1', '- Quarantined: 1', '- Confirmed with verified regression: 1 (uncovered: none)', '- Automated tests: 2', '## Likely, unproven',
  '- BUG-0003 (Minor, needs-oracle): Order total rounds half-cent amounts down — would be confirmed by: oracle — A cited rounding rule for order totals would decide whether this is a defect.',
  '## Unresolved proof residuals', '- BUG-0006 (Major, bounced): Coupon applies twice after a retried checkout — repair round 1 — missing: reproduction',
  '- BUG-0007 (Minor, quarantined): Order history omits cancelled orders — reasons: The original capture was replaced after collection; fresh evidence is required.',
  '- Verdict: APPROVE (REV-02, round 2, blockers 0, warnings 0)', '- Delivery gate: yes', '- Automated re-execution: 100%', '- Critical surface not executed: SRF-UI-HOME', '- Required-case depth: unknown (not fully planned)']) {
  assert(rendered.includes(line), `rendered final summary lacks: ${line}`);
}
const unprovenFree = copy(finalSummary);
Object.assign(unprovenFree.counts.bugs, { suspected: 0, needsOracle: 0, bounced: 0, quarantined: 0, headline: 1 }); unprovenFree.unproven = []; unprovenFree.residuals = [];
Object.assign(unprovenFree.counts.regression, { wired: 0, uncovered: ['BUG-0001'] });
unprovenFree.automationReview = { status: 'absent', reviewId: null, round: null, blockers: 0, warnings: 0 };
const unprovenFreeLines = renderFinalSummary(unprovenFree).split('\n');
assert.equal(unprovenFreeLines[unprovenFreeLines.indexOf('## Likely, unproven') + 2], 'None.');
assert.equal(unprovenFreeLines[unprovenFreeLines.indexOf('## Unresolved proof residuals') + 2], 'None.');
assert(unprovenFreeLines.includes('- Confirmed with verified regression: 0 (uncovered: BUG-0001)'));
assert(unprovenFreeLines.includes('- Verdict: ABSENT (no review round, blockers 0, warnings 0)'));
const unfunded = copy(finalSummary); unfunded.runner = null; unfunded.counts.automated = 0;
const unfundedText = renderFinalSummary(unfunded);
assert(unfundedText.includes('no framework runner was executed') && unfundedText.includes('- Automated re-execution: n/a (automation unfunded)'));
assert(!unfundedText.includes('- Delivery gate:'));
for (const mutate of [
  (document) => { document.counts.bugs.headline = 1; },
  (document) => { document.unproven = document.unproven.slice(1); },
  (document) => { document.unproven.reverse(); },
  (document) => { document.residuals = document.residuals.slice(1); },
  (document) => { document.residuals.reverse(); },
  (document) => { document.counts.bugs.bounced = 0; },
  (document) => { document.residuals[0].missing = []; },
  (document) => { document.residuals[1].reasons = []; },
  (document) => { document.residuals[0].id = 'BUG-0002'; document.residuals.sort((left, right) => left.id.localeCompare(right.id)); },
  (document) => { delete document.residuals; },
  (document) => { document.status = 'completed'; },
  (document) => { document.counts.regression.wired = 0; },
  (document) => { document.automationReview.reviewId = null; },
  (document) => { delete document.coverage; },
]) {
  const document = copy(finalSummary); mutate(document);
  assert(validateCanonicalDocument('final-summary', document).length > 0, `final summary accepted ${mutate}`);
  assert.throws(() => renderFinalSummary(document), /invalid final summary/);
}
const plan = read('../argus/orchestration-plan.json');
assert(!plan.roles.find(role => role.slug === 'perseus').gates.includes('browser-runtime'));
assert(!plan.roles.find(role => role.slug === 'daidalos').modes.includes('B'));
console.log('PASS  Finding proof, conditional oracles, intermittent and single-attempt independence, ledger@2 status blocks, causal merges, per-bug quarantine, evidence@3 content and review binding, dedup evidence, case depth, final-summary@2 rendering and semantics, and unfunded runner regressions');
