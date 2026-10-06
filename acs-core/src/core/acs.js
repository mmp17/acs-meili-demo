// ACS control plane: Order & Mission state machine, Fleet Dispatcher,
// Recovery Manager and Telemetry & Events. Vendor-neutral: it only talks to
// robots through the RobotAdapter contract (see adapters/robot-adapter.js).

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { RouteGraph } from './routing.js';
import { TrafficController } from './traffic.js';

export const DEFAULTS = {
  tickMs: 250,
  dwellMs: 2000, // simulated load/unload time at a station
  ackTimeoutMs: 5000, // robot must report ACTIVE within this window
  stallTimeoutMs: 15000, // a moving step must make progress within this window
  heartbeatTimeoutMs: 5000,
  cancelCooldownMs: 1500, // let the robot finish aborting before reusing it
  maxOrderAttempts: 3,
  minBatteryPct: 20,
  parkAfterIdleMs: 3000,
};

const uid = () => randomUUID().replaceAll('-', '');
const ACTIVE_MISSION = new Set(['EXECUTING']);

export class Acs extends EventEmitter {
  /**
   * @param {object} site   stations/paths/mapId (config/site.json)
   * @param {Array<{uuid: string, name: string, home: string}>} vehicles
   * @param {import('../adapters/robot-adapter.js').RobotAdapter} adapter
   */
  constructor(site, vehicles, adapter, options = {}) {
    super();
    this.site = site;
    this.options = { ...DEFAULTS, ...options };
    this.graph = new RouteGraph(site);
    this.adapter = adapter;
    this.traffic = new TrafficController(this);
    this.robots = new Map();
    this.orders = new Map();
    this.missions = new Map();
    this.log = [];
    this.orderSeq = 0;
    this.missionSeq = 0;

    for (const v of vehicles) {
      this.robots.set(v.uuid, {
        id: v.uuid,
        name: v.name,
        home: v.home,
        online: false,
        pose: null,
        battery: null,
        speed: 0,
        missionId: null,
        paused: false, // operator pause
        held: false, // traffic hold
        lastSeen: 0,
        idleSince: 0,
        busyUntil: 0,
        route: null,
      });
    }

    adapter.on('connected', (id) => this.onRobotConnected(id));
    adapter.on('disconnected', (id) => this.onRobotDisconnected(id));
    adapter.on('telemetry', (id, t) => this.onTelemetry(id, t));
    adapter.on('stepStatus', (id, stepId, status) => this.onStepStatus(id, stepId, status));
    adapter.on('notification', (id, level, message) =>
      this.record(level === 'error' ? 'error' : 'info', 'robot.notification', message, { robotId: id }),
    );
  }

