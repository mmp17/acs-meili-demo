// The contract between the ACS control plane and any robot integration.
// The core never sees vendor message formats: a new vendor (VDA 5050, a ROS 2
// bridge, a proprietary REST fleet controller...) is a new subclass of this.

import { EventEmitter } from 'node:events';

/**
 * Events emitted towards the core:
 *   'connected'    (robotId)
 *   'disconnected' (robotId)
 *   'telemetry'    (robotId, { x, y, theta, mapId, battery, speed })   metres, degrees, percent, m/s
 *   'stepStatus'   (robotId, stepId, 'ACTIVE' | 'SUCCEEDED' | 'ABORTED')
 *   'notification' (robotId, level, message)
 *   'trace'        ({ ts, dir: 'rx' | 'tx', robotId, type, payload })   raw vendor frames, for diagnostics
 */
export class RobotAdapter extends EventEmitter {
  /**
   * Execute one mission step.
   * @param {string} robotId
   * @param {{ missionId: string, missionNumber: string,
   *           step: { id: string, type: 'move' | 'pick' | 'drop', station: string,
   *                   target: { x: number, y: number, mapId: string },
   *                   waypoints: Array<{ x: number, y: number }> } }} command
   */
  sendStep(robotId, command) {
    throw new Error('not implemented');
  }

  cancelStep(robotId, missionId, stepId) {
    throw new Error('not implemented');
  }

  /** Stop or release motion. reason: 'traffic' (ACS hold) or 'operator' (manual pause). */
  inhibit(robotId, reason, stopped) {
    throw new Error('not implemented');
  }

  /** Tell the robot where it is (initial localisation). theta in degrees. */
  setPose(robotId, pose) {
    throw new Error('not implemented');
  }

  /** Drop the link to a robot that stopped reporting. */
  disconnect(robotId) {
    throw new Error('not implemented');
  }
}
