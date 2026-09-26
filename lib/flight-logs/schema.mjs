/**
 * Small JSON Schema checker for the flight-log documents.
 * Supports the subset used by docs/schemas/flight-log.
 */

function typeOk(type, data) {
  if (type === 'null') return data === null;
  if (type === 'string') return typeof data === 'string';
  if (type === 'boolean') return typeof data === 'boolean';
  if (type === 'number') return typeof data === 'number' && Number.isFinite(data);
  if (type === 'integer') return typeof data === 'number' && Number.isInteger(data);
  if (type === 'array') return Array.isArray(data);
  if (type === 'object') return data !== null && typeof data === 'object' && !Array.isArray(data);
  return false;
}

export function validateSchema(schema, data, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  if (Object.prototype.hasOwnProperty.call(schema, 'const') && data !== schema.const) {
    errors.push(`${path} expected const ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(data)) {
    errors.push(`${path} not in enum`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(t, data))) {
      errors.push(`${path} type ${types.join('|')}`);
      return errors;
    }
  }
  if (typeof data === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) errors.push(`${path} pattern`);
    if (schema.minLength !== undefined && data.length < schema.minLength) errors.push(`${path} minLength`);
    if (schema.maxLength !== undefined && data.length > schema.maxLength) errors.push(`${path} maxLength`);
  }
  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) errors.push(`${path} minimum`);
    if (schema.maximum !== undefined && data > schema.maximum) errors.push(`${path} maximum`);
  }
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) errors.push(`${path} minItems`);
    if (schema.items) {
      data.forEach((item, i) => {
        errors.push(...validateSchema(schema.items, item, `${path}[${i}]`));
      });
    }
  }
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const props = schema.properties || {};
    const required = schema.required || [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) errors.push(`${path}.${key} required`);
    }
    const extra = schema.additionalProperties;
    for (const key of Object.keys(data)) {
      if (props[key]) {
        errors.push(...validateSchema(props[key], data[key], `${path}.${key}`));
      } else if (extra === false) {
        errors.push(`${path}.${key} additional`);
      } else if (extra && typeof extra === 'object') {
        errors.push(...validateSchema(extra, data[key], `${path}.${key}`));
      }
    }
  }
  return errors;
}
