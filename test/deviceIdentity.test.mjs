// Regression tests for device identity handling across a reflash.
//
// The scenario these exist for: a unit is flashed with firmware whose id was
// not updated first, so it boots claiming an id another device already owns.
// That must not cost the innocent device its configuration or its place in the
// user's schedules, and the misflashed unit must recover completely once it is
// reflashed with its own id.

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TOKEN = 'test-token';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-bridge-test-'));
process.env.OFFLINE_AFTER_MS = '30000';
process.env.DEVICE_TIMEOUT_MS = '500';

const store = await import('../src/store.js');
const scheduleStore = await import('../src/scheduleStore.js');
const { buildApp } = await import('../src/server.js');
const { pollOne } = await import('../src/reconcile.js');

// One bridge instance for every test; ids are namespaced per test so the
// shared in-memory registry can't leak between them.
let baseUrl;
before(async () => {
  const server = buildApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  server.unref();
});

const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

const register = (body) =>
  fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
  });

/** A stand-in ESP32 that answers GET /health with whatever id it currently holds. */
async function fakeUnit(id) {
  const unit = { id };
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, id: unit.id, configId: 1, applied: true }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  server.unref();
  unit.ip = '127.0.0.1';
  unit.port = server.address().port;
  return unit;
}

describe('same-ip collisions', () => {
  test('automatic resolution releases the losing ip but keeps the entry intact', () => {
    store.upsert('a-old', {
      ip: '10.0.0.1', lastSeen: iso(-5_000),
      desiredConfig: { schema: 1, power: 'on' }, outdoorUnit: 'north',
    });
    store.upsert('a-new', { ip: '10.0.0.1', lastSeen: iso(0) });

    const released = store.resolveDuplicateIps();

    assert.deepEqual(released, ['a-old']);
    const loser = store.getEntry('a-old');
    assert.ok(loser, 'the losing entry must survive — it may be a live device that was hijacked');
    assert.equal(loser.ip, null, 'its stale ip is dropped so it stops being polled');
    assert.equal(loser.orphaned.reason, 'ip_claimed_by_other_device');
    assert.deepEqual(loser.desiredConfig, { schema: 1, power: 'on' }, 'config is preserved');
    assert.equal(loser.outdoorUnit, 'north', 'outdoor-unit grouping is preserved');
    assert.equal(store.computeStatus(loser), 'offline', 'unreachable devices must not read online');
  });

  test('an entry is reclaimed intact when the real unit checks back in', () => {
    store.upsert('b-dev', { ip: '10.0.0.2', desiredConfig: { schema: 1, power: 'off' } });
    store.releaseIp('b-dev', 'ip_answers_to_other_id');
    assert.equal(store.getEntry('b-dev').ip, null);

    store.touch('b-dev', { ip: '10.0.0.2' });

    const entry = store.getEntry('b-dev');
    assert.equal(entry.orphaned, null, 'the orphan marker clears on contact');
    assert.equal(entry.ip, '10.0.0.2');
    assert.deepEqual(entry.desiredConfig, { schema: 1, power: 'off' });
    assert.equal(store.computeStatus(entry), 'online');
  });
});

describe('schedule membership', () => {
  const schedule = () => ({
    id: 'sched-x',
    name: 'Morning',
    enabled: true,
    deviceIds: ['c-keep', 'c-lose'],
    steps: [{ id: 'step-1', time: '07:00', config: { schema: 1, power: 'on', mode: 'heat', temp: 22 } }],
  });

  test('automatic ip resolution never rewrites the user\'s schedules', () => {
    scheduleStore.putSchedule(schedule());
    store.upsert('c-lose', { ip: '10.0.0.3', lastSeen: iso(-5_000) });
    store.upsert('c-keep', { ip: '10.0.0.3', lastSeen: iso(0) });

    store.resolveDuplicateIps();

    assert.deepEqual(
      scheduleStore.getSchedule('sched-x').deviceIds,
      ['c-keep', 'c-lose'],
      'inferred cleanup must not strip devices from schedules — it is irreversible',
    );
  });

  test('an explicit delete does prune schedules', () => {
    scheduleStore.putSchedule(schedule());
    store.upsert('c-lose', {});

    store.removeEntry('c-lose', { pruneSchedules: true });

    assert.deepEqual(scheduleStore.getSchedule('sched-x').deviceIds, ['c-keep']);
  });

  test('removeEntry leaves schedules alone by default', () => {
    scheduleStore.putSchedule(schedule());
    store.upsert('c-lose', {});

    store.removeEntry('c-lose');

    assert.deepEqual(scheduleStore.getSchedule('sched-x').deviceIds, ['c-keep', 'c-lose']);
  });
});

