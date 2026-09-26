import { createHmac } from 'node:crypto';

// Deterministic derivation for every corpus value that varies per seed.
// Identical (seed, name) pairs yield identical values across restarts, so Mode A
// regression replay can address the same IDs and limits on a fresh instance.
const KEY = 'argus-eval-corpus-v2';

function checkInput(seed, name) {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('corpus seed must be a non-negative safe integer');
  if (typeof name !== 'string' || !name) throw new Error('derivation name must be a non-empty string');
}

export function derive(seed, name) {
  checkInput(seed, name);
  return createHmac('sha256', KEY).update(`${seed}:${name}`).digest();
}

// Lowercase UUID-shaped identifier (8-4-4-4-12) with version nibble 4 and the RFC 4122 variant.
export function deriveId(seed, name) {
  const bytes = derive(seed, name).subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Integer in [min, max], both inclusive.
export function deriveInt(seed, name, min, max) {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) throw new Error('deriveInt requires integer bounds with min <= max');
  const span = max - min + 1;
  if (span > 2 ** 48) throw new Error('deriveInt range is limited to 2^48 values');
  return min + derive(seed, name).readUIntBE(0, 6) % span;
}
