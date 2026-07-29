// SPDX-License-Identifier: GPL-3.0-or-later
// On-screen clock / date string formatting. Pure formatters driven once a
// second by updateClock() in app.js. Reads the live clock settings each call
// (via the global Settings module from settings.js, a classic script that
// loads before this module), so a settings change takes effect within a
// second. Extracted from app.js (renderer ES-module split, s92; updateClock +
// startClock folded in s94).

import { $ } from './util.js';

const CLK_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CLK_DOW_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CLK_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CLK_MON_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const clk2 = (n) => String(n).padStart(2, '0');

function clockTimeStr(d) {
  const sec = Settings.get('clockSeconds');
  let h = d.getHours(); const m = clk2(d.getMinutes()), s = clk2(d.getSeconds());
  if (Settings.get('clockTimeFormat') === '12') {
    const ap = h < 12 ? 'AM' : 'PM'; h = h % 12; if (h === 0) h = 12;
    return h + ':' + m + (sec ? ':' + s : '') + ' ' + ap;
  }
  return clk2(h) + ':' + m + (sec ? ':' + s : '');
}

function clockDateStr(d) {
  const Y = d.getFullYear(), mo = d.getMonth(), day = d.getDate();
  const dow = CLK_DOW[d.getDay()], dowF = CLK_DOW_FULL[d.getDay()];
  const mon = CLK_MON[mo], monF = CLK_MON_FULL[mo];
  switch (Settings.get('clockDateFormat')) {
    case 'dow-md': return dow + ' ' + mon + ' ' + day;          // Wed Jul 22
    case 'dm': return day + ' ' + mon;                          // 22 Jul
    case 'md': return mon + ' ' + day;                          // Jul 22
    case 'dmy-short': return day + ' ' + mon + ' ' + Y;         // 22 Jul 2026
    case 'mdy-short': return mon + ' ' + day + ', ' + Y;        // Jul 22, 2026
    case 'dmy-long': return day + ' ' + monF + ' ' + Y;         // 22 July 2026
    case 'mdy-long': return monF + ' ' + day + ', ' + Y;        // July 22, 2026
    case 'full': return dowF + ', ' + day + ' ' + monF + ' ' + Y;      // Wednesday, 22 July 2026
    case 'full-us': return dowF + ', ' + monF + ' ' + day + ', ' + Y;  // Wednesday, July 22, 2026
    case 'dmy': return clk2(day) + '/' + clk2(mo + 1) + '/' + Y;       // 22/07/2026
    case 'mdy': return clk2(mo + 1) + '/' + clk2(day) + '/' + Y;       // 07/22/2026
    case 'ymd': return Y + '/' + clk2(mo + 1) + '/' + clk2(day);       // 2026/07/22
    case 'dmy-dot': return clk2(day) + '.' + clk2(mo + 1) + '.' + Y;   // 22.07.2026
    case 'iso': return Y + '-' + clk2(mo + 1) + '-' + clk2(day);       // 2026-07-22
    case 'dow-dm':
    default: return dow + ' ' + day + ' ' + mon;                // Wed 22 Jul
  }
}

export function clockText() {
  const d = new Date();
  const content = Settings.get('clockContent') || 'time';
  if (content === 'time') return clockTimeStr(d);
  if (content === 'date') return clockDateStr(d);
  // datetime: order controlled by clockOrder ('time' first | 'date' first).
  const t = clockTimeStr(d), dt = clockDateStr(d);
  return (Settings.get('clockOrder') === 'date' ? [dt, t] : [t, dt]).join('  ·  ');
}

// The player clock is only shown while the player HUD is visible, so
// updateClock needs to know the app's current mode. app.js passes a getter via
// startClock(() => mode); updateClock() is also called directly (from
// showTransport) to reveal/hide the player clock together with the HUD.
let getMode = () => '';

export function startClock(modeGetter) {
  if (modeGetter) getMode = modeGetter;
  setInterval(updateClock, 1000);
  updateClock();
}

export function updateClock() {
  const c = $('clock'), pc = $('player-clock');
  if (!Settings.get('clockEnabled')) {
    if (c) c.classList.add('hidden');
    if (pc) pc.classList.add('hidden');
    return;
  }
  const text = clockText();
  if (c) { c.textContent = text; c.classList.toggle('hidden', Settings.get('clockShowHome') === false); }
  // Player clock: only while the player HUD is visible (hides with the controls).
  const hudVisible = getMode() === 'player' && !$('player-hud').classList.contains('hidden');
  if (pc) { pc.textContent = text; pc.classList.toggle('hidden', !(Settings.get('clockShowPlayer') !== false && hudVisible)); }
}
