"""Write the ~/.meili config that meili-cli would normally generate, then start the simulator.

meili-cli fetches these files from Meili's cloud; here the fleet is defined by
the ACS (acs-core/config/fleet.json) and `site` points at the ACS gateway.
"""
import json
import os
import sys
from pathlib import Path

import yaml

fleet = json.loads(Path(os.environ.get("FLEET_FILE", "/config/fleet.json")).read_text())
site = os.environ.get("ACS_URL", "http://acs-core:8900")

meili_dir = Path.home() / ".meili"
meili_dir.mkdir(exist_ok=True)

# Read by meili-sdk: fleet token and FMS host. No client_id => WebSocket transport.
(meili_dir / "cfg.yaml").write_text(yaml.safe_dump({"token": fleet["fleetToken"], "site": site}))
# Read by the simulator: the vehicle name is the first word of `token`.
(meili_dir / "config.yaml").write_text(
    yaml.safe_dump({"vehicles": [{"uuid": v["uuid"], "token": v["name"]} for v in fleet["vehicles"]]})
)

print(f"Starting {len(fleet['vehicles'])} simulated vehicle(s) against {site}", flush=True)
os.execv(sys.executable, [sys.executable, "-u", "src/main.py"])
