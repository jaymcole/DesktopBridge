import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Env ${name} must be an integer, got "${raw}"`);
  }
  return n;
}

/**
 * Parse UI_ORIGIN into a value the `cors` middleware understands. Accepts a
 * single origin, a comma-separated list (the app is reachable under several
 * origins — e.g. http://localhost:5173 in dev and http://accontroller.local:8080
 * when served on the LAN), or "*" to allow any.
 */
function parseOrigins(raw) {
  if (!raw || raw.trim() === '') return ['http://localhost:5173'];
  if (raw.trim() === '*') return '*';
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : ['http://localhost:5173'];
}

// Directory holding the persisted registry, schedules and command log.
// Overridable so a second instance (or a test run) can keep its own state
// instead of writing over the deployment's.
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  // Fail fast: without a token the bridge cannot auth to units or protect /register.
  console.error('FATAL: TOKEN is required. Copy .env.example to .env and set it.');
  process.exit(1);
}

export const config = {
  token: TOKEN,
  port: int('PORT', 8080),
  pollIntervalMs: int('POLL_INTERVAL_MS', 60_000),
  // A unit not heard from for this long is marked offline. Kept just above one
  // poll interval so a single missed check-in is tolerated, but a second miss
  // flips it offline promptly. MUST exceed POLL_INTERVAL_MS.
  offlineAfterMs: int('OFFLINE_AFTER_MS', 150_000),
  uiOrigin: parseOrigins(process.env.UI_ORIGIN),
  // Where the registry + desired configs are persisted.
  dataFile: path.join(dataDir, 'state.json'),
  // Where automated control schedules are persisted (separate from device state
  // so a schedule save never rewrites the volatile device registry).
  schedulesFile: path.join(dataDir, 'schedules.json'),
  // Append-only audit log of every command pushed to a unit (JSON-lines), for
  // later review. Not exposed via the API yet; the per-device "last command" is.
  commandLogFile: path.join(dataDir, 'commands.jsonl'),
  // Timeout for the bridge's read-only polls of a unit (GET /health, GET
  // /config). Kept short so a stalled poll fails fast instead of blocking a
  // reconcile tick; on a healthy LAN a unit answers these in well under 200ms.
  deviceTimeoutMs: int('DEVICE_TIMEOUT_MS', 5_000),
  // Timeout for calls that make a unit DO something, which are legitimately slow
  // and must not inherit the poll budget. POST /config and POST /resend transmit
  // an IR burst and then verify it by reading their own emission back, which can
  // reach ~2.4s when a command needs its full retry allowance; POST /identify
  // blinks the status LED for ~3s before it answers. Cutting one of these off
  // mid-transmission is worse than waiting: the unit still applies the command,
  // but the bridge records the push as failed and leaves desiredConfigId stale,
  // so the UI shows drift on a command that actually worked.
  deviceCommandTimeoutMs: int('DEVICE_COMMAND_TIMEOUT_MS', 8_000),
  version: '1.0.0',
  service: 'ac-bridge',
};
