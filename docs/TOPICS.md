# SolMate message contract (app <-> device), v2.0

Prefix: `solmate/unit1/`. Payloads are JSON unless noted. The same messages travel two ways:
- **Cloud**: MQTT topics exactly as below (EMQX Cloud Serverless, TLS only).
- **Local direct** (ESP32 WebSocket, default port 8081): one JSON text frame per message: `{"topic":"<suffix>","payload":<json>}`
  (suffix = the part after the prefix, e.g. `{"topic":"cmd/jog","payload":{"axis":"az","dir":1,"seq":4}}`).

New in v2.0 are marked **(new)**. Every new telemetry field is optional: the app shows `--` and hides the feature when a field is missing.

## Device -> app
| Topic | QoS / retain | Payload |
|---|---|---|
| `telemetry` | 0 / no | `{source, ts, mode, estop, fault, moving, power_w, voltage_v, current_a, az_deg, el_deg, az_target, el_target, imu_pitch_deg, temp_c, rev, calibrated}` every 2 s (0.5 s while moving). `mode` = `auto` \| `manual` \| `local` \| `fault` \| **`stow`** (new). `source:"simulator"` only from the simulator. |
| | | **(new, optional)** `fixed_power_w` (reference panel, for the tracking-gain comparison), `irradiance_wm2` (plane of the tracker, used for the soiling ratio), `wind_ms`, `rain` (bool), `water_pct` (cleaning water), `cleaning` (`idle`\|`running`\|`done`\|`fault`), `lat`, `lon` (GPS) |
| `status` | 1 / **retained** | plain text `online` / `offline`. `offline` must be the MQTT last will. |
| `ack` | 1 / no | `{id, ok, reason}` reply to a command that had an `id`. Also sent with `ok:false` for a rejected jog. |
| `event` **(new)** | 1 / no | `{ts, type, sev, msg, data?}`. `type`: `stall`, `overcurrent`, `sensor_loss`, `fault`, `estop`, `gps_move`, `mismatch`, `low_water`, `wind_stow`, `rain`, `clean_start`, `clean_done`. `sev`: `info`\|`warn`\|`crit`. `ts` in seconds or milliseconds. The app also detects most of these from telemetry and ignores a duplicate within 30 s. |
| `settings/applied` | 1 / **retained** | `{rev, ok, reason?, ts}` after `settings/set`. |
| `calib/state` | 0 / retained | `{active, marks:{az_min,az_max,el_min,el_max}, imu_offset, calibrated, hard, az_deg, el_deg}` |

## App -> device
| Topic | QoS / retain | Payload | Device rule |
|---|---|---|---|
| `cmd/jog` | 0 / no | `{axis:"az"\|"el", dir:-1\|0\|1, seq}` every 200 ms while a button is held | **Stop if no jog message for 600 ms.** Only in `manual`. |
| `cmd/goto` | 1 / no | `{az, el, id}` | Reject outside limits. Only in `manual`. |
| `cmd/stop` | 1 / no | `{id}` | Always honoured, in every mode. |
| `cmd/mode` | 1 / no | `{mode:"auto"\|"manual", id}` | Rejected in `local`, `fault`, E-stop. **While `stow`, this is "Resume": reject with `wind_high` if the wind is still above the stow limit minus 2 m/s.** |
| `cmd/estop` | 1 / no | `{estop:true\|false, id}` | `true` always honoured. `false` only releases the e-stop. |
| `cmd/stow` **(new)** | 1 / no | `{id}` | Move to the safe position (azimuth south, elevation lowest) and report `mode:"stow"`. The device also does this by itself when `wind_ms` reaches the stow limit. |
| `cmd/clean` **(new)** | 1 / no | `{action:"start"\|"stop", id}` | Reject with `busy`, `low_water`, `wind_high`, or the usual gate reasons. Report `cleaning:"running"` while active. |
| `cmd/ping` **(new)** | 1 / no | `{id, t}` | Reply `ack {id, ok:true}` immediately in **every** state. Used by the link test. |
| `settings/set` | 1 / **retained** | `{rev, location:{lat,lon,tz}, limits:{...}, thresholds:{confirm_az, confirm_el, wind_stow_ms, low_water_pct, mismatch_deg, overcurrent_a, gps_move_m, clean_interval_days, soil_threshold_pct, panel_rated_w}, pid:{az:{kp,ki,kd}, el:{...}}}` | Validate, store in flash, reply on `settings/applied`. Ignore a `rev` it already applied. |
| `cmd/calib` | 1 / no | `{action:"start"\|"mark"\|"zero_imu"\|"set_az_ref"\|"commit"\|"cancel", what?, az?, id}` | See `sim/simulator.py` for the reference behaviour. |

## Rejection reasons
`estop`, `fault`, `local_mode`, `not_manual`, `out_of_limits`, `bad_args`, `bad_mode`, `incomplete_marks`, `not_started`, `unknown_cmd`, **`stowed`, `wind_high`, `low_water`, `busy`** (new).

## Safety rules (never retain a motion command)
1. `cmd/*` topics are **never retained**: a retained "move" would run again every time the device reconnects.
2. The device must stop motion on its own (jog watchdog 600 ms, limit switches, over-current cutoff). The app is never the only safety layer.
3. The app E-stop is a software stop. The physical stop and limit switches stay the real safety layer.

## Recommended broker topic rules (if your plan offers authorization rules)
| Login | May publish | May subscribe |
|---|---|---|
| `solmate-device` | `solmate/unit1/telemetry`, `status`, `ack`, `event`, `settings/applied`, `calib/state` | `solmate/unit1/cmd/#`, `settings/set` |
| `solmate-app` | `solmate/unit1/cmd/#`, `settings/set` | `solmate/unit1/telemetry`, `status`, `ack`, `event`, `settings/applied`, `calib/state` |
Deny everything else. Without such rules, any valid login can publish to any topic.
