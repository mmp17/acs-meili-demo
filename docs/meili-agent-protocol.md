# Meili agent protocol (WebSocket) — working notes

Derived from reading `meili-sdk` 0.9.x (MIT) and Meili's `python-simulator`, and confirmed by
running the simulator against `acs-core`. It covers the subset this demo implements; it is not
official documentation. Official SDK docs: <https://docs.meilirobots.com/docs/get-started/on-robot-agent/meili-sdk/>.

## Connection

- URL: `ws(s)://<site>/ws/fleets/` — `site` comes from `~/.meili/cfg.yaml` (or `MEILI_HOST`).
- Auth: HTTP header `x-meili-fleet-token: <fleet token>` on the upgrade request.
  The SDK also sends `x-meili-app-name: sdk` and `x-meili-app-version`.
- The simulator opens **one connection per vehicle**; the SDK also allows several vehicles on one connection.
- The SDK reconnects by itself every 2 s and re-sends the registration frame.
- Close codes 4000–4003 are treated by the SDK as fatal (version/event/team/site errors).

Agent configuration files (normally written by `meili-cli`, here by `fleet-sim/entrypoint.py`):

```yaml
# ~/.meili/cfg.yaml            read by meili-sdk
token: <fleet token>
site: http://acs-core:8900    # add client_id + uuid to switch the simulator to MQTT
# ~/.meili/config.yaml         read by the simulator / ROS agents
vehicles:
  - uuid: a0000000000000000000000000000001   # 32 hex chars
    token: AMR-01
```

## Agent → FMS

Every frame is `{ "event": …, "value": …, "vehicle": "<uuid>" }`.

| `event` | `value` | Notes |
| --- | --- | --- |
| `connect` | `1`, plus top-level `"vehicles": [uuid, …]` | First frame after open; registers the vehicles on this connection |
| `state` | `{ location, battery, speed, timestamp, … }` | Combined telemetry; the simulator sends it every 0.5 s by default |
| `location` | `{ xm, ym, rotation, map_id }` | Metres and degrees. Alternatives: `x`/`y` (ROS) or `lat`/`lon` |
| `batteryStatus` | `{ value, power_supply_status }` | Percent; status 2 = discharging, 3 = not charging |
| `speed` | `{ speed }` | m/s |
| `goalStatus` | `{ goal_id, status_id }` | `goal_id` = subtask uuid. 1 = active, 3 = succeeded, 4 = aborted |
| `notification` | `{ level, message }` | `info` / `warning` / `error`, message ≤ 255 chars |

Also defined by the SDK but unused here: `topics`, `topic_data`, `path_data`, `map_update`,
`new_mission`, `loads`, `map_id_update`, `docking_routine`, `disconnect`.

## FMS → Agent

Every frame is `{ "type": …, "vehicle": "<uuid>", "data": … }`. `vehicle` is mandatory on fleet connections.

| `type` | `data` | SDK callback |
| --- | --- | --- |
| `taskv2` | see below | `task_v2_handler(task, vehicle)` |
| `cancelOrder` | `{ task, subtask, goal_id }` | `task_cancellation_handler` |
| `slow_down` | `{ max_vel_x, max_vel_theta, goal_id? }` | `slow_down_handler` — traffic control; the simulator stops |
| `clear_collision` | `{ message_type }` | `collision_clearance_handler` — the simulator resumes |
| `startPause` / `stopPause` | ignored | `pause_task_handler` / `resume_task_handler` |
| `set_initial_pose` | `{ x, y, yaw, map_id }` | `set_initial_position_handler` — `yaw` in **radians** |
| `update_map_id` | `{ map_id }` | `update_map_id_handler` |
| `errors` | top-level `"errors": { field: [text] }` | `message_error_handler`; a specific text removes a vehicle (see gateway.js) |

Also defined: `path_rerouting`, `update_maps`, `vehicle_settings`, `request_topics`, `topic_init`,
`docking_routine_request`, `docking_routine_finalize_request`, `move`, `move_charge`.

### `taskv2`

One frame carries one **subtask** of a task (mission). The FMS sends the next subtask after the
previous one reports `goalStatus` 3.

```json
{
  "type": "taskv2",
  "vehicle": "a0000000000000000000000000000001",
  "data": {
    "uuid": "<task uuid>",
    "number": "MIS-0001",
    "subtask": {
      "uuid": "<subtask uuid — echoed back as goal_id>",
      "action": {
        "action_type": "move_to_point",
        "values": {},
        "point": { "uuid": "P3", "x": 2, "y": 3, "rotation": 180, "metric": { "x": 2, "y": 3 } }
      },
      "metric_waypoints": [[6, 3], [2, 3]],
      "rotation_angles": [90, 180],
      "speed_limits": []
    }
  }
}
```

All of `uuid`, `number`, `subtask.uuid`, `action.{action_type, values, point}`, `metric_waypoints`,
`rotation_angles` and `speed_limits` must be present or the SDK raises while parsing.

Simulator behaviour worth knowing:

- Supported `action_type`: `move_to_point`, `change_map`, `update_robot_map`. Any other type
  (this demo sends `pick` and `drop`) is acknowledged immediately with status 1 then 3.
- It follows `metric_waypoints` in order; if the list is empty it drives to `action.point.metric`.
- A task received while busy is **dropped**, but it still reports status 1 for it. The ACS therefore
  needs a completion watchdog, not only an acknowledgement timeout.
- `cancelOrder` produces `goalStatus` 4 for the running subtask, and clears any pause.
- `slow_down` and `startPause` set the same pause flag; `clear_collision` and `stopPause` clear it.
