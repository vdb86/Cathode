// SPDX-License-Identifier: GPL-3.0-or-later
// Screen dimming (General > Screen dimming). After dimTimeout minutes with no
// input, fade a black overlay (#dim-overlay) in to dimAmount opacity (reduces
// brightness / burn-in). Any input wakes it instantly and that press is
// consumed (see the input router in app.js, which calls isDimmed()/wakeDim()).
// All values are read live from the global Settings (settings.js). Extracted
// from app.js (renderer ES-module split, s94).

import { $ } from './util.js';

let dimTimer = null;
let screenDimmed = false;

export function resetDimTimer() {
  clearTimeout(dimTimer);
  if (screenDimmed) return; // waking is handled by wakeDim()
  if (!Settings.get('dimEnabled')) return;
  const mins = Settings.get('dimTimeout') || 5;
  dimTimer = setTimeout(dimScreen, mins * 60 * 1000);
}

function dimScreen() {
  if (!Settings.get('dimEnabled')) return;
  const amt = Settings.get('dimAmount');
  const ov = $('dim-overlay');
  if (!ov) return;
  ov.style.opacity = String((amt == null ? 40 : amt) / 100);
  screenDimmed = true;
}

export function wakeDim() {
  const ov = $('dim-overlay');
  if (ov) {
    ov.style.transition = 'none';   // wake instantly (skip the slow fade-out)
    ov.style.opacity = '0';
    requestAnimationFrame(() => { ov.style.transition = ''; });
  }
  screenDimmed = false;
  resetDimTimer();
}

export function isDimmed() { return screenDimmed; }
