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
//   outdoorUnit,
//   // set when an ip-identity collision released this entry's ip (see releaseIp):
//   orphaned
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
    // Set when an ip-identity collision showed this entry's `ip` was pointing at
    // hardware that is not this device (see releaseIp). The entry is KEPT with
    // all of its configuration; only the ip is dropped, so it stops being polled
    // at an address that isn't it and ages out to offline until the real unit
    // checks back in. { at, reason } or null.
    orphaned: null,
    // Free-text id of the shared outdoor/condenser unit this indoor head is
    // wired to, or null if unassigned. Multiple indoor heads on one outdoor
    // unit must agree on heat vs. cool — see conflict.js, which treats every
    // device with a null outdoorUnit as one shared implicit default group
    // (not "no group") so conflict checking works before anything is tagged.
    // Not learned automatically (nothing in discovery/register reports it);
    // assigned via POST /devices/:id/outdoor-unit.
    outdoorUnit: null,
  };
}

export function getEntry(id) {
  return registry.get(id) || null;
}

export function allEntries() {
  return [...registry.values()];
}

/**
 * Hard-delete a device entry. Returns whether it existed. Does not persist (the
 * schedule-store prune persists itself, on its own file).
 *
 * `pruneSchedules` additionally drops the id from every schedule referencing
 * it. That is IRREVERSIBLE — re-registering under the same id cannot restore
 * schedule membership — so it is opt-in and reserved for a user-initiated
 * delete (DELETE /devices/:id, POST /devices/dedupe), where removing the device
 * is a deliberate act. Automatic, inferred cleanup must never pass it: a wrong
 * guess would silently rewrite the user's schedules. Automatic paths should
 * generally prefer releaseIp() and not delete at all.
 */
export function removeEntry(id, { pruneSchedules = false } = {}) {
  const existed = registry.delete(id);
  if (existed && pruneSchedules) {
    const affected = removeDeviceFromSchedules(id);
    if (affected.length > 0) log.info('schedule_device_pruned', { deviceId: id, scheduleIds: affected });
  }
  return existed;
}

/**
 * Drop an entry's ip (and port) while keeping the entry and everything the user
 * configured on it — desiredConfig, outdoorUnit, schedule membership.
 *
 * This is the safe response to any ip-identity collision. Discovering that the
 * unit answering at an ip is not this device proves exactly one thing: this
 * entry's `ip` is stale. It says nothing about whether the device still exists
 * — it may simply have moved, or another unit may have briefly claimed its id
 * (e.g. a unit flashed with firmware whose id was not updated first). Deleting
 * on that evidence destroys a live device's configuration; releasing the ip
 * costs nothing, because the entry ages out to offline on its own and is
 * reclaimed intact the moment the real unit registers or is rediscovered.
 */
export function releaseIp(id, reason) {
  const entry = registry.get(id);
  if (!entry || !entry.ip) return false;
  log.warn('device_ip_released', { id, ip: entry.ip, reason });
  entry.ip = null;
  entry.orphaned = { at: new Date().toISOString(), reason };
  // Drop liveness with the ip. Whatever refreshed lastSeen did so by answering
  // at an ip we have just established is not this device, so keeping it would
  // report a device as "online" that the bridge provably cannot reach. Cleared,
  // it reads offline until the real unit makes contact and reclaims the entry.
  entry.lastSeen = null;
  entry.down = true;
  return true;
}

/**
 * Group entries by ip and return [{ ip, keep, stale[] }] for every ip claimed by
 * more than one entry, `keep` being the most recently seen. Sorted newest-first
 * with the id as a deterministic tiebreaker, so a restart (which nulls every
 * lastSeen, tying them all) can't resolve the same collision two different ways
 * on two different runs.
 */
function collisionsByIp() {
  const byIp = new Map();
  for (const entry of registry.values()) {
    if (!entry.ip) continue;
    if (!byIp.has(entry.ip)) byIp.set(entry.ip, []);
    byIp.get(entry.ip).push(entry);
  }
  const out = [];
  for (const [ip, entries] of byIp) {
    if (entries.length < 2) continue;
    entries.sort((a, b) => {
      const delta = new Date(b.lastSeen ?? 0) - new Date(a.lastSeen ?? 0);
      return delta !== 0 ? delta : a.id.localeCompare(b.id);
    });
    const [keep, ...stale] = entries;
    out.push({ ip, keep, stale });
  }
  return out;
}

