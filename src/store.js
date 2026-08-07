import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

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
//   desiredConfig, desiredConfigId
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
  };
}

export function getEntry(id) {
  return registry.get(id) || null;
}

export function allEntries() {
  return [...registry.values()];
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

/** Record any contact with a unit: updates lastSeen and clears the down flag. */
export function touch(id, fields = {}) {
  return upsert(id, { ...fields, lastSeen: new Date().toISOString(), down: false });
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
