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
  // Backstop first, so that whatever else throws below, this process still exits. It used to be
  // scheduled last, which meant an error during teardown could leave the bridge running forever.
  setTimeout(() => process.exit(0), 3_000).unref();

  stopScheduler();
  stopReconcile();
  stopDiscovery();

  server.close(() => process.exit(0));
  // close() drops idle keep-alive sockets by itself, but it *waits* for any request still in
  // flight — and with the UI polling through the HouseGraph proxy there often is one. When that
  // happened the callback above never ran, the backstop took the full 3s, and the port stayed
  // bound that whole time; whatever HouseGraph started next hit EADDRINUSE and died. Measured:
  // in-flight + plain close() never completes, the same case with this line completes in ~1ms.
  //
  // It aborts those requests, which is the right trade at shutdown — the backstop was killing
  // them anyway 3s later, just with a hung client instead of a closed socket.
  // Needs Node >= 18.2 (see engines in package.json).
  server.closeAllConnections();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log.error('uncaught_exception', { message: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandled_rejection', { reason: String(reason) });
});
