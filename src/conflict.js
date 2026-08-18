import { allEntries } from './store.js';
import { applyDeviceConfig } from './control.js';
import { log } from './logger.js';

// Multi-zone minisplits often wire several indoor heads to one shared outdoor
// (condenser) unit. The outdoor unit can only run one thermal direction at a
// time: whichever indoor head calls for heat or cool first "wins" it, and any
// other head asking for the opposite direction is simply ignored by the
// hardware until the winner backs off. That means a scheduled "cool" can
// silently do nothing if a sibling head is already running "heat".
//
// We treat schedules as the source of truth: when a step pushes a thermal
// mode to a device, every other device sharing its `outdoorUnit` group that
// is currently running the opposite direction gets turned off, so the
// scheduled command actually takes effect.
//
// `outdoorUnit` is physical wiring the bridge has no way to discover on its
// own (see POST /devices/:id/outdoor-unit) — nothing reports it. Rather than
// silently skipping conflict checks until every device is manually tagged
// (which would look like the feature does nothing on a fresh install), any
// device with no `outdoorUnit` set falls into one shared implicit default
// group together. That matches the common case of a single physical outdoor
// unit out of the box. A device gets carved out of the default group only
// once it's given its own explicit `outdoorUnit` value — so a second outdoor
// unit can be introduced later by tagging just the devices on it, without
// having to also tag everything already on the first one.

// Sentinel for "no explicit outdoorUnit assigned". The endpoint validator
// rejects an empty string as a real assignment, so this can never collide
// with a user-provided value.
const DEFAULT_GROUP = '';

function groupOf(entry) {
  return entry.outdoorUnit ?? DEFAULT_GROUP;
}

// 'dry' runs the compressor on the cooling side (it dehumidifies via the
// cooling coil), so it's grouped with 'cool' here. 'auto' has no fixed side —
// the unit picks one dynamically — so it's deliberately never treated as
// heat or cool for conflict purposes; we don't have enough information to
// know which way it actually swung.
const COOL_SIDE_MODES = new Set(['cool', 'dry']);

/** Which thermal direction a config represents, or null if it doesn't occupy one. */
function thermalSide(cfg) {
  if (!cfg || cfg.power !== 'on') return null;
  if (cfg.mode === 'heat') return 'heat';
  if (COOL_SIDE_MODES.has(cfg.mode)) return 'cool';
  return null;
}

/**
 * Best-known current thermal side for a device: prefer what the unit itself
 * last reported (closest to physical truth, and reflects physical-remote use
 * the bridge never commanded), falling back to the bridge's own desired state
 * when nothing has been reported yet.
 */
function currentSide(entry) {
  return thermalSide(entry.reportedConfig) ?? thermalSide(entry.desiredConfig);
}

/**
 * After a schedule step successfully pushes `step.config` to `deviceId`,
 * find any other device in its outdoor-unit group (explicit, or the shared
 * implicit default group when unset — see module comment) that is currently
 * running the opposite thermal direction, and turn it off. Devices also
 * targeted by this same step are never treated as conflicting with each
 * other — a step is allowed to set several of its own devices at once.
 *
 * Best-effort: a failure turning off a conflicting unit is logged, not
 * thrown — it must not abort the rest of the step (same isolation policy as
 * scheduler.js's per-device pushes).
 */
export async function resolveStepConflicts(schedule, step, deviceId, entry) {
  const side = thermalSide(step.config);
  if (!side) return;

  const group = groupOf(entry);
  const siblings = allEntries().filter(
    (other) =>
      other.id !== deviceId &&
      groupOf(other) === group &&
      !schedule.deviceIds.includes(other.id)
  );

  for (const sibling of siblings) {
    const otherSide = currentSide(sibling);
    if (!otherSide || otherSide === side) continue;

    log.warn('schedule_conflict_detected', {
      scheduleId: schedule.id,
      stepId: step.id,
      outdoorUnit: entry.outdoorUnit,
      source: deviceId,
      sourceMode: side,
      target: sibling.id,
      targetMode: otherSide,
    });

    try {
      await applyDeviceConfig(sibling, { schema: 1, power: 'off' }, 'scheduled', {
        scheduleId: schedule.id,
        stepId: step.id,
        conflictWith: deviceId,
      });
      log.info('schedule_conflict_resolved', {
        scheduleId: schedule.id,
        stepId: step.id,
        deviceId: sibling.id,
      });
    } catch (err) {
      log.warn('schedule_conflict_resolve_failed', {
        scheduleId: schedule.id,
        stepId: step.id,
        deviceId: sibling.id,
        error: err.message,
      });
    }
  }
}
