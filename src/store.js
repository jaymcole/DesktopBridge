import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';
import { removeDeviceFromSchedules } from './scheduleStore.js';

// In-memory device registry, keyed by device id, persisted to a JSON file.
// Each entry:
// {
//   id, location, firmware, schema, ip, port,
//   lastSeen: ISO string | null,
//   down: bool,                      // last mDNS "down" signal (advisory only —
//                                    // computeStatus trusts lastSeen, not this)
//   // learned from the unit's GET /health:
//   rssi, uptimeSec, unitConfigId, applied,
//   // learned from the unit's GET /config:
//   reportedConfig,
//   // the bridge's intent:
//   desiredConfig, desiredConfigId,
//   // manually assigned grouping (see POST /devices/:id/outdoor-unit):
//   outdoorUnit
// }

const registry = new Map();

function blankEntry(id) {
  return {
    id,
    location: null,
    firmware: null,
    schema: null,
    ip: null,
    port: 80,
    lastSeen: null,
    down: false,
    rssi: null,
    uptimeSec: null,
    unitConfigId: null,
    applied: null,
    reportedConfig: null,
    desiredConfig: null,
    desiredConfigId: null,
    // Most recent command initiated against this unit: { source, at } (or null).
    // Surfaced to the UI's info pane; the full history lives in the command log.
    lastCommand: null,
    // Free-text id of the shared outdoor/condenser unit this indoor head is
    // wired to, or null if unknown/unset. Multiple indoor heads on one
    // outdoor unit must agree on heat vs. cool — see conflict.js. Not learned
    // automatically (nothing in discovery/register reports it); assigned via
    // POST /devices/:id/outdoor-unit.
    outdoorUnit: null,
  };
}

export function getEntry(id) {
  return registry.get(id) || null;
}

export function allEntries() {
  return [...registry.values()];
}

/** Hard-delete a device entry (e.g. a stale id left behind after a unit was
 * renamed/reflashed). Also drops the id from any schedule that still
 * references it, so a renamed/removed device can't leave schedules failing
 * on a ghost id forever. Returns whether it existed. Does not persist (the
 * schedule-store prune persists itself, on its own file). */
export function removeEntry(id) {
  const existed = registry.delete(id);
  if (existed) {
    const affected = removeDeviceFromSchedules(id);
    if (affected.length > 0) log.info('schedule_device_pruned', { deviceId: id, scheduleIds: affected });
  }
  return existed;
}

/**
 * Find entries that share an ip address with another entry and remove all but
 * the most recently seen one. Units are stationary with a fixed ip, so a
 * shared ip always means the same physical unit under more than one id (e.g.
 * left behind after a rename/reflash) — never two distinct units. Returns the
 * removed ids. Does not persist.
 */
export function pruneDuplicateIps() {
  const byIp = new Map();
  for (const entry of registry.values()) {
    if (!entry.ip) continue;
    if (!byIp.has(entry.ip)) byIp.set(entry.ip, []);
    byIp.get(entry.ip).push(entry);
  }
  const removed = [];
  for (const entries of byIp.values()) {
    if (entries.length < 2) continue;
    entries.sort((a, b) => new Date(b.lastSeen ?? 0) - new Date(a.lastSeen ?? 0));
    const [keep, ...stale] = entries;
    for (const entry of stale) {
      registry.delete(entry.id);
      removed.push(entry.id);
      log.info('device_duplicate_removed', { removedId: entry.id, keptId: keep.id, ip: entry.ip });
      const affected = removeDeviceFromSchedules(entry.id);
      if (affected.length > 0) log.info('schedule_device_pruned', { deviceId: entry.id, scheduleIds: affected });
    }
  }
  return removed;
}

/**
 * Merge fields into a device entry, creating it if needed. Only defined values
 * overwrite existing ones, so partial updates from different sources compose.
 * Does NOT persist — callers persist explicitly (persistence is triggered on
 * desired-state changes).
 */
