import { actorOf, call, methodNotAllowed, segmentsAfter, send } from '../http.mjs';

const OBJECTS = '/api/objects';
const PROFILE = '/api/profile';

function handleObjects(req, res, parts, ctx) {
  if (req.method !== 'GET') {
    methodNotAllowed(res, ['GET']);
    return;
  }
  const actor = actorOf(req);
  if (!actor) {
    send(res, 401, { error: 'unauthenticated' });
    return;
  }
  const { objects } = ctx.state;
  if (parts.length === 0) {
    send(res, 200, { objects: objects.filter(item => item.owner === actor).map(({ id, owner, title }) => ({ id, owner, title })) });
    return;
  }
  const object = objects.find(item => item.id === parts[0]);
  if (!object) {
    send(res, 404, { error: 'not-found' });
    return;
  }
  // The faulty build authenticates the actor but never checks ownership.
  if (object.owner !== actor && !ctx.enabled('cross-owner-read')) {
    send(res, 403, { error: 'forbidden' });
    return;
  }
  send(res, 200, object);
}

function handleProfile(req, res, url) {
  if (req.method !== 'GET') {
    methodNotAllowed(res, ['GET']);
    return;
  }
  const email = url.searchParams.get('email');
  if (!email) {
    send(res, 422, { error: 'email-required' });
    return;
  }
  send(res, 200, { email });
}

export default Object.freeze({
  id: 'accounts',
  title: 'Private objects and profiles',
  basePaths: [OBJECTS, PROFILE],
  seeds: [
    { id: 'cross-owner-read', surface: 'authz', severity: 'Critical', criterion: 'Bob retrieves the private object owned by Alice, including its privateNote, with 200 instead of 403.' },
  ],
  controls: [
    { id: 'accounts-email-case', description: 'GET /api/profile echoes the email with its exact case; case preservation is intentional.' },
  ],
  publicContract: ctx => ({
    objectId: ctx.state.objects[0].id,
    rules: [
      'GET /api/objects lists the objects owned by the x-actor account as {objects: [{id, owner, title}]}. A missing or unknown x-actor returns 401.',
      'GET /api/objects/{objectId} returns the object, including its privateNote, only to its owner; objectId is owned by alice. Any other known actor receives 403, a missing or unknown x-actor receives 401, and an unknown id returns 404.',
      'GET /api/profile?email=<address> returns {email} exactly as supplied. Email case is preserved intentionally; a missing email returns 422.',
    ],
  }),
  createState: ctx => ({
    objects: [{ id: ctx.deriveId('objectId'), owner: 'alice', title: 'Quarterly plan', privateNote: 'Synthetic private note visible only to alice.' }],
  }),
  async handle(req, res, url, ctx) {
    const objectParts = segmentsAfter(url.pathname, OBJECTS);
    if (objectParts !== null) {
      if (objectParts.length > 1) return false;
      handleObjects(req, res, objectParts, ctx);
      return true;
    }
    const profileParts = segmentsAfter(url.pathname, PROFILE);
    if (profileParts === null || profileParts.length) return false;
    handleProfile(req, res, url);
    return true;
  },
  probes: {
    'cross-owner-read': async (baseUrl, contract) => {
      const read = await call(baseUrl, 'GET', `${OBJECTS}/${contract.objectId}`, { actor: 'bob' });
      return read.status === 200 && typeof read.json?.privateNote === 'string';
    },
    'accounts-email-case': async baseUrl => {
      const email = 'Mixed.Case@Example.TEST';
      const profile = await call(baseUrl, 'GET', `${PROFILE}?email=${encodeURIComponent(email)}`);
      return profile.status === 200 && profile.json.email === email;
    },
  },
});
