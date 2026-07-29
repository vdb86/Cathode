// SPDX-License-Identifier: GPL-3.0-or-later
// Multi-account system: the rail account label/avatar, the "Who's watching"
// startup picker, account switching, and the Settings > Accounts management
// menus. Extracted from app.js (renderer ES-module split, s102). Drives menu.js
// for the switch/manage menus. Settings / window.tv / Nav are classic-script
// globals; the account-scoped caches live on state.
//
// Two app.js-owned functions are injected via initAccounts:
//   stopForAccountSwitch -- player teardown (reads bgPlaying/currentVideoId/
//     userQueue + stopPlayback/updateRailQueueItem), kept in app.js.
//   loadSection -- (re)loads a feed section after an account change.

import { $, show, hide, toast } from './util.js';
import { state } from './state.js';
import { showMenu, renderMenu, closeMenu } from './menu.js';

// "Who's watching" picker state.
let pickerAccounts = [];
let pickerIndex = 0;

// Injected app.js functions (set at boot by initAccounts).
let stopForAccountSwitch = () => {};
let loadSection = () => {};

export function initAccounts(deps) {
  stopForAccountSwitch = deps.stopForAccountSwitch;
  loadSection = deps.loadSection;
}

function setAccountLabel(name) { $('signin-label').textContent = name || 'Sign in'; state.currentAccountName = name || 'Guest'; }
// Top-left rail avatar: show the signed-in account's profile photo. No URL
// (signed out / no photo) hides the img so the CSS person fallback shows
// instead of a broken image.
function setAccountAvatar(url) {
  const img = $('account-avatar');
  if (!img) return;
  if (url) { img.src = url; img.classList.remove('hidden'); }
  else { img.removeAttribute('src'); img.classList.add('hidden'); }
}

export async function refreshAccountLabel() {
  try {
    const d = await window.tv.listAccounts();
    const s = d.accounts.find((a) => a.selected);
    setAccountLabel(s && s.name);
    setAccountAvatar(s && s.avatar);
  } catch (e) { /* leave label as-is */ }
}

// Clear renderer-side cached lists so a switched/removed account never shows
// the previous account's data.
export function resetAccountScopedCaches() {
  state.subsChannels = null; state.currentPlaylists = null; state.currentMusic = null; state.wlIds = null;
}

// Finalize entering an account: load ITS settings, reset renderer caches and
// load the boot feed. Used by every entry path (picker choose, boot
// 'last'/'default', add/switch).
export async function finalizeAccount(name) {
  stopForAccountSwitch();
  setAccountLabel(name);
  refreshAccountLabel();
  const tok = ++state.loadToken; // claim this (boot) navigation before the await
  try { await Settings.reload(); } catch (e) {}
  resetAccountScopedCaches();
  // If the user navigated away during the await (e.g. opened Settings, which bumps
  // loadToken), a newer token exists -> don't override their screen with the boot
  // feed (that was the "videos appear on the Settings grid" bug).
  if (state.loadToken !== tok) return;
  loadSection(Settings.get('bootSection') || 'home');
  state.mode = 'browse';
  Nav.apply();
}

// Switch the active account (id may be 'guest') then finalize.
export async function enterAccount(id) {
  try {
    const r = await window.tv.selectAccount(id);
    // Belt-and-suspenders: a restored (creds-less) account resolves with
    // needsRelogin instead of entering -- route to the sign-in flow.
    if (r && r.needsRelogin) { return startAddAccount(); }
    await finalizeAccount(r && r.name);
  } catch (e) {
    toast('Could not load that account');
    await finalizeAccount(null);
  }
}

export async function showPicker() {
  let data;
  try { data = await window.tv.listAccounts(); }
  catch (e) { return finalizeAccount(null); } // fall back to whatever is active
  pickerAccounts = data.accounts.slice();
  pickerAccounts.push({ id: '__add', name: 'Add account', add: true });
  pickerAccounts.push({ id: '__exit', name: 'Exit', exit: true });
  const sel = pickerAccounts.findIndex((a) => a.selected);
  pickerIndex = sel >= 0 ? sel : 0;
  $('picker-title').textContent = 'Who’s watching?';
  renderPicker(data.defaultId);
  show('picker-overlay');
  state.mode = 'picker';
}

