import { isDeepStrictEqual } from 'node:util';

const SUPPORTED_KEYWORDS = new Set([
  '$defs', '$id', '$ref', '$schema', 'additionalProperties', 'allOf', 'const',
  'enum', 'format', 'if', 'items', 'maximum', 'maxItems', 'minItems', 'minLength', 'minimum',
  'pattern', 'properties', 'required', 'then', 'title', 'type', 'uniqueItems',
]);

export function compileJsonSchema(schema) {
  assertSupportedSchema(schema);
  return (value) => {
    const errors = [];
    validateNode(schema, value, schema, '', '#', errors);
    return errors;
  };
}

function validateNode(schema, value, root, instancePath, schemaPath, errors) {
  if (schema.$ref) {
    validateNode(resolveLocalReference(root, schema.$ref), value, root, instancePath, schema.$ref, errors);
  }

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    addError(errors, instancePath, `${schemaPath}/type`, 'type', `must be ${formatTypes(schema.type)}`);
    return;
  }

  if (schema.const !== undefined && !isDeepStrictEqual(value, schema.const)) {
    addError(errors, instancePath, `${schemaPath}/const`, 'const', 'must be equal to constant');
  }
  if (schema.enum && !schema.enum.some((item) => isDeepStrictEqual(value, item))) {
    addError(errors, instancePath, `${schemaPath}/enum`, 'enum', 'must be equal to one of the allowed values');
  }

  for (const [index, branch] of (schema.allOf ?? []).entries()) {
    validateNode(branch, value, root, instancePath, `${schemaPath}/allOf/${index}`, errors);
  }
  if (schema.if) {
    const conditionErrors = [];
    validateNode(schema.if, value, root, instancePath, `${schemaPath}/if`, conditionErrors);
    if (conditionErrors.length === 0 && schema.then) {
      validateNode(schema.then, value, root, instancePath, `${schemaPath}/then`, errors);
    }
  }

  if (typeof value === 'string') validateString(schema, value, instancePath, schemaPath, errors);
  if (Array.isArray(value)) validateArray(schema, value, root, instancePath, schemaPath, errors);
  if (isObject(value)) validateObject(schema, value, root, instancePath, schemaPath, errors);
  if (typeof value === 'number') validateNumber(schema, value, instancePath, schemaPath, errors);
}

function validateString(schema, value, instancePath, schemaPath, errors) {
  if (schema.minLength !== undefined && [...value].length < schema.minLength) {
    addError(errors, instancePath, `${schemaPath}/minLength`, 'minLength', `must NOT have fewer than ${schema.minLength} characters`);
  }
  if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
    addError(errors, instancePath, `${schemaPath}/pattern`, 'pattern', `must match pattern ${schema.pattern}`);
  }
  if (schema.format !== undefined && !validateFormat(schema.format, value)) {
    addError(errors, instancePath, `${schemaPath}/format`, 'format', `must match format ${schema.format}`);
  }
}

function validateArray(schema, value, root, instancePath, schemaPath, errors) {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    addError(errors, instancePath, `${schemaPath}/minItems`, 'minItems', `must NOT have fewer than ${schema.minItems} items`);
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    addError(errors, instancePath, `${schemaPath}/maxItems`, 'maxItems', `must NOT have more than ${schema.maxItems} items`);
  }
  if (schema.uniqueItems) {
    for (let right = 1; right < value.length; right += 1) {
      for (let left = 0; left < right; left += 1) {
        if (isDeepStrictEqual(value[left], value[right])) {
          addError(errors, instancePath, `${schemaPath}/uniqueItems`, 'uniqueItems', 'must NOT have duplicate items');
          right = value.length;
          break;
        }
      }
    }
  }
  if (schema.items) {
    value.forEach((item, index) => validateNode(
      schema.items,
      item,
      root,
      `${instancePath}/${index}`,
      `${schemaPath}/items`,
      errors,
    ));
  }
}

