import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { log } from './logger.js';
import { ApiError, errorBody } from './errors.js';
import { validateConfig } from './schema.js';
import { validateSchedule } from './scheduleSchema.js';
import {
  getEntry, allEntries, toDevice, computeStatus, touch, upsert, persist,
  removeEntry, pruneDuplicateIps,
} from './store.js';
import {
  getSchedule, allSchedules, putSchedule, removeSchedule,
} from './scheduleStore.js';
import { armSchedule, disarmSchedule, schedulerStatus } from './scheduler.js';
import { applyDeviceConfig } from './control.js';
import { deviceClient } from './deviceClient.js';

const startedAt = new Date();

// Wrap async route handlers so thrown errors reach the error middleware.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Require the shared bearer token (used only by units calling /register).
function requireToken(req, res, next) {
  const header = req.get('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m || m[1] !== config.token) {
    throw new ApiError('unauthorized', 'missing or invalid bearer token');
  }
  next();
}

// Resolve :id into a registry entry or throw device_not_found.
function requireDevice(req) {
  const entry = getEntry(req.params.id);
  if (!entry) {
    throw new ApiError('device_not_found', `no device with id "${req.params.id}"`);
  }
  return entry;
}

export function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(cors({ origin: config.uiOrigin === '*' ? true : config.uiOrigin }));

  // Structured request logging.
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      log.info('request', {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Math.round(ms * 10) / 10,
      });
    });
    next();
  });

  // ---- landing: friendly response when the base URL is opened in a browser -
  app.get('/', (req, res) => {
    res.json({
      ok: true,
      service: config.service,
      version: config.version,
      endpoints: {
        'GET /health': "bridge liveness",
        'GET /devices': 'all devices',
        'GET /devices/:id': 'one device',
        'DELETE /devices/:id': 'remove a stale/duplicate device entry',
        'POST /devices/dedupe': 'remove duplicate entries sharing an ip, keeping the most recently seen',
        'POST /devices/:id/config': 'set desired config (validated, proxied to unit)',
        'POST /devices/:id/identify': "blink the unit's LED",
        'POST /devices/:id/resend': "re-transmit the unit's last config",
        'GET /schedules': 'all automated control schedules',
        'GET /schedules/:id': 'one schedule',
        'PUT /schedules/:id': 'upsert a schedule (validated, triggers re-armed)',
        'DELETE /schedules/:id': 'delete a schedule and cancel its triggers',
        'POST /register': 'unit self-registration (requires bearer token)',
        'POST /observed': "unit-pushed state observed from its physical remote (requires bearer token)",
      },
    });
  });

  // ---- bridge liveness -----------------------------------------------------
  app.get('/health', (req, res) => {
    const now = Date.now();
    const devices = allEntries();
    const onlineCount = devices.filter((e) => computeStatus(e, now) === 'online').length;
    res.json({
      ok: true,
      service: config.service,
      version: config.version,
      uptimeSec: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      deviceCount: devices.length,
      onlineCount,
      startedAt: startedAt.toISOString(),
      // Automated schedules: per-schedule next-run + last-run for observability.
      schedules: schedulerStatus(),
    });
  });

  // ---- unit self-registration (units authenticate with the shared token) ---
  app.post('/register', requireToken, wrap(async (req, res) => {
    const { id, location, ip, firmware, schema, configId, port } = req.body || {};
    if (!id || typeof id !== 'string') {
      throw new ApiError('validation_error', 'register requires a string "id"', { field: 'id' });
    }
    touch(id, {
      location: location ?? undefined,
      ip: ip ?? undefined,
      firmware: firmware ?? undefined,
      schema: schema ?? undefined,
      // Optional: lets a unit that only self-registers (no mDNS) advertise a non-80 port.
      port: typeof port === 'number' ? port : undefined,
      unitConfigId: typeof configId === 'number' ? configId : undefined,
    });
    persist();
    log.info('register', { id, ip, location, configId });
    res.json({ ok: true });
  }));

  // ---- unit-pushed observed state (from its physical remote) ---------------
  // The unit watches the AC's original remote and pushes the decoded state here
  // the instant a button is pressed, so the UI reflects it within a round-trip
  // instead of waiting for the next reconcile poll. Deliberately NOT run through
  // validateConfig: this is the unit's *reported* truth, and a physical remote
  // can set firmware-only values (e.g. fan 'silent', mode 'fan') that the command
  // validator rejects. It lands in reportedConfig exactly like a GET /config poll
  // would, so the reconcile loop remains the backstop if a push is ever lost.
  app.post('/observed', requireToken, wrap(async (req, res) => {
    const { id, config, configId } = req.body || {};
    if (!id || typeof id !== 'string') {
      throw new ApiError('validation_error', 'observed requires a string "id"', { field: 'id' });
    }
    if (config !== undefined && config !== null
        && (typeof config !== 'object' || Array.isArray(config))) {
      throw new ApiError('validation_error', 'observed "config" must be an object', { field: 'config' });
    }
    touch(id, {
      reportedConfig: config !== undefined ? config : undefined,
      unitConfigId: typeof configId === 'number' ? configId : undefined,
      applied: true,
    });
    persist();
    log.info('observed', { id, configId });
    res.json({ ok: true });
  }));

  // ---- UI: list devices ----------------------------------------------------
  app.get('/devices', (req, res) => {
    const now = Date.now();
    const devices = allEntries().map((e) => toDevice(e, now));
    res.json({ devices, count: devices.length });
  });

  // ---- UI: one device ------------------------------------------------------
  app.get('/devices/:id', (req, res) => {
    const entry = requireDevice(req);
    res.json(toDevice(entry));
  });

  // ---- UI: remove a stale/duplicate device entry ---------------------------
  // Idempotent — removing an unknown id is not an error (nothing to remove).
  app.delete('/devices/:id', (req, res) => {
    const removed = removeEntry(req.params.id);
    if (removed) persist();
    log.info('device_removed', { id: req.params.id, removed });
    res.json({ ok: true, removed });
  });

  // ---- UI: remove duplicate entries sharing an ip --------------------------
  // A unit is stationary at one ip, so entries sharing an ip are always the
  // same physical unit left registered under more than one id (e.g. after a
  // rename/reflash). Keeps whichever entry per ip was seen most recently.
  app.post('/devices/dedupe', (req, res) => {
    const removed = pruneDuplicateIps();
    if (removed.length > 0) persist();
    log.info('devices_deduped', { removed });
    res.json({ ok: true, removed });
  });

  // ---- UI: set desired config (validate on bridge, then proxy to unit) -----
  app.post('/devices/:id/config', wrap(async (req, res) => {
    const entry = requireDevice(req);
    const clean = validateConfig(req.body); // throws validation_error (400)
    // Optional ?source= tags what initiated the command in the audit log
    // (e.g. "manual" vs "manual_immediate"); unknown/absent → "manual".
    await applyDeviceConfig(entry, clean, req.query.source); // proxy to unit + persist; throws device_* on failure
    res.json({ ok: true, device: toDevice(entry) });
  }));

  // ---- UI: identify --------------------------------------------------------
  app.post('/devices/:id/identify', wrap(async (req, res) => {
    const entry = requireDevice(req);
    await deviceClient.identify(entry);
    touch(entry.id);
    res.json({ ok: true });
  }));

  // ---- UI: resend ----------------------------------------------------------
  app.post('/devices/:id/resend', wrap(async (req, res) => {
    const entry = requireDevice(req);
    const unitRes = await deviceClient.resend(entry);
    upsert(entry.id, {
      unitConfigId: typeof unitRes.configId === 'number' ? unitRes.configId : entry.unitConfigId,
      applied: true,
    });
    touch(entry.id);
    persist();
    res.json({ ok: true, configId: unitRes.configId });
  }));

  // ---- UI: list schedules --------------------------------------------------
  app.get('/schedules', (req, res) => {
    const schedules = allSchedules();
    res.json({ schedules, count: schedules.length });
  });

  // ---- UI: one schedule ----------------------------------------------------
  app.get('/schedules/:id', (req, res) => {
    const schedule = getSchedule(req.params.id);
    if (!schedule) {
      throw new ApiError('schedule_not_found', `no schedule with id "${req.params.id}"`);
    }
    res.json({ schedule });
  });

  // ---- UI: upsert a schedule (validate, persist, re-arm triggers) ----------
  app.put('/schedules/:id', wrap(async (req, res) => {
    const clean = validateSchedule(req.body, req.params.id); // throws 400 on bad input; enforces :id === body.id

    // Referencing an unknown device does NOT fail the save — devices can be
    // offline now and rediscovered later; the schedule just skips them per fire.
    const unknownDevices = clean.deviceIds.filter((d) => !getEntry(d));
    if (unknownDevices.length > 0) {
      log.warn('schedule_unknown_devices', { id: clean.id, unknownDevices });
    }

    putSchedule(clean);
    armSchedule(clean); // cancel + rebuild triggers so the change takes effect now
    log.info('schedule_saved', { id: clean.id, name: clean.name, steps: clean.steps.length });
    res.json({ schedule: clean });
  }));

  // ---- UI: create a schedule (optional alias of PUT; upsert by body.id) -----
  app.post('/schedules', wrap(async (req, res) => {
    const clean = validateSchedule(req.body); // id comes from the body
    const unknownDevices = clean.deviceIds.filter((d) => !getEntry(d));
    if (unknownDevices.length > 0) {
      log.warn('schedule_unknown_devices', { id: clean.id, unknownDevices });
    }
    putSchedule(clean);
    armSchedule(clean);
    log.info('schedule_saved', { id: clean.id, name: clean.name, steps: clean.steps.length });
    res.json({ schedule: clean });
  }));

  // ---- UI: delete a schedule (idempotent; cancels its triggers) ------------
  app.delete('/schedules/:id', (req, res) => {
    disarmSchedule(req.params.id);
    removeSchedule(req.params.id); // deleting a missing id is not an error
    log.info('schedule_deleted', { id: req.params.id });
    res.json({ ok: true });
  });

  // ---- 404 for unknown routes ----------------------------------------------
  app.use((req, res) => {
    res.status(404).json(errorBody('device_not_found', `no route ${req.method} ${req.path}`));
  });

  // ---- uniform error handler ----------------------------------------------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      if (err.status >= 500) log.error('api_error', { code: err.code, message: err.message });
      else log.warn('api_error', { code: err.code, message: err.message });
      return res.status(err.status).json(errorBody(err.code, err.message, err.details));
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json(errorBody('validation_error', 'invalid JSON body'));
    }
    log.error('internal_error', { message: err?.message, stack: err?.stack });
    res.status(500).json(errorBody('internal_error', 'internal server error'));
  });

  return app;
}