function renderPicker(defaultId) {
  const list = $('picker-list');
  list.innerHTML = '';
  pickerAccounts.forEach((a, i) => {
    const tile = document.createElement('div');
    tile.className = 'picker-tile' + (i === pickerIndex ? ' focused' : '') +
      ((a.add || a.exit) ? ' picker-add' : '') + (!a.add && !a.exit && a.id === defaultId ? ' is-default' : '');
    const ava = document.createElement('div');
    ava.className = 'picker-ava';
    if (a.add) ava.textContent = '＋';
    else if (a.exit) ava.textContent = '🚪';
    else if (a.avatar) { const img = document.createElement('img'); img.src = a.avatar; ava.appendChild(img); }
    const nm = document.createElement('div');
    nm.className = 'picker-name';
    nm.textContent = a.name;
    tile.appendChild(ava); tile.appendChild(nm);
    // Restored (creds-less) account: flag it so the user knows selecting it
    // re-runs sign-in rather than entering directly.
    if (a.needsRelogin) {
      tile.classList.add('needs-relogin');
      const badge = document.createElement('div');
      badge.className = 'relogin-badge';
      badge.textContent = '⚠ Sign in again';
      tile.appendChild(badge);
    }
    list.appendChild(tile);
  });
}

function applyPickerFocus() {
  const els = $('picker-list').children;
  for (let i = 0; i < els.length; i++) els[i].classList.toggle('focused', i === pickerIndex);
  if (els[pickerIndex]) els[pickerIndex].scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

async function choosePicker() {
  const a = pickerAccounts[pickerIndex];
  if (!a) return;
  if (a.exit) { window.tv.quit(); return; }
  hide('picker-overlay');
  // 'Add account' AND restored (needsRelogin) accounts share the sign-in
  // flow: addAccount() de-dupes by handle/name and reattaches the existing id.
  if (a.add || a.needsRelogin) {
    // Device-code flow, then enter the (re)signed-in account.
    try {
      const r = await window.tv.addAccount();
      hide('auth-overlay');
      await finalizeAccount(r && r.name);
    } catch (e) { toast('Sign-in failed: ' + (e.message || 'error')); return showPicker(); }
    return;
  }
  toast('Loading ' + a.name + '…');
  await enterAccount(a.id); // selectAccount handles the 'guest' id too
}

// "Who's watching" startup picker is modal. app.js delegates its mode==='picker'
// router branch here.
export function handlePickerInput(a) {
  if (a === 'left' || a === 'up') { pickerIndex = Math.max(0, pickerIndex - 1); applyPickerFocus(); }
  else if (a === 'right' || a === 'down') { pickerIndex = Math.min(pickerAccounts.length - 1, pickerIndex + 1); applyPickerFocus(); }
  else if (a === 'select') choosePicker();
  else if (a === 'back') window.tv.quit(); // Back exits the app from the chooser
}

// Rail account item: switch accounts + Add account. Selecting an account
// switches to it; 'Add account' starts sign-in. Management (remove / set
// default / startup) lives in Settings > Accounts (openAccountsSettings).
export async function openAccountSwitcher() {
  showMenu();
  renderMenu([{ label: 'Loading…', run: () => {} }], 'Switch account');
  let data;
  try { data = await window.tv.listAccounts(); }
  catch (e) { toast('Couldn’t load accounts'); return closeMenu(); }
  const items = data.accounts.map((a) => {
    const mark = a.selected ? '● ' : '○ ';
    const flag = a.needsRelogin ? '  ⚠ Sign in again' : '';
    return { label: mark + a.name + flag, run: () => {
      // Restored account: re-run sign-in (reattaches by handle/name), never switch.
      if (a.needsRelogin) return startAddAccount();
      if (a.selected) closeMenu(); else doSwitchAccount(a.id, a.name);
    } };
  });
  items.push({ label: '＋ Add account', run: () => startAddAccount() });
  renderMenu(items, 'Switch account');
}

// Settings > Accounts: full management. Lists Guest + each account
// (● selected / ○ others, ★ = default) plus a Startup row and 'Add account';
// each account opens an action menu (use / set default / remove).
export async function openAccountsSettings() {
  showMenu();
  renderMenu([{ label: 'Loading…', run: () => {} }], 'Accounts');
  let data;
  try { data = await window.tv.listAccounts(); }
  catch (e) { toast('Couldn’t load accounts'); return closeMenu(); }
  const startupLabel = data.startup === 'last' ? 'Use last used account'
    : data.startup === 'default' ? 'Start with a chosen account'
    : 'Ask every time (Who’s watching)';
  const items = [{ label: 'Startup: ' + startupLabel, run: () => startupMenu() }];
  for (const a of data.accounts) {
    const mark = a.selected ? '● ' : '○ ';
    const def = (a.id === data.defaultId) ? '  ★' : '';
    const flag = a.needsRelogin ? '  ⚠ Sign in again' : '';
    items.push({ label: mark + a.name + def + flag, run: () => accountActionMenu(a) });
  }
  items.push({ label: '＋ Add account', run: () => startAddAccount() });
  renderMenu(items, 'Accounts');
}

// Startup preference submenu. (A specific default account is set from that
// account's action menu, which flips startup to 'default'.)
function startupMenu() {
  const items = [
    { label: 'Ask every time (Who’s watching)', run: () => setStartupMode('ask') },
    { label: 'Use last used account', run: () => setStartupMode('last') }
  ];
  renderMenu(items, 'Startup', openAccountsSettings);
}

async function setStartupMode(m) {
  try { await window.tv.setStartup(m); toast('Startup updated'); }
  catch (e) { toast('Could not update startup'); }
  openAccountsSettings();
}

function accountActionMenu(a) {
  const items = [];
  // Restored (creds-less) account: 'Use' must re-run sign-in (reattaches by
  // handle/name to the existing id), not the normal switch.
  if (a.needsRelogin) items.push({ label: 'Sign in again', run: () => startAddAccount() });
  else if (!a.selected) items.push({ label: 'Use this account', run: () => doSwitchAccount(a.id, a.name) });
  items.push({ label: 'Start with this account by default', run: () => doSetDefault(a) });
  if (!a.guest) items.push({ label: 'Remove account', run: () => doRemoveAccount(a) });
  renderMenu(items, a.name, openAccountsSettings);
}

async function doSetDefault(a) {
  try { await window.tv.setDefaultAccount(a.id); toast(a.name + ' is now the default'); }
  catch (e) { toast('Could not set default'); }
  openAccountsSettings();
}

async function doSwitchAccount(id, name) {
  closeMenu();
  toast('Switching account…');
  try {
    const r = await window.tv.selectAccount(id);
    // Belt-and-suspenders: restored account resolves with needsRelogin instead
    // of switching -- route to the sign-in flow (reattaches the existing id).
    if (r && r.needsRelogin) { return startAddAccount(); }
    stopForAccountSwitch();
    setAccountLabel((r && r.name) || name);
    refreshAccountLabel(); // pull the switched-to account's profile photo for the rail avatar
    const tok = ++state.loadToken;
    try { await Settings.reload(); } catch (e) {} // load the new account's settings
    resetAccountScopedCaches();
    if (state.loadToken === tok) loadSection(Settings.get('bootSection') || 'home');
    toast('Switched to ' + ((r && r.name) || name || 'account'));
  } catch (e) { toast('Switch failed: ' + (e.message || 'error')); }
}

async function doRemoveAccount(a) {
  closeMenu();
  try {
    await window.tv.removeAccount(a.id);
    await refreshAccountLabel();
    // Removing the ACTIVE account switches to another (or Guest) -- reload its
    // settings + Home. Removing a background account leaves the view alone.
    if (a.selected) { stopForAccountSwitch(); const tok = ++state.loadToken; try { await Settings.reload(); } catch (e) {} resetAccountScopedCaches(); if (state.loadToken === tok) loadSection(Settings.get('bootSection') || 'home'); }
    toast('Removed ' + a.name);
  } catch (e) { toast('Remove failed: ' + (e.message || 'error')); }
}

function startAddAccount() {
  closeMenu();
  // Device-code flow: onAuthPending shows the code overlay; resolves on done.
  window.tv.addAccount().then(async (r) => {
    hide('auth-overlay');
    state.mode = 'browse';
    stopForAccountSwitch();
    setAccountLabel(r && r.name);
    refreshAccountLabel(); // pull the new account's profile photo for the rail avatar
    const tok = ++state.loadToken;
    try { await Settings.reload(); } catch (e) {} // load the new account's settings
    resetAccountScopedCaches();
    if (state.loadToken === tok) loadSection(Settings.get('bootSection') || 'home');
    Nav.apply();
  }).catch((err) => { toast('Sign-in failed: ' + (err.message || 'error')); });
}
