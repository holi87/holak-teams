import { counterfactualApiURL, targetApiURL } from '../argus/api-url';

// Central config for the target app. Fill in at the start of an engagement from Kalchas's recon.
const TARGET_API_URL = targetApiURL();

export const ENV = {
  /**
   * The API every client uses, resolved at call time. In a cf-* evidence pass the
   * counterfactual fixture points it at the in-worker stub (src/argus/api-url.ts).
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
