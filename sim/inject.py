r"""Trigger test situations in the running simulator (safety states, weather, cleaning, GPS).

    python sim\inject.py local | remote          device switched to LOCAL control / back
    python sim\inject.py fault | clear           stall fault / clear it
    python sim\inject.py offline | online        link dies / comes back
    python sim\inject.py wind 15                 wind speed 15 m/s (auto-stow above the limit)   | calm  = normal wind
    python sim\inject.py rain | dry              rain starts / stops
    python sim\inject.py lowwater | refill       cleaning water at 12 percent / 100 percent
    python sim\inject.py gps 200 | gpsback       device "moved" 200 m (default 200)  / back to the installed place
    python sim\inject.py nogps | gpson           GPS stops / returns
    python sim\inject.py dirty | cleanpanel      soiling 0.90 / 1.00
    python sim\inject.py mismatch | fixmismatch  IMU reads 9 degrees off / normal
Options: --host localhost --port 1883
"""
import argparse
import json

import paho.mqtt.publish as publish

CASES = {
    "local": {"mode": "local"}, "remote": {"mode": "remote"},
    "fault": {"fault": "stall"}, "clear": {"fault": None},
    "offline": {"offline": True}, "online": {"offline": False},
    "calm": {"wind": None}, "rain": {"rain": True}, "dry": {"rain": False},
    "lowwater": {"water": 12}, "refill": {"water": 100},
    "gpsback": {"gps_move_m": 0}, "nogps": {"gps": False}, "gpson": {"gps": True},
    "dirty": {"soil": 0.90}, "cleanpanel": {"soil": 1.0},
    "mismatch": {"imu_bias": 9.0}, "fixmismatch": {"imu_bias": 1.3},
}
ap = argparse.ArgumentParser()
ap.add_argument("case", choices=list(CASES) + ["wind", "gps"])
ap.add_argument("value", nargs="?", type=float)
ap.add_argument("--host", default="localhost")
ap.add_argument("--port", type=int, default=1883)
a = ap.parse_args()
if a.case == "wind":
    msg = {"wind": a.value if a.value is not None else 15.0}
elif a.case == "gps":
    msg = {"gps_move_m": a.value if a.value is not None else 200.0}
else:
    msg = CASES[a.case]
publish.single("solmate/unit1/sim/inject", json.dumps(msg), qos=1, hostname=a.host, port=a.port)
print("sent:", a.case, msg)
