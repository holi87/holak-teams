import { test, expect } from '../../src/fixtures/fixtures';
import { ResourceClient } from '../../src/api/api-client';
import { buildOrder } from '../../src/data/factory';
import { assertRestStatus, assertSchema, boundary3, expectStatus, invalidObjectPartitions, loadOpenApi, resolveRef } from '../../src/oracles';

// ADAPT-ME: example API tests. Replace endpoints, operation ids, and SPEC with the real
// OpenAPI surface. Put each resource/tag in its own dir (tests/api/<resource>/) so parallel
// writers don't collide. Every oracle is exact: one documented status code, the strict
// schema by operationId, and a read-back of what was written.

// ADAPT-ME: each value comes from the OpenAPI document or a written requirement; cite it.
const SPEC = {
  // The status the API documents for an anonymous request to a protected route. Use that
  // one code (401 here, 403 if the documentation says so), never a class or a list.
  anonymousStatus: 401,
  // The documented rejection of an invalid request body.
  invalidBodyStatus: 400,
  // The documented qty range and the domain's smallest unit (a count moves by 1).
  qty: { minimum: 1, maximum: 99, step: 1 },
  // The order request schema and the read operation behind the Location header.
  orderInputSchema: '#/components/schemas/OrderInput',
  readOrderOperationId: 'getOrder',
} as const;

test.describe('@api smoke', () => {
  test('health endpoint answers 200', async ({ request }) => {
    const res = await request.get('/health'); // <-- adapt
    await expectStatus(res, 200);
  });

  test('authenticated read returns the contracted shape', async ({ apiAsUser }) => {
    const res = await apiAsUser.get('/me'); // <-- adapt
    await expectStatus(res, 200);
    await assertSchema(res, 'getMe'); // <-- adapt the operationId; strict, so an undocumented field is RED
  });

  test('create answers 201 with a Location that reads back what was written', async ({ apiAsUser, createdResources }) => {
    const orders = new ResourceClient(apiAsUser, '/orders'); // <-- adapt resource
    const input = buildOrder();
    const res = await orders.create(input);
    // Registered before any assertion, so a RED still cleans up what was created.
    const location = res.headers().location;
    if (location) createdResources.push({ ctx: apiAsUser, path: location });
    await expectStatus(res, 201);
    await assertRestStatus(res, 'created');
    const readBack = await apiAsUser.get(location);
    await expectStatus(readBack, 200);
    expect(await readBack.json()).toMatchObject({ ...input });
    await assertSchema(readBack, SPEC.readOrderOperationId);
  });

  test('negative: protected route rejects anonymous access with the documented status', async ({ request }) => {
    const res = await request.get('/me'); // <-- adapt protected route
    await expectStatus(res, SPEC.anonymousStatus);
  });

  test('boundary: qty is accepted exactly from its minimum to its maximum', async ({ apiAsUser, createdResources }) => {
    const orders = new ResourceClient(apiAsUser, '/orders'); // <-- adapt resource
    // Accepted means 201 with a Location, rejected means exactly the documented 400; any
    // other status is RED, so the probe cannot mistake a 500 for a validation error.
    const probe = async (qty: number) => {
      const res = await orders.create(buildOrder({ qty }));
      const location = res.headers().location;
      if (location) createdResources.push({ ctx: apiAsUser, path: location });
      if (res.status() === 201) {
        await assertRestStatus(res, 'created');
        return true;
      }
      await expectStatus(res, SPEC.invalidBodyStatus);
      return false;
    };
    const { minimum, maximum, step } = SPEC.qty;
    await boundary3({ boundary: minimum, step, probe, acceptBelow: false, acceptAt: true, acceptAbove: true });
    await boundary3({ boundary: maximum, step, probe, acceptBelow: true, acceptAt: true, acceptAbove: false });
  });

  test('negative: every invalid order partition is rejected with the documented status', async ({ apiAsUser, createdResources }) => {
    const orders = new ResourceClient(apiAsUser, '/orders'); // <-- adapt resource
    // ADAPT-ME: the resolved request schema (no $ref or allOf inside). A bounded number
    // without multipleOf needs its smallest unit: { numberSteps: { price: 0.01 } }.
    const schema = resolveRef(loadOpenApi(), SPEC.orderInputSchema) as Record<string, unknown>;
    for (const partition of invalidObjectPartitions(schema, { ...buildOrder() })) {
      await test.step(partition.label, async () => {
        const res = await orders.create(partition.value);
        const location = res.headers().location;
        if (location) createdResources.push({ ctx: apiAsUser, path: location });
        await expectStatus(res, SPEC.invalidBodyStatus);
      });
    }
  });
});
