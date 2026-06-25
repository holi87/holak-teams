import { test, expect } from '../../src/fixtures/fixtures';
import { ResourceClient } from '../../src/api/api-client';
import { buildOrder } from '../../src/data/factory';

// ADAPT-ME: example API tests. Replace endpoints/shapes with the real OpenAPI surface.
// Put each resource/tag in its own dir (tests/api/<resource>/) so parallel writers don't collide.
test.describe('@api smoke', () => {
  test('health endpoint responds', async ({ request }) => {
    const res = await request.get('/health'); // <-- adapt
    expect(res.ok()).toBeTruthy();
  });

  test('authenticated read returns the contracted shape', async ({ apiAsUser }) => {
    const res = await apiAsUser.get('/me'); // <-- adapt
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('id'); // <-- assert the real contract from OpenAPI
  });

  test('create with valid data succeeds', async ({ apiAsUser }) => {
    const orders = new ResourceClient(apiAsUser, '/orders'); // <-- adapt resource
    const res = await orders.create(buildOrder());
    expect(res.status()).toBe(201); // <-- assert per OpenAPI
  });

  test('negative: protected route rejects anonymous access', async ({ request }) => {
    const res = await request.get('/me'); // <-- adapt protected route
    expect([401, 403]).toContain(res.status());
  });
});