/**
 * Automatic, NON-destructive resolution of entries sharing an ip: the most
 * recently seen entry keeps the ip, and every other entry has its ip released
 * (releaseIp) while the entry itself — and everything configured on it — is
 * kept. Returns the ids whose ip was released. Does not persist.
 *
 * Two entries at one ip mean one of two things, and the bridge cannot tell them
 * apart from the ip alone:
 *
 *   1. A rename/reflash to a NEW id, leaving the old id behind as a genuine
 *      orphan. Deleting it is correct.
 *   2. An id COLLISION between two distinct units — e.g. a unit flashed with
 *      firmware whose id was not updated first, so it boots claiming an id
 *      another device already owns. Here BOTH ids are real devices, and the
 *      loser is a live unit that is about to check back in.
 *
 * This used to assume (1) always and hard-delete the loser, which in case (2)
 * destroyed a working device's desiredConfig and outdoor-unit grouping and
 * stripped it from every schedule — damage that re-registering cannot undo,
 * from nothing worse than one bad boot. Releasing the ip is the action that is
 * correct in BOTH cases: the stale ip stops being polled either way, case (2)
 * heals completely the moment the real unit registers, and case (1) leaves a
 * visible, offline, ip-less entry the user can delete deliberately (DELETE
 * /devices/:id or POST /devices/dedupe) once they can see it is an orphan.
 */
export function resolveDuplicateIps() {
  const released = [];
  for (const { ip, keep, stale } of collisionsByIp()) {
    for (const entry of stale) {
      log.warn('device_ip_conflict', { id: entry.id, keptId: keep.id, ip });
      releaseIp(entry.id, 'ip_claimed_by_other_device');
      released.push(entry.id);
    }
  }
  return released;
}

/**
 * Destructive dedup: hard-delete every entry that shares an ip with a more
 * recently seen one, pruning the deleted ids from schedules too. Returns the
 * removed ids. Does not persist.
 *
 * User-initiated only (POST /devices/dedupe) — this is the "yes, these really
 * are leftover duplicates, remove them" action. Automatic paths use
 * resolveDuplicateIps() instead; see the note there on why guessing must not
 * delete.
 */
export function pruneDuplicateIps() {
  const removed = [];
  for (const { ip, keep, stale } of collisionsByIp()) {
    for (const entry of stale) {
      removeEntry(entry.id, { pruneSchedules: true });
      removed.push(entry.id);
      log.info('device_duplicate_removed', { removedId: entry.id, keptId: keep.id, ip });
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
 * Contact at a known ip also re-resolves that ip: this entry's live contact
 * makes it the freshest claimant, so any other entry still pointing at the same
 * ip has a stale ip and gets it released (never deleted — see
 * resolveDuplicateIps). Reaching a device again also clears its own `orphaned`
 * marker, since it just proved where it lives. Callers persist as usual; this
 * doesn't add an extra write. */
export function touch(id, fields = {}) {
  const entry = upsert(id, { ...fields, lastSeen: new Date().toISOString(), down: false });
  if (entry.ip) {
    if (entry.orphaned) {
      log.info('device_reclaimed', { id, ip: entry.ip, orphanedAt: entry.orphaned.at });
      entry.orphaned = null;
    }
    resolveDuplicateIps();
  }
  return entry;
}

/**
 * Would letting `id` claim `ip` hijack a live device? Returns the incumbent's
 * ip when it would, else null.
 *
 * True when the id is already held by an entry sitting at a DIFFERENT ip that
 * is still online — i.e. two physical units claiming one id, which is what a
 * unit flashed before its id was updated looks like. Shared by every inbound
 * identity claim (POST /register and mDNS), so a unit cannot simply take the
 * path that isn't guarded.
 *
 * Deliberately scoped to an ONLINE incumbent: a device that genuinely changed
 * ip (new DHCP lease) goes quiet at the old one and ages out within
 * OFFLINE_AFTER_MS, after which its claim is accepted normally.
 */
export function identityConflict(id, ip) {
  if (!ip) return null;
  const incumbent = registry.get(id);
  if (!incumbent || !incumbent.ip || incumbent.ip === ip) return null;
  return computeStatus(incumbent) === 'online' ? incumbent.ip : null;
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
    orphaned: entry.orphaned,
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