  start() {
    this.timer = setInterval(() => this.tick(), this.options.tickMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  // ---- Telemetry & Events -------------------------------------------------

  record(level, type, message, refs = {}) {
    const entry = { ts: Date.now(), level, type, message, ...refs };
    this.log.push(entry);
    if (this.log.length > 500) this.log.shift();
    this.emit('event', entry);
  }

  robotState(robot) {
    if (!robot.online) return 'OFFLINE';
    if (robot.paused) return 'PAUSED';
    if (robot.held) return 'HELD';
    return robot.missionId ? 'EXECUTING' : 'IDLE';
  }

  snapshot() {
    const missions = [...this.missions.values()];
    const done = missions.filter((m) => m.state === 'COMPLETED' && m.orderId);
    const avgMs = done.length ? done.reduce((sum, m) => sum + (m.endedAt - m.createdAt), 0) / done.length : 0;
    const orders = [...this.orders.values()];
    return {
      ts: Date.now(),
      robots: [...this.robots.values()].map((r) => ({
        id: r.id,
        name: r.name,
        home: r.home,
        state: this.robotState(r),
        pose: r.pose,
        battery: r.battery,
        speed: r.speed,
        missionId: r.missionId,
        route: r.route,
      })),
      orders: orders.slice(-40),
      missions: missions.slice(-40),
      log: this.log.slice(-80),
      kpi: {
        online: [...this.robots.values()].filter((r) => r.online).length,
        robots: this.robots.size,
        queued: orders.filter((o) => o.state === 'QUEUED').length,
        inProgress: orders.filter((o) => o.state === 'IN_PROGRESS').length,
        completed: orders.filter((o) => o.state === 'COMPLETED').length,
        failed: orders.filter((o) => o.state === 'FAILED').length,
        avgMissionSec: Math.round(avgMs / 100) / 10,
      },
    };
  }

  // ---- Order & Mission ----------------------------------------------------

  createOrder({ from, to, priority = 0 }) {
    for (const id of [from, to]) {
      const station = this.graph.station(id);
      if (!station || station.type === 'junction') throw new Error(`Unknown station: ${id}`);
    }
    if (from === to) throw new Error('Pickup and drop stations must differ');
    const order = {
      id: uid(),
      number: `ORD-${String(++this.orderSeq).padStart(4, '0')}`,
      from,
      to,
      priority: Number(priority) || 0,
      state: 'QUEUED',
      attempts: 0,
      missionId: null,
      createdAt: Date.now(),
    };
    this.orders.set(order.id, order);
    this.record('info', 'order.created', `${order.number} ${from} → ${to} (priority ${order.priority})`, {
      orderId: order.id,
    });
    return order;
  }

  cancelOrder(orderId) {
    const order = this.orders.get(orderId);
    if (!order) throw new Error('Order not found');
    if (order.state === 'QUEUED') {
      order.state = 'CANCELLED';
      this.record('warn', 'order.cancelled', `${order.number} cancelled while queued`, { orderId });
    } else if (order.state === 'IN_PROGRESS') {
      this.endMission(this.missions.get(order.missionId), 'CANCELLED', 'cancelled by operator');
    }
    return order;
  }

  createMission(robot, order) {
    const step = (type, station) => ({ id: uid(), type, station, state: 'PENDING', attempts: 0 });
    const mission = {
      id: uid(),
      number: `MIS-${String(++this.missionSeq).padStart(4, '0')}`,
      orderId: order ? order.id : null,
      kind: order ? 'transport' : 'park',
      robotId: robot.id,
      state: 'EXECUTING',
      stepIndex: 0,
      steps: order
        ? [step('move', order.from), step('pick', order.from), step('move', order.to), step('drop', order.to)]
        : [step('move', robot.home)],
      createdAt: Date.now(),
      endedAt: null,
      reason: null,
    };
    this.missions.set(mission.id, mission);
    robot.missionId = mission.id;
    if (order) {
      order.state = 'IN_PROGRESS';
      order.missionId = mission.id;
      order.attempts += 1;
    }
    this.record('info', 'mission.dispatched', `${mission.number} (${mission.kind}) → ${robot.name}`, {
      missionId: mission.id,
      robotId: robot.id,
    });
    this.sendCurrentStep(mission);
    return mission;
  }

  sendCurrentStep(mission) {
    const robot = this.robots.get(mission.robotId);
    const step = mission.steps[mission.stepIndex];
    const target = this.graph.station(step.station);
    step.target = { x: target.x, y: target.y, mapId: this.site.mapId };
    if (step.type === 'move') {
      const route = this.graph.route(robot.pose, step.station);
      if (!route) return this.endMission(mission, 'FAILED', `no route to ${step.station}`);
      step.waypoints = route.waypoints;
      robot.route = route.waypoints;
    } else {
      step.waypoints = [];
      robot.route = null;
    }
    step.state = 'SENT';
    step.attempts += 1;
    step.sentAt = Date.now();
    step.progressAt = Date.now();
    step.progressPose = robot.pose;
    this.adapter.sendStep(robot.id, { missionId: mission.id, missionNumber: mission.number, step });
  }

  onStepStatus(robotId, stepId, status) {
    const robot = this.robots.get(robotId);
    const mission = robot && this.missions.get(robot.missionId);
    const step = mission && mission.steps[mission.stepIndex];
    // Late or foreign reports (e.g. the ABORTED that follows a cancel) are ignored.
    if (!step || step.id !== stepId || !ACTIVE_MISSION.has(mission.state)) return;

    if (status === 'ACTIVE') {
      if (step.state === 'SENT') step.state = 'ACTIVE';
    } else if (status === 'SUCCEEDED') {
      step.state = 'SUCCEEDED';
      robot.route = null;
      // pick/drop: hold the robot at the station while the load is transferred
      step.dwellUntil = Date.now() + (step.type === 'move' ? 0 : this.options.dwellMs);
    } else if (status === 'ABORTED') {
      this.recover(mission, `robot aborted ${step.type} step`);
    }
  }

  advance(mission) {
    mission.stepIndex += 1;
    if (mission.stepIndex >= mission.steps.length) return this.endMission(mission, 'COMPLETED');
    this.sendCurrentStep(mission);
  }

  endMission(mission, state, reason = null) {
    if (!mission || !ACTIVE_MISSION.has(mission.state)) return;
    const robot = this.robots.get(mission.robotId);
    const step = mission.steps[mission.stepIndex];
    const interrupted = state !== 'COMPLETED';
    mission.state = state;
    mission.reason = reason;
    mission.endedAt = Date.now();

    if (interrupted && step && robot.online && ['SENT', 'ACTIVE'].includes(step.state)) {
      this.adapter.cancelStep(robot.id, mission.id, step.id);
      robot.busyUntil = Date.now() + this.options.cancelCooldownMs;
    }
    robot.missionId = null;
    robot.route = null;
    robot.idleSince = Date.now();
    this.traffic.release(robot);

    const order = this.orders.get(mission.orderId);
    if (order) {
      if (state === 'COMPLETED') order.state = 'COMPLETED';
      else if (state === 'CANCELLED') order.state = 'CANCELLED';
      else if (order.attempts < this.options.maxOrderAttempts) order.state = 'QUEUED';
      else order.state = 'FAILED';
      order.missionId = state === 'COMPLETED' ? mission.id : null;
    }
    const level = state === 'COMPLETED' ? 'info' : state === 'CANCELLED' ? 'warn' : 'error';
    const requeued = order && order.state === 'QUEUED' ? ` — ${order.number} re-queued` : '';
    this.record(level, `mission.${state.toLowerCase()}`, `${mission.number} ${state}${reason ? `: ${reason}` : ''}${requeued}`, {
      missionId: mission.id,
      robotId: robot.id,
    });
  }

  // ---- Recovery Manager ---------------------------------------------------

  /** Retry the current step once; after that fail the mission (the order is re-queued). */
  recover(mission, reason) {
    const robot = this.robots.get(mission.robotId);
    const step = mission.steps[mission.stepIndex];
    if (robot.online && step.attempts < 2) {
      this.record('warn', 'mission.recovery', `${mission.number} retrying ${step.type} step: ${reason}`, {
        missionId: mission.id,
        robotId: robot.id,
      });
      this.adapter.cancelStep(robot.id, mission.id, step.id);
      step.state = 'RETRY';
      step.retryAt = Date.now() + this.options.cancelCooldownMs;
      return;
    }
    this.endMission(mission, 'FAILED', reason);
  }

  superviseMission(mission, now) {
    const robot = this.robots.get(mission.robotId);
    const step = mission.steps[mission.stepIndex];

    if (step.state === 'RETRY') {
      if (now >= step.retryAt) {
        step.id = uid(); // a fresh id so late reports for the old attempt are ignored
        this.sendCurrentStep(mission);
      }
    } else if (step.state === 'SUCCEEDED') {
      if (now >= step.dwellUntil) this.advance(mission);
    } else if (step.state === 'SENT') {
      if (now - step.sentAt > this.options.ackTimeoutMs) this.recover(mission, 'no acknowledgement from robot');
    } else if (step.state === 'ACTIVE' && step.type === 'move') {
      const moved =
        step.progressPose && robot.pose && Math.hypot(robot.pose.x - step.progressPose.x, robot.pose.y - step.progressPose.y);
      if (moved > 0.05 || robot.paused || robot.held) {
        step.progressAt = now;
        step.progressPose = robot.pose;
      } else if (now - step.progressAt > this.options.stallTimeoutMs) {
        this.recover(mission, 'robot stalled');
      }
    } else if (step.state === 'ACTIVE') {
      if (now - step.sentAt > this.options.stallTimeoutMs) this.recover(mission, `${step.type} step never finished`);
    }
  }

  // ---- Fleet Dispatcher ---------------------------------------------------

  isEligible(robot, now) {
    return (
      robot.online &&
      robot.pose &&
      !robot.missionId &&
      !robot.paused &&
      now >= robot.busyUntil &&
      (robot.battery ?? 100) >= this.options.minBatteryPct
    );
  }

  dispatch(now) {
    const queue = [...this.orders.values()]
      .filter((o) => o.state === 'QUEUED')
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);

    for (const order of queue) {
      let best = null;
      for (const robot of this.robots.values()) {
        if (!this.isEligible(robot, now)) continue;
        const route = this.graph.route(robot.pose, order.from);
        if (route && (!best || route.length < best.length)) best = { robot, length: route.length };
      }
      if (!best) break; // no free robot: keep priority order, try again next tick
      this.createMission(best.robot, order);
    }

    // Idle robots away from home go back to their parking station.
    for (const robot of this.robots.values()) {
      if (!this.isEligible(robot, now) || now - robot.idleSince < this.options.parkAfterIdleMs) continue;
      const home = this.graph.station(robot.home);
      if (Math.hypot(robot.pose.x - home.x, robot.pose.y - home.y) > 0.3) this.createMission(robot, null);
    }
  }

  // ---- Robot lifecycle ----------------------------------------------------

  onRobotConnected(robotId) {
    const robot = this.robots.get(robotId);
    if (!robot) return;
    robot.online = true;
    robot.lastSeen = Date.now();
    robot.idleSince = Date.now();
    robot.paused = false;
    robot.held = false;
    const home = this.graph.station(robot.home);
    this.adapter.setPose(robotId, { x: home.x, y: home.y, theta: 0, mapId: this.site.mapId });
    this.record('info', 'robot.online', `${robot.name} connected, localised at ${robot.home}`, { robotId });
  }

  onRobotDisconnected(robotId) {
    const robot = this.robots.get(robotId);
    if (!robot || !robot.online) return;
    robot.online = false;
    robot.speed = 0;
    this.record('error', 'robot.offline', `${robot.name} disconnected`, { robotId });
    const mission = this.missions.get(robot.missionId);
    if (mission) this.endMission(mission, 'FAILED', `${robot.name} went offline`);
  }

  onTelemetry(robotId, t) {
    const robot = this.robots.get(robotId);
    if (!robot) return;
    robot.lastSeen = Date.now();
    robot.pose = { x: t.x, y: t.y, theta: t.theta, mapId: t.mapId };
    robot.battery = t.battery;
    robot.speed = t.speed;
  }

  /** Motion inhibit with two independent reasons: operator 'paused' and traffic 'held'. */
  setInhibit(robot, kind, on) {
    if (robot[kind] === on) return;
    const wasStopped = robot.paused || robot.held;
    robot[kind] = on;
    const stopped = robot.paused || robot.held;
    if (!robot.online || wasStopped === stopped) return;
    this.adapter.inhibit(robot.id, kind === 'held' ? 'traffic' : 'operator', stopped);
  }

  pauseRobot(robotId, on) {
    const robot = this.robots.get(robotId);
    if (!robot) throw new Error('Robot not found');
    this.setInhibit(robot, 'paused', on);
    this.record('warn', on ? 'robot.paused' : 'robot.resumed', `${robot.name} ${on ? 'paused' : 'resumed'} by operator`, {
      robotId,
    });
    return robot;
  }

  tick() {
    const now = Date.now();
    for (const robot of this.robots.values()) {
      if (robot.online && now - robot.lastSeen > this.options.heartbeatTimeoutMs) {
        this.adapter.disconnect(robot.id);
        this.onRobotDisconnected(robot.id);
      }
    }
    for (const mission of this.missions.values()) {
      if (ACTIVE_MISSION.has(mission.state)) this.superviseMission(mission, now);
    }
    this.traffic.update();
    this.dispatch(now);
    this.emit('tick');
  }
}
