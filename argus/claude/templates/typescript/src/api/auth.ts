import { APIRequestContext, request } from '@playwright/test';
import { ENV, Role } from '../config/env';

// Token cache — one login per API and role per worker, not per test. Keying by the API URL
// keeps a counterfactual stub's token and the real target's token apart.
const tokenCache = new Map<string, string>();

// Adapt the login flow to the app's real auth (token/JWT/session). Discover it from the OpenAPI spec.
export async function login(role: Role): Promise<string> {
  const apiURL = ENV.apiURL;
  const key = `${apiURL}|${role}`;
  const cached = tokenCache.get(key);
  if (cached) return cached;

  const ctx = await request.newContext({ baseURL: apiURL });
  const { username, password } = ENV.accounts[role];
  const res = await ctx.post('/auth/login', { data: { username, password } }); // <-- adapt path/payload
  if (!res.ok()) throw new Error(`login(${role}) failed: ${res.status()} ${await res.text()}`);
  const body = await res.json();
  await ctx.dispose();

  const token = body.token ?? body.accessToken; // <-- adapt token field
  tokenCache.set(key, token);
  return token;
}

// Authenticated request context for a given role.
export async function apiAs(role: Role): Promise<APIRequestContext> {
  const token = await login(role);
  return request.newContext({
    baseURL: ENV.apiURL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` }, // <-- adapt scheme
  });
}
