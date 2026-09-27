// Central config for the target app. Fill in at the start of an engagement from Kalchas's recon.
const TARGET_API_URL = process.env.API_URL ?? 'http://localhost:3001';

export const ENV = {
  /**
   * The API every client uses. In a cf-* evidence pass the counterfactual fixture points it
   * at the in-worker stub (ARGUS_COUNTERFACTUAL_API_URL); only a 127.0.0.1 URL is honoured.
   */
  get apiURL(): string {
    return counterfactualApiURL() ?? TARGET_API_URL;
  },
  /** The real target API, never the counterfactual stub. */
  targetApiURL: TARGET_API_URL,
  uiURL: process.env.UI_URL ?? 'http://localhost:3000',
  helperURL: process.env.HELPER_URL ?? 'http://localhost:3002',

  // Test accounts — replace with the real seeded accounts/roles from the docs.
  accounts: {
    admin: { username: 'admin@example.com', password: 'CHANGE_ME' },
    user: { username: 'user@example.com', password: 'CHANGE_ME' },
  },
} as const;

export type Role = keyof typeof ENV.accounts;

function counterfactualApiURL(): string | undefined {
  if (!(process.env.ARGUS_EVIDENCE_PASS ?? '').startsWith('cf-')) return undefined;
  const value = process.env.ARGUS_COUNTERFACTUAL_API_URL;
  if (!value) return undefined;
  try {
    return new URL(value).hostname === '127.0.0.1' ? value : undefined;
  } catch {
    return undefined;
  }
}
