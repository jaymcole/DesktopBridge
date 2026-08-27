import { config } from './config.js';
import {
  allEntries, touch, upsert, persist, releaseIp, resolveDuplicateIps,
} from './store.js';
import { deviceClient } from './deviceClient.js';
import { log } from './logger.js';

// Reconciliation loop: periodically poll each known unit's /health (and /config
// to learn its reported state). If a *running* unit reports a configId lower
// than the bridge's stored desired-state configId, a fire-and-forget push was
// lost — best-effort re-push the desired state (IR has no ACK, so this is
// expected). We do NOT re-push on reboot: the firmware is intentionally inert on
// boot, and reasserting there would override a remote-set state and resurrect a
// stale desiredConfig.

let timer = null;
// Guard against overlapping ticks. A single slow/hung unit poll can take up to
// deviceTimeoutMs; without this, setInterval keeps firing every pollIntervalMs
// and piles concurrent requests onto the (single-connection) unit, amplifying
// the stall into a multi-second blackout. If a tick is still running, skip.
let ticking = false;

/** Poll one entry. Exported for tests; the loop below drives it normally. */
export async function pollOne(entry) {
  const id = entry.id;
  // No ip means there is nowhere to poll: either the unit has only ever been
  // seen via a register that carried no ip, or its ip was released after an
  // identity collision. Either way it stays put, ages out to offline, and comes
  // back the moment it registers or is rediscovered over mDNS.
  if (!entry.ip) {
    log.debug('poll_skipped_no_ip', { id, orphaned: entry.orphaned?.reason ?? null });
    return;
  }
  try {
    const health = await deviceClient.health(entry);
    // The unit reports its own id in /health. If it doesn't match the entry we
    // are polling, this entry's ip is stale — the unit living there answers to
    // someone else. Release the ip (keeping the entry and everything configured
    // on it) rather than refreshing lastSeen, which would otherwise let a
    // still-reachable unit keep a second entry alive forever under an id it no
    // longer uses.
    //
    // Note what this does NOT prove: that the device named `id` is gone. It may
    // have moved, or another unit may have taken its id (a unit flashed before
    // its id was updated). Deleting here would destroy a live device's config
    // and schedule membership on that guess — see store.js releaseIp.
    if (health.id && health.id !== id) {
      log.info('device_id_changed', { staleId: id, currentId: health.id, ip: entry.ip });
      releaseIp(id, 'ip_answers_to_other_id');
      persist();
      return;
    }
    // Any successful contact refreshes liveness.
    touch(id, {
      location: health.location ?? undefined,
      firmware: health.firmware ?? undefined,
      schema: health.schema ?? undefined,
      ip: health.ip ?? undefined,
      rssi: health.rssi ?? null,
      uptimeSec: health.uptimeSec ?? null,
      unitConfigId: health.configId ?? null,
      applied: typeof health.applied === 'boolean' ? health.applied : null,
    });
  } catch (err) {
    // Unreachable: leave lastSeen/down as-is (computeStatus will age it to offline).
    log.warn('poll_health_failed', { id, error: err.message });
    return;
  }

  // Best-effort: also learn the unit's own reported config for the UI drift badge.
  try {
    const cfg = await deviceClient.getConfig(entry);
    upsert(id, {
      reportedConfig: cfg.config ?? null,
      unitConfigId: cfg.configId ?? entry.unitConfigId,
      applied: typeof cfg.applied === 'boolean' ? cfg.applied : entry.applied,
    });
  } catch (err) {
    log.debug('poll_config_failed', { id, error: err.message });
  }

  await maybeReassert(entry);
}

async function maybeReassert(entry) {
  const id = entry.id;
  if (!entry.desiredConfig || entry.desiredConfigId === null) return; // nothing to assert

  // Re-push ONLY when a running unit's configId has regressed below our desired
  // — i.e. a push that never landed. Deliberately NOT on reboot (applied===false):
  // the firmware stays inert on boot by design (a power blip must not turn the AC
  // on), and reasserting there would clobber a state the user later set via the
  // physical remote and revive a stale desiredConfig. After a reboot the unit is
  // left as-is until the next UI push or remote press.
  const missed = entry.unitConfigId !== null && entry.unitConfigId < entry.desiredConfigId;
  if (!missed) return;

  log.info('reassert_start', {
    id,
    reason: 'config_id_regressed',
    unitConfigId: entry.unitConfigId,
    desiredConfigId: entry.desiredConfigId,
  });

  try {
    const res = await deviceClient.postConfig(entry, entry.desiredConfig);
    upsert(id, {
      desiredConfigId: res.configId ?? entry.desiredConfigId,
      unitConfigId: res.configId ?? entry.unitConfigId,
      applied: true,
    });
    touch(id);
    persist();
    log.info('reassert_ok', { id, configId: res.configId });
  } catch (err) {
    log.warn('reassert_failed', { id, error: err.message });
  }
}

async function tick() {
  if (ticking) {
    log.debug('reconcile_skip_overlap');
    return;
  }
  ticking = true;
  try {
    // Belt-and-suspenders: catch any same-ip collisions the per-poll id check
    // in pollOne wouldn't (e.g. a stale entry whose unit never answers, so it
    // never gets the chance to report a changed id) before polling this tick.
    // Non-destructive — it only releases the losing entries' ip.
    const released = resolveDuplicateIps();
    if (released.length > 0) persist();
    const entries = allEntries();
    await Promise.allSettled(entries.map(pollOne));
  } finally {
    ticking = false;
  }
}

export function startReconcile() {
  // Kick one pass shortly after boot, then on the configured interval.
  setTimeout(tick, 2_000);
  timer = setInterval(tick, config.pollIntervalMs);
  log.info('reconcile_started', { pollIntervalMs: config.pollIntervalMs });
}

export function stopReconcile() {
  if (timer) clearInterval(timer);
}
