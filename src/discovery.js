import { Bonjour } from 'bonjour-service';
import { touch, upsert, getEntry, persist, identityConflict, normalizeMac } from './store.js';
import { log } from './logger.js';

// mDNS discovery for service type _acctrl._tcp. Each advertised service carries
// TXT records id/loc/fw/mac plus host/ip/port. We merge these into the registry
// keyed by device id, following a unit for the whole life of the process:
// first sighting, later changes to what it advertises, and down.

let bonjour = null;
let browser = null;

function pickIp(service) {
  // Prefer an IPv4 address from the announced records.
  const v4 = (service.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  return v4 || service.referer?.address || null;
}

// Merge one advertisement into the registry. Every browser event carrying a
// current view of a service routes through here, not just first sighting.
function onAdvertisement(service, event) {
  const txt = service.txt || {};
  const id = txt.id;
  if (!id) {
    log.warn('mdns_service_missing_id', { name: service.name, host: service.host, event });
    return;
  }
  const ip = pickIp(service);
  // Same identity guard as POST /register: an advertisement that would move a
  // known id onto a different ip while the incumbent is still online is two
  // units claiming one id (a unit flashed before its id was updated), not a
  // move. Ignore the advertisement rather than repointing the entry at the
  // wrong hardware — guarding only /register would leave mDNS as a way around
  // it, since a misflashed unit advertises under the borrowed id too.
  const mac = normalizeMac(txt.mac);
  const conflict = identityConflict(id, ip, mac);
  if (conflict) {
    log.warn('mdns_id_conflict', { id, claimingIp: ip, claimingMac: mac, ...conflict });
    return;
  }
  touch(id, {
    location: txt.loc ?? undefined,
    firmware: txt.fw ?? undefined,
    ip: ip ?? undefined,
    mac: mac ?? undefined,
    port: service.port ?? undefined,
  });
  log.info(event === 'up' ? 'mdns_up' : 'mdns_service_updated',
           { id, ip, port: service.port, location: txt.loc, firmware: txt.fw, event });
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

/**
 * Start browsing for units. Tests inject a stand-in browser (any emitter
 * speaking the same events) so the wiring itself is covered — which events we
 * subscribe to is precisely where a reflashed unit's new identity went missing.
 */
export function startDiscovery({ browser: injected = null } = {}) {
  if (injected) {
    browser = injected;
  } else {
    bonjour = new Bonjour();
    browser = bonjour.find({ type: 'acctrl' });
  }
  browser.on('up', (service) => onAdvertisement(service, 'up'));
  // bonjour-service caches discovered services by instance fqdn and emits 'up'
  // only the FIRST time it sees one; a re-announcement under a known fqdn comes
  // back as txt-update (TXT changed) or srv-update (host/port changed) instead.
  // Our instance names are stable across a reflash by design — a unit keeps
  // advertising ac-<location>.local while its id/mac/fw TXT records change — so
  // listening for 'up' alone pinned the registry to whatever a unit advertised
  // the first time THIS PROCESS saw it. Nothing shook it loose either: the
  // browser's cache has no expiry timer and it re-queries only at startup, so a
  // reflashed unit's new id and firmware stayed invisible until the bridge was
  // restarted — which is exactly how a unit moved onto its chip-derived id went
  // unnoticed for a day.
  browser.on('txt-update', (service) => onAdvertisement(service, 'txt-update'));
  browser.on('srv-update', (service) => onAdvertisement(service, 'srv-update'));
  browser.on('down', onDown);
  log.info('mdns_browsing', { type: '_acctrl._tcp' });
}

export function stopDiscovery() {
  try {
    browser?.stop?.();
    bonjour?.destroy();
  } catch (err) {
    log.warn('mdns_stop_failed', { error: err.message });
  }
}
