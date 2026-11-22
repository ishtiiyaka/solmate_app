"""Start the whole SolMate stack from one window.

Starts: Mosquitto broker, simulator, web server (port 8000), then opens the browser.
Press Ctrl+C to stop everything.
Option: python run_all.py --demo   (simulator uses a fast daylight clock: 1 hour = 20 s)
"""
import os
import shutil
import subprocess
import sys
import time
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)

DEFAULT_MOSQUITTO = r"C:\Program Files\mosquitto\mosquitto.exe"
mosquitto = shutil.which("mosquitto") or (DEFAULT_MOSQUITTO if os.path.exists(DEFAULT_MOSQUITTO) else None)
if not mosquitto:
    sys.exit("Could not find mosquitto. Install it or edit DEFAULT_MOSQUITTO in run_all.py.")

procs = []


def start(name, cmd):
    p = subprocess.Popen(cmd, cwd=ROOT)
    procs.append((name, p))
    print(f"[{name}] started")
    return p


try:
    broker = start("broker", [mosquitto, "-c", "mosquitto.conf"])
    time.sleep(2)
    if broker.poll() is not None:
        sys.exit("Broker exited immediately. Port 1883 may be in use (run: net stop mosquitto as Admin) "
                 "or mosquitto.conf has an error.")

    sim_cmd = [sys.executable, os.path.join("sim", "simulator.py")]
    if "--demo" in sys.argv:
        sim_cmd.append("--demo")
    start("simulator", sim_cmd)
    # --bind 0.0.0.0 lets a phone on the same Wi-Fi open http://<laptop-ip>:8000 (Week 2 onward)
    start("web", [sys.executable, "-m", "http.server", "8000", "--bind", "0.0.0.0"])
    time.sleep(1)
    webbrowser.open("http://localhost:8000")
    print("\nRunning. Dashboard: http://localhost:8000   (Ctrl+C to stop all)\n")

    while True:
        time.sleep(1)
        for name, p in procs:
            if p.poll() is not None:
                print(f"[{name}] stopped unexpectedly (exit code {p.returncode})")
                raise KeyboardInterrupt
except KeyboardInterrupt:
    pass
finally:
    print("Stopping everything...")
    for name, p in procs:
        if p.poll() is None:
            p.terminate()
    for name, p in procs:
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()
    print("Done.")
