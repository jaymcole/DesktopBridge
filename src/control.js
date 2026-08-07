import { upsert, touch, persist } from './store.js';
import { deviceClient } from './deviceClient.js';
import { log } from './logger.js';

// The single internal "push a config to a unit" path, shared by the HTTP route
// (POST /devices/:id/config) and the schedule execution engine so both take the
// identical route: proxy to the unit, adopt the configId it assigns as the new
// desired/unit state, refresh liveness, and persist. `clean` MUST already be a
// schema-v1-validated config (validateConfig). Throws ApiError('device_*') on a
// unit failure; the caller is responsible for handling/isolating that.
export async function applyDeviceConfig(entry, clean) {
  const unitRes = await deviceClient.postConfig(entry, clean); // throws device_* on failure

  // Persist desired state as the new intent, keyed to the configId the unit assigned.
  upsert(entry.id, {
    desiredConfig: clean,
    desiredConfigId: typeof unitRes.configId === 'number' ? unitRes.configId : entry.desiredConfigId,
    unitConfigId: typeof unitRes.configId === 'number' ? unitRes.configId : entry.unitConfigId,
    applied: true,
  });
  touch(entry.id);
  persist();
  log.info('config_pushed', { id: entry.id, configId: unitRes.configId });

  return unitRes;
}
