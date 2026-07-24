import { config } from './config.js';
import { allEntries, touch, upsert, persist } from './store.js';
import { deviceClient } from './deviceClient.js';
import { log } from './logger.js';

// Reconciliation loop: periodically poll each known unit's /health (and /config
// to learn its reported state). If a unit reports applied:false or a configId
// lower than the bridge's stored desired-state configId, it rebooted or missed
// a command — best-effort re-push the desired state. IR is fire-and-forget, so
// re-assertion has no ACK and is expected.

let timer = null;

async function pollOne(entry) {
  const id = entry.id;
  try {
    const health = await deviceClient.health(entry);
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
    // Unreachable: leave lastSeen/down as-is (computeStatus will age it to stale).
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

  const rebooted = entry.applied === false;
  const missed = entry.unitConfigId !== null && entry.unitConfigId < entry.desiredConfigId;
  if (!rebooted && !missed) return;

  log.info('reassert_start', {
    id,
    reason: rebooted ? 'applied_false' : 'config_id_regressed',
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
  const entries = allEntries();
  await Promise.allSettled(entries.map(pollOne));
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
