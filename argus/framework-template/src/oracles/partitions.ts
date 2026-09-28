import { addDecimal, decimalPlaces } from './boundary';
import { invalidEmails } from './identity';

// Invalid equivalence partitions generated from a field schema: one invalid value per
// declared constraint, each isolated as far as the schema allows, with fixed labels in a
// fixed order that every runtime port keeps. A partition generator asserts nothing itself;
// a spec sends every value and expects the documented rejection (one exact status code).
//
// Input is a raw OpenAPI 3.0 or 3.1 field schema: `nullable: true`, a type list such as
// ['string', 'null'], and the boolean exclusiveMinimum/exclusiveMaximum form are read as
// written. Resolve $ref and allOf/oneOf/anyOf into one field schema first.

export type Partition = { label: string; value: unknown };

export type PartitionOptions = {
  /**
   * The smallest unit of a bounded `number` field without multipleOf (money 0.01, a
   * percentage 1). Required for such a field; an integer's step is 1 (or its integer
   * multipleOf) and a multipleOf is its own step.
   */
  numberStep?: number;
};

export type ObjectPartitionOptions = PartitionOptions & {
  /** Per-property numberStep, overriding `numberStep`. */
  numberSteps?: Record<string, number>;
};

/** The candidates string.pattern-mismatch tries, in order; the first one the pattern rejects wins. */
export const PATTERN_MISMATCH_CANDIDATES: readonly string[] = Object.freeze(['', ' ', '!', '0', 'a', '\u0000']);

/** string.above-max-length is omitted above this many characters: that probe is a load test, not a partition. */
export const MAX_GENERATED_LENGTH = 1_048_576;

const TYPES = ['string', 'integer', 'number', 'boolean', 'object', 'array'] as const;
type FieldType = (typeof TYPES)[number];
type Bounds = { minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number };

/**
 * One invalid value per declared constraint, in this order:
 * - format email: email.missing-at, email.missing-domain, email.missing-local-part, email.double-at,
 *   email.embedded-whitespace;
 * - string: string.below-min-length ('a' repeated minLength - 1), string.above-max-length,
 *   string.pattern-mismatch (the first PATTERN_MISMATCH_CANDIDATES entry the pattern
 *   rejects; omitted when it accepts all), string.empty (minLength >= 1),
 *   type.number-for-string;
 * - integer and number: number.below-minimum, number.above-maximum,
 *   number.exclusive-minimum-equal, number.exclusive-maximum-equal,
 *   number.fractional-for-integer, number.unsafe-integer (2^53, an integer without a
 *   maximum), number.multiple-of-violation, type.string-for-number (a valid value as a
 *   string);
 * - enum: enum.out-of-enum; boolean: type.string-for-boolean;
 * - type.null-for-non-nullable, last, whenever the schema constrains the type and null is
 *   not allowed.
 */
export function invalidPartitions(fieldSchema: Record<string, unknown>, options: PartitionOptions = {}): Partition[] {
  return inContext('invalidPartitions', () => fieldPartitions(fieldSchema, options));
}

/**
 * Invalid request bodies for an object schema, built from a valid example:
 * object.missing-required.<field> for each required field (in `required` order),
 * object.extra-field (unless additionalProperties or patternProperties allow extra
 * fields), object.null-body, object.wrong-type-body, then field.<name>.<label> for every
 * property in schema order with that one property replaced by an invalidPartitions value.
 * readOnly properties are skipped: they are not part of a request. Every value is a fresh
 * deep copy.
 */
