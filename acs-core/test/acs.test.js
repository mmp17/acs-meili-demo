import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import WebSocket from 'ws';
import { createServer } from '../src/server.js';
import { FakeAgent } from '../tools/fake-agent.js';

const site = JSON.parse(fs.readFileSync(new URL('../config/site.json', import.meta.url), 'utf8'));
const fleet = JSON.parse(fs.readFileSync(new URL('../config/fleet.json', import.meta.url), 'utf8'));
const FAST = { tickMs: 20, dwellMs: 40, ackTimeoutMs: 400, stallTimeoutMs: 400, cancelCooldownMs: 100, parkAfterIdleMs: 60_000 };

async function harness(t, { agents = 1, options = {} } = {}) {
  const { server, acs } = createServer({ site, fleet, options: { ...FAST, ...options } });
  await new Promise((resolve) => server.listen(0, resolve));
  const host = `ws://localhost:${server.address().port}`;
  acs.start();
  const fakes = [];
  for (const v of fleet.vehicles.slice(0, agents)) {
    const agent = new FakeAgent({ host, token: fleet.fleetToken, uuid: v.uuid, speed: 40, statePeriodMs: 20, stepPeriodMs: 10 });
    await agent.connect();
    fakes.push(agent);
  }
  t.after(() => {
    acs.stop();
    fakes.forEach((a) => a.close());
    server.closeAllConnections();
    server.close();
  });
  return { acs, host, fakes };
}

