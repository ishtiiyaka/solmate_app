# SolMate App v1.0 (Weeks 1-10)

Phone-friendly web app for the SolMate dual-axis solar tracker. Plain HTML/CSS/JavaScript modules, no build step. Works with a simulator now and with the real ESP32 later (same messages).

| Week | What the app does |
|---|---|
| 1 | Live read-only dashboard over MQTT, simulator, local broker |
| 2 | Cloud broker (wss) + direct local link with automatic switching, online/last seen, installable app, jog, sliders, E-stop |
| 3 | Auto/manual, safety states (offline, fault, E-stop, local control), saved positions, large-move confirmation |
| 4 | Settings with validation and publish to device, calibration wizard, browser history |
| 5 | Charts, daily energy, tracking gain vs fixed panel, sun-path plot, CSV export and import, demo data |
| 6 | Event log, alerts and notifications, map and GPS movement alert |
| 7 | Cleaning control and log, soiling ratio, next clean, wind/rain/stow status, weather forecast |
| 8 | PIN lock, encrypted saved password, auto-lock, read-only mode, security checklist, clear login errors, faster reconnect |
| 9 | Link test (round trip, loss), E-stop timing, diagnostics report, link log |
| 10 | Version 1.0, CSV import of comparison results, final documentation |

## One-time setup (Windows)
```
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```
Install Mosquitto (https://mosquitto.org/download/) if you have not already.

## Run everything
```
start.bat            (or:  python run_all.py   /   python run_all.py --demo)
```
Opens http://localhost:8000. `--demo` gives the simulator a fast daylight clock (1 hour = 20 s).
Phone on the same Wi-Fi: open `http://<laptop-ip>:8000`, and use the laptop address in Settings > Connection.

## Test situations
```
python sim\inject.py local | remote | fault | clear | offline | online
python sim\inject.py wind 15 | calm | rain | dry | lowwater | refill
python sim\inject.py gps 200 | gpsback | nogps | gpson | dirty | cleanpanel | mismatch | fixmismatch
```

## Files
| File | Purpose |
|---|---|
| `index.html`, `styles.css` | Screens and look (6 tabs, dialogs, lock screen) |
| `js/app.js` | Entry point: Live tab, Control tab, presets, install prompt |
| `js/core.js` | Shared state, safety rules, commands and acknowledgements, jog, E-stop, stow |
| `js/link.js` | Cloud (MQTT) + local (WebSocket) links, automatic switching, login-error handling |
| `js/store.js` | Defaults, saved data, validation rules, app version |
| `js/settings.js`, `js/wizard.js` | Settings, publish to device, calibration wizard |
| `js/history.js`, `js/historyview.js`, `js/analysis.js`, `js/charts.js`, `js/sun.js`, `js/demodata.js` | History storage, Charts tab, energy/gain/soiling maths, canvas charts, sun position, demo data |
| `js/events.js`, `js/mapview.js`, `js/care.js` | Event log and alerts, map and GPS, cleaning/soiling/weather |
| `js/security.js`, `js/diag.js` | PIN lock and encryption, link test and diagnostics |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installable app and offline start |
| `vendor/mqtt.min.js` | mqtt.js 5.10.1 stored locally so the app works with no internet |
| `sim/simulator.py`, `sim/inject.py` | Fake tracker (MQTT + local WebSocket) and test-event helper |
| `docs/TOPICS.md` | Message contract v2.0 for the firmware side |
| `mosquitto.conf`, `run_all.py`, `start.bat`, `requirements.txt` | Local broker and one-click launcher |

Before deploying a change: edit `VERSION` in `sw.js` and in `js/store.js` so phones fetch the new files.
