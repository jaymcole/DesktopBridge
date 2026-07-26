import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { log } from './logger.js';
import { ApiError, errorBody } from './errors.js';
import { validateConfig } from './schema.js';
import {
  getEntry, allEntries, toDevice, computeStatus, touch, upsert, persist,
} from './store.js';
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
        'POST /devices/:id/config': 'set desired config (validated, proxied to unit)',
        'POST /devices/:id/identify': "blink the unit's LED",
        'POST /devices/:id/resend': "re-transmit the unit's last config",
        'POST /register': 'unit self-registration (requires bearer token)',
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

  // ---- UI: set desired config (validate on bridge, then proxy to unit) -----
  app.post('/devices/:id/config', wrap(async (req, res) => {
    const entry = requireDevice(req);
    const clean = validateConfig(req.body); // throws validation_error (400)

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
