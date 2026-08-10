import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';
import { validateSchedule } from './scheduleSchema.js';

// In-memory schedule registry, keyed by schedule id, persisted to its own JSON
// file. A schedule is:
// {
//   id,                 // client-generated uuid, the resource id
//   name,               // free-text label (may be empty)
//   deviceIds: [...],    // device ids this schedule drives
//   steps: [ { id, time: "HH:MM", config: <schema-v1 config> } ]   // ordered
// }
// Only validated, normalized schedules ever enter the map (validateSchedule
// runs on every write and on load), so what we persist is always well-formed.

const schedules = new Map();

export function getSchedule(id) {
  return schedules.get(id) || null;
}

export function allSchedules() {
  return [...schedules.values()];
}

/** Insert or replace a schedule (upsert by id) and persist. */
export function putSchedule(schedule) {
  schedules.set(schedule.id, schedule);
  persist();
  return schedule;
}

/** Delete a schedule; idempotent. Returns whether it existed. */
export function removeSchedule(id) {
  const existed = schedules.delete(id);
  if (existed) persist();
  return existed;
}

/**
 * Drop a device id from every schedule's deviceIds, e.g. once its registry
 * entry is gone for good (deleted, deduped, or reconciled away after a
 * rename). Leaves the schedule itself in place — even with zero devices left,
 * its name/steps are still meaningful config the user may reassign later.
 * Returns the ids of schedules that were changed.
 */
export function removeDeviceFromSchedules(deviceId) {
  const affected = [];
  for (const schedule of schedules.values()) {
    if (!schedule.deviceIds.includes(deviceId)) continue;
    schedule.deviceIds = schedule.deviceIds.filter((d) => d !== deviceId);
    affected.push(schedule.id);
  }
  if (affected.length > 0) persist();
  return affected;
}

// ---- persistence -----------------------------------------------------------

let persistTimer = null;

/** Debounced atomic write of every schedule to disk. */
export function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const dir = path.dirname(config.schedulesFile);
      fs.mkdirSync(dir, { recursive: true });
      const payload = { version: 1, savedAt: new Date().toISOString(), schedules: allSchedules() };
      const tmp = config.schedulesFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, config.schedulesFile); // atomic replace
    } catch (err) {
      log.error('schedule_persist_failed', { error: err.message });
    }
  }, 100);
}

/**
 * Load persisted schedules on startup. Missing/corrupt file → start empty.
 * Each schedule is re-validated; a schedule that no longer passes validation
 * (e.g. hand-edited to an invalid config) is skipped with a warning rather than
 * aborting the whole load.
 */
export function load() {
  try {
    if (!fs.existsSync(config.schedulesFile)) {
      log.info('schedules_load_skipped', { reason: 'no_file', file: config.schedulesFile });
      return;
    }
    const raw = fs.readFileSync(config.schedulesFile, 'utf8');
    const parsed = JSON.parse(raw);
    let loaded = 0;
    let skipped = 0;
    for (const s of parsed.schedules ?? []) {
      try {
        const clean = validateSchedule(s);
        schedules.set(clean.id, clean);
        loaded += 1;
      } catch (err) {
        skipped += 1;
        log.warn('schedule_load_skipped', { id: s?.id ?? null, error: err.message });
      }
    }
    log.info('schedules_loaded', { file: config.schedulesFile, loaded, skipped });
  } catch (err) {
    log.error('schedules_load_failed', { error: err.message, file: config.schedulesFile });
  }
}
