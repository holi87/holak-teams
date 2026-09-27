import { expect } from '@playwright/test';

// Canonical identity-input vectors and the credential consistency oracle. Every non-ASCII
// vector is written as a \u{...} escape so no editor, formatter, or git filter can normalize
// it (an NFD vector folded to NFC is worthless) or hide it (a literal bidi override is a
// Trojan-Source pattern). A comment names or shows each vector.

export type EmailPartitionLabel =
  | 'email.missing-at'
  | 'email.missing-domain'
  | 'email.missing-tld'
  | 'email.double-at'
  | 'email.embedded-whitespace';

export type Credentials = { email: string; password: string };

export type CredentialCheck = {
  name: 'byte-identical' | 'case-variant-email' | 'case-variant-password' | 'trailing-space-password';
  expected: 'accepted' | 'rejected';
  actual: 'accepted' | 'rejected';
};

export const IDENTITY_VECTORS = deepFreeze({
  whitespace: {
    leading: ' Argus',
    trailing: 'Argus ',
    internal: 'Argus QA',
    tab: 'Argus\tQA',
    spaceOnly: '   ',
  },
  diacritics: [
    '\u{17B}\u{F3}\u{142}\u{107} \u{104}\u{107}\u{119}\u{142}\u{144}', // Żółć Ąćęłń
    'Zo\u{EB} Salda\u{F1}a', // Zoë Saldaña
  ],
  special: '!@#$%^&*()"\'<>',
  unicodeEdge: {
    emoji: '\u{1F600}\u{1F44D}\u{1F3FD}', // grinning face, thumbs up with a skin-tone modifier
    rtl: '\u{202E}abc', // RIGHT-TO-LEFT OVERRIDE, then abc
    zeroWidth: 'a\u{200B}b', // a, ZERO WIDTH SPACE, b
    combining: 'e\u{301}', // e, COMBINING ACUTE ACCENT
    nfc: '\u{E9}', // e with acute, precomposed (NFC)
    nfd: 'e\u{301}', // e with acute, decomposed (NFD)
    overlong: 'a'.repeat(1025),
  },
} as const);

/** One invalid email per email partition label; each must be rejected. */
export const invalidEmails: ReadonlyArray<Readonly<{ label: EmailPartitionLabel; value: string }>> = Object.freeze(
  [
    { label: 'email.missing-at', value: 'argus.qa.example.com' },
    { label: 'email.missing-domain', value: 'argus.qa@' },
    { label: 'email.missing-tld', value: 'argus.qa@example' },
    { label: 'email.double-at', value: 'argus.qa@@example.com' },
    { label: 'email.embedded-whitespace', value: 'argus qa@example.com' },
  ].map((entry) => Object.freeze(entry as { label: EmailPartitionLabel; value: string })),
);

/**
 * The known-good email 'argus.qa+<seq>@example.com', the positive oracle for every email
 * field. `seq` is a non-negative integer or a lowercase [a-z0-9-] token; against an
 * environment that keeps accounts across runs, pass a run-unique token.
 */
export function validEmail(seq: number | string): string {
  const valid = typeof seq === 'number' ? Number.isSafeInteger(seq) && seq >= 0 : typeof seq === 'string' && /^[a-z0-9-]{1,32}$/.test(seq);
  if (!valid) throw new TypeError(`validEmail: seq must be a non-negative integer or a lowercase [a-z0-9-] token, got ${JSON.stringify(seq)}`);
  return `argus.qa+${seq}@example.com`;
}

/** [lower, UPPER, Mixed]; Mixed alternates upper and lower case over the cased letters. */
export function caseVariants(value: string): [string, string, string] {
  if (typeof value !== 'string') throw new TypeError('caseVariants: value must be a string');
  let letter = 0;
  let mixed = '';
  for (const char of value) {
    const upper = char.toUpperCase();
    const lower = char.toLowerCase();
    if (upper === lower) {
      mixed += char;
      continue;
    }
    mixed += letter % 2 === 0 ? upper : lower;
    letter += 1;
  }
  return [value.toLowerCase(), value.toUpperCase(), mixed];
}

// Argus!Żółć#Qa7 followed by one space: diacritics, special characters, a trailing space.
const DEFAULT_PASSWORD = 'Argus!\u{17B}\u{F3}\u{142}\u{107}#Qa7 ';
let sequence = 0;

