#!/usr/bin/env python3
"""SolMate tracker simulator (Weeks 1-10).

Pretends to be the real device so the app can be built and tested without hardware.
  * MQTT    : publishes telemetry/status/event, listens to cmd/#, settings/set, sim/inject
              Also simulates wind + auto-stow, rain, water level, GPS, soiling and a cleaning cycle
  * Local WS: raw WebSocket server (default port 8081) that mimics the ESP32 direct link.
              Same messages, wrapped as {"topic": "...", "payload": ...}

Usage (from the project folder, venv active):
    python sim\\simulator.py                       # local Mosquitto on localhost:1883
    python sim\\simulator.py --demo                # fast "day" so you can watch tracking
    python sim\\simulator.py --host xxxx.s1.hivemq.cloud --port 8883 --tls --user U --password P
Stop with Ctrl+C (publishes "offline" first).
"""
import argparse
import asyncio
import json
import math
import random
import time

import paho.mqtt.client as mqtt

try:
    from websockets.asyncio.server import serve as ws_serve
    from websockets import broadcast as ws_broadcast
except ImportError:  # websockets not installed -> local direct link disabled
    ws_serve = None
    ws_broadcast = None

SPEED_DEG_S = 3.0          # simulated actuator speed
HEARTBEAT_TIMEOUT = 0.6    # jog stops if no heartbeat for this long (firmware must do the same)
TICK = 0.1


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