describe('POST /register identity guard', () => {
  test('refuses a second unit claiming an online device\'s id', async () => {
    await register({ id: 'd-dev', ip: '10.0.1.1' });

    const res = await register({ id: 'd-dev', ip: '10.0.1.2' });

    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, 'id_conflict');
    assert.equal(body.error.details.heldByIp, '10.0.1.1');
    assert.equal(store.getEntry('d-dev').ip, '10.0.1.1', 'the incumbent keeps the id');
  });

  test('allows an ordinary ip change once the incumbent has aged out', async () => {
    await register({ id: 'e-dev', ip: '10.0.1.3' });
    store.upsert('e-dev', { lastSeen: new Date(Date.now() - 60_000).toISOString() });

    const res = await register({ id: 'e-dev', ip: '10.0.1.4' });

    assert.equal(res.status, 200);
    assert.equal(store.getEntry('e-dev').ip, '10.0.1.4', 'a DHCP move is not a conflict');
  });

  test('a first registration is never a conflict', async () => {
    const res = await register({ id: 'f-dev', ip: '10.0.1.5' });
    assert.equal(res.status, 200);
    assert.equal(store.getEntry('f-dev').ip, '10.0.1.5');
  });
});

describe('reconcile poll', () => {
  test('an ip answering to another id releases the ip instead of deleting the device', async () => {
    const unit = await fakeUnit('g-other');
    store.upsert('g-dev', {
      ip: unit.ip, port: unit.port, lastSeen: iso(0),
      desiredConfig: { schema: 1, power: 'on' }, outdoorUnit: 'south',
    });

    await pollOne(store.getEntry('g-dev'));

    const entry = store.getEntry('g-dev');
    assert.ok(entry, 'a device is not deleted just because its ip now answers to someone else');
    assert.equal(entry.ip, null);
    assert.equal(entry.orphaned.reason, 'ip_answers_to_other_id');
    assert.deepEqual(entry.desiredConfig, { schema: 1, power: 'on' });
    assert.equal(entry.outdoorUnit, 'south');
  });
});

describe('full misflash → reflash recovery', () => {
  test('the reflashed device comes back as itself, with nothing lost', async () => {
    scheduleStore.putSchedule({
      id: 'sched-y',
      name: 'Evening',
      enabled: true,
      deviceIds: ['bedroom', 'kitchen'],
      steps: [{ id: 'step-1', time: '18:00', config: { schema: 1, power: 'on', mode: 'heat', temp: 21 } }],
    });
    await register({ id: 'kitchen', ip: '10.0.2.1' });
    await register({ id: 'bedroom', ip: '10.0.2.2' });
    store.upsert('bedroom', { desiredConfig: { schema: 1, power: 'on', mode: 'heat', temp: 22 }, outdoorUnit: 'north' });

    // The bedroom unit is flashed without updating its id, and boots as "kitchen".
    const misflash = await register({ id: 'kitchen', ip: '10.0.2.2' });
    assert.equal(misflash.status, 409, 'the borrowed id is refused, not handed over');
    assert.equal(store.getEntry('kitchen').ip, '10.0.2.1', 'the real kitchen unit is untouched');

    // Reflashed with its own id, it registers normally.
    assert.equal((await register({ id: 'bedroom', ip: '10.0.2.2' })).status, 200);

    const bedroom = store.getEntry('bedroom');
    assert.equal(bedroom.ip, '10.0.2.2');
    assert.equal(store.computeStatus(bedroom), 'online');
    assert.deepEqual(bedroom.desiredConfig, { schema: 1, power: 'on', mode: 'heat', temp: 22 });
    assert.equal(bedroom.outdoorUnit, 'north');
    assert.deepEqual(
      scheduleStore.getSchedule('sched-y').deviceIds,
      ['bedroom', 'kitchen'],
      'both devices keep their place in the schedule',
    );
  });
});
