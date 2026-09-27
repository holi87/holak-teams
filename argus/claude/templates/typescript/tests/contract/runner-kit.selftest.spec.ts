import { test, expect } from '@playwright/test';
import { ArgusCleanupError, ArgusPrerequisiteError, ArgusRestoreError } from '../../src/argus/errors';
import { FaultInjector, FaultSpec, run } from '../../src/argus/fault-injector';
import { StubServer } from '../../src/argus/stub-server';
import { cleanupCreatedResources, CreatedResource } from '../../src/fixtures/fixtures';

// Self-tests for the runner-kit helpers behind the `faultInjector` and `createdResources`
// fixtures. Nothing contacts a real target: faults are recorded calls, and cleanup DELETEs go
// to a 127.0.0.1 stub. Negative cases assert the rejection itself, so a healthy run reports
// `product pass` for every case.

const SECRET = 'argus-never-print-me';

async function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: Error) => error,
  );
}

/** A client fault whose hooks append to `calls`; `fail` makes the named hooks throw. */
function recordedFault(calls: string[], fail: string[] = [], scope: FaultSpec['scope'] = 'client'): FaultSpec {
  const hook = (name: string) => async () => {
    calls.push(name);
    if (fail.includes(name)) throw new Error(`${name} failed with ${SECRET}`);
  };
  return { name: 'api-unavailable', scope, inject: hook('inject'), restore: hook('restore'), verifyRestored: hook('verify') };
}

test.describe('runner kit', { tag: '@contract-smoke' }, () => {
  test('faultInjector restores and verifies after a passing body', async () => {
    const calls: string[] = [];
    const injector = new FaultInjector();
    const value = await injector.run(recordedFault(calls), async () => {
      calls.push('body');
      expect(injector.active).toBe(true);
      return 'body-result';
    });
    expect(value).toBe('body-result');
    expect(calls).toEqual(['inject', 'body', 'restore', 'verify']);
    expect(injector.active).toBe(false);
  });

  test('faultInjector restores after a failing body and rethrows the body error', async () => {
    const calls: string[] = [];
    const error = await rejection(run(recordedFault(calls), async () => {
      calls.push('body');
      throw new TypeError('assertion in the body');
    }));
    expect(error).toBeInstanceOf(TypeError);
    expect(calls).toEqual(['inject', 'body', 'restore', 'verify']);
  });

  test('faultInjector restores a partial injection', async () => {
    const calls: string[] = [];
    const error = await rejection(run(recordedFault(calls, ['inject']), async () => {
      calls.push('body');
    }));
    expect(error.message).toContain('inject failed');
    expect(calls).toEqual(['inject', 'restore', 'verify']);
  });

  test('a failed restore or verification is ArgusRestoreError and outranks the body error', async () => {
    for (const failing of ['restore', 'verify']) {
      const calls: string[] = [];
      const error = await rejection(run(recordedFault(calls, [failing]), async () => {
        throw new TypeError('assertion in the body');
      }));
      expect(error).toBeInstanceOf(ArgusRestoreError);
      expect(error.name).toBe('ArgusRestoreError');
      expect(error.message).not.toContain(SECRET);
    }
  });

  test('a server fault needs ARGUS_FAULT_INJECTION=authorized before anything is injected', async () => {
    const previous = process.env.ARGUS_FAULT_INJECTION;
    try {
      for (const value of [undefined, '', 'yes']) {
        if (value === undefined) delete process.env.ARGUS_FAULT_INJECTION;
        else process.env.ARGUS_FAULT_INJECTION = value;
        const calls: string[] = [];
        const error = await rejection(run(recordedFault(calls, [], 'server'), async () => undefined));
        expect(error).toBeInstanceOf(ArgusPrerequisiteError);
        expect(calls).toEqual([]);
      }
      process.env.ARGUS_FAULT_INJECTION = 'authorized';
      const calls: string[] = [];
      await run(recordedFault(calls, [], 'server'), async () => undefined);
      expect(calls).toEqual(['inject', 'restore', 'verify']);
    } finally {
      if (previous === undefined) delete process.env.ARGUS_FAULT_INJECTION;
      else process.env.ARGUS_FAULT_INJECTION = previous;
    }
  });

  test('settle restores a fault the test left active, exactly once', async () => {
    const calls: string[] = [];
    const injector = new FaultInjector();
    let release: () => void = () => undefined;
    const pending = injector.run(recordedFault(calls), () => new Promise<void>((resolve) => { release = resolve; }));
    await expect.poll(() => calls).toEqual(['inject']);
    await injector.settle();
    expect(calls).toEqual(['inject', 'restore', 'verify']);
    expect(injector.active).toBe(false);
    release();
    await pending;
    expect(calls).toEqual(['inject', 'restore', 'verify']);
  });

  test('an invalid fault is refused before it is injected', async () => {
    const calls: string[] = [];
    for (const fault of [{ ...recordedFault(calls), name: 'Not A Token' }, { ...recordedFault(calls), scope: 'global' as FaultSpec['scope'] }]) {
      expect(await rejection(run(fault, async () => undefined))).toBeInstanceOf(TypeError);
    }
    expect(calls).toEqual([]);
  });

  test('createdResources cleanup attempts every DELETE, newest first, and counts failures', async ({ playwright }) => {
    const stub = await StubServer.start();
    const live = await playwright.request.newContext({ baseURL: stub.url });
    try {
      stub.load([
        { id: 'already-gone', request: { method: 'DELETE', path: '/items/1' }, response: { status: 404 } },
        { id: 'deleted', request: { method: 'DELETE', path: '/items/2' }, response: { status: 204 } },
        { id: 'refused', request: { method: 'DELETE', path: '/items/3' }, response: { status: 409, body: { detail: SECRET } } },
        { id: 'accepted', request: { method: 'DELETE', path: '/items/4' }, response: { status: 202 } },
        { id: 'ok', request: { method: 'DELETE', path: '/items/5' }, response: { status: 200 } },
      ]);
      const disposed = await playwright.request.newContext({ baseURL: stub.url });
      await disposed.dispose();
      const created: CreatedResource[] = [
        { ctx: live, path: '/items/1' },
        { ctx: live, path: '/items/2' },
        { ctx: disposed, path: '/items/6' },
        { ctx: live, path: '/items/3' },
        { ctx: live, path: '/items/4' },
        { ctx: live, path: '/items/5' },
      ];
      const error = await rejection(cleanupCreatedResources(created));
      expect(error).toBeInstanceOf(ArgusCleanupError);
      expect(error.message).toBe('cleanup failed for 2 resource(s)');
      expect(stub.requests().map((record) => record.path)).toEqual(['/items/5', '/items/4', '/items/3', '/items/2', '/items/1']);
    } finally {
      await live.dispose();
      await stub.stop();
    }
  });

  test('createdResources cleanup passes when every DELETE succeeds or finds nothing', async ({ playwright }) => {
    const stub = await StubServer.start();
    const live = await playwright.request.newContext({ baseURL: stub.url });
    try {
      stub.load([
        { id: 'deleted', request: { method: 'DELETE', path: '/items/1' }, response: { status: 204 } },
        { id: 'already-gone', request: { method: 'DELETE', path: '/items/2' }, response: { status: 404 } },
      ]);
      await cleanupCreatedResources([{ ctx: live, path: '/items/1' }, { ctx: live, path: '/items/2' }]);
      expect(stub.requests()).toHaveLength(2);
    } finally {
      await live.dispose();
      await stub.stop();
    }
  });
});
