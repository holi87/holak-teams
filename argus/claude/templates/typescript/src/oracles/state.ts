import { expect } from '@playwright/test';
import { assertRestStatus, describeResult, HttpResult, readResult, REST_STATUS, RestState } from './http';

// Lifecycle state oracles. A deleted resource must be gone from every read path, not only
// from the detail GET: a list, a search, or an export that still serves it is a
// soft-delete defect, and a deleted user who can still log in is a security one.

export type SoftDeleteResult = {
  /** The delete status (the exact code of expectedDeleteState). */
  deleteStatus: number;
  /** The status of the detail read after the delete (404). */
  getStatus: number;
  /** How many list reads were checked. */
  lists: number;
  /** The login status after the delete (401), when loginAttempt was given. */
  loginStatus?: number;
};

/**
 * Delete a resource, then sweep every read path. The delete must answer
 * assertRestStatus(expectedDeleteState) (default 'deleted': 204 with an empty body); then
 * `getById()` must answer 404 ('missing'), every function in `listIds` must return ids
 * that exclude `id`, and `loginAttempt()`, when given (a deleted user's credentials), must
 * answer 401 ('unauthenticated'). A failed delete stops the sweep; after a successful one
 * every read path is checked and all of the failures are reported together. Ids compare as
 * strings, so a list serving 7 still matches the id '7' read from a Location header: a
 * type mismatch never hides a resurrected resource.
 */
export async function softDeleteSweep(options: {
  deleteResource: () => Promise<HttpResult>;
  getById: () => Promise<HttpResult>;
  listIds: ReadonlyArray<() => ReadonlyArray<unknown> | Promise<ReadonlyArray<unknown>>>;
  id: string | number;
  loginAttempt?: () => Promise<HttpResult>;
  expectedDeleteState?: RestState;
}): Promise<SoftDeleteResult> {
  const { deleteResource, getById, listIds, id, loginAttempt } = options;
  const expectedDeleteState = options.expectedDeleteState ?? 'deleted';
  if (typeof deleteResource !== 'function' || typeof getById !== 'function') throw new TypeError('softDeleteSweep: deleteResource and getById must be functions');
  if (!Array.isArray(listIds) || listIds.length === 0 || !listIds.every((list) => typeof list === 'function')) {
    throw new TypeError('softDeleteSweep: listIds must be a non-empty array of functions, one per list read that could still serve the resource');
  }
  if (!((typeof id === 'string' && id !== '') || (typeof id === 'number' && Number.isFinite(id)))) {
    throw new TypeError(`softDeleteSweep: id must be a non-empty string or a finite number, got ${JSON.stringify(id)}`);
  }
  if (loginAttempt !== undefined && typeof loginAttempt !== 'function') throw new TypeError('softDeleteSweep: loginAttempt must be a function');
  if (!Object.prototype.hasOwnProperty.call(REST_STATUS, expectedDeleteState)) {
    throw new TypeError(`softDeleteSweep: unknown expectedDeleteState ${JSON.stringify(expectedDeleteState)}`);
  }

  const deleted = await deleteResource();
  await assertRestStatus(deleted, expectedDeleteState);
  const deleteStatus = typeof deleted.status === 'function' ? deleted.status() : deleted.status;

  const target = String(id);
  const problems: string[] = [];
  const read = await readResult(await getById());
  if (read.status !== REST_STATUS.missing) problems.push(`getById: expected HTTP ${REST_STATUS.missing} after the delete, got ${read.status}: ${describeResult(read)}`);
  for (const [index, list] of listIds.entries()) {
    const ids = await list();
    if (!Array.isArray(ids)) throw new TypeError(`softDeleteSweep: listIds[${index}] must return an array of ids`);
    if (ids.some((entry) => String(entry) === target)) problems.push(`listIds[${index}] still serves the deleted id ${JSON.stringify(id)}`);
  }
  let loginStatus: number | undefined;
  if (loginAttempt) {
    const login = await readResult(await loginAttempt());
    loginStatus = login.status;
    if (login.status !== REST_STATUS.unauthenticated) {
      problems.push(`loginAttempt: expected HTTP ${REST_STATUS.unauthenticated} for the deleted account, got ${login.status}: ${describeResult(login, false)}`);
    }
  }
  expect(problems.length === 0, `softDeleteSweep: resource ${JSON.stringify(id)} is not gone after the delete\n${problems.join('\n')}`).toBe(true);
  return { deleteStatus, getStatus: read.status, lists: listIds.length, ...(loginStatus !== undefined ? { loginStatus } : {}) };
}
