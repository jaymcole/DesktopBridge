import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

// Append-only audit log of commands pushed to units, one JSON object per line
// (JSON-lines). Append (not the atomic full-file rewrite the registry uses) so
// the log can grow without re-serializing history on every write. Not exposed
// over the API yet — this just durably records commands for later review; the
// per-device "last command" surfaced in the Device object is set separately.
//
// A command source is what initiated the push:
//   'manual'            — a UI control on the Controllers page
//   'manual_immediate'  — a schedule step's "send now" button
//   'scheduled'         — the scheduler firing a step at its time
export const COMMAND_SOURCES = new Set(['manual', 'manual_immediate', 'scheduled']);

/** Coerce an untrusted source label to a known one, defaulting to 'manual'. */
export function normalizeSource(source) {
  return COMMAND_SOURCES.has(source) ? source : 'manual';
}

/**
 * Append one command record. Best-effort: a logging failure must never break a
 * real command, so errors are logged and swallowed. `entry` carries at least
 * { at, deviceId, source, config, ok }; scheduled fires may also add
 * scheduleId/stepId, and the assigned configId / error where relevant.
 */
export function recordCommand(entry) {
  try {
    fs.mkdirSync(path.dirname(config.commandLogFile), { recursive: true });
    fs.appendFileSync(config.commandLogFile, JSON.stringify(entry) + '\n');
  } catch (err) {
    log.error('command_log_failed', { error: err.message });
  }
}
