import { allSchedules, getSchedule } from './scheduleStore.js';
import { getEntry } from './store.js';
import { applyDeviceConfig } from './control.js';
import { resolveStepConflicts } from './conflict.js';
import { log } from './logger.js';

// Schedule execution engine.
//
// Each step of each schedule is a DAILY-RECURRING trigger: at its local "HH:MM"
// it pushes its config to every device in the schedule's deviceIds, taking the
// exact same internal path as a manual POST /devices/:id/config (applyDeviceConfig).
//
// Design choices (see README "Schedules"):
//  - Local time. "HH:MM" is interpreted in the bridge host's local timezone.
//  - DST-safe recurrence. We never use a fixed 24h interval (which would drift an
//    hour each DST transition). Instead each fire computes the NEXT wall-clock
//    occurrence with Date's local-time setters, so 07:00 stays 07:00 year-round.
//  - Missed fires are skipped, not replayed. On boot we only arm FUTURE
//    occurrences; a step whose time already passed today first fires tomorrow.
//  - Per-device isolation. One unreachable/offline device is logged and skipped;
//    the rest of the step still runs.
//
// A "trigger" is one live per-step timer. `armed` maps a schedule id to its list
// of triggers so a re-arm (on write) or disarm (on delete) can cancel precisely.

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** @type {Map<string, Trigger[]>} scheduleId -> live per-step triggers */
const armed = new Map();

/** @type {Map<string, LastRun>} scheduleId -> most recent fire summary */
const lastRuns = new Map();

/**
 * Next wall-clock occurrence of local hh:mm strictly after `from`. Uses local
 * setters so DST is handled by the platform: across a spring-forward gap the
 * nonexistent time rolls forward an hour; there is no drift because we recompute
 * from the real clock every day rather than adding a fixed interval.
 */
function nextOccurrence(hh, mm, from) {
  const next = new Date(from);
  next.setHours(hh, mm, 0, 0);
  if (next.getTime() <= from.getTime()) {
    next.setDate(next.getDate() + 1);
    // Re-set after crossing the date boundary so the wall-clock time is exact
    // even if the day rollover landed on a DST transition.
    next.setHours(hh, mm, 0, 0);
  }
  return next;
}

/**
 * Fire one step now: push step.config to each device, isolating per-device
 * failures. Re-reads the schedule from the store at fire time so a config edit
 * or device change is always reflected even between explicit re-arms.
 */
async function fireStep(scheduleId, stepId) {
  const schedule = getSchedule(scheduleId);
  if (!schedule) return; // deleted between arm and fire
  const step = schedule.steps.find((s) => s.id === stepId);
  if (!step) return; // step removed by an edit

  log.info('schedule_fire', {
    scheduleId,
    name: schedule.name,
    stepId,
    time: step.time,
    deviceCount: schedule.deviceIds.length,
  });

  const results = [];
  for (const deviceId of schedule.deviceIds) {
    const entry = getEntry(deviceId);
    if (!entry) {
      // Devices can be offline/rediscovered later; a schedule may reference one
      // the bridge hasn't seen yet. Skip it this fire, keep going.
      log.warn('schedule_device_unknown', { scheduleId, stepId, deviceId });
      results.push({ deviceId, ok: false, reason: 'unknown_device' });
      continue;
    }
    try {
      const res = await applyDeviceConfig(entry, step.config, 'scheduled', { scheduleId, stepId });
      log.info('schedule_device_ok', { scheduleId, stepId, deviceId, configId: res.configId });
      results.push({ deviceId, ok: true, configId: res.configId ?? null });
      // Schedules are the source of truth: if this push shares an outdoor unit
      // with a sibling running the opposite heat/cool direction, turn the
      // sibling off so the scheduled command actually takes effect.
      await resolveStepConflicts(schedule, step, deviceId, entry);
    } catch (err) {
      // Per-device isolation: one offline/unreachable unit must not abort the rest.
      log.warn('schedule_device_failed', { scheduleId, stepId, deviceId, code: err.code ?? null, error: err.message });
      results.push({ deviceId, ok: false, reason: err.code ?? 'error' });
    }
  }

  lastRuns.set(scheduleId, { stepId, time: step.time, at: new Date().toISOString(), results });
}

