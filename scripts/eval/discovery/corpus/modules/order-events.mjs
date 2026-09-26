import { call, methodNotAllowed, readJsonObject, segmentsAfter, send } from '../http.mjs';

const SHIPMENTS = '/api/shipments';
const EVENTS = '/api/events';
const FIELDS = ['recipientName', 'recipientPhone', 'city'];
const isText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 100;
const PROBE_SHIPMENT = { recipientName: 'Probe Recipient', recipientPhone: '+1 555 0100', city: 'Springfield' };

function emit(ctx, type, shipment) {
  const { state } = ctx;
  const data = { recipientName: shipment.recipientName, city: shipment.city };
  // The faulty build serializes the whole recipient record into the event payload.
  if (ctx.enabled('event-payload-pii')) data.recipientPhone = shipment.recipientPhone;
  // The faulty build numbers update events with their own counter instead of the global sequence.
  const seq = type === 'shipment.updated' && ctx.enabled('event-sequence-regression') ? ++state.updatedSeq : ++state.seq;
  state.emitted += 1;
  state.events.push({ seq, eventId: ctx.deriveId(`event:${state.emitted}`), type, shipmentId: shipment.id, data });
}

async function createShipment(req, res, ctx) {
  const body = await readJsonObject(req);
  const invalid = FIELDS.find(field => !isText(body[field]));
  if (invalid) {
    send(res, 422, { error: 'invalid-field', field: invalid });
    return;
  }
  const { shipments } = ctx.state;
  const shipment = { id: ctx.deriveId(`shipment:${shipments.size + 1}`), status: 'active', recipientName: body.recipientName, recipientPhone: body.recipientPhone, city: body.city };
  shipments.set(shipment.id, shipment);
  emit(ctx, 'shipment.created', shipment);
  // The faulty build's retry wrapper re-emits the creation event after a successful commit.
  if (ctx.enabled('event-duplicate-emission')) emit(ctx, 'shipment.created', shipment);
  send(res, 201, shipment);
}

async function updateShipment(req, res, shipment, ctx) {
  const body = await readJsonObject(req);
  const unknown = Object.keys(body).filter(field => field !== 'city');
  if (unknown.length) {
    send(res, 422, { error: 'unknown-field', fields: unknown });
    return;
  }
  if (!isText(body.city)) {
    send(res, 422, { error: 'invalid-field', field: 'city' });
    return;
  }
  if (shipment.status === 'cancelled') {
    send(res, 409, { error: 'shipment-cancelled' });
    return;
  }
  if (body.city !== shipment.city) {
    shipment.city = body.city;
    emit(ctx, 'shipment.updated', shipment);
  }
  send(res, 200, shipment);
}

function cancelShipment(res, shipment, ctx) {
  if (shipment.status === 'cancelled') {
    send(res, 409, { error: 'shipment-cancelled' });
    return;
  }
  shipment.status = 'cancelled';
  // The faulty build commits the cancellation but skips the outbox write.
  if (!ctx.enabled('event-missing-on-cancel')) emit(ctx, 'shipment.cancelled', shipment);
  send(res, 200, shipment);
}

async function handleShipments(req, res, parts, ctx) {
  const { shipments } = ctx.state;
  if (parts.length === 0) {
    if (req.method === 'GET') send(res, 200, { shipments: [...shipments.values()] });
    else if (req.method === 'POST') await createShipment(req, res, ctx);
    else methodNotAllowed(res, ['GET', 'POST']);
    return true;
  }
  if (parts.length > 2 || (parts.length === 2 && parts[1] !== 'cancel')) return false;
  const shipment = shipments.get(parts[0]);
  if (!shipment) {
    send(res, 404, { error: 'not-found' });
    return true;
  }
  if (parts.length === 2) {
    if (req.method === 'POST') cancelShipment(res, shipment, ctx);
    else methodNotAllowed(res, ['POST']);
  } else if (req.method === 'GET') send(res, 200, shipment);
  else if (req.method === 'PATCH') await updateShipment(req, res, shipment, ctx);
  else methodNotAllowed(res, ['GET', 'PATCH']);
  return true;
}

function handleEvents(req, res, url, parts, ctx) {
  const { state } = ctx;
  if (parts.length === 0) {
    if (req.method !== 'GET') {
      methodNotAllowed(res, ['GET']);
      return true;
    }
    const raw = url.searchParams.get('after') ?? '0';
    if (!/^\d{1,15}$/.test(raw)) {
      send(res, 422, { error: 'invalid-after' });
      return true;
    }
    const after = Number(raw);
    const redelivered = state.redelivery.splice(0);
    send(res, 200, { events: state.events.filter(event => event.seq > after), redelivered });
    return true;
  }
  if (parts.length !== 2 || parts[1] !== 'nack') return false;
  if (req.method !== 'POST') {
    methodNotAllowed(res, ['POST']);
    return true;
  }
  const event = state.events.find(item => item.eventId === parts[0]);
  if (!event) {
    send(res, 404, { error: 'not-found' });
    return true;
  }
  state.redelivery.push(event);
  send(res, 202, { eventId: event.eventId, status: 'queued-for-redelivery' });
  return true;
}

