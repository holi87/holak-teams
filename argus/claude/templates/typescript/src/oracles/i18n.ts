import { expect } from '@playwright/test';
import { IDENTITY_VECTORS } from './identity';

// Character-set round-trip oracle. A stored value must come back code point for code
// point: a byte-truncating column, a stripped 4-byte character, or a silent NFC/NFD
// normalization is RED. A length limit counts characters, never UTF-8 bytes.

export type I18nVector = { label: string; value: string };

/** The vectors i18nCharset round-trips, in order. */
export const I18N_VECTORS: ReadonlyArray<Readonly<I18nVector>> = Object.freeze(
  [
    { label: 'diacritics.0', value: IDENTITY_VECTORS.diacritics[0] },
    { label: 'diacritics.1', value: IDENTITY_VECTORS.diacritics[1] },
    { label: 'emoji', value: IDENTITY_VECTORS.unicodeEdge.emoji },
    { label: 'nfd', value: IDENTITY_VECTORS.unicodeEdge.nfd },
  ].map((vector) => Object.freeze(vector)),
);

// ż: one code point, one UTF-16 unit, two UTF-8 bytes, so every sane character count
// agrees and only a byte count differs.
const MULTI_BYTE = '\u{17C}';
const MAX_LISTED_CODE_POINTS = 24;

/**
 * Round-trip every I18N_VECTORS entry: `submit(value)` returns true when the product
 * accepted the value, and `readBack()` returns the value it stored (a closure over the
 * created id or the profile read works). Each vector must be accepted and read back with
 * exactly the same code points. With `maxLength`, maxLength multi-byte characters must be
 * accepted and read back intact, and maxLength + 1 must be refused.
 */
export async function i18nCharset(options: {
  submit: (value: string) => boolean | Promise<boolean>;
  readBack: () => string | Promise<string>;
  maxLength?: number;
}): Promise<{ checked: string[] }> {
  const { submit, readBack, maxLength } = options;
  if (typeof submit !== 'function' || typeof readBack !== 'function') throw new TypeError('i18nCharset: submit and readBack must be functions');
  if (maxLength !== undefined && (!Number.isSafeInteger(maxLength) || maxLength < 1)) {
    throw new TypeError(`i18nCharset: maxLength must be a positive integer, got ${JSON.stringify(maxLength)}`);
  }
  const vectors: I18nVector[] = I18N_VECTORS.map((vector) => ({ ...vector }));
  if (maxLength !== undefined) vectors.push({ label: `max-length.${maxLength}`, value: MULTI_BYTE.repeat(maxLength) });
  const failures: string[] = [];
  for (const vector of vectors) {
    if (!(await accepted(submit, vector.value))) {
      failures.push(`${vector.label}: refused ${describe(vector.value)}`);
      continue;
    }
    const stored = await readBack();
    if (typeof stored !== 'string') throw new TypeError('i18nCharset: readBack must return the stored string');
    if (codePoints(stored).join(' ') !== codePoints(vector.value).join(' ')) {
      failures.push(`${vector.label}: sent ${describe(vector.value)}, read back ${describe(stored)}`);
    }
  }
  if (maxLength !== undefined) {
    const over = MULTI_BYTE.repeat(maxLength + 1);
    if (await accepted(submit, over)) failures.push(`max-length.${maxLength + 1}: accepted maxLength + 1 = ${maxLength + 1} characters`);
  }
  expect(failures.length === 0, `i18nCharset: the value did not round-trip character for character\n${failures.join('\n')}`).toBe(true);
  return { checked: [...vectors.map((vector) => vector.label), ...(maxLength !== undefined ? [`max-length.${maxLength + 1}`] : [])] };
}

async function accepted(submit: (value: string) => boolean | Promise<boolean>, value: string): Promise<boolean> {
  const result = await submit(value);
  if (typeof result !== 'boolean') throw new TypeError('i18nCharset: submit must return true (accepted) or false (refused)');
  return result;
}

function codePoints(value: string): string[] {
  return [...value].map((char) => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`);
}

/** "5 code points (11 UTF-8 bytes): U+017B U+00F3 …", never the raw value. */
function describe(value: string): string {
  const points = codePoints(value);
  const listed = points.slice(0, MAX_LISTED_CODE_POINTS).join(' ');
  const more = points.length > MAX_LISTED_CODE_POINTS ? ' …' : '';
  return `${points.length} code points (${Buffer.byteLength(value, 'utf8')} UTF-8 bytes): ${listed}${more}`;
}