export function upsert(id, fields = {}) {
  let entry = registry.get(id);
  if (!entry) {
    entry = blankEntry(id);
    registry.set(id, entry);
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) entry[k] = v;
  }
  return entry;
}

/** Record any contact with a unit: updates lastSeen and clears the down flag.
 * Also immediately drops any other entry left sharing this ip — this entry's
 * live contact makes it the freshest, so a same-ip sibling is a stale
 * duplicate (an old id from before a rename/reflash) rather than a distinct
 * unit. Callers persist as usual; this doesn't add an extra write. */
export function touch(id, fields = {}) {
  const entry = upsert(id, { ...fields, lastSeen: new Date().toISOString(), down: false });
  if (entry.ip) pruneDuplicateIps();
  return entry;
}

export function computeStatus(entry, now = Date.now()) {
  if (!entry.lastSeen) return 'offline';
  const age = now - new Date(entry.lastSeen).getTime();
  // Reachability is authoritative. A successful poll/observe within this window
  // is direct proof the unit is up, so it always wins — we deliberately do NOT
  // let the mDNS `down` flag veto it. mDNS records flap on TTL expiry / missed
  // refreshes, so an actively (and successfully) polled unit would otherwise
  // oscillate to "offline" between polls despite excellent signal and climbing
  // uptime. If the unit is genuinely gone, polls stop refreshing lastSeen and it
  // ages out to offline on its own — no separate "stale" grace band.
  return age <= config.offlineAfterMs ? 'online' : 'offline';
}

/** Build the exact Device response shape the React UI depends on. */
export function toDevice(entry, now = Date.now()) {
  const status = computeStatus(entry, now);
  const applied = entry.applied === null ? null : entry.applied;
  const inSync =
    entry.unitConfigId !== null &&
    entry.desiredConfigId !== null &&
    entry.unitConfigId === entry.desiredConfigId &&
    applied === true;

  return {
    id: entry.id,
    location: entry.location,
    firmware: entry.firmware,
    schema: entry.schema,
    ip: entry.ip,
    port: entry.port,
    status,
    lastSeen: entry.lastSeen,
    rssi: entry.rssi,
    uptimeSec: entry.uptimeSec,
    unitConfigId: entry.unitConfigId,
    desiredConfigId: entry.desiredConfigId,
    inSync,
    applied,
    desiredConfig: entry.desiredConfig,
    reportedConfig: entry.reportedConfig,
    lastCommand: entry.lastCommand,
    outdoorUnit: entry.outdoorUnit,
  };
}

// ---- persistence -----------------------------------------------------------

let persistTimer = null;

/** Debounced write of the whole registry to disk. */
export function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const dir = path.dirname(config.dataFile);
      fs.mkdirSync(dir, { recursive: true });
      const payload = { version: 1, savedAt: new Date().toISOString(), devices: allEntries() };
      const tmp = config.dataFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, config.dataFile); // atomic replace
    } catch (err) {
      log.error('persist_failed', { error: err.message });
    }
  }, 100);
}

/** Load persisted state on startup. Missing/corrupt file → start empty. */
export function load() {
  try {
    if (!fs.existsSync(config.dataFile)) {
      log.info('state_load_skipped', { reason: 'no_file', file: config.dataFile });
      return;
    }
    const raw = fs.readFileSync(config.dataFile, 'utf8');
    const parsed = JSON.parse(raw);
    for (const d of parsed.devices ?? []) {
      if (!d.id) continue;
      // Restore intent + last-known facts, but never trust volatile liveness:
      // drop the restored lastSeen so the unit reads offline until the
      // reconciliation loop actually reaches it and refreshes the timestamp.
      // (We no longer rely on `down` for this — computeStatus treats a fresh
      // lastSeen as authoritative, so a stale restored one must not look fresh.)
      const entry = { ...blankEntry(d.id), ...d, lastSeen: null, down: true };
      registry.set(d.id, entry);
    }
    log.info('state_loaded', { file: config.dataFile, deviceCount: registry.size });
  } catch (err) {
    log.error('state_load_failed', { error: err.message, file: config.dataFile });
  }
}
