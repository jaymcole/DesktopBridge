import { config } from './config.js';
import { log } from './logger.js';
import { load } from './store.js';
import { load as loadSchedules } from './scheduleStore.js';
import { buildApp } from './server.js';
import { startDiscovery, stopDiscovery } from './discovery.js';
import { startReconcile, stopReconcile } from './reconcile.js';
import { startScheduler, stopScheduler } from './scheduler.js';

// Load persisted intent + last-known facts. Units start marked offline until
// the reconciliation loop actually reaches them — we do NOT push on startup
// beyond the normal loop.
load();
// Load persisted schedules; triggers are armed once below (future occurrences
// only — a fire whose time already passed while the bridge was down is skipped).
loadSchedules();

const app = buildApp();
const server = app.listen(config.port, () => {
  log.info('bridge_listening', {
    port: config.port,
    uiOrigin: config.uiOrigin,
    version: config.version,
  });
});

startDiscovery();
startReconcile();
startScheduler();

function shutdown(signal) {
  log.info('shutdown', { signal });
  stopScheduler();
  stopReconcile();
  stopDiscovery();
  server.close(() => process.exit(0));
  // Force-exit if connections linger.
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log.error('uncaught_exception', { message: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandled_rejection', { reason: String(reason) });
});
