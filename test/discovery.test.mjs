// Regression tests for what the bridge learns from mDNS after first sighting.
//
// The scenario these exist for: a unit is reflashed — new firmware, and with
// the move to chip-derived ids a new device id — but its mDNS instance name is
// deliberately unchanged (ac-<location>.local stays human-readable). bonjour-
// service caches services by that instance name and emits 'up' only once, so
// everything the unit later changes about itself arrives as txt-update /
// srv-update. Subscribing to 'up' alone left the registry frozen on whatever a
// unit advertised the first time the process saw it, with no expiry timer and
// no re-query to shake it loose: the bridge reported a stale firmware version
// and never saw the new id until it was restarted.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TOKEN = 'test-token';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-bridge-test-'));

const store = await import('../src/store.js');
const { startDiscovery, stopDiscovery } = await import('../src/discovery.js');

const browser = new EventEmitter();
before(() => startDiscovery({ browser }));
after(() => stopDiscovery());

/** One unit's advertisement. The instance name stays put across a reflash. */
const advert = (name, ip, txt, port = 80) => ({
  name, host: `${name}.local`, port, addresses: [ip], txt,
});

describe('re-announcements from an already-known instance', () => {
  test('a firmware bump on a known instance is picked up', () => {
    browser.emit('up', advert('ac-fw', '10.9.0.1', { id: 'ac-fw', loc: 'fw', fw: '1.1.1' }));
    assert.equal(store.getEntry('ac-fw').firmware, '1.1.1');

    browser.emit('txt-update', advert('ac-fw', '10.9.0.1', { id: 'ac-fw', loc: 'fw', fw: '1.3.1' }));
    assert.equal(store.getEntry('ac-fw').firmware, '1.3.1',
                 'a reflash must not need a bridge restart to be visible');
  });

  test('a unit that comes back under a chip-derived id is recorded, not ignored', () => {
    browser.emit('up', advert('ac-bed', '10.9.0.2', { id: 'ac-bed', loc: 'bed', fw: '1.1.1' }));

    browser.emit('txt-update', advert('ac-bed', '10.9.0.2',
      { id: 'ac-a0f262fffe86', loc: 'bed', fw: '1.3.1', mac: 'a0:f2:62:ff:fe:86' }));

    const moved = store.getEntry('ac-a0f262fffe86');
    assert.ok(moved, 'the new id reaches the registry');
    assert.equal(moved.mac, 'a0f262fffe86', 'and carries the chip MAC that identifies it');
    assert.equal(moved.firmware, '1.3.1');

    // The predecessor is kept, not deleted: it still holds the user's config
    // and schedule membership, waiting to be adopted by /register or rekey.
    const old = store.getEntry('ac-bed');
    assert.ok(old, 'the entry under the old id survives for the migration to adopt');
    assert.equal(old.ip, null, 'but stops being polled at an ip that is not it');
  });

  test('a unit that changed port is followed', () => {
    browser.emit('up', advert('ac-port', '10.9.0.3', { id: 'ac-port', loc: 'port', fw: '1.1.1' }));
    browser.emit('srv-update',
      advert('ac-port', '10.9.0.3', { id: 'ac-port', loc: 'port', fw: '1.1.1' }, 8080));
    assert.equal(store.getEntry('ac-port').port, 8080);
  });

  test('the identity guard still applies to updates, not just first sighting', () => {
    browser.emit('up', advert('ac-guard', '10.9.0.4',
      { id: 'ac-guard', loc: 'guard', fw: '1.1.1', mac: '11:11:11:11:11:11' }));
    // A different chip claiming a live id — a unit flashed before its id was
    // updated. It advertises under the borrowed id too, so the update path has
    // to refuse it exactly like the 'up' path does.
    browser.emit('txt-update', advert('ac-guard', '10.9.0.5',
      { id: 'ac-guard', loc: 'guard', fw: '1.1.1', mac: '22:22:22:22:22:22' }));
    const entry = store.getEntry('ac-guard');
    assert.equal(entry.mac, '111111111111', 'the incumbent chip keeps the id');
    assert.equal(entry.ip, '10.9.0.4');
  });
});
