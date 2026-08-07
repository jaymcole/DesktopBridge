import { ApiError } from './errors.js';
import { validateConfig } from './schema.js';

// Validation for schedule write bodies (PUT/POST /schedules). Mirrors schema.js:
// closed shapes (unknown keys rejected), reused for both the HTTP path and the
// on-disk load so what we persist is always well-formed. Each step's config is
// validated with the SAME schema-v1 validator as a device push, so a scheduled
// transmission can never carry a config the live control surface would reject.

const SCHEDULE_KEYS = new Set(['id', 'name', 'enabled', 'deviceIds', 'steps']);
const STEP_KEYS = new Set(['id', 'time', 'config']);
// 24h "HH:MM", interpreted in the bridge host's local time.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function fail(code, message, details = null) {
  throw new ApiError(code, message, details);
}

/**
 * Validate a schedule object. Throws ApiError (invalid_schedule / invalid_time /
 * invalid_config, all 400) on any problem. Returns a normalized copy containing
 * only known keys, with each step's config normalized by validateConfig.
 *
 * If `idFromPath` is provided (the PUT/DELETE `:id`), the body's `id` must equal
 * it — the resource id and the payload id cannot disagree.
 */
export function validateSchedule(input, idFromPath) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid_schedule', 'schedule must be a JSON object');
  }

  const unknown = Object.keys(input).filter((k) => !SCHEDULE_KEYS.has(k));
  if (unknown.length > 0) {
    fail('invalid_schedule', `unknown schedule key(s): ${unknown.join(', ')}`, { unknownKeys: unknown });
  }

  if (typeof input.id !== 'string' || input.id === '') {
    fail('invalid_schedule', 'schedule id must be a non-empty string', { field: 'id' });
  }
  if (idFromPath !== undefined && input.id !== idFromPath) {
    fail('invalid_schedule', 'path id must equal body.id', { field: 'id', pathId: idFromPath, bodyId: input.id });
  }

  if (typeof input.name !== 'string') {
    fail('invalid_schedule', 'name must be a string (may be empty)', { field: 'name' });
  }

  // Optional; defaults to true so schedules persisted before this field existed
  // (and new ones that omit it) keep running. A disabled schedule is persisted
  // but the scheduler arms no triggers for it (see scheduler.js).
  let enabled = true;
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') {
      fail('invalid_schedule', 'enabled must be a boolean', { field: 'enabled' });
    }
    enabled = input.enabled;
  }

  if (!Array.isArray(input.deviceIds) || !input.deviceIds.every((d) => typeof d === 'string')) {
    fail('invalid_schedule', 'deviceIds must be an array of strings', { field: 'deviceIds' });
  }

  if (!Array.isArray(input.steps)) {
    fail('invalid_schedule', 'steps must be an array', { field: 'steps' });
  }

  const steps = input.steps.map((step, i) => {
    if (step === null || typeof step !== 'object' || Array.isArray(step)) {
      fail('invalid_schedule', `step[${i}] must be an object`, { index: i });
    }
    const unknownStep = Object.keys(step).filter((k) => !STEP_KEYS.has(k));
    if (unknownStep.length > 0) {
      fail('invalid_schedule', `step[${i}] has unknown key(s): ${unknownStep.join(', ')}`, { index: i, unknownKeys: unknownStep });
    }
    if (typeof step.id !== 'string' || step.id === '') {
      fail('invalid_schedule', `step[${i}] id must be a non-empty string`, { index: i, field: 'id' });
    }
    if (typeof step.time !== 'string' || !TIME_RE.test(step.time)) {
      fail('invalid_time', `step[${i}] time must be 24h "HH:MM"`, { index: i, time: step.time ?? null });
    }
    let config;
    try {
      config = validateConfig(step.config); // throws validation_error on any problem
    } catch (err) {
      // Re-badge the device-config error as a schedule-config error, preserving
      // the specific message + details so the UI can still point at the field.
      fail('invalid_config', `step[${i}] config invalid: ${err.message}`, { index: i, config: err.details ?? null });
    }
    return { id: step.id, time: step.time, config };
  });

  return {
    id: input.id,
    name: input.name,
    enabled,
    deviceIds: [...input.deviceIds],
    steps,
  };
}