export function invalidObjectPartitions(objectSchema: Record<string, unknown>, validExample: Record<string, unknown>, options: ObjectPartitionOptions = {}): Partition[] {
  const schema = inContext('invalidObjectPartitions', () => requireSchema(objectSchema));
  const declared = schema.type;
  if (declared !== undefined && declared !== 'object' && !(Array.isArray(declared) && declared.includes('object'))) {
    throw new TypeError(`invalidObjectPartitions: the schema must describe an object, got type ${JSON.stringify(declared)}`);
  }
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (!isObject(validExample)) throw new TypeError('invalidObjectPartitions: validExample must be a plain object');
  for (const name of required) {
    if (typeof name !== 'string') throw new TypeError('invalidObjectPartitions: required must list property names');
    if (!Object.prototype.hasOwnProperty.call(validExample, name)) throw new TypeError(`invalidObjectPartitions: validExample lacks the required field ${name}`);
  }
  const copy = () => structuredClone(validExample);
  const partitions: Partition[] = [];
  for (const name of required as string[]) {
    const body = copy();
    delete body[name];
    partitions.push({ label: `object.missing-required.${name}`, value: body });
  }
  const openObject = schema.additionalProperties === true || isObject(schema.additionalProperties) || isObject(schema.patternProperties);
  if (!openObject) {
    let extra = 'argusUndocumentedField';
    while (Object.prototype.hasOwnProperty.call(properties, extra) || Object.prototype.hasOwnProperty.call(validExample, extra)) extra += 'X';
    partitions.push({ label: 'object.extra-field', value: { ...copy(), [extra]: 'argus' } });
  }
  partitions.push({ label: 'object.null-body', value: null });
  partitions.push({ label: 'object.wrong-type-body', value: [copy()] });
  for (const [name, property] of Object.entries(properties)) {
    if (isObject(property) && property.readOnly === true) continue;
    const numberStep = options.numberSteps?.[name] ?? options.numberStep;
    const field = inContext(`invalidObjectPartitions: property ${name}`, () => fieldPartitions(property, { numberStep }));
    for (const partition of field) partitions.push({ label: `field.${name}.${partition.label}`, value: { ...copy(), [name]: partition.value } });
  }
  return partitions;
}

function fieldPartitions(fieldSchema: unknown, options: PartitionOptions): Partition[] {
  const schema = requireSchema(fieldSchema);
  const { type, nullable } = fieldType(schema);
  const partitions: Partition[] = [];
  const add = (label: string, value: unknown) => partitions.push({ label, value });
  if (type === 'string') stringPartitions(schema, add);
  if (type === 'integer' || type === 'number') numberPartitions(schema, type === 'integer', options.numberStep, add);
  if (Array.isArray(schema.enum)) {
    const outside = outOfEnum(schema.enum, type);
    if (outside !== undefined) add('enum.out-of-enum', outside);
  }
  if (type === 'boolean') add('type.string-for-boolean', 'true');
  if ((type !== undefined || Array.isArray(schema.enum)) && !nullable) add('type.null-for-non-nullable', null);
  return partitions;
}

function stringPartitions(schema: Record<string, unknown>, add: (label: string, value: unknown) => void): void {
  const minLength = optionalCount(schema.minLength, 'minLength');
  const maxLength = optionalCount(schema.maxLength, 'maxLength');
  if (schema.format === 'email') for (const { label, value } of invalidEmails) add(label, value);
  if (minLength !== undefined && minLength >= 1) add('string.below-min-length', 'a'.repeat(minLength - 1));
  if (maxLength !== undefined && maxLength < MAX_GENERATED_LENGTH) add('string.above-max-length', 'a'.repeat(maxLength + 1));
  if (schema.pattern !== undefined) {
    const pattern = compilePattern(schema.pattern);
    const mismatch = PATTERN_MISMATCH_CANDIDATES.find((candidate) => !pattern.test(candidate));
    if (mismatch !== undefined) add('string.pattern-mismatch', mismatch);
  }
  if (minLength !== undefined && minLength >= 1) add('string.empty', '');
  add('type.number-for-string', 1);
}

