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
  staleAfterMs: int('STALE_AFTER_MS', 15 * 60_000),
  uiOrigin: process.env.UI_ORIGIN || 'http://localhost:5173',
  // Where the registry + desired configs are persisted.
  dataFile: path.join(__dirname, '..', 'data', 'state.json'),
  // Timeout for any HTTP call the bridge makes to a unit.
  deviceTimeoutMs: int('DEVICE_TIMEOUT_MS', 5_000),
  version: '1.0.0',
  service: 'ac-bridge',
};
