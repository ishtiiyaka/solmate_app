// Sun position (NOAA algorithm) and day helpers. Accuracy about 0.1 degree, enough for a tracker plot.
const R = Math.PI / 180;

export function solarPosition(date, lat, lon) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const t = (jd - 2451545) / 36525;
  const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c = Math.sin(m * R) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(2 * m * R) * (0.019993 - 0.000101 * t) + Math.sin(3 * m * R) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const lambda = l0 + c - 0.00569 - 0.00478 * Math.sin(omega * R);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * R);
  const decl = Math.asin(Math.sin(eps * R) * Math.sin(lambda * R)) / R;
  const y = Math.tan((eps * R) / 2) ** 2;
  const eqTime = (4 / R) * (y * Math.sin(2 * l0 * R) - 2 * e * Math.sin(m * R) + 4 * e * y * Math.sin(m * R) * Math.cos(2 * l0 * R)
    - 0.5 * y * y * Math.sin(4 * l0 * R) - 1.25 * e * e * Math.sin(2 * m * R));            // minutes
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const tst = (((utcMin + eqTime + 4 * lon) % 1440) + 1440) % 1440;                       // true solar time, minutes
  const ha = tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180;                                 // hour angle, degrees
  const cosZ = Math.sin(lat * R) * Math.sin(decl * R) + Math.cos(lat * R) * Math.cos(decl * R) * Math.cos(ha * R);
  const zen = Math.acos(Math.max(-1, Math.min(1, cosZ))) / R;
  const sinZ = Math.sin(zen * R);
  let az = 180;
  if (sinZ > 1e-6) {
    const a = Math.acos(Math.max(-1, Math.min(1, (Math.sin(lat * R) * cosZ - Math.sin(decl * R)) / (Math.cos(lat * R) * sinZ)))) / R;
    az = ha > 0 ? (a + 180) % 360 : (540 - a) % 360;
  }
  return { az, el: 90 - zen, decl };
}

// minutes east of UTC for a time zone at a given moment
export function tzOffset(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000;
}

export function startOfDay(date, tz) {
  const off = tzOffset(date, tz);
  const localMs = date.getTime() + off * 60000;
  return new Date(Math.floor(localMs / 86400000) * 86400000 - off * 60000);
}

export function dayKey(ts, tz) {                       // 'YYYY-MM-DD' in the site's time zone
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}

// Sun positions over one local day, every stepMin minutes, only while the sun is up.
export function sunPath(date, lat, lon, tz, stepMin = 10) {
  const t0 = startOfDay(date, tz).getTime(); const out = [];
  for (let m = 0; m < 1440; m += stepMin) {
    const d = new Date(t0 + m * 60000); const p = solarPosition(d, lat, lon);
    if (p.el > -0.5) out.push({ t: d.getTime(), az: p.az, el: p.el });
  }
  return out;
}

export function sunTimes(path) {
  if (!path.length) return null;
  const peak = path.reduce((a, b) => (b.el > a.el ? b : a));
  return { rise: path[0].t, set: path[path.length - 1].t, noon: peak.t, maxEl: peak.el };
}

// angle between sun and a fixed panel (tilt from horizontal, facing panelAz). Returns cos of incidence (0 if behind).
export function cosIncidence(sunAz, sunEl, tilt, panelAz = 180) {
  const c = Math.sin(sunEl * R) * Math.cos(tilt * R) + Math.cos(sunEl * R) * Math.sin(tilt * R) * Math.cos((sunAz - panelAz) * R);
  return Math.max(0, c);
}

// distance in metres between two lat/lon points (haversine)
export function distanceM(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * R; const dLon = (lon2 - lon1) * R;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * R) * Math.cos(lat2 * R) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