/** Build one self-rescheduling trigger for a step. */
function makeTrigger(schedule, step) {
  const [hh, mm] = step.time.split(':').map(Number);
  const trigger = { stepId: step.id, time: step.time, cancelled: false, handle: null, nextAt: null };

  const scheduleNext = (from) => {
    if (trigger.cancelled) return;
    const target = nextOccurrence(hh, mm, from);
    trigger.nextAt = target.toISOString();
    const delay = Math.max(0, target.getTime() - Date.now());
    trigger.handle = setTimeout(() => {
      if (trigger.cancelled) return;
      // Fire, then arm the following day. Base the next computation just past
      // this target so nextOccurrence rolls to tomorrow (never re-fires today).
      fireStep(schedule.id, step.id).finally(() => {
        scheduleNext(new Date(target.getTime() + 60_000));
      });
    }, delay);
  };

  scheduleNext(new Date());
  return trigger;
}

/**
 * (Re)arm all triggers for one schedule: cancel any existing ones first, then
 * build a fresh trigger per step. Called on every write so edits take effect
 * without a restart. Steps with a malformed time are skipped defensively (write
 * validation already guarantees valid times for persisted schedules).
 */
export function armSchedule(schedule) {
  disarmSchedule(schedule.id);
  // A disabled schedule is kept/persisted but never fires: arm no triggers until
  // it's re-enabled (a later PUT with enabled:true re-runs this and arms them).
  if (schedule.enabled === false) {
    log.info('schedule_arm_skipped_disabled', { id: schedule.id, name: schedule.name });
    return;
  }
  const triggers = [];
  for (const step of schedule.steps) {
    if (!TIME_RE.test(step.time)) {
      log.warn('schedule_step_skipped_bad_time', { scheduleId: schedule.id, stepId: step.id, time: step.time });
      continue;
    }
    triggers.push(makeTrigger(schedule, step));
  }
  armed.set(schedule.id, triggers);
  log.info('schedule_armed', {
    id: schedule.id,
    name: schedule.name,
    stepCount: triggers.length,
    nextRunAt: nextRunAt(schedule.id),
  });
}

/** Cancel and forget every trigger for a schedule. Idempotent. */
export function disarmSchedule(id) {
  const triggers = armed.get(id);
  if (!triggers) return;
  for (const t of triggers) {
    t.cancelled = true;
    if (t.handle) clearTimeout(t.handle);
  }
  armed.delete(id);
  log.info('schedule_disarmed', { id });
}

/** Earliest upcoming fire (ISO) across a schedule's triggers, or null. */
function nextRunAt(id) {
  const triggers = armed.get(id);
  if (!triggers || triggers.length === 0) return null;
  const times = triggers.map((t) => t.nextAt).filter(Boolean).sort();
  return times[0] ?? null;
}

/** Arm every loaded schedule. Call once on startup after schedules are loaded. */
export function startScheduler() {
  let count = 0;
  for (const schedule of allSchedules()) {
    armSchedule(schedule);
    count += 1;
  }
  log.info('scheduler_started', { scheduleCount: count });
}

/** Cancel every armed trigger (shutdown). */
export function stopScheduler() {
  for (const id of [...armed.keys()]) disarmSchedule(id);
}

/** Observability snapshot: per-schedule next-run + last-run, for GET /health. */
export function schedulerStatus() {
  return allSchedules().map((s) => ({
    id: s.id,
    name: s.name,
    enabled: s.enabled !== false,
    stepCount: s.steps.length,
    deviceCount: s.deviceIds.length,
    nextRunAt: nextRunAt(s.id), // null when disabled (no triggers armed)
    lastRun: lastRuns.get(s.id) ?? null,
  }));
}
