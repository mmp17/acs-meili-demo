// Meili agent gateway: the FMS side of the WebSocket protocol spoken by
// meili-sdk (MeiliWebsocketClient). Anything built on that SDK — Meili's
// python-simulator, meili-agent-ros2, a custom integration — can connect here
// unmodified by pointing its `site` at this server.
//
// Wire format (see docs/meili-agent-protocol.md):
//   agent -> FMS   { event, value, vehicle }            first frame: { event: 'connect', vehicles: [...] }
//   FMS -> agent   { type, vehicle, data }

import { WebSocketServer } from 'ws';
import { RobotAdapter } from '../robot-adapter.js';

const WS_PATH = '/ws/fleets/';
const TOKEN_HEADER = 'x-meili-fleet-token';

// goalStatus.status_id follows ROS actionlib GoalStatus.
const GOAL_STATUS = { 1: 'ACTIVE', 3: 'SUCCEEDED', 2: 'ABORTED', 4: 'ABORTED', 5: 'ABORTED', 8: 'ABORTED', 9: 'ABORTED' };
const ACTION_TYPE = { move: 'move_to_point', pick: 'pick', drop: 'drop' };

const heading = (from, to) => (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;

export class MeiliGateway extends RobotAdapter {
  /**
   * @param {import('node:http').Server} httpServer
   * @param {{ fleetToken: string, vehicles: Array<{ uuid: string }> }} fleet
   */
  constructor(httpServer, fleet) {
    super();
    this.fleetToken = fleet.fleetToken;
    this.known = new Set(fleet.vehicles.map((v) => v.uuid));
    this.sockets = new Map(); // vehicle uuid -> socket
    this.telemetry = new Map(); // vehicle uuid -> last merged telemetry
    this.wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (req, socket, head) => {
      const { pathname } = new URL(req.url, 'http://localhost');
      socket.on('error', () => {}); // a client hanging up mid-handshake must not crash the ACS
      if (pathname !== WS_PATH) return socket.destroy();
      if (req.headers[TOKEN_HEADER] !== this.fleetToken) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws));
    });
  }

  onSocket(ws) {
    ws.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.onFrame(ws, frame);
    });
    ws.on('close', () => {
      for (const [uuid, socket] of this.sockets) {
        if (socket !== ws) continue;
        this.sockets.delete(uuid);
        this.emit('disconnected', uuid);
      }
    });
    ws.on('error', () => ws.terminate());
  }

  onFrame(ws, frame) {
    const { event, value, vehicle } = frame;
    if (event !== 'state') this.emit('trace', { ts: Date.now(), dir: 'rx', robotId: vehicle ?? null, type: event, payload: frame });

    if (event === 'connect') {
      for (const uuid of frame.vehicles ?? []) {
        if (!this.known.has(uuid)) {
          // Same wording as Meili FMS: the SDK parses it to detect removed vehicles.
          const text = `Vehicle with UUID ${uuid} does not exist, or was removed from the fleet setup`;
          ws.send(JSON.stringify({ type: 'errors', errors: { vehicle: [text] } }));
          continue;
        }
        const previous = this.sockets.get(uuid);
        if (previous && previous !== ws) previous.terminate();
        this.sockets.set(uuid, ws);
        this.telemetry.set(uuid, { x: 0, y: 0, theta: 0, mapId: null, battery: null, speed: 0 });
        this.emit('connected', uuid);
      }
      return;
    }
    if (this.sockets.get(vehicle) !== ws) return; // not registered on this connection

    if (event === 'state') {
      this.mergeTelemetry(vehicle, value.location, value.battery, value.speed);
    } else if (event === 'location') {
      this.mergeTelemetry(vehicle, value, null, null);
    } else if (event === 'batteryStatus') {
      this.mergeTelemetry(vehicle, null, value, null);
    } else if (event === 'speed') {
      this.mergeTelemetry(vehicle, null, null, value);
    } else if (event === 'goalStatus') {
      const status = GOAL_STATUS[value.status_id];
      if (status) this.emit('stepStatus', vehicle, value.goal_id, status);
    } else if (event === 'notification') {
      this.emit('notification', vehicle, value.level, value.message);
    }
  }

  mergeTelemetry(uuid, location, battery, speed) {
    const t = this.telemetry.get(uuid);
    if (location) {
      t.x = Number(location.xm ?? location.x);
      t.y = Number(location.ym ?? location.y);
      t.theta = Number(location.rotation ?? 0);
      t.mapId = location.map_id ?? t.mapId;
    }
    if (battery) t.battery = Number(battery.value);
    if (speed) t.speed = Number(speed.speed);
    this.emit('telemetry', uuid, { ...t });
  }

  send(uuid, type, data) {
    const ws = this.sockets.get(uuid);
    if (!ws || ws.readyState !== ws.OPEN) return false;
    const frame = { type, vehicle: uuid, data };
    ws.send(JSON.stringify(frame));
    this.emit('trace', { ts: Date.now(), dir: 'tx', robotId: uuid, type, payload: frame });
    return true;
  }

  // ---- RobotAdapter commands ----------------------------------------------

  sendStep(robotId, { missionId, missionNumber, step }) {
    const points = step.waypoints.length ? step.waypoints : [step.target];
    const rotations = points.map((p, i) => {
      if (i > 0) return heading(points[i - 1], p);
      return points.length > 1 ? heading(p, points[1]) : 0;
    });
    return this.send(robotId, 'taskv2', {
      uuid: missionId,
      number: missionNumber,
      subtask: {
        uuid: step.id,
        action: {
          action_type: ACTION_TYPE[step.type],
          values: { station: step.station },
          // Meili sends pixel coordinates in x/y and metres in `metric`; this site has no image map.
          point: {
            uuid: step.station,
            x: step.target.x,
            y: step.target.y,
            rotation: rotations.at(-1),
            metric: { x: step.target.x, y: step.target.y },
          },
        },
        metric_waypoints: step.type === 'move' ? points.map((p) => [p.x, p.y]) : [],
        rotation_angles: step.type === 'move' ? rotations : [],
        speed_limits: [],
      },
    });
  }

  cancelStep(robotId, missionId, stepId) {
    return this.send(robotId, 'cancelOrder', { task: missionId, subtask: stepId, goal_id: stepId });
  }

  inhibit(robotId, reason, stopped) {
    if (reason === 'traffic') {
      return stopped
        ? this.send(robotId, 'slow_down', { max_vel_x: 0, max_vel_theta: 0 })
        : this.send(robotId, 'clear_collision', { message_type: 'clear_collision' });
    }
    return this.send(robotId, stopped ? 'startPause' : 'stopPause', {});
  }

  setPose(robotId, pose) {
    return this.send(robotId, 'set_initial_pose', {
      x: pose.x,
      y: pose.y,
      yaw: (pose.theta * Math.PI) / 180,
      map_id: pose.mapId,
    });
  }

  disconnect(robotId) {
    this.sockets.get(robotId)?.terminate();
  }
}