/**
 * The credential consistency oracle. Registers one account, then requires:
 * - byte-identical: the exact registered email and password log in;
 * - case-variant-email: an email case variant logs in (must be refused when
 *   emailCaseInsensitive is false);
 * - case-variant-password: a password case variant is refused (must log in when
 *   passwordCaseSensitive is false);
 * - trailing-space-password: the password plus one trailing space is refused.
 * The default password carries diacritics, special characters, and a trailing space, so a
 * silent trim, truncation, or charset strip on only one side (register or login) is RED.
 * `register` and `login` return true when the product accepted the credentials. The
 * default email is validEmail(<per-process sequence>); pass `email` for a run-unique one
 * and `password` when the product documents a stricter password policy. Messages name the
 * checks only, never the credentials.
 */
export async function credentialConsistency(options: {
  register: (credentials: Credentials) => boolean | Promise<boolean>;
  login: (credentials: Credentials) => boolean | Promise<boolean>;
  email?: string;
  password?: string;
  passwordCaseSensitive?: boolean;
  emailCaseInsensitive?: boolean;
}): Promise<{ email: string; checks: CredentialCheck[] }> {
  const { register, login } = options;
  if (typeof register !== 'function' || typeof login !== 'function') {
    throw new TypeError('credentialConsistency: register and login must be functions');
  }
  const passwordCaseSensitive = flag(options.passwordCaseSensitive, true, 'passwordCaseSensitive');
  const emailCaseInsensitive = flag(options.emailCaseInsensitive, true, 'emailCaseInsensitive');
  const email = options.email ?? validEmail((sequence += 1));
  const password = options.password ?? DEFAULT_PASSWORD;
  if (typeof email !== 'string' || email === '' || typeof password !== 'string' || password === '') {
    throw new TypeError('credentialConsistency: email and password must be non-empty strings');
  }
  const emailVariant = differentVariant(email, 'email');
  const passwordVariant = differentVariant(password, 'password');

  const registered = await accepted(register, { email, password }, 'register');
  expect(registered, 'credentialConsistency: register refused the credential vector; nothing else can be checked').toBe(true);

  const plan: Array<{ name: CredentialCheck['name']; credentials: Credentials; expected: boolean }> = [
    // Expected successes run before expected refusals, so a lockout policy cannot mask them.
    { name: 'byte-identical', credentials: { email, password }, expected: true },
    { name: 'case-variant-email', credentials: { email: emailVariant, password }, expected: emailCaseInsensitive },
    { name: 'case-variant-password', credentials: { email, password: passwordVariant }, expected: !passwordCaseSensitive },
    { name: 'trailing-space-password', credentials: { email, password: `${password} ` }, expected: false },
  ];
  plan.sort((left, right) => Number(right.expected) - Number(left.expected));
  const checks: CredentialCheck[] = [];
  for (const step of plan) {
    const actual = await accepted(login, step.credentials, `login (${step.name})`);
    checks.push({ name: step.name, expected: verdict(step.expected), actual: verdict(actual) });
  }
  const failures = checks.filter((check) => check.expected !== check.actual);
  expect(
    failures.length === 0,
    `credentialConsistency: ${failures.map((check) => `${check.name} login expected ${check.expected}, got ${check.actual}`).join('; ')}`,
  ).toBe(true);
  return { email, checks };
}

async function accepted(callback: (credentials: Credentials) => boolean | Promise<boolean>, credentials: Credentials, label: string): Promise<boolean> {
  const result = await callback({ ...credentials });
  if (typeof result !== 'boolean') throw new TypeError(`credentialConsistency: ${label} must return true (accepted) or false (refused)`);
  return result;
}

function differentVariant(value: string, label: string): string {
  const variant = caseVariants(value).find((candidate) => candidate !== value);
  if (variant === undefined) throw new TypeError(`credentialConsistency: the ${label} has no cased letter, so its case handling cannot be checked`);
  return variant;
}

function flag(value: boolean | undefined, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`credentialConsistency: ${label} must be a boolean`);
  return value;
}

function verdict(value: boolean): 'accepted' | 'rejected' {
  return value ? 'accepted' : 'rejected';
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