function numberPartitions(schema: Record<string, unknown>, integer: boolean, numberStep: number | undefined, add: (label: string, value: unknown) => void): void {
  const bounds = readBounds(schema);
  const multipleOf = optionalNumber(schema.multipleOf, 'multipleOf');
  if (multipleOf !== undefined && multipleOf <= 0) throw new TypeError('multipleOf must be greater than 0');
  if (numberStep !== undefined && (!Number.isFinite(numberStep) || numberStep <= 0)) throw new TypeError(`numberStep must be a finite number > 0, got ${JSON.stringify(numberStep)}`);
  // The grid every valid value sits on: multipleOf, 1 for a plain integer, none otherwise.
  const grid = integer ? (multipleOf !== undefined && Number.isInteger(multipleOf) ? multipleOf : 1) : multipleOf;
  const bounded = Object.values(bounds).some((value) => value !== undefined);
  if (grid === undefined && bounded && numberStep === undefined) {
    throw new TypeError('a bounded number field without multipleOf needs options.numberStep, the domain\'s smallest unit (money 0.01, a percentage 1); never a blind +-1');
  }
  const step = grid ?? (numberStep as number);
  const anchor = validAnchor(bounds, grid, step);
  const upper = (value: number) => (bounds.maximum === undefined || value <= bounds.maximum) && (bounds.exclusiveMaximum === undefined || value < bounds.exclusiveMaximum);

  if (bounds.minimum !== undefined) add('number.below-minimum', grid !== undefined ? onGrid(bounds.minimum, grid, 'below') : addDecimal(bounds.minimum, -step));
  if (bounds.maximum !== undefined) add('number.above-maximum', grid !== undefined ? onGrid(bounds.maximum, grid, 'above') : addDecimal(bounds.maximum, step));
  if (bounds.exclusiveMinimum !== undefined) add('number.exclusive-minimum-equal', bounds.exclusiveMinimum);
  if (bounds.exclusiveMaximum !== undefined) add('number.exclusive-maximum-equal', bounds.exclusiveMaximum);
  if (integer) add('number.fractional-for-integer', upper(addDecimal(anchor, 0.5)) ? addDecimal(anchor, 0.5) : addDecimal(anchor, -0.5));
  if (integer && bounds.maximum === undefined && bounds.exclusiveMaximum === undefined) add('number.unsafe-integer', 2 ** 53);
  if (multipleOf !== undefined) {
    const delta = integer ? 1 : Number((multipleOf / 2).toFixed(Math.min(20, decimalPlaces(multipleOf) + 1)));
    const candidate = upper(addDecimal(anchor, delta)) ? addDecimal(anchor, delta) : addDecimal(anchor, -delta);
    if (!isMultiple(candidate, multipleOf)) add('number.multiple-of-violation', candidate);
  }
  add('type.string-for-number', String(anchor));
}

function readBounds(schema: Record<string, unknown>): Bounds {
  const bounds: Bounds = {
    minimum: optionalNumber(schema.minimum, 'minimum'),
    maximum: optionalNumber(schema.maximum, 'maximum'),
  };
  // OpenAPI 3.0 writes an exclusive bound as `minimum` plus `exclusiveMinimum: true`; read it
  // as the 3.1 numeric form so both produce the same partitions.
  for (const [exclusive, inclusive] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']] as const) {
    const value = schema[exclusive];
    if (value === true) {
      if (bounds[inclusive] === undefined) throw new TypeError(`${exclusive}: true needs ${inclusive}`);
      bounds[exclusive] = bounds[inclusive];
      bounds[inclusive] = undefined;
    } else if (value !== undefined && value !== false) {
      bounds[exclusive] = optionalNumber(value, exclusive);
    }
  }
  return bounds;
}

/** The smallest valid value at or above the lower bound (on the grid); 0 when unbounded. */
function validAnchor(bounds: Bounds, grid: number | undefined, step: number): number {
  if (bounds.minimum !== undefined) return grid !== undefined ? onGrid(bounds.minimum, grid, 'at-or-above') : bounds.minimum;
  if (bounds.exclusiveMinimum !== undefined) return grid !== undefined ? onGrid(bounds.exclusiveMinimum, grid, 'above') : addDecimal(bounds.exclusiveMinimum, step);
  if (bounds.maximum !== undefined) return grid !== undefined ? onGrid(bounds.maximum, grid, 'at-or-below') : bounds.maximum;
  if (bounds.exclusiveMaximum !== undefined) return grid !== undefined ? onGrid(bounds.exclusiveMaximum, grid, 'below') : addDecimal(bounds.exclusiveMaximum, -step);
  return 0;
}

