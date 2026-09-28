import { expect } from '@playwright/test';

// Collection conservation across pages. Walking a collection twice at a small page size
// exposes the classic pagination defects: an unstable sort that repeats one item and skips
// another at a page boundary, a total that drifts from the items served, a page size that
// is ignored, and a cursor that loops.

export type CollectionId = string | number;

/** Page mode sends {page, pageSize}; cursor mode sends {cursor, pageSize}, cursor undefined first. */
export type PageRequest = { page?: number; cursor?: string; pageSize: number };

/** One page as the adapter maps it: the items, the reported total, and the next cursor. */
export type PageResult<T> = { items: T[]; total?: number | null; nextCursor?: string | null };

export type PaginationResult = {
  /** Distinct ids of the first walk, in first-seen order. */
  ids: CollectionId[];
  /** The total reported by the first page that reports one; undefined when none does. */
  total: number | undefined;
  /** Ids served more than once within one walk. */
  duplicates: CollectionId[];
  /** Ids served in one walk but not in the other. */
  missing: CollectionId[];
  /** Pages fetched by the first walk. */
  pages: number;
  /** True when both walks served the same id sequence and nothing in `anomalies` occurred. */
  consistent: boolean;
  /** Human-readable reasons for `consistent: false`. */
  anomalies: string[];
};

type Walk = { ids: CollectionId[]; totals: number[]; pages: number; anomalies: string[] };

/**
 * Walk the whole collection twice through `fetchPage` and collect what conservation needs.
 * Page mode starts at `firstPage` (default 1) and ends on a page shorter than `pageSize`;
 * cursor mode ends when `nextCursor` is null, undefined, or empty. A walk that has not
 * ended after `maxPages` pages (default 1000), a repeated cursor, a page larger than
 * `pageSize`, an item without an id, reported totals that differ, and walks that serve
 * different id sequences are anomalies, never exceptions; assertCollectionConservation
 * turns them into RED. `idOf(item)` returns the item's string or number id.
 */
