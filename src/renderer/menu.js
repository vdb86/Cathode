// SPDX-License-Identifier: GPL-3.0-or-later
// Generic menu-overlay engine: the vertical popup list shared by the video
// context menu AND the account menus. Owns the list state, focus, and the
// mode==='menu' input router. The specific menu BUILDERS (showMainMenu,
// openVideoMenu, the account menus, etc.) stay in app.js and drive this via
// showMenu() + renderMenu(items, title, back). Extracted from app.js (renderer
// ES-module split, s98).
//
// Nav is a classic-script global (loaded before this module); state comes from
// state.js.

import { $, show, hide } from './util.js';
import { state } from './state.js';

let menuItems = [];   // current items [{label, run}]
let menuIndex = 0;
let menuBack = null;  // fn to go back one level, or null to close

function applyMenuFocus() {
  const els = $('menu-list').children;
  for (let i = 0; i < els.length; i++) els[i].classList.toggle('focused', i === menuIndex);
  // #menu-list has max-height + overflow:auto; keep the focused item in view so
  // long menus (context menu, advanced download) scroll to follow the cursor.
  const cur = els[menuIndex];
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  // Position counter (1 / N) so long menus show where the cursor is.
  const cnt = document.getElementById('menu-count');
  if (cnt) cnt.textContent = menuItems.length ? ((menuIndex + 1) + ' / ' + menuItems.length) : '';
}

// Open (or bring up) the menu overlay shell. Builders call this, then renderMenu.
export function showMenu() {
  state.mode = 'menu';
  show('menu-overlay');
}

// Fill the overlay with items. `back` (optional) is the one-level-back handler
// used by the Back action; omit / null means Back closes the menu. `keepIndex`
// preserves the cursor position across a re-render (used when a menu rebuilds
// itself in place after toggling an option, so the cursor does not jump to the
// top); it is clamped to the new item count. Fresh menus / drill-ins omit it so
// they open at the top.
export function renderMenu(items, titleText, back, keepIndex) {
  menuItems = items;
  menuIndex = keepIndex ? Math.min(menuIndex, Math.max(0, items.length - 1)) : 0;
  menuBack = back || null;
  $('menu-title').textContent = titleText || '';
  const list = $('menu-list');
  list.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('div');
    b.className = 'menu-item';
    b.textContent = it.label;
    list.appendChild(b);
  }
  applyMenuFocus();
}

export function closeMenu() {
  hide('menu-overlay');
  state.mode = 'browse';
  menuBack = null;
  Nav.apply();
}

function menuActivate() {
  const it = menuItems[menuIndex];
  if (it && it.run) it.run();
}

// app.js delegates its whole mode==='menu' branch here.
export function handleMenuInput(a) {
  if (a === 'back') { if (menuBack) { const f = menuBack; menuBack = null; f(); } else closeMenu(); return; }
  // Wrap around at the ends (Up on the first item -> last, Down on the last -> first).
  const n = menuItems.length;
  if (a === 'up') { if (n) menuIndex = (menuIndex - 1 + n) % n; applyMenuFocus(); }
  else if (a === 'down') { if (n) menuIndex = (menuIndex + 1) % n; applyMenuFocus(); }
  else if (a === 'select') menuActivate();
}
