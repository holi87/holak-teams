#!/usr/bin/env node

// Test-only fixture generator. Production authorization is created and verified by
// argus-launch; this helper lets unrelated preflight suites exercise the same runtime
// signature verifier even when their legacy fixture keeps artifacts inside the target.

import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  modelAuthenticatedDocumentSha256,
  modelAuthenticationPayload,
  modelPublicKeyFingerprint,
} from '../../../argus/runtime/model-policy.mjs';

const [
  targetKind, target, workspace, artifactRoot, mode, engagementId, launcher, launcherPidRaw,
  claudeExecutable, runtimeKeyId, trustStore, privateKeyPath, authorizationPath, receiptPath, capabilitySha256,
  sandboxProbePath,
] = process.argv.slice(2);
if (!sandboxProbePath) throw new Error('unit authorization fixture arguments are incomplete');

const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const trust = JSON.parse(readFileSync(trustStore, 'utf8'));
const record = trust.keys.find((key) => key.keyId === runtimeKeyId);
if (!record) throw new Error(`runtime fixture key is missing: ${runtimeKeyId}`);
const publicKey = createPublicKey(record.publicKeyPem);
const sandboxProbe = lstatSync(sandboxProbePath);
const requestNonce = randomBytes(32).toString('hex');
const issuedAt = new Date();
const authorization = {
  schema: 'argus/native-launch-authorization@1',
  schemaVersion: 1,
  kind: 'ARGUS_NATIVE_LAUNCH_AUTHORIZATION',
  launchId: `LCH-${createHash('sha256').update(`${requestNonce}\0${launcherPidRaw}`).digest('hex').slice(0, 24)}`,
  engagementId,
  requestNonce,
  launcherPid: Number(launcherPidRaw),
  launchCapabilitySha256: capabilitySha256,
  runtime: 'claude',
  model: 'opus',
  effort: 'max',
  maxTurns: 96,
  mode,
  targetKind,
  target,
  workspace,
  artifactRoot,
  launcherExecutable: launcher,
  launcherSha256: sha256File(launcher),
  claudeExecutable,
  claudeExecutableSha256: sha256File(claudeExecutable),
  claudeVersion: execFileSync(claudeExecutable, ['--version'], { encoding: 'utf8' }).trim(),
  sandboxPolicy: 'os-native-target-readonly@2',
  sandboxProbePath,
  sandboxProbeDevice: sandboxProbe.dev,
  sandboxProbeInode: sandboxProbe.ino,
  sandboxProbeUid: sandboxProbe.uid,
  sandboxProbeMode: sandboxProbe.mode & 0o777,
  environmentPolicy: 'argus-launch-allowlist@1',
  issuedBy: record.subjectId,
  issuedAt: issuedAt.toISOString(),
  expiresAt: new Date(issuedAt.getTime() + 300_000).toISOString(),
  authentication: {
    algorithm: 'Ed25519',
    keyId: runtimeKeyId,
    purpose: 'runtime-attestation',
    keyFingerprintSha256: modelPublicKeyFingerprint(record.publicKeyPem),
    signatureBase64: '',
  },
};
authorization.authentication.signatureBase64 = sign(
  null,
  Buffer.from(modelAuthenticationPayload(authorization)),
  createPrivateKey(readFileSync(privateKeyPath)),
).toString('base64');
writeFileSync(authorizationPath, `${JSON.stringify(authorization, null, 2)}\n`, { mode: 0o600 });

const receipt = {
  schema: 'argus/native-launch-receipt@1',
  schemaVersion: 1,
  launchId: authorization.launchId,
  engagementId,
  launcherPid: authorization.launcherPid,
  launchCapabilitySha256: capabilitySha256,
  authorizationPath,
  authorizationSha256: modelAuthenticatedDocumentSha256(authorization),
  trustStorePath: trustStore,
  trustStoreSha256: sha256File(trustStore),
  runtimeKeyId,
  runtimeKeyFingerprintSha256: modelPublicKeyFingerprint(publicKey.export({ type: 'spki', format: 'pem' })),
  targetKind,
  target,
  workspace,
  artifactRoot,
  mode,
  runtime: 'claude',
  model: 'opus',
  effort: 'max',
  maxTurns: 96,
  launcherExecutable: launcher,
  launcherSha256: authorization.launcherSha256,
  claudeExecutable,
  claudeExecutableSha256: authorization.claudeExecutableSha256,
  claudeVersion: authorization.claudeVersion,
  sandboxPolicy: authorization.sandboxPolicy,
  sandboxProbePath,
  sandboxProbeDevice: authorization.sandboxProbeDevice,
  sandboxProbeInode: authorization.sandboxProbeInode,
  sandboxProbeUid: authorization.sandboxProbeUid,
  sandboxProbeMode: authorization.sandboxProbeMode,
  environmentPolicy: authorization.environmentPolicy,
  verifiedAt: new Date().toISOString(),
  expiresAt: authorization.expiresAt,
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
