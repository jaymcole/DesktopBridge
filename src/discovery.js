import { Bonjour } from 'bonjour-service';
import { touch, upsert, getEntry, persist, identityConflict } from './store.js';
import { log } from './logger.js';

// mDNS discovery for service type _acctrl._tcp. Each advertised service carries
// TXT records id/loc/fw plus host/ip/port. We merge these into the registry
// keyed by device id and handle up/down events.

let bonjour = null;
let browser = null;

function pickIp(service) {
  // Prefer an IPv4 address from the announced records.
  const v4 = (service.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  return v4 || service.referer?.address || null;
}

function onUp(service) {
  const txt = service.txt || {};
  const id = txt.id;
  if (!id) {
    log.warn('mdns_service_missing_id', { name: service.name, host: service.host });
    return;
  }
  const ip = pickIp(service);
  // Same identity guard as POST /register: an advertisement that would move a
  // known id onto a different ip while the incumbent is still online is two
  // units claiming one id (a unit flashed before its id was updated), not a
  // move. Ignore the advertisement rather than repointing the entry at the
  // wrong hardware — guarding only /register would leave mDNS as a way around
  // it, since a misflashed unit advertises under the borrowed id too.
  const heldByIp = identityConflict(id, ip);
  if (heldByIp) {
    log.warn('mdns_id_conflict', { id, claimingIp: ip, heldByIp });
    return;
  }
  touch(id, {
    location: txt.loc ?? undefined,
    firmware: txt.fw ?? undefined,
    ip: ip ?? undefined,
    port: service.port ?? undefined,
  });
  log.info('mdns_up', { id, ip, port: service.port, location: txt.loc });
  persist();
}

function onDown(service) {
  const id = service.txt?.id;
  if (!id) return;
  const entry = getEntry(id);
  if (!entry) return;
  // Don't delete — mark down so the UI still shows a known-but-offline unit.
  upsert(id, { down: true });
  log.info('mdns_down', { id });
  persist();
}

export function startDiscovery() {
  bonjour = new Bonjour();
  browser = bonjour.find({ type: 'acctrl' });
  browser.on('up', onUp);
  browser.on('down', onDown);
  log.info('mdns_browsing', { type: '_acctrl._tcp' });
}

export function stopDiscovery() {
  try {
    browser?.stop();
    bonjour?.destroy();
  } catch (err) {
    log.warn('mdns_stop_failed', { error: err.message });
  }
}
