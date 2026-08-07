import { upsert, touch, persist } from './store.js';
import { deviceClient } from './deviceClient.js';
import { log } from './logger.js';
import { recordCommand, normalizeSource } from './commandLog.js';

// The single internal "push a config to a unit" path, shared by the HTTP route
// (POST /devices/:id/config) and the schedule execution engine so both take the
// identical route: proxy to the unit, adopt the configId it assigns as the new
// desired/unit state, refresh liveness, and persist. `clean` MUST already be a
// schema-v1-validated config (validateConfig). Throws ApiError('device_*') on a
// unit failure; the caller is responsible for handling/isolating that.
//
// `source` records what initiated the command (see commandLog.js). `meta` adds
// context to the audit record (e.g. scheduleId/stepId for a scheduled fire).
export async function applyDeviceConfig(entry, clean, source = 'manual', meta = {}) {
  const src = normalizeSource(source);
  // Initiation time — captured up front so it's the moment the command was
  // issued, not when the unit answered.
  const at = new Date().toISOString();

  // Record the last command as soon as it's initiated so the UI reflects the
  // attempt even if the unit turns out to be unreachable.
  upsert(entry.id, { lastCommand: { source: src, at } });

  let unitRes;
  try {
    unitRes = await deviceClient.postConfig(entry, clean); // throws device_* on failure
  } catch (err) {
    recordCommand({ at, deviceId: entry.id, source: src, config: clean, ok: false, error: err.message, ...meta });
    persist(); // still persist the lastCommand update
    throw err;
  }

  // Persist desired state as the new intent, keyed to the configId the unit assigned.
  upsert(entry.id, {
    desiredConfig: clean,
    desiredConfigId: typeof unitRes.configId === 'number' ? unitRes.configId : entry.desiredConfigId,
    unitConfigId: typeof unitRes.configId === 'number' ? unitRes.configId : entry.unitConfigId,
    applied: true,
  });
  touch(entry.id);
  recordCommand({ at, deviceId: entry.id, source: src, config: clean, ok: true, configId: unitRes.configId ?? null, ...meta });
  persist();
  log.info('config_pushed', { id: entry.id, configId: unitRes.configId, source: src });

  return unitRes;
}
