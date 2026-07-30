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
  dataFile: path.join(__dirname, '..', 'data', 'state.json'),
  // Timeout for any HTTP call the bridge makes to a unit.
  deviceTimeoutMs: int('DEVICE_TIMEOUT_MS', 5_000),
  version: '1.0.0',
  service: 'ac-bridge',
};
