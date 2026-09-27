import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ArgusPrerequisiteError, ArgusRestoreError, requireEnv } from './errors';

// Fault injection for the resilience lane (TEMPLATE-CONTRACT.md, RUNNER-CONTRACT.md SD-5).
// A fault is injected only around one body and always restored afterwards:
//
// 1. A server-scope fault changes the shared target, so it needs the caller's explicit
//    ARGUS_FAULT_INJECTION=authorized. Inside an engagement (insideEngagement()) that value
//    is only a request: the fault also needs ARGUS_FAULT_INJECTION_GRANT, which
//    scripts/runner-lib.sh sets only after the chaos grant and the exclusive fault window.
// 2. The restore is recorded before inject() runs, so a partial injection is undone too.
// 3. restore() runs in every case, then verifyRestored() proves the target is back to
//    normal. A failure in either throws ArgusRestoreError (`infrastructure fail
//    fault-restore-failed`): the environment is in an unknown state and the run must stop
//    trusting it. That error outranks an error of the body.
//
// Messages carry only the fault name, never target data.

export type FaultScope = 'client' | 'server';

export type FaultSpec = {
  /** Safe token naming the fault in messages, e.g. `api-unavailable`. */
  name: string;
  /** `client` faults stay inside the test process (page.route, a stub); `server` faults change the target. */
  scope: FaultScope;
  inject: () => unknown;
  restore: () => unknown;
  /** Throws when the target still shows the fault after restore(). */
  verifyRestored: () => unknown;
};

const FAULT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

type RecordedFault = { fault: FaultSpec; restoring?: Promise<void> };

/** Tracks the faults of one test; the `faultInjector` fixture restores whatever a test leaves active. */
export class FaultInjector {
  private readonly recorded = new Set<RecordedFault>();

  /** True from the moment a fault's restore is recorded until that restore is verified. */
  get active(): boolean {
    return this.recorded.size > 0;
  }

  async run<T>(fault: FaultSpec, body: () => T | Promise<T>): Promise<T> {
    validate(fault);
    if (fault.scope === 'server') requireServerAuthorization(fault.name);
    const entry: RecordedFault = { fault };
    this.recorded.add(entry);
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      await fault.inject();
      outcome = { ok: true, value: await body() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    await this.restore(entry);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /** Restores every fault still recorded, for example one whose run() was never awaited. */
  async settle(): Promise<void> {
    let failure: unknown;
    for (const entry of [...this.recorded]) {
      try {
        await this.restore(entry);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  // Each recorded fault is restored exactly once, whether run() or settle() gets there first.
  private async restore(entry: RecordedFault): Promise<void> {
    entry.restoring ??= restoreAndVerify(entry.fault);
    try {
      await entry.restoring;
    } finally {
      this.recorded.delete(entry);
    }
  }
}

/** Injects `fault` around `body` and always restores it; see the module comment. */
export async function run<T>(fault: FaultSpec, body: () => T | Promise<T>): Promise<T> {
  return new FaultInjector().run(fault, body);
}

async function restoreAndVerify(fault: FaultSpec): Promise<void> {
  try {
    await fault.restore();
  } catch (error) {
    throw new ArgusRestoreError(`fault ${fault.name}: restore failed`, { cause: error });
  }
  try {
    await fault.verifyRestored();
  } catch (error) {
    throw new ArgusRestoreError(`fault ${fault.name}: the restore could not be verified`, { cause: error });
  }
}

function validate(fault: FaultSpec): void {
  if (!FAULT_NAME.test(fault?.name ?? '')) throw new TypeError('a fault name must be a lowercase token such as api-unavailable');
  if (fault.scope !== 'client' && fault.scope !== 'server') throw new TypeError(`fault ${fault.name}: scope must be client or server`);
  for (const hook of ['inject', 'restore', 'verifyRestored'] as const) {
    if (typeof fault[hook] !== 'function') throw new TypeError(`fault ${fault.name}: ${hook} must be a function`);
  }
}

function requireServerAuthorization(name: string): void {
  if (requireEnv('ARGUS_FAULT_INJECTION') !== 'authorized') {
    throw new ArgusPrerequisiteError(`server-side fault ${name} requires ARGUS_FAULT_INJECTION=authorized`);
  }
  if (insideEngagement() && !/^[a-z][a-z0-9-]*$/.test(process.env.ARGUS_FAULT_INJECTION_GRANT ?? '')) {
    throw new ArgusPrerequisiteError(
      `server-side fault ${name} inside an Argus engagement requires the grant scripts/runner-lib.sh issues after the chaos authorization; run it through run-tests.sh`,
    );
  }
}

/**
 * Whether this run belongs to an Argus engagement: ARGUS_ENGAGEMENT_MANIFEST is set, or an
 * ai_agents_internal/engagement.json sits in the working directory, this harness, or an
 * ancestor of either (as argus-assets finds one).
 */
export function insideEngagement(): boolean {
  if (process.env.ARGUS_ENGAGEMENT_MANIFEST) return true;
  for (const start of [process.cwd(), __dirname]) {
    for (let cursor = resolve(start); ; cursor = dirname(cursor)) {
      if (existsSync(join(cursor, 'ai_agents_internal', 'engagement.json'))) return true;
      if (dirname(cursor) === cursor) break;
    }
  }
  return false;
}
