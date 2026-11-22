// Two connections to the device, one active "route":
//   cloud = MQTT over WebSockets to a broker (wss:// for the real cloud broker)
//   local = direct WebSocket to the ESP32 on the home network (same messages as {topic, payload})
// Route rule: use LOCAL while it is up and delivering data, otherwise CLOUD, otherwise none.
// Both keep reconnecting in the background, so the app switches back to local by itself.
// Week 8: clear status text, login failures stop the retry loop, instant retry when the network or app returns.
import { PREFIX } from './store.js';

const SUBS = ['telemetry', 'status', 'ack', 'event', 'settings/applied', 'calib/state'];
const LOCAL_FRESH_MS = 6000;      // local counts as usable if it delivered something this recently
const LOCAL_DEAD_MS = 15000;      // silent this long: drop the socket and reconnect
const AUTH_RE = /not authori|bad user|bad username|credential|unauthori/i;

const parse = (p) => {
  const t = typeof p === 'string' ? p : new TextDecoder().decode(p);
  try { return JSON.parse(t); } catch { return t; }
};

export class Link {
  constructor() {
    this.h = {};
    this.route = null;
    this.local = { state: 'off', lastRx: 0, error: '', attempt: 0, nextAt: 0 };   // off | blocked | connecting | up | down
    this.cloud = { state: 'off', error: '', attempt: 0, nextAt: 0 };              // + auth (login refused)
    this.ws = null; this.mq = null; this.conn = null;
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { this.log('network is back'); this.kick(); });
      window.addEventListener('offline', () => this.log('network lost'));
      document.addEventListener('visibilitychange', () => { if (!document.hidden) this.kick(); });
    }
  }

  on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); }
  emit(ev, ...a) { (this.h[ev] || []).forEach((f) => f(...a)); }
  log(msg) { this.emit('log', msg); }

  start(conn) {
    this.stop();
    this.conn = conn;
    this.startCloud();
    this.startLocal();
    this.tickTimer = setInterval(() => this.tick(), 1000);
  }

  stop() {
    clearInterval(this.tickTimer);
    clearTimeout(this.localRetry);
    if (this.ws) { const w = this.ws; this.ws = null; try { w.close(); } catch { /* ignore */ } }
    if (this.mq) { try { this.mq.end(true); } catch { /* ignore */ } this.mq = null; }
    this.cloud.attempt = 0; this.local.attempt = 0;
    this.setCloud('off'); this.setLocal('off');
    this.route = null;
  }

  setCloud(state, error = '') {
    if (state !== this.cloud.state) this.log(`cloud ${state}${error ? ': ' + error : ''}`);
    this.cloud.state = state; this.cloud.error = error; this.evalRoute(); this.emit('state');
  }
  setLocal(state, error = '') {
    if (state !== this.local.state) this.log(`local ${state}${error ? ': ' + error : ''}`);
    this.local.state = state; this.local.error = error; this.evalRoute(); this.emit('state');
  }

  // Short human text for the status strip
  statusText(which) {
    const s = this[which]; const wait = Math.max(0, Math.ceil((s.nextAt - Date.now()) / 1000));
    switch (s.state) {
      case 'up': return 'Connected';
      case 'connecting': return s.attempt > 1 ? `Connecting... (try ${s.attempt})` : 'Connecting...';
      case 'down': return wait > 0 ? `Disconnected, retry in ${wait} s` : 'Disconnected';
      case 'auth': return 'Login refused';
      case 'blocked': return 'Blocked';
      default: return 'Off';
    }
  }

  // ---- cloud (MQTT over WebSockets) ----
  startCloud() {
    const c = this.conn;
    if (!c.cloudUrl) return this.setCloud('off');
    if (location.protocol === 'https:' && c.cloudUrl.startsWith('ws://'))
      return this.setCloud('blocked', 'This page is HTTPS, so the broker URL must start with wss://');
    if (c.cloudPass && !c.cloudUser) return this.setCloud('blocked', 'A password needs a username. Enter the cloud username in Settings.');
    if (typeof mqtt === 'undefined') return this.setCloud('down', 'mqtt.js not loaded (check vendor/mqtt.min.js)');
    this.setCloud('connecting');
    let mq;
    try {
      mq = mqtt.connect(c.cloudUrl, {
        clientId: 'web-' + Math.random().toString(16).slice(2, 10),
        username: c.cloudUser || undefined,
        password: c.cloudPass || undefined,
        reconnectPeriod: 3000, connectTimeout: 8000, keepalive: 30,
        clean: true,
        queueQoSZero: false,      // never queue commands while offline: a stale "move" must not fire later
      });
    } catch (e) { return this.setCloud('down', String(e.message || e)); }
    this.mq = mq;
    mq.on('connect', () => {
      if (this.mq !== mq) return;                       // ignore events from a connection that was replaced
      this.cloud.attempt = 0;
      SUBS.forEach((s) => mq.subscribe(`${PREFIX}/${s}`, { qos: 1 }));
      this.setCloud('up');
    });
    mq.on('reconnect', () => { if (this.mq !== mq) return; this.cloud.attempt++; this.setCloud('connecting', this.cloud.error); });
    mq.on('close', () => { if (this.mq !== mq) return; if (this.cloud.state !== 'off' && this.cloud.state !== 'auth') { this.cloud.nextAt = Date.now() + 3000; this.setCloud('down', this.cloud.error); } });
    mq.on('error', (e) => {
      if (this.mq !== mq) return;
      const msg = String((e && e.message) || e);
      this.cloud.error = msg;
      if (AUTH_RE.test(msg) || [4, 5, 134, 135].includes(e && e.code)) {      // wrong login: retrying forever would only hammer the broker
        try { mq.end(true); } catch { /* ignore */ }
        if (this.mq === mq) this.mq = null;
        return this.setCloud('auth', 'The broker refused the username or password. Fix them in Settings and press Save.');
      }
      this.emit('state');
    });
    mq.on('message', (topic, payload) => this.mq === mq && this.rx(topic.slice(PREFIX.length + 1), parse(payload), 'cloud'));
  }

  // ---- local (direct WebSocket to the ESP32) ----
  startLocal() {
    const c = this.conn;
    if (!c.localEnabled || !c.localUrl) return this.setLocal('off');
    if (location.protocol === 'https:' && c.localUrl.startsWith('ws://'))
      return this.setLocal('blocked', 'Browsers block ws:// from an HTTPS page. Open the app from the local http:// address.');
    this.backoff = 2000;
    this.openLocal();
  }

  openLocal() {
    this.local.attempt++;
    this.setLocal('connecting');
    let ws;
    try { ws = new WebSocket(this.conn.localUrl); } catch (e) { return this.retryLocal(String(e.message || e)); }
    this.ws = ws;
    const giveUp = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } }, 4000);
    ws.onopen = () => { clearTimeout(giveUp); this.backoff = 2000; this.local.attempt = 0; this.local.lastRx = Date.now(); this.setLocal('up'); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (!m || typeof m.topic !== 'string') return;
      this.local.lastRx = Date.now();
      this.rx(m.topic, m.payload, 'local');
    };
    ws.onclose = () => { clearTimeout(giveUp); if (this.ws === ws) { this.ws = null; this.retryLocal(); } };
    ws.onerror = () => { /* onclose follows */ };
  }

  retryLocal(err = '') {
    if (this.local.state === 'off') return;
    this.local.nextAt = Date.now() + this.backoff;
    this.setLocal('down', err);
    this.localRetry = setTimeout(() => this.openLocal(), this.backoff);
    this.backoff = Math.min(this.backoff * 1.5, 15000);
  }

  // Retry now (network came back, or the app was reopened) instead of waiting for the timers.
  kick() {
    if (!this.conn) return;
    if (this.local.state === 'down' && this.conn.localEnabled) { clearTimeout(this.localRetry); this.backoff = 2000; this.openLocal(); }
    if (this.mq && !this.mq.connected && this.cloud.state !== 'auth') { try { this.mq.reconnect(); } catch { /* ignore */ } }
  }

  // ---- shared ----
  rx(sub, payload, via) { this.evalRoute(); this.emit('message', sub, payload, via); }

  tick() {
    if (this.local.state === 'up' && Date.now() - this.local.lastRx > LOCAL_DEAD_MS && this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }     // silent link: force a reconnect
    }
    this.evalRoute();
    this.emit('state');                                    // refreshes "retry in N s"
  }

  evalRoute() {
    const localOk = this.local.state === 'up' && Date.now() - this.local.lastRx < LOCAL_FRESH_MS;
    const r = localOk ? 'local' : this.cloud.state === 'up' ? 'cloud' : null;
    if (r !== this.route) { this.log(`route ${this.route || 'none'} -> ${r || 'none'}`); this.route = r; this.emit('route', r); }
  }

  viaLocal(sub, payload) {
    if (this.ws && this.ws.readyState === 1 && this.local.state === 'up') { this.ws.send(JSON.stringify({ topic: sub, payload })); return true; }
    return false;
  }
  viaCloud(sub, payload, { qos = 0, retain = false } = {}) {
    if (this.mq && this.mq.connected) { this.mq.publish(`${PREFIX}/${sub}`, JSON.stringify(payload), { qos, retain }); return true; }
    return false;
  }

  // send(sub, payload, {qos, retain, all}). all:true = every link that is up (used for E-stop and settings).
  send(sub, payload, opts = {}) {
    if (opts.all) { const a = this.viaLocal(sub, payload); const b = this.viaCloud(sub, payload, opts); return a || b; }
    if (this.route === 'local') return this.viaLocal(sub, payload);
    if (this.route === 'cloud') return this.viaCloud(sub, payload, opts);
    return false;
  }

  // Force one specific link (used by the link test in Diagnostics)
  sendVia(route, sub, payload, opts = {}) { return route === 'local' ? this.viaLocal(sub, payload) : this.viaCloud(sub, payload, opts); }
}
