// Tests for chip-MAC identity and the id migration that comes with it.
//
// Devices are moving from a hardcoded id (typed in before flashing, and so
// forgettable — see deviceIdentity.test.mjs) to an id derived from the chip's
// factory-burned MAC. The migration must not look like "old device vanished,
// new device appeared": that would strand each device's config and its place in
// every schedule on an id nothing answers to.

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TOKEN = 'test-token';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-bridge-mac-'));
process.env.OFFLINE_AFTER_MS = '30000';

const store = await import('../src/store.js');
const scheduleStore = await import('../src/scheduleStore.js');
const { buildApp } = await import('../src/server.js');

let baseUrl;
before(async () => {
  const server = buildApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  server.unref();
});

const post = (url, body) =>
  fetch(baseUrl + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
  });
const register = (body) => post('/register', body);

const scheduleWith = (id, deviceIds) => ({
  id, name: 'Morning', enabled: true, deviceIds,
  steps: [{ id: 'step-1', time: '07:00', config: { schema: 1, power: 'on', mode: 'heat', temp: 22 } }],
});

describe('MAC normalization', () => {
  test('accepts the usual spellings so one chip is never two identities', () => {
    assert.equal(store.normalizeMac('84:FC:E6:12:34:56'), '84fce6123456');
    assert.equal(store.normalizeMac('84-fc-e6-12-34-56'), '84fce6123456');
    assert.equal(store.normalizeMac('84fce6123456'), '84fce6123456');
  });

  test('rejects anything that is not a 12-digit MAC', () => {
    for (const bad of ['', 'not-a-mac', '84fce612345', '84fce61234567', null, 42]) {
      assert.equal(store.normalizeMac(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test('a malformed mac is rejected at the door rather than stored', async () => {
    const res = await register({ id: 'ac-bad-mac', ip: '10.1.9.9', mac: 'nope' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.details.field, 'mac');
  });
});

describe('MAC is authoritative over ip', () => {
  test('the same chip moving to a new ip is a move, not a conflict', async () => {
    await register({ id: 'ac-move', ip: '10.1.0.1', mac: 'aa:bb:cc:00:00:01' });

    // Still online at the old ip — the ip heuristic alone would call this a
    // collision. The matching MAC proves it is the same unit.
    const res = await register({ id: 'ac-move', ip: '10.1.0.2', mac: 'aa:bb:cc:00:00:01' });

    assert.equal(res.status, 200);
    assert.equal(store.getEntry('ac-move').ip, '10.1.0.2');
  });

  test('a different chip claiming a held id is refused even from the same ip', async () => {
    await register({ id: 'ac-held', ip: '10.1.0.3', mac: 'aa:bb:cc:00:00:02' });

    const res = await register({ id: 'ac-held', ip: '10.1.0.3', mac: 'aa:bb:cc:00:00:99' });

    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.details.reason, 'mac_mismatch');
    assert.equal(store.getEntry('ac-held').mac, 'aabbcc000002', 'the incumbent chip keeps the id');
  });
});

describe('migration to a chip-derived id', () => {
  test('legacyId carries config and schedule membership onto the new id', async () => {
    scheduleStore.putSchedule(scheduleWith('sched-mig', ['ac-basement', 'ac-attic']));
    await register({ id: 'ac-basement', ip: '10.1.1.1', location: 'basement' });
    store.upsert('ac-basement', {
      desiredConfig: { schema: 1, power: 'on', mode: 'heat', temp: 22 }, outdoorUnit: 'north',
    });

    // Reflashed: same unit, id now derived from its chip, reporting where it came from.
    const res = await register({
      id: 'ac-84fce6123456', ip: '10.1.1.1', location: 'basement',
      mac: '84:FC:E6:12:34:56', legacyId: 'ac-basement',
    });

    assert.equal(res.status, 200);
    assert.equal((await res.json()).migratedFrom, 'ac-basement');
    assert.equal(store.getEntry('ac-basement'), null, 'the old id is gone, not left as a ghost');

    const moved = store.getEntry('ac-84fce6123456');
    assert.deepEqual(moved.desiredConfig, { schema: 1, power: 'on', mode: 'heat', temp: 22 });
    assert.equal(moved.outdoorUnit, 'north');
    assert.equal(moved.mac, '84fce6123456');
    assert.equal(moved.location, 'basement', 'the hardcoded location survives as the label');
    assert.deepEqual(
      scheduleStore.getSchedule('sched-mig').deviceIds,
      ['ac-84fce6123456', 'ac-attic'],
      'the schedule follows the device to its new id, in place',
    );
  });

  test('a known MAC alone migrates a device, with no legacyId needed', async () => {
    scheduleStore.putSchedule(scheduleWith('sched-mac', ['ac-old-name']));
    await register({ id: 'ac-old-name', ip: '10.1.2.1', mac: 'de:ad:be:ef:00:01' });
    store.upsert('ac-old-name', { outdoorUnit: 'south' });

    const res = await register({ id: 'ac-deadbeef0001', ip: '10.1.2.1', mac: 'de:ad:be:ef:00:01' });

    assert.equal(res.status, 200);
    assert.equal((await res.json()).migratedFrom, 'ac-old-name');
    assert.equal(store.getEntry('ac-deadbeef0001').outdoorUnit, 'south');
    assert.deepEqual(scheduleStore.getSchedule('sched-mac').deviceIds, ['ac-deadbeef0001']);
  });

  test('a legacyId naming a different chip is not adopted', async () => {
    await register({ id: 'ac-other-chip', ip: '10.1.3.1', mac: 'aa:aa:aa:aa:aa:aa' });
    store.upsert('ac-other-chip', { outdoorUnit: 'do-not-steal' });

    const res = await register({
      id: 'ac-bbbbbbbbbbbb', ip: '10.1.3.2', mac: 'bb:bb:bb:bb:bb:bb', legacyId: 'ac-other-chip',
    });

    assert.equal(res.status, 200);
    assert.equal((await res.json()).migratedFrom, null, 'a mismatched chip must not inherit');
    assert.ok(store.getEntry('ac-other-chip'), 'the other device is untouched');
    assert.equal(store.getEntry('ac-other-chip').outdoorUnit, 'do-not-steal');
  });

  test('migration is idempotent across the repeated registers firmware sends', async () => {
    scheduleStore.putSchedule(scheduleWith('sched-idem', ['ac-idem-old']));
    await register({ id: 'ac-idem-old', ip: '10.1.4.1' });
    const body = { id: 'ac-111111111111', ip: '10.1.4.1', mac: '11:11:11:11:11:11', legacyId: 'ac-idem-old' };

    await register(body);
    await register(body);
    await register(body);

    assert.deepEqual(scheduleStore.getSchedule('sched-idem').deviceIds, ['ac-111111111111']);
    assert.equal(store.allEntries().filter((e) => e.ip === '10.1.4.1').length, 1);
  });

  test('a unit that already registered under its new id is merged, not duplicated', async () => {
    scheduleStore.putSchedule(scheduleWith('sched-merge', ['ac-merge-old']));
    store.upsert('ac-merge-old', { outdoorUnit: 'kept', desiredConfig: { schema: 1, power: 'off' } });
    await register({ id: 'ac-222222222222', ip: '10.1.5.1', mac: '22:22:22:22:22:22' });

    const result = await post('/devices/ac-merge-old/rekey', { newId: 'ac-222222222222' });

    assert.equal(result.status, 200);
    const merged = store.getEntry('ac-222222222222');
    assert.equal(merged.outdoorUnit, 'kept', 'user config comes from the old entry');
    assert.deepEqual(merged.desiredConfig, { schema: 1, power: 'off' });
    assert.equal(merged.ip, '10.1.5.1', 'live facts come from the entry that is actually online');
    assert.equal(merged.mac, '222222222222');
    assert.equal(store.getEntry('ac-merge-old'), null);
    assert.deepEqual(scheduleStore.getSchedule('sched-merge').deviceIds, ['ac-222222222222']);
  });
});

describe('POST /devices/:id/rekey', () => {
  test('refuses to rekey onto an id belonging to a different chip', async () => {
    await register({ id: 'ac-chip-a', ip: '10.1.6.1', mac: 'a1:a1:a1:a1:a1:a1' });
    await register({ id: 'ac-chip-b', ip: '10.1.6.2', mac: 'b1:b1:b1:b1:b1:b1' });

    const res = await post('/devices/ac-chip-a/rekey', { newId: 'ac-chip-b' });

    assert.equal(res.status, 409);
    assert.ok(store.getEntry('ac-chip-a'), 'both devices survive a refused rekey');
    assert.ok(store.getEntry('ac-chip-b'));
  });

  test('404s for an unknown device and 400s without a newId', async () => {
    assert.equal((await post('/devices/nope/rekey', { newId: 'x' })).status, 404);
    await register({ id: 'ac-needs-newid', ip: '10.1.7.1' });
    assert.equal((await post('/devices/ac-needs-newid/rekey', {})).status, 400);
  });
});