class Tracker:
    def __init__(self, args):
        self.a = args
        self.prefix = args.prefix
        self.t0 = time.time()
        self.az, self.el = 180.0, 30.0
        self.az_t, self.el_t = self.az, self.el
        self.mode = "manual"
        self.estop = False
        self.fault = None
        self.local = False           # physical "local control" switch on the device
        self.offline = False         # simulate a dead link
        self.jog = {"az": 0, "el": 0}
        self.last_hb = 0.0
        self.settings = {"rev": 0,
                         "limits": {"az_min": 90, "az_max": 270, "el_min": 5, "el_max": 85},
                         "thresholds": {"wind_stow_ms": 12, "low_water_pct": 20}}
        self.hard = {"az_min": 60, "az_max": 300, "el_min": 0, "el_max": 90}
        self.calibrated = False
        self.calib = {"active": False, "marks": {}, "imu_offset": 0.0}
        self.imu_bias = 1.3          # pretend the IMU is mounted 1.3 deg off
        self.moving = False
        self.stowed = False
        self.wind_override = None    # inject: fixed wind speed (m/s). None = gentle random wind
        self.rain = False
        self.water = 100.0           # cleaning water, percent
        self.lat, self.lon = 31.5204, 74.3587
        self.gps_dlat = 0.0          # inject: pretend the device was moved (degrees of latitude)
        self.has_gps = True
        self.cleaning = "idle"       # idle | running | done
        self.clean_end = 0.0
        self.soil = 0.97             # 1.0 = clean panel
        self.last_slow = 0.0
        self.low_water_sent = False
        self.last_tel = 0.0
        self.last_telemetry = None
        self.clients = set()
        self.mq = None
        self.loop = None

    # ---------- publishing ----------
    def pub(self, sub, payload, retain=False, qos=0):
        if self.offline and sub != "status":
            return
        text = payload if isinstance(payload, str) else json.dumps(payload, separators=(",", ":"))
        if self.mq is not None:
            self.mq.publish(f"{self.prefix}/{sub}", text, qos=qos, retain=retain)
        if ws_broadcast and self.clients:
            ws_broadcast(self.clients, json.dumps({"topic": sub, "payload": payload}))

    def ack(self, cid, ok, reason=None):
        self.pub("ack", {"id": cid, "ok": ok, "reason": reason}, qos=1)
        if not ok:
            print(f"  rejected ({reason})")

    def thr(self, key, default):
        t = self.settings.get("thresholds") or {}
        return t.get(key, default)

    def wind(self):
        if self.wind_override is not None:
            return float(self.wind_override)
        return max(0.0, 3.0 + 1.5 * math.sin(time.time() / 30.0) + random.uniform(-0.4, 0.4))

    def event(self, etype, sev, msg):
        print(f"  event {etype}: {msg}")
        self.pub("event", {"ts": int(time.time()), "type": etype, "sev": sev, "msg": msg}, qos=1)

    # ---------- sun model ----------
    def hour(self):
        if self.a.demo:                       # 1 simulated hour every 20 s, 06:00 -> 18:00
            return 6 + ((time.time() - self.t0) / 20.0) % 12
        lt = time.localtime()
        return lt.tm_hour + lt.tm_min / 60 + lt.tm_sec / 3600

    def sun(self):
        frac = (self.hour() - 6) / 12
        if 0 < frac < 1:
            return 90 + 180 * frac, 5 + 50 * math.sin(math.pi * frac), math.sin(math.pi * frac) ** 1.2
        return 180.0, 10.0, 0.0              # night: park

    # ---------- limits ----------
    def limits(self):
        s, h = self.settings["limits"], self.hard
        return (max(s["az_min"], h["az_min"]), min(s["az_max"], h["az_max"]),
                max(s["el_min"], h["el_min"]), min(s["el_max"], h["el_max"]))

    # ---------- command handling ----------
    def on_cmd(self, sub, p):
        if not isinstance(p, dict):
            p = {}
        cid = p.get("id")
        if sub != "cmd/jog":                      # jog heartbeats are too chatty to print
            print(f"< {sub} {p}")

        if sub == "cmd/ping":                     # link test: answer at once, in every state
            return self.ack(cid, True)
        if sub == "sim/inject":
            return self.inject(p)
        if sub == "settings/set":
            return self.apply_settings(p)
        if sub == "cmd/estop":
            was = self.estop
            self.estop = bool(p.get("estop", True))
            if self.estop and not was:
                self.event("estop", "crit", "Emergency stop pressed")
            self.jog = {"az": 0, "el": 0}
            self.az_t, self.el_t = self.az, self.el
            self.ack(cid, True)
            return self.send_telemetry()
        if sub == "cmd/stop":
            self.jog = {"az": 0, "el": 0}
            self.az_t, self.el_t = self.az, self.el
            return self.ack(cid, True)

        # everything below moves hardware: apply the safety gates
        if self.estop:
            return self.ack(cid, False, "estop")
        if self.fault:
            return self.ack(cid, False, "fault")
        if self.local:
            return self.ack(cid, False, "local_mode")

        if sub == "cmd/stow":
            self.stowed = True
            self.jog = {"az": 0, "el": 0}
            self.event("wind_stow", "info", "Stow requested from the app")
            self.ack(cid, True)
            return self.send_telemetry()
        if sub == "cmd/clean":
            return self.clean_cmd(p, cid)
        if self.stowed and sub in ("cmd/jog", "cmd/goto"):
            return self.ack(cid, False, "stowed")
        if sub == "cmd/mode":
            m = p.get("mode")
            if m not in ("auto", "manual"):
                return self.ack(cid, False, "bad_mode")
            if self.stowed:                                 # "Resume": only when the wind has dropped
                if self.wind() >= self.thr("wind_stow_ms", 12) - 2:
                    return self.ack(cid, False, "wind_high")
                self.stowed = False
                self.event("wind_stow", "info", "Tracking resumed after stow")
            self.mode = m
            self.jog = {"az": 0, "el": 0}
            self.az_t, self.el_t = self.az, self.el
            self.ack(cid, True)
            return self.send_telemetry()
        if sub == "cmd/jog":
            if self.mode != "manual":
                return self.ack(cid, False, "not_manual")
            axis, d = p.get("axis"), int(p.get("dir", 0))
            if axis not in ("az", "el") or d not in (-1, 0, 1):
                return self.ack(cid, False, "bad_args")
            self.jog[axis] = d
            self.last_hb = time.time()
            self.az_t, self.el_t = self.az, self.el
            return
        if sub == "cmd/goto":
            if self.mode != "manual":
                return self.ack(cid, False, "not_manual")
            try:
                az, el = float(p["az"]), float(p["el"])
            except (KeyError, TypeError, ValueError):
                return self.ack(cid, False, "bad_args")
            a0, a1, e0, e1 = self.limits()
            if not (a0 <= az <= a1 and e0 <= el <= e1):
                return self.ack(cid, False, "out_of_limits")
            self.az_t, self.el_t = az, el
            return self.ack(cid, True)
        if sub == "cmd/calib":
            return self.calibration(p, cid)
        self.ack(cid, False, "unknown_cmd")

    def inject(self, p):
        if "mode" in p:                       # {"mode":"local"} / {"mode":"remote"}
            self.local = p["mode"] == "local"
            self.jog = {"az": 0, "el": 0}
        if "fault" in p:                      # {"fault":"stall"} / {"fault":null}
            self.fault = p["fault"]
            self.jog = {"az": 0, "el": 0}
        if "offline" in p:                    # {"offline":true} stops all publishing
            if p["offline"]:
                self.pub("status", "offline", retain=True, qos=1)
                self.offline = True
            else:
                self.offline = False
                self.pub("status", "online", retain=True, qos=1)
        if "wind" in p:                       # {"wind": 15} fixed wind m/s, {"wind": null} back to normal
            self.wind_override = p["wind"]
        if "rain" in p:
            self.rain = bool(p["rain"])
            self.event("rain", "info" if not self.rain else "warn", "Rain detected" if self.rain else "Rain stopped")
        if "water" in p:
            self.water = float(p["water"])
        if "gps_move_m" in p:                 # pretend the device was carried away (metres north)
            self.gps_dlat = float(p["gps_move_m"]) / 111320.0
            if self.gps_dlat:
                self.event("gps_move", "crit", f"Device moved about {int(float(p['gps_move_m']))} m")
        if "gps" in p:
            self.has_gps = bool(p["gps"])
        if "soil" in p:
            self.soil = float(p["soil"])
        if "imu_bias" in p:
            self.imu_bias = float(p["imu_bias"])
        if p.get("fault"):
            self.event("stall" if p["fault"] == "stall" else "fault", "crit", f"Fault: {p['fault']}")
        print(f"  inject -> local={self.local} fault={self.fault} offline={self.offline} wind={self.wind_override} rain={self.rain} water={self.water} soil={self.soil}")
        self.send_telemetry()

    def apply_settings(self, p):
        try:
            lim = p["limits"]
            ok = (lim["az_min"] < lim["az_max"] and lim["el_min"] < lim["el_max"]
                  and 0 <= lim["el_min"] and lim["el_max"] <= 90
                  and 0 <= lim["az_min"] and lim["az_max"] <= 360)
            rev = int(p["rev"])
        except (KeyError, TypeError, ValueError):
            return self.pub("settings/applied", {"rev": p.get("rev"), "ok": False, "reason": "bad_format"},
                            retain=True, qos=1)
        if not ok:
            return self.pub("settings/applied", {"rev": rev, "ok": False, "reason": "bad_limits"},
                            retain=True, qos=1)
        self.settings = {"rev": rev, "limits": lim, "pid": p.get("pid"),
                         "location": p.get("location"), "thresholds": p.get("thresholds") or self.settings.get("thresholds")}
        self.az_t = clamp(self.az_t, *self.limits()[:2])
        self.el_t = clamp(self.el_t, *self.limits()[2:])
        print(f"  settings rev {rev} applied")
        self.pub("settings/applied", {"rev": rev, "ok": True, "ts": int(time.time())}, retain=True, qos=1)

    def calibration(self, p, cid):
        act = p.get("action")
        c = self.calib
        if act == "start":
            self.calib = c = {"active": True, "marks": {}, "imu_offset": 0.0}
        elif act == "cancel":
            self.calib["active"] = False
        elif not c["active"]:
            return self.ack(cid, False, "not_started")
        elif act == "mark":
            what = p.get("what")
            if what not in ("az_min", "az_max", "el_min", "el_max"):
                return self.ack(cid, False, "bad_args")
            c["marks"][what] = round(self.az if what.startswith("az") else self.el, 1)
        elif act == "zero_imu":
            c["imu_offset"] = round(self.el - (self.el + self.imu_bias), 2)   # = -bias
        elif act == "set_az_ref":
            try:
                self.az = float(p["az"])
            except (KeyError, TypeError, ValueError):
                return self.ack(cid, False, "bad_args")
            self.az_t = self.az
        elif act == "commit":
            m = c["marks"]
            need = ("az_min", "az_max", "el_min", "el_max")
            if not all(k in m for k in need) or m["az_min"] >= m["az_max"] or m["el_min"] >= m["el_max"]:
                return self.ack(cid, False, "incomplete_marks")
            self.hard = dict(m)
            self.calibrated = True
            c["active"] = False
        else:
            return self.ack(cid, False, "bad_args")
        self.ack(cid, True)
        self.pub("calib/state", {"active": c["active"], "marks": c["marks"], "imu_offset": c["imu_offset"],
                                 "calibrated": self.calibrated, "hard": self.hard,
                                 "az_deg": round(self.az, 1), "el_deg": round(self.el, 1)}, retain=True)

    def clean_cmd(self, p, cid):
        act = p.get("action")
        if act == "stop":
            if self.cleaning == "running":
                self.cleaning = "idle"
            return self.ack(cid, True)
        if act != "start":
            return self.ack(cid, False, "bad_args")
        if self.cleaning == "running":
            return self.ack(cid, False, "busy")
        if self.water < 10:
            return self.ack(cid, False, "low_water")
        if self.wind() >= self.thr("wind_stow_ms", 12):
            return self.ack(cid, False, "wind_high")
        self.cleaning = "running"
        self.clean_end = time.time() + (8 if self.a.demo else 15)
        self.water = max(0.0, self.water - 8)
        self.ack(cid, True)
        self.event("clean_start", "info", "Cleaning cycle started")
        self.send_telemetry()

    def slow_checks(self):
        """Once a second: auto-stow in strong wind, finish cleaning, low-water event."""
        now = time.time()
        w = self.wind()
        if (not self.stowed and not self.estop and not self.fault and not self.local
                and w >= self.thr("wind_stow_ms", 12)):
            self.stowed = True
            self.jog = {"az": 0, "el": 0}
            self.event("wind_stow", "warn", f"Wind {w:.1f} m/s above the stow limit. Moving to the safe position")
        if self.cleaning == "running" and now >= self.clean_end:
            self.soil = 1.0
            self.cleaning = "done"
            self.clean_end = now + 5
            self.event("clean_done", "info", "Cleaning cycle finished")
        elif self.cleaning == "done" and now >= self.clean_end:
            self.cleaning = "idle"
        low = self.water <= self.thr("low_water_pct", 20)
        if low and not self.low_water_sent:
            self.event("low_water", "warn", f"Cleaning water at {self.water:.0f} percent")
        self.low_water_sent = low

    # ---------- physics ----------
    def step(self, dt):
        a0, a1, e0, e1 = self.limits()
        # heartbeat watchdog: no heartbeat -> stop jogging
        if (self.jog["az"] or self.jog["el"]) and time.time() - self.last_hb > HEARTBEAT_TIMEOUT:
            self.jog = {"az": 0, "el": 0}
            print("  heartbeat lost -> jog stopped")
        before = (self.az, self.el)
        if self.estop or self.fault or self.local:
            pass
        elif self.stowed:                                   # safe position: azimuth south, elevation at its lowest
            self.az_t, self.el_t = clamp(180.0, a0, a1), e0
            for attr, tgt in (("az", self.az_t), ("el", self.el_t)):
                cur = getattr(self, attr)
                setattr(self, attr, cur + clamp(tgt - cur, -SPEED_DEG_S * dt, SPEED_DEG_S * dt))
        else:
            if self.mode == "auto":
                saz, sel, _ = self.sun()
                self.az_t, self.el_t = clamp(saz, a0, a1), clamp(sel, e0, e1)
            if self.jog["az"] or self.jog["el"]:
                self.az = clamp(self.az + self.jog["az"] * SPEED_DEG_S * dt, a0, a1)
                self.el = clamp(self.el + self.jog["el"] * SPEED_DEG_S * dt, e0, e1)
                self.az_t, self.el_t = self.az, self.el
            else:
                for attr, tgt in (("az", self.az_t), ("el", self.el_t)):
                    cur = getattr(self, attr)
                    setattr(self, attr, cur + clamp(tgt - cur, -SPEED_DEG_S * dt, SPEED_DEG_S * dt))
        self.moving = abs(self.az - before[0]) + abs(self.el - before[1]) > 1e-4

    def send_telemetry(self):
        saz, sel, irr = self.sun()
        mism = math.hypot((saz - self.az) * math.cos(math.radians(sel)), sel - self.el)
        power = 300 * irr * self.soil * max(0.0, math.cos(math.radians(min(mism, 90)))) * random.uniform(0.97, 1.03)
        # fixed reference panel (tilt = latitude, facing south) for the tracking-gain comparison
        r = math.radians
        cos_inc = max(0.0, math.sin(r(sel)) * math.cos(r(self.lat)) + math.cos(r(sel)) * math.sin(r(self.lat)) * math.cos(r(saz - 180)))
        fixed = 300 * irr * self.soil * cos_inc * random.uniform(0.97, 1.03)
        volt = 18.0 + random.uniform(-0.3, 0.3)
        mode = "fault" if self.fault else ("local" if self.local else ("stow" if self.stowed else self.mode))
        t = {"source": "simulator", "ts": int(time.time()), "mode": mode, "estop": self.estop,
             "fault": self.fault, "moving": self.moving,
             "power_w": round(power, 1), "voltage_v": round(volt, 2), "current_a": round(power / volt, 2),
             "az_deg": round(self.az, 1), "el_deg": round(self.el, 1),
             "az_target": round(self.az_t, 1), "el_target": round(self.el_t, 1),
             "imu_pitch_deg": round(self.el + self.imu_bias + self.calib["imu_offset"] + random.uniform(-.5, .5), 1),
             "temp_c": round(30 + random.uniform(-1, 1), 1),
             "rev": self.settings["rev"], "calibrated": self.calibrated,
             "fixed_power_w": round(fixed, 1), "irradiance_wm2": round(1000 * irr), "wind_ms": round(self.wind(), 1),
             "rain": self.rain, "water_pct": round(self.water), "cleaning": self.cleaning}
        if self.has_gps:
            t["lat"] = round(self.lat + self.gps_dlat, 6)
            t["lon"] = round(self.lon, 6)
        self.last_telemetry = t
        self.last_tel = time.time()
        self.pub("telemetry", t)

    # ---------- main loop ----------
    async def run(self):
        self.loop = asyncio.get_running_loop()
        self.connect_mqtt()
        server = None
        if ws_serve and not self.a.no_ws:
            server = await ws_serve(self.ws_handler, "0.0.0.0", self.a.ws_port)
            print(f"Local direct link (ESP32 emulation): ws://localhost:{self.a.ws_port}")
        print("Simulator running. Ctrl+C to stop." + ("  [demo clock: 1 h = 20 s]" if self.a.demo else ""))
        try:
            while True:
                self.step(TICK)
                if time.time() - self.last_slow >= 1.0:
                    self.last_slow = time.time()
                    if not self.offline:
                        self.slow_checks()
                every = 0.5 if self.moving else 2.0
                if not self.offline and time.time() - self.last_tel >= every:
                    self.send_telemetry()
                await asyncio.sleep(TICK)
        finally:
            self.pub("status", "offline", retain=True, qos=1)
            if self.mq:
                time.sleep(0.3)
                self.mq.loop_stop()
                self.mq.disconnect()
            if server:
                server.close()

    # ---------- MQTT ----------
    def connect_mqtt(self):
        a = self.a
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"sim-{random.randrange(1 << 24):06x}")
        if a.user:
            c.username_pw_set(a.user, a.password)
        if a.tls:
            c.tls_set()
        c.will_set(f"{self.prefix}/status", "offline", qos=1, retain=True)

        def on_connect(cl, _u, _f, rc, _p):
            print(f"MQTT connected to {a.host}:{a.port} (rc={rc})")
            cl.publish(f"{self.prefix}/status", "online", qos=1, retain=True)
            for t in ("cmd/#", "settings/set", "sim/inject"):
                cl.subscribe(f"{self.prefix}/{t}", qos=1)

        def on_message(_cl, _u, msg):
            sub = msg.topic[len(self.prefix) + 1:]
            try:
                p = json.loads(msg.payload.decode())
            except ValueError:
                p = {}
            self.loop.call_soon_threadsafe(self.on_cmd, sub, p)

        c.on_connect, c.on_message = on_connect, on_message
        c.connect_async(a.host, a.port, keepalive=30)
        c.loop_start()
        self.mq = c

    # ---------- local WebSocket (ESP32 direct link emulation) ----------
    async def ws_handler(self, ws):
        self.clients.add(ws)
        print(f"Local client connected ({len(self.clients)})")
        await ws.send(json.dumps({"topic": "status", "payload": "online"}))
        if self.last_telemetry:
            await ws.send(json.dumps({"topic": "telemetry", "payload": self.last_telemetry}))
        try:
            async for raw in ws:
                try:
                    m = json.loads(raw)
                    self.on_cmd(m["topic"], m.get("payload", {}))
                except (ValueError, KeyError, TypeError):
                    pass
        finally:
            self.clients.discard(ws)
            print("Local client left")


def main():
    ap = argparse.ArgumentParser(description="SolMate tracker simulator")
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--tls", action="store_true")
    ap.add_argument("--user")
    ap.add_argument("--password")
    ap.add_argument("--prefix", default="solmate/unit1")
    ap.add_argument("--ws-port", type=int, default=8081)
    ap.add_argument("--no-ws", action="store_true", help="disable the local direct WebSocket")
    ap.add_argument("--demo", action="store_true", help="fast daylight clock for watching tracking")
    args = ap.parse_args()
    try:
        asyncio.run(Tracker(args).run())
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