/** The nearest multiple of `grid` relative to `value`, computed in scaled integers. */
function onGrid(value: number, grid: number, direction: 'below' | 'above' | 'at-or-above' | 'at-or-below'): number {
  const places = Math.min(15, Math.max(decimalPlaces(value), decimalPlaces(grid)));
  const scale = 10 ** places;
  const v = Math.round(value * scale);
  const g = Math.round(grid * scale);
  const k = {
    below: Math.ceil(v / g) - 1,
    above: Math.floor(v / g) + 1,
    'at-or-above': Math.ceil(v / g),
    'at-or-below': Math.floor(v / g),
  }[direction];
  return Number(((k * g) / scale).toFixed(places));
}

function isMultiple(value: number, grid: number): boolean {
  const places = Math.min(15, Math.max(decimalPlaces(value), decimalPlaces(grid)));
  const scale = 10 ** places;
  return Math.round(value * scale) % Math.round(grid * scale) === 0;
}

function outOfEnum(values: unknown[], type: FieldType | undefined): unknown {
  const members = values.filter((value) => value !== null);
  if (members.length === 0) return undefined;
  const has = (candidate: unknown) => members.some((member) => member === candidate);
  if (type === 'boolean' || members.every((member) => typeof member === 'boolean')) {
    return [false, true].find((candidate) => !has(candidate));
  }
  if (type === 'integer' || type === 'number' || members.every((member) => typeof member === 'number')) {
    let candidate = Math.floor(Math.max(...members.filter((member): member is number => typeof member === 'number'), 0)) + 1;
    while (has(candidate)) candidate += 1;
    return candidate;
  }
  let candidate = 'argus-out-of-enum';
  while (has(candidate)) candidate += '-x';
  return candidate;
}

function fieldType(schema: Record<string, unknown>): { type: FieldType | undefined; nullable: boolean } {
  const declared = schema.type;
  const list = declared === undefined ? [] : Array.isArray(declared) ? declared : [declared];
  if (!list.every((entry) => typeof entry === 'string')) throw new TypeError('type must be a string or a list of strings');
  const types = (list as string[]).filter((entry) => entry !== 'null');
  if (types.length > 1) throw new TypeError(`one field type is required, got ${JSON.stringify(declared)}`);
  const type = types[0];
  if (type !== undefined && !(TYPES as readonly string[]).includes(type)) throw new TypeError(`unsupported type ${JSON.stringify(type)}`);
  const nullable = schema.nullable === true || list.includes('null') || (Array.isArray(schema.enum) && schema.enum.includes(null));
  return { type: type as FieldType | undefined, nullable };
}

function requireSchema(schema: unknown): Record<string, unknown> {
  if (!isObject(schema)) throw new TypeError('the schema must be a schema object');
  for (const keyword of ['$ref', 'allOf', 'oneOf', 'anyOf']) {
    if (keyword in schema) throw new TypeError(`resolve ${keyword} into one schema first`);
  }
  return schema;
}

/** Run `body`, prefixing a TypeError (a usage error) with `context`. */
function inContext<T>(context: string, body: () => T): T {
  try {
    return body();
  } catch (error) {
    if (error instanceof TypeError) throw new TypeError(`${context}: ${error.message}`);
    throw error;
  }
}

function compilePattern(pattern: unknown): RegExp {
  if (typeof pattern !== 'string') throw new TypeError('pattern must be a string');
  // JSON Schema patterns are ECMA-262 with Unicode semantics and are not implicitly anchored.
  try {
    return new RegExp(pattern, 'u');
  } catch {
    try {
      return new RegExp(pattern);
    } catch {
      throw new TypeError(`pattern ${JSON.stringify(pattern)} is not a valid regular expression`);
    }
  }
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be a finite number, got ${JSON.stringify(value)}`);
  return value;
}

function optionalCount(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} must be a non-negative integer, got ${JSON.stringify(value)}`);
  return value as number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
