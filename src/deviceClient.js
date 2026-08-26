import { config } from './config.js';
import { ApiError } from './errors.js';

// Thin authenticated client for a single ESP32 unit's HTTP+JSON API.
// Translates transport failures into ApiError('device_unreachable') and
// unit-reported errors into ApiError('device_error') so the routes can map
// them straight onto the bridge's error contract.

function baseUrl(entry) {
  if (!entry.ip) {
    throw new ApiError('device_unreachable', `no ip known for ${entry.id}`);
  }
  const port = entry.port || 80;
  return `http://${entry.ip}:${port}`;
}

// `timeoutMs` defaults to the short poll budget; calls that make the unit act
// (transmit IR, blink the LED) pass the longer command budget explicitly.
async function call(entry, method, pathname, { body, auth = true, timeoutMs = config.deviceTimeoutMs } = {}) {
  const url = baseUrl(entry) + pathname;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        ...(auth ? { Authorization: `Bearer ${config.token}` } : {}),
        // Advertise our listening port so a unit can learn where to push
        // (POST /observed, /register) without a hardcoded bridge address — it
        // pairs this with the source IP of this (authenticated) request. Sent on
        // every call; units only trust it on requests that pass auth.
        'X-Bridge-Port': String(config.port),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Name the budget that was exceeded — a timeout on a command call means
    // something quite different from one on a poll, and the logs should say so.
    const reason = err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err.message;
    throw new ApiError('device_unreachable', `unit ${entry.id} unreachable: ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // Non-JSON body from the unit — treat as an opaque error.
      if (!res.ok) {
        throw new ApiError('device_error', `unit ${entry.id} returned ${res.status}`, text.slice(0, 500));
      }
    }
  }

  if (res.status === 401) {
    // The bridge's own token was rejected by the unit — a config problem, not a UI auth issue.
    // TEMP DEBUG: prints the token being sent (JSON-stringified so hidden whitespace/CRLF is visible). Remove once the mismatch is resolved.
    console.error(`[deviceClient] token rejected by ${entry.id}; bridge sent TOKEN=${JSON.stringify(config.token)}`);
    throw new ApiError('device_error', `unit ${entry.id} rejected bridge token (401)`, data?.error ?? null);
  }
  if (!res.ok || (data && data.ok === false)) {
    const unitMsg = (data && data.error) || `unit ${entry.id} returned ${res.status}`;
    throw new ApiError('device_error', `unit ${entry.id} rejected request`, unitMsg);
  }

  return data ?? {};
}

export const deviceClient = {
  // GET /health (no auth) → { ok, id, location, firmware, schema, ip, rssi, uptimeSec, configId, applied }
  health: (entry) => call(entry, 'GET', '/health', { auth: false }),
  // GET /config (auth) → { ok, configId, applied, config }
  getConfig: (entry) => call(entry, 'GET', '/config'),
  // POST /config (auth) → { ok, configId, verified, attempts } — transmits IR.
  postConfig: (entry, cfg) =>
    call(entry, 'POST', '/config', { body: cfg, timeoutMs: config.deviceCommandTimeoutMs }),
  // POST /identify (auth) → { ok } — blinks the unit's LED for ~3s before answering.
  identify: (entry) =>
    call(entry, 'POST', '/identify', { body: {}, timeoutMs: config.deviceCommandTimeoutMs }),
  // POST /resend (auth) → { ok, configId, verified, attempts } — transmits IR.
  resend: (entry) =>
    call(entry, 'POST', '/resend', { body: {}, timeoutMs: config.deviceCommandTimeoutMs }),
};
