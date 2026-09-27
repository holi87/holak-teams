// Contract testing mechanised: validate live responses against the OpenAPI schema
// instead of hand-rolled per-field assertions. The oracle lives in src/oracles/schema.ts
// (strict by default, OpenAPI 3.0 normalization, operation-based lookup); this module
// keeps the historical import path.
//
// Usage: await assertSchema(res, 'getOrder')
//        await expectMatchesSchema(await res.json(), '#/components/schemas/Order')
//
// ADAPT-ME: point OPENAPI_PATH at the spec file Kalchas found (JSON; convert YAML
// first: npx js-yaml openapi.yaml > openapi.json), or fetch it from the live
// Swagger endpoint at setup and save it locally.

export { expectMatchesSchema, assertSchema, assertSchemaRef } from '../oracles/schema';