// Every event the log currently holds, independent of any `after` cursor.
const allEvents = async baseUrl => (await call(baseUrl, 'GET', `${EVENTS}?after=0`)).json.events;
const createProbeShipment = async baseUrl => (await call(baseUrl, 'POST', SHIPMENTS, { json: PROBE_SHIPMENT })).json.id;
const eventsFor = async (baseUrl, shipmentId) => (await allEvents(baseUrl)).filter(event => event.shipmentId === shipmentId);

export default Object.freeze({
  id: 'order-events',
  title: 'Shipments and event feed',
  basePaths: [SHIPMENTS, EVENTS],
  seeds: [
    { id: 'event-duplicate-emission', surface: 'events', severity: 'Major', criterion: 'Creating one shipment emits two shipment.created events with different eventIds.' },
    { id: 'event-missing-on-cancel', surface: 'events', severity: 'Major', criterion: 'Cancelling a shipment changes its status to cancelled but emits no shipment.cancelled event.' },
    { id: 'event-sequence-regression', surface: 'events', severity: 'Major', criterion: 'shipment.updated events use a separate counter starting at 1, so seq is not strictly increasing across event types.' },
    { id: 'event-payload-pii', surface: 'events', severity: 'Critical', criterion: 'Event data includes the recipientPhone of the shipment.' },
  ],
  controls: [
    { id: 'events-redelivery-same-id', description: 'A nacked event is redelivered with the same eventId and seq; documented at-least-once delivery, not a duplicate.' },
  ],
  publicContract: () => ({
    eventTypes: ['shipment.created', 'shipment.updated', 'shipment.cancelled'],
    rules: [
      'POST /api/shipments with {recipientName, recipientPhone, city} (each a non-empty string of at most 100 characters) creates an active shipment and returns 201 with its id. GET /api/shipments lists shipments and GET /api/shipments/{id} returns one.',
      'PATCH /api/shipments/{id} accepts only {city}. POST /api/shipments/{id}/cancel cancels an active shipment. A cancelled shipment cannot be changed or cancelled again: 409 and no event.',
      'Every state change emits exactly one event: shipment.created, shipment.updated or shipment.cancelled. A PATCH that leaves the city unchanged is not a state change and emits nothing.',
      'GET /api/events?after=<seq> returns {events, redelivered}, where events holds the events with seq greater than after (default 0). seq is strictly increasing across all event types. Each event is {seq, eventId, type, shipmentId, data: {recipientName, city}}; event data never contains recipientPhone.',
      'Delivery is at-least-once by design: POST /api/events/{eventId}/nack returns 202, and the same event (same eventId and seq) is returned again in the redelivered list of the next GET /api/events. A redelivered event is not a second emission.',
    ],
  }),
  createState: () => ({ shipments: new Map(), events: [], redelivery: [], seq: 0, updatedSeq: 0, emitted: 0 }),
  async handle(req, res, url, ctx) {
    const shipmentParts = segmentsAfter(url.pathname, SHIPMENTS);
    if (shipmentParts !== null) return handleShipments(req, res, shipmentParts, ctx);
    const eventParts = segmentsAfter(url.pathname, EVENTS);
    return eventParts !== null && handleEvents(req, res, url, eventParts, ctx);
  },
  probes: {
    'event-duplicate-emission': async baseUrl => {
      const id = await createProbeShipment(baseUrl);
      const created = (await eventsFor(baseUrl, id)).filter(event => event.type === 'shipment.created');
      return new Set(created.map(event => event.eventId)).size > 1;
    },
    'event-missing-on-cancel': async baseUrl => {
      const id = await createProbeShipment(baseUrl);
      const cancelled = await call(baseUrl, 'POST', `${SHIPMENTS}/${id}/cancel`);
      const shipment = await call(baseUrl, 'GET', `${SHIPMENTS}/${id}`);
      const events = await eventsFor(baseUrl, id);
      return cancelled.status === 200 && shipment.json.status === 'cancelled' && !events.some(event => event.type === 'shipment.cancelled');
    },
    // Reads the whole log: a regressed seq is exactly what an `after` cursor would silently skip.
    'event-sequence-regression': async baseUrl => {
      const previousMax = Math.max(0, ...(await allEvents(baseUrl)).map(event => event.seq));
      const id = await createProbeShipment(baseUrl);
      await call(baseUrl, 'PATCH', `${SHIPMENTS}/${id}`, { json: { city: 'Shelbyville' } });
      const events = await eventsFor(baseUrl, id);
      return events.some((event, index) => event.seq <= previousMax || (index > 0 && event.seq <= events[index - 1].seq));
    },
    'event-payload-pii': async baseUrl => {
      const id = await createProbeShipment(baseUrl);
      const events = await eventsFor(baseUrl, id);
      return events.some(event => 'recipientPhone' in event.data || JSON.stringify(event.data).includes(PROBE_SHIPMENT.recipientPhone));
    },
    'events-redelivery-same-id': async baseUrl => {
      const id = await createProbeShipment(baseUrl);
      const [original] = await eventsFor(baseUrl, id);
      if (!original) return false;
      const nack = await call(baseUrl, 'POST', `${EVENTS}/${original.eventId}/nack`);
      const next = await call(baseUrl, 'GET', `${EVENTS}?after=${original.seq}`);
      return nack.status === 202 && next.json.redelivered.some(event => event.eventId === original.eventId && event.seq === original.seq
        && event.type === original.type && event.shipmentId === original.shipmentId);
    },
  },
});