function validateObject(schema, value, root, instancePath, schemaPath, errors) {
  for (const required of schema.required ?? []) {
    if (!Object.hasOwn(value, required)) {
      addError(errors, instancePath, `${schemaPath}/required`, 'required', `must have required property ${required}`);
    }
  }

  const properties = schema.properties ?? {};
  for (const [name, propertySchema] of Object.entries(properties)) {
    if (Object.hasOwn(value, name)) {
      validateNode(
        propertySchema,
        value[name],
        root,
        `${instancePath}/${escapePointer(name)}`,
        `${schemaPath}/properties/${escapePointer(name)}`,
        errors,
      );
    }
  }

  for (const [name, propertyValue] of Object.entries(value)) {
    if (Object.hasOwn(properties, name)) continue;
    if (schema.additionalProperties === false) {
      addError(errors, instancePath, `${schemaPath}/additionalProperties`, 'additionalProperties', `must NOT have additional property ${name}`);
    } else if (isObject(schema.additionalProperties)) {
      validateNode(
        schema.additionalProperties,
        propertyValue,
        root,
        `${instancePath}/${escapePointer(name)}`,
        `${schemaPath}/additionalProperties`,
        errors,
      );
    }
  }
}

function validateNumber(schema, value, instancePath, schemaPath, errors) {
  if (schema.minimum !== undefined && value < schema.minimum) {
    addError(errors, instancePath, `${schemaPath}/minimum`, 'minimum', `must be >= ${schema.minimum}`);
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    addError(errors, instancePath, `${schemaPath}/maximum`, 'maximum', `must be <= ${schema.maximum}`);
  }
}

function assertSupportedSchema(schema, path = '#') {
  if (!isObject(schema)) throw new Error(`${path}: JSON Schema node must be an object`);
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) throw new Error(`${path}: unsupported JSON Schema keyword ${keyword}`);
  }
  for (const [name, child] of Object.entries(schema.$defs ?? {})) assertSupportedSchema(child, `${path}/$defs/${escapePointer(name)}`);
  for (const [name, child] of Object.entries(schema.properties ?? {})) assertSupportedSchema(child, `${path}/properties/${escapePointer(name)}`);
  if (isObject(schema.items)) assertSupportedSchema(schema.items, `${path}/items`);
  if (isObject(schema.additionalProperties)) assertSupportedSchema(schema.additionalProperties, `${path}/additionalProperties`);
  for (const [index, child] of (schema.allOf ?? []).entries()) assertSupportedSchema(child, `${path}/allOf/${index}`);
  if (schema.if) assertSupportedSchema(schema.if, `${path}/if`);
  if (schema.then) assertSupportedSchema(schema.then, `${path}/then`);
  if (schema.$ref && !schema.$ref.startsWith('#/')) throw new Error(`${path}: only local JSON Schema references are supported`);
  if (schema.format && schema.format !== 'date-time') throw new Error(`${path}: unsupported JSON Schema format ${schema.format}`);
}

function resolveLocalReference(root, reference) {
  let current = root;
  for (const token of reference.slice(2).split('/').map(unescapePointer)) {
    if (!isObject(current) || !Object.hasOwn(current, token)) throw new Error(`unresolved local JSON Schema reference ${reference}`);
    current = current[token];
  }
  return current;
}

function matchesType(value, expected) {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((type) => {
    if (type === 'null') return value === null;
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return isObject(value);
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    return typeof value === type;
  });
}

function validateFormat(format, value) {
  if (format === 'date-time') return isDateTime(value);
  throw new Error(`unsupported JSON Schema format ${format}`);
}

function isDateTime(value) {
  const parts = value.split(/t|\s/i);
  return parts.length === 2 && isDate(parts[0]) && isTime(parts[1]);
}

function isDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const days = [0, 31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month];
}

function isTime(value) {
  const match = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2})(?::?(\d{2}))?)$/i.exec(value);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  const sign = match[5] === '-' ? -1 : 1;
  const zoneHour = Number(match[6] ?? 0);
  const zoneMinute = Number(match[7] ?? 0);
  if (hour > 23 || minute > 59 || zoneHour > 23 || zoneMinute > 59 || second >= 61) return false;
  if (second < 60) return true;
  const utcMinute = (hour * 60 + minute - sign * (zoneHour * 60 + zoneMinute) + 1440) % 1440;
  return utcMinute === 1439;
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function addError(errors, instancePath, schemaPath, keyword, message) {
  errors.push({ instancePath, schemaPath, keyword, message });
}

function formatTypes(types) {
  return (Array.isArray(types) ? types : [types]).join(' or ');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapePointer(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function unescapePointer(value) {
  return value.replaceAll('~1', '/').replaceAll('~0', '~');
}
