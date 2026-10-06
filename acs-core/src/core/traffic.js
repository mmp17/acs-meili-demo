// Demo-grade traffic control: when two moving robots get close, the one whose
// mission started later is held until the other has moved away. A production
// ACS would reserve path segments/zones up front instead of reacting to distance.

const HOLD_DISTANCE_M = 1.6;
const RELEASE_DISTANCE_M = 2.2;

export class TrafficController {
  constructor(acs) {
    this.acs = acs;
    this.holds = new Map(); // held robot id -> robot id it is yielding to
  }

  isMoving(robot) {
    const mission = this.acs.missions.get(robot.missionId);
    const step = mission && mission.steps[mission.stepIndex];
    return Boolean(robot.online && robot.pose && step && step.type === 'move' && ['SENT', 'ACTIVE'].includes(step.state));
  }

  release(robot) {
    if (!this.holds.delete(robot.id)) return;
    this.acs.setInhibit(robot, 'held', false);
    this.acs.record('info', 'traffic.release', `${robot.name} released`, { robotId: robot.id });
  }

  update() {
    const { robots, missions } = this.acs;
    const distance = (a, b) => Math.hypot(a.pose.x - b.pose.x, a.pose.y - b.pose.y);

    for (const [heldId, otherId] of this.holds) {
      const held = robots.get(heldId);
      const other = robots.get(otherId);
      // Never wait behind a robot that is itself stopped (operator pause or its own hold).
      const blocked = !this.isMoving(other) || other.paused || other.held;
      if (!this.isMoving(held) || blocked || distance(held, other) > RELEASE_DISTANCE_M) this.release(held);
    }

    const moving = [...robots.values()].filter((r) => this.isMoving(r) && !r.paused && !this.holds.has(r.id));
    for (let i = 0; i < moving.length; i++) {
      for (let j = i + 1; j < moving.length; j++) {
        const [a, b] = [moving[i], moving[j]];
        if (this.holds.has(a.id) || this.holds.has(b.id) || distance(a, b) > HOLD_DISTANCE_M) continue;
        const yielding = missions.get(a.missionId).createdAt > missions.get(b.missionId).createdAt ? a : b;
        const passing = yielding === a ? b : a;
        this.holds.set(yielding.id, passing.id);
        this.acs.setInhibit(yielding, 'held', true);
        this.acs.record('warn', 'traffic.hold', `${yielding.name} yields to ${passing.name}`, { robotId: yielding.id });
      }
    }
  }
}
