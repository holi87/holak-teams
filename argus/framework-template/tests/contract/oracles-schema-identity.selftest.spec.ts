import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { assertSchema, invalidEmails, invalidPartitions } from '../../src/oracles';

test.describe('schema and identity oracles', { tag: '@contract-smoke' }, () => {
  test('webhook response schemas use their own escaped JSON pointer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'argus-webhook-schema-'));
    const previous = process.env.OPENAPI_PATH;
    const response = { description: 'Accepted delivery', content: { 'application/json': { schema: {
      type: 'object', required: ['accepted'], properties: { accepted: { type: 'boolean' } },
    } } } };
    try {
      process.env.OPENAPI_PATH = join(root, 'openapi.json');
      writeFileSync(process.env.OPENAPI_PATH, JSON.stringify({ openapi: '3.1.0', info: { title: 'Webhook oracle', version: '1' },
        paths: { '/delivery': { get: { operationId: 'readDelivery', responses: { '200': response } } } },
        webhooks: {
          'payment/~settled': { post: { operationId: 'paymentSettled', responses: { '2XX': response } } },
          linked: { post: { operationId: 'linkedDelivery', responses: { '200': { $ref: '#/components/responses/Accepted' } } } },
        }, components: { responses: { Accepted: response } } }));
      await assertSchema({ status: 200, body: { accepted: true } }, 'readDelivery');
      await assertSchema({ status: 202, body: { accepted: true } }, 'paymentSettled');
      await expect(assertSchema({ status: 202, body: { accepted: 'yes' } }, 'paymentSettled')).rejects.toThrow(/must be boolean/);
      await assertSchema({ status: 200, body: { accepted: false } }, 'linkedDelivery');
    } finally {
      if (previous === undefined) delete process.env.OPENAPI_PATH;
      else process.env.OPENAPI_PATH = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('email invalid partitions do not require a dotted domain', () => {
    // RFC 5322 section 3.4.1 permits a single dot-atom domain label. The fast email
    // format preserves that case; the full ajv-formats check adds a dotted-domain rule.
    const reference = new Ajv2020({ strict: false });
    addFormats(reference, { mode: 'fast' });
    const accepts = reference.compile({ type: 'string', format: 'email' });
    expect(accepts('argus.qa@example')).toBe(true);
    for (const { label, value } of invalidEmails) expect(accepts(value), label).toBe(false);
    for (const { label, value } of invalidPartitions({ type: 'string', format: 'email' })) {
      expect(accepts(value), label).toBe(false);
    }
  });
});