async function until(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const robotOf = (acs, agent) => acs.robots.get(agent.uuid);

test('robot is localised at its home station on connect', async (t) => {
  const { acs, fakes } = await harness(t);
  await until(() => robotOf(acs, fakes[0]).pose?.x === 6, 'pose at K1');
  assert.deepEqual(robotOf(acs, fakes[0]).pose, { x: 6, y: 0.5, theta: 0, mapId: 'floor-1' });
});

test('transport order runs move → pick → move → drop to completion', async (t) => {
  const { acs, fakes } = await harness(t);
  await until(() => robotOf(acs, fakes[0]).pose?.x === 6, 'localised');
  const order = acs.createOrder({ from: 'P3', to: 'D1' });
  await until(() => order.state === 'COMPLETED', 'order completed');
  const mission = acs.missions.get(order.missionId);
  assert.deepEqual(mission.steps.map((s) => `${s.type}:${s.state}`), ['move:SUCCEEDED', 'pick:SUCCEEDED', 'move:SUCCEEDED', 'drop:SUCCEEDED']);
  assert.ok(Math.hypot(fakes[0].pose.x - 18, fakes[0].pose.y - 11) < 0.1, 'robot ended at D1');
});

test('higher priority order is dispatched first; nearest robot is chosen', async (t) => {
  const { acs, fakes } = await harness(t, { agents: 3 });
  await until(() => fakes.every((a) => robotOf(acs, a).pose?.y === 0.5), 'all localised');
  acs.stop(); // queue both orders before the dispatcher sees either
  const low = acs.createOrder({ from: 'P1', to: 'D1', priority: 0 });
  const high = acs.createOrder({ from: 'P3', to: 'D3', priority: 5 });
  acs.dispatch(Date.now());
  // K1 is the closest park to both pickups, so the high-priority order must get AMR-01.
  assert.equal(acs.missions.get(high.missionId).robotId, fleet.vehicles[0].uuid);
  assert.notEqual(acs.missions.get(low.missionId).robotId, fleet.vehicles[0].uuid);
});

test('order is re-queued and finished by another robot when its robot goes offline', async (t) => {
  const { acs, fakes } = await harness(t, { agents: 2 });
  await until(() => fakes.every((a) => robotOf(acs, a).pose?.y === 0.5), 'all localised');
  fakes[0].speed = 0.5; // slow enough to still be driving when it drops off the network
  const order = acs.createOrder({ from: 'P3', to: 'D3' });
  await until(() => order.state === 'IN_PROGRESS', 'dispatched');
  const first = acs.missions.get(order.missionId);
  assert.equal(first.robotId, fakes[0].uuid);
  fakes[0].close();
  await until(() => order.state === 'COMPLETED', 'completed by second robot');
  assert.equal(first.state, 'FAILED');
  assert.equal(acs.missions.get(order.missionId).robotId, fakes[1].uuid);
  assert.equal(order.attempts, 2);
});

test('cancelling an order aborts the robot and frees it', async (t) => {
  const { acs, fakes } = await harness(t);
  await until(() => robotOf(acs, fakes[0]).pose?.x === 6, 'localised');
  fakes[0].speed = 0.5;
  const order = acs.createOrder({ from: 'P1', to: 'D1' });
  await until(() => fakes[0].task, 'robot driving');
  acs.cancelOrder(order.id);
  await until(() => !fakes[0].task, 'robot aborted');
  assert.equal(order.state, 'CANCELLED');
  assert.equal(robotOf(acs, fakes[0]).missionId, null);
});

test('a stalled robot triggers a retry, then the mission fails and the order is re-queued', async (t) => {
  const { acs, fakes } = await harness(t, { options: { maxOrderAttempts: 1 } });
  await until(() => robotOf(acs, fakes[0]).pose?.x === 6, 'localised');
  fakes[0].frozen = true;
  const order = acs.createOrder({ from: 'P1', to: 'D1' });
  await until(() => order.state === 'FAILED', 'order failed');
  const types = acs.log.map((e) => e.type);
  assert.ok(types.includes('mission.recovery'), 'a retry was attempted');
  assert.ok(types.includes('mission.failed'));
});

test('traffic control holds the later mission when two robots converge', async (t) => {
  const { acs, fakes } = await harness(t, { agents: 2 });
  await until(() => fakes.every((a) => robotOf(acs, a).pose?.y === 0.5), 'all localised');
  fakes.forEach((a) => (a.speed = 8));
  acs.createOrder({ from: 'P3', to: 'D3' });
  acs.createOrder({ from: 'P3', to: 'D2' });
  await until(() => acs.log.some((e) => e.type === 'traffic.hold'), 'a hold was issued');
  await until(() => acs.log.some((e) => e.type === 'traffic.release'), 'the hold was released');
  await until(() => [...acs.orders.values()].every((o) => o.state === 'COMPLETED'), 'both completed', 15000);
});

test('a robot paused by the operator does not block traffic behind it', async (t) => {
  const { acs, fakes } = await harness(t, { agents: 2 });
  await until(() => fakes.every((a) => robotOf(acs, a).pose?.y === 0.5), 'all localised');
  fakes.forEach((a) => (a.speed = 8));
  const first = acs.createOrder({ from: 'P3', to: 'D3' });
  await until(() => fakes[0].task, 'first robot driving');
  acs.pauseRobot(fakes[0].uuid, true);
  const second = acs.createOrder({ from: 'P3', to: 'D2' });
  await until(() => second.state === 'COMPLETED', 'second order completed past the paused robot', 15000);
  assert.equal(first.state, 'IN_PROGRESS');
  acs.pauseRobot(fakes[0].uuid, false);
  await until(() => first.state === 'COMPLETED', 'first order completed after resume', 15000);
});

test('gateway rejects a wrong fleet token and reports unknown vehicles', async (t) => {
  const { host } = await harness(t, { agents: 0 });
  const denied = new WebSocket(`${host}/ws/fleets/`, { headers: { 'x-meili-fleet-token': 'wrong' } });
  const status = await new Promise((resolve) => {
    denied.on('unexpected-response', (_, res) => resolve(res.statusCode));
    denied.on('error', () => {});
  });
  assert.equal(status, 401);

  const ws = new WebSocket(`${host}/ws/fleets/`, { headers: { 'x-meili-fleet-token': fleet.fleetToken } });
  t.after(() => ws.terminate());
  await new Promise((resolve) => ws.once('open', resolve));
  const reply = new Promise((resolve) => ws.once('message', (raw) => resolve(JSON.parse(raw.toString()))));
  const unknown = 'f'.repeat(32);
  ws.send(JSON.stringify({ event: 'connect', value: 1, vehicles: [unknown] }));
  const frame = await reply;
  assert.equal(frame.type, 'errors');
  assert.match(frame.errors.vehicle[0], new RegExp(`^Vehicle with UUID ${unknown} does not exist`));
});
