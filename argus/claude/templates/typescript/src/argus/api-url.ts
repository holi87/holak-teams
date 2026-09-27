// API URL seam of the runner kit (TEMPLATE-CONTRACT.md "ADAPT: the runner kit"). Every API
// client resolves its base URL through counterfactualApiURL() at call time, never from a
// constant captured at module load, so a cf-* evidence pass reaches the in-worker stub.

/** The real target API: API_URL, or the local default. Never the counterfactual stub. */
export function targetApiURL(): string {
  return process.env.API_URL ?? 'http://localhost:3001';
}

/**
 * In a cf-* evidence pass, the in-worker stub URL that the counterfactual fixture publishes
 * (ARGUS_COUNTERFACTUAL_API_URL); only a 127.0.0.1 URL is honoured. Undefined otherwise.
 */
export function counterfactualApiURL(): string | undefined {
  if (!(process.env.ARGUS_EVIDENCE_PASS ?? '').startsWith('cf-')) return undefined;
  const value = process.env.ARGUS_COUNTERFACTUAL_API_URL;
  if (!value) return undefined;
  try {
    return new URL(value).hostname === '127.0.0.1' ? value : undefined;
  } catch {
    return undefined;
  }
}
