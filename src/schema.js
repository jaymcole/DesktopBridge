import { ApiError } from './errors.js';

// Config schema v1 validation, performed on the bridge so bad input never
// reaches a unit. Rejects unknown keys and out-of-range values with 400.

const ALLOWED_KEYS = new Set([
  'schema', 'power', 'mode', 'temp', 'fan', 'vaneVert', 'vaneHoriz',
]);

const POWER = new Set(['on', 'off']);
const MODE = new Set(['auto', 'cool', 'heat', 'dry']);
const FAN = new Set(['auto', '1', '2', '3', '4']);
const VANE_VERT = new Set(['auto', '1', '2', '3', '4', '5', 'swing']);
const VANE_HORIZ = new Set(['left', 'mleft', 'middle', 'mright', 'right', 'wide', 'auto']);

function fail(message, details = null) {
  throw new ApiError('validation_error', message, details);
}

/**
 * Validates a schema-v1 config object. Throws ApiError('validation_error') on
 * any problem. Returns a normalized copy containing only known keys.
 */
export function validateConfig(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('config must be a JSON object');
  }

  // Reject unknown keys explicitly so typos don't silently reach a unit.
  const unknown = Object.keys(input).filter((k) => !ALLOWED_KEYS.has(k));
  if (unknown.length > 0) {
    fail(`unknown config key(s): ${unknown.join(', ')}`, { unknownKeys: unknown });
  }

  if (input.schema !== 1) {
    fail('schema must be 1', { field: 'schema' });
  }

  if (!POWER.has(input.power)) {
    fail('power must be "on" or "off"', { field: 'power' });
  }

  const out = { schema: 1, power: input.power };

  if (input.power === 'on') {
    // mode + temp are required when on.
    if (!MODE.has(input.mode)) {
      fail('mode must be one of auto|cool|heat|dry (required when on)', { field: 'mode' });
    }
    if (!Number.isInteger(input.temp)) {
      fail('temp must be an integer (required when on)', { field: 'temp' });
    }
    if (input.temp < 16 || input.temp > 31) {
      fail('temp out of range (16-31)', { field: 'temp' });
    }
    out.mode = input.mode;
    out.temp = input.temp;
  } else {
    // When off, mode/temp are meaningless but tolerated if present + valid.
    if (input.mode !== undefined) {
      if (!MODE.has(input.mode)) fail('mode must be one of auto|cool|heat|dry', { field: 'mode' });
      out.mode = input.mode;
    }
    if (input.temp !== undefined) {
      if (!Number.isInteger(input.temp) || input.temp < 16 || input.temp > 31) {
        fail('temp out of range (16-31)', { field: 'temp' });
      }
      out.temp = input.temp;
    }
  }

  // Optional fields.
  if (input.fan !== undefined) {
    if (!FAN.has(input.fan)) fail('fan must be auto|1|2|3|4', { field: 'fan' });
    out.fan = input.fan;
  }
  if (input.vaneVert !== undefined) {
    if (!VANE_VERT.has(input.vaneVert)) fail('vaneVert must be auto|1..5|swing', { field: 'vaneVert' });
    out.vaneVert = input.vaneVert;
  }
  if (input.vaneHoriz !== undefined) {
    if (!VANE_HORIZ.has(input.vaneHoriz)) {
      fail('vaneHoriz must be left|mleft|middle|mright|right|wide|auto', { field: 'vaneHoriz' });
    }
    out.vaneHoriz = input.vaneHoriz;
  }

  return out;
}