export async function paginateAll<T>(options: {
  fetchPage: (request: PageRequest) => PageResult<T> | Promise<PageResult<T>>;
  mode: 'page' | 'cursor';
  pageSize: number;
  idOf: (item: T) => unknown;
  maxPages?: number;
  firstPage?: number;
}): Promise<PaginationResult> {
  const { fetchPage, mode, pageSize, idOf } = options;
  const maxPages = options.maxPages ?? 1000;
  const firstPage = options.firstPage ?? 1;
  if (typeof fetchPage !== 'function' || typeof idOf !== 'function') throw new TypeError('paginateAll: fetchPage and idOf must be functions');
  if (mode !== 'page' && mode !== 'cursor') throw new TypeError(`paginateAll: mode must be 'page' or 'cursor', got ${JSON.stringify(mode)}`);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new TypeError(`paginateAll: pageSize must be a positive integer, got ${JSON.stringify(pageSize)}`);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new TypeError(`paginateAll: maxPages must be a positive integer, got ${JSON.stringify(maxPages)}`);
  if (!Number.isSafeInteger(firstPage) || firstPage < 0) throw new TypeError(`paginateAll: firstPage must be a non-negative integer, got ${JSON.stringify(firstPage)}`);

  const walk = async (): Promise<Walk> => {
    const result: Walk = { ids: [], totals: [], pages: 0, anomalies: [] };
    const cursors = new Set<string>();
    let page = firstPage;
    let cursor: string | undefined;
    for (;;) {
      if (result.pages >= maxPages) {
        result.anomalies.push(`the walk did not end within maxPages=${maxPages}`);
        return result;
      }
      const where = mode === 'page' ? `page ${page}` : `page ${result.pages + 1}`;
      const served = await fetchPage(mode === 'page' ? { page, pageSize } : { cursor, pageSize });
      result.pages += 1;
      if (served === null || typeof served !== 'object' || !Array.isArray(served.items)) {
        throw new TypeError(`paginateAll: fetchPage must return {items: [...], total?, nextCursor?} (${where})`);
      }
      if (served.total !== undefined && served.total !== null) {
        if (typeof served.total !== 'number') throw new TypeError(`paginateAll: a reported total must be a number (${where})`);
        result.totals.push(served.total);
      }
      if (served.items.length > pageSize) result.anomalies.push(`${where} served ${served.items.length} items for pageSize ${pageSize}`);
      served.items.forEach((item, index) => {
        const id = idOf(item);
        if (id === undefined || id === null || id === '') {
          result.anomalies.push(`${where} item ${index} has no id`);
        } else if ((typeof id === 'number' && Number.isFinite(id)) || typeof id === 'string') {
          result.ids.push(id);
        } else {
          throw new TypeError(`paginateAll: idOf must return a string or a finite number (${where} item ${index})`);
        }
      });
      if (mode === 'page') {
        if (served.items.length < pageSize) return result;
        page += 1;
        continue;
      }
      const next = served.nextCursor;
      if (next === undefined || next === null || next === '') return result;
      if (typeof next !== 'string') throw new TypeError(`paginateAll: nextCursor must be a string, null, or undefined (${where})`);
      if (cursors.has(next)) {
        result.anomalies.push(`${where} repeated an earlier cursor`);
        return result;
      }
      cursors.add(next);
      cursor = next;
    }
  };

  const first = await walk();
  const second = await walk();
  const firstKeys = new Set(first.ids.map(key));
  const secondKeys = new Set(second.ids.map(key));
  const anomalies = [...first.anomalies.map((note) => `walk 1: ${note}`), ...second.anomalies.map((note) => `walk 2: ${note}`)];
  const totals = [...new Set([...first.totals, ...second.totals])];
  if (totals.length > 1) anomalies.push(`the reported totals differ: ${totals.join(', ')}`);
  if (first.ids.map(key).join('\n') !== second.ids.map(key).join('\n')) anomalies.push('the two walks served different id sequences');
  return {
    ids: distinct(first.ids),
    total: first.totals[0] ?? second.totals[0],
    duplicates: distinct([...repeated(first.ids), ...repeated(second.ids)]),
    missing: distinct([...first.ids.filter((id) => !secondKeys.has(key(id))), ...second.ids.filter((id) => !firstKeys.has(key(id)))]),
    pages: first.pages,
    consistent: anomalies.length === 0,
    anomalies,
  };
}

/**
 * Require collection conservation: no id served twice, no id served in only one walk,
 * total === ids.length when a total is reported, and a consistent walk.
 */
export function assertCollectionConservation(result: PaginationResult): void {
  if (result === null || typeof result !== 'object' || !Array.isArray(result.ids) || !Array.isArray(result.duplicates) || !Array.isArray(result.missing)) {
    throw new TypeError('assertCollectionConservation: pass the result of paginateAll');
  }
  const problems: string[] = [];
  if (result.duplicates.length > 0) problems.push(`${result.duplicates.length} id(s) served more than once: ${listIds(result.duplicates)}`);
  if (result.missing.length > 0) problems.push(`${result.missing.length} id(s) served in one walk only: ${listIds(result.missing)}`);
  if (result.total !== undefined && result.total !== result.ids.length) problems.push(`total ${result.total} reported, ${result.ids.length} distinct ids served`);
  if (!result.consistent) problems.push(`inconsistent walk: ${(result.anomalies ?? []).join('; ') || 'no anomaly recorded'}`);
  expect(problems.length === 0, `collection conservation: ${problems.join('; ')}`).toBe(true);
}

// 1 and '1' are different ids.
function key(id: CollectionId): string {
  return `${typeof id}:${id}`;
}

function distinct(ids: CollectionId[]): CollectionId[] {
  const seen = new Set<string>();
  return ids.filter((id) => {
    const k = key(id);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function repeated(ids: CollectionId[]): CollectionId[] {
  const seen = new Set<string>();
  return ids.filter((id) => {
    const k = key(id);
    if (seen.has(k)) return true;
    seen.add(k);
    return false;
  });
}

function listIds(ids: CollectionId[]): string {
  const shown = ids.slice(0, 20).map((id) => JSON.stringify(id)).join(', ');
  return ids.length > 20 ? `${shown}, … ${ids.length - 20} more` : shown;
}
