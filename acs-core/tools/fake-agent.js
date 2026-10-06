// A Node stand-in for Meili's python-simulator, for running the demo and the
// tests without Docker/Python. It speaks the same frames as meili-sdk's
// MeiliWebsocketClient and mirrors the simulator's behaviour: one connection
// per vehicle, straight-line motion, unsupported actions acknowledged at once.
//
//   node tools/fake-agent.js            (uses config/fleet.json, ACS at ws://localhost:8900)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const STATUS = { ACTIVE: 1, SUCCEEDED: 3, ABORTED: 4 };

export class FakeAgent {
  constructor({ host, token, uuid, speed = 1.5, statePeriodMs = 500, stepPeriodMs = 100 }) {
    Object.assign(this, { host, token, uuid, speed, statePeriodMs, stepPeriodMs });
    this.pose = { x: 0, y: 0, rotation: 0, map_id: 'lvl0' };
    this.battery = 100;
    this.task = null; // { goalId, waypoints }
    this.paused = false;
    this.frozen = false; // test hook: stop moving without reporting anything
  }

  connect() {
    this.ws = new WebSocket(`${this.host}/ws/fleets/`, { headers: { 'x-meili-fleet-token': this.token } });
    this.ws.on('open', () => {
      this.sendRaw({ event: 'connect', value: 1, vehicles: [this.uuid] });
      this.stateTimer = setInterval(() => this.sendState(), this.statePeriodMs);
      this.moveTimer = setInterval(() => this.step(), this.stepPeriodMs);
    });
    this.ws.on('message', (raw) => this.onMessage(JSON.parse(raw.toString())));
    this.ws.on('close', () => this.stopTimers());
    this.ws.on('error', (err) => console.error(`[fake-agent ${this.uuid.slice(-2)}] ${err.message}`));
    return new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  stopTimers() {
    clearInterval(this.stateTimer);
    clearInterval(this.moveTimer);
  }

  close() {
    this.stopTimers();
    this.ws.terminate();
  }

  sendRaw(frame) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  send(event, value) {
    this.sendRaw({ event, value, vehicle: this.uuid });
  }

  goal(goalId, status) {
    this.send('goalStatus', { goal_id: goalId, status_id: STATUS[status] });
  }

  sendState() {
    const moving = this.task && !this.paused && !this.frozen;
    this.send('state', {
      timestamp: Date.now() / 1000,
      location: { xm: this.pose.x, ym: this.pose.y, rotation: this.pose.rotation, map_id: this.pose.map_id },
      battery: { value: this.battery, power_supply_status: 3 },
      speed: { speed: moving ? this.speed : 0 },
    });
  }

  onMessage({ type, data }) {
    if (type === 'taskv2') {
      const { subtask } = data;
      if (this.task) return this.goal(subtask.uuid, 'ACTIVE'); // busy: the simulator rejects like this
      if (subtask.action.action_type !== 'move_to_point') {
        this.goal(subtask.uuid, 'ACTIVE');
        return this.goal(subtask.uuid, 'SUCCEEDED');
      }
      const waypoints = subtask.metric_waypoints.length
        ? subtask.metric_waypoints.map(([x, y], i) => ({ x, y, rotation: subtask.rotation_angles?.[i] ?? 0 }))
        : [{ ...subtask.action.point.metric, rotation: 0 }];
      this.task = { goalId: subtask.uuid, waypoints };
      this.goal(subtask.uuid, 'ACTIVE');
    } else if (type === 'cancelOrder') {
      if (this.task) this.goal(this.task.goalId, 'ABORTED');
      this.task = null;
      this.paused = false;
    } else if (type === 'slow_down' || type === 'startPause') {
      this.paused = true;
    } else if (type === 'clear_collision' || type === 'stopPause') {
      this.paused = false;
    } else if (type === 'set_initial_pose') {
      this.pose = { x: Number(data.x), y: Number(data.y), rotation: (Number(data.yaw) * 180) / Math.PI, map_id: data.map_id };
    }
  }

  step() {
    if (!this.task || this.paused || this.frozen) return;
    this.battery = Math.max(0, this.battery - 0.001);
    const target = this.task.waypoints[0];
    const dx = target.x - this.pose.x;
    const dy = target.y - this.pose.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 0.1) {
      this.pose.rotation = target.rotation;
      this.task.waypoints.shift();
      if (!this.task.waypoints.length) {
        const { goalId } = this.task;
        this.task = null;
        this.goal(goalId, 'SUCCEEDED');
      }
      return;
    }
    const stride = Math.min((this.speed * this.stepPeriodMs) / 1000, distance);
    this.pose.x += (stride * dx) / distance;
    this.pose.y += (stride * dy) / distance;
    this.pose.rotation = (Math.atan2(dy, dx) * 180) / Math.PI;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const fleet = JSON.parse(fs.readFileSync(path.join(root, 'config/fleet.json'), 'utf8'));
  const host = process.env.ACS_WS ?? 'ws://localhost:8900';
  for (const v of fleet.vehicles) {
    const agent = new FakeAgent({ host, token: fleet.fleetToken, uuid: v.uuid });
    agent.connect().then(
      () => console.log(`${v.name} connected to ${host}`),
      (err) => console.error(`${v.name} failed to connect: ${err.message}`),
    );
  }
}
