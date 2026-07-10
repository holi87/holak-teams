// Central config for the target app. Fill in at the start of an engagement from Kalchas's recon.
export const ENV = {
  apiURL: process.env.API_URL ?? 'http://localhost:3001',
  uiURL: process.env.UI_URL ?? 'http://localhost:3000',
  helperURL: process.env.HELPER_URL ?? 'http://localhost:3002',

  // Test accounts — replace with the real seeded accounts/roles from the docs.
  accounts: {
    admin: { username: 'admin@example.com', password: 'CHANGE_ME' },
    user: { username: 'user@example.com', password: 'CHANGE_ME' },
  },
} as const;

export type Role = keyof typeof ENV.accounts;
