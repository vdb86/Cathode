// SPDX-License-Identifier: GPL-3.0-or-later
// On-screen keyboard, search, search-suggestions/history strip, and generic
// text entry. Extracted from app.js (renderer ES-module split, s97).
//
// The search-overlay input router lives here too: app.js delegates its whole
// mode==='search' branch to handleSearchInput(a) so the OSK/strip state stays
// encapsulated in this module (ES-module `let` exports are read-only to
// importers, so the router in app.js can't poke these vars directly).
//
// Nav / Settings / window.tv are classic-script globals (loaded before this
// module) and resolve normally here. moreExhausted (a shared Set) and
// feedErrorHint (a helper) stay owned by app.js and are injected via initOsk.

import { $, show, hide } from './util.js';
import { grid, shelvesBox, title } from './dom.js';
import { state } from './state.js';
import { renderVideoGrid } from './render.js';

// ---------- injected deps (owned by app.js) ----------
let moreExhausted = null;      // shared Set of sections whose load-more is exhausted
let feedErrorHint = () => {};  // app.js helper: annotate a failed feed load

// ---------- state ----------
let oskKeys = [];         // on-screen keyboard: 2D array of key elements
let oskRow = 1;
let oskCol = 0;
let oskCaret = 0;         // text caret position in the search field
let oskMode = 'search';   // on-screen keyboard purpose: 'search' | 'command'
let textEditCb = null;    // callback for the generic OSK text-entry mode (Settings command rows)
let oskZone = 'osk';      // search overlay focus zone: 'osk' | 'suggest'
let suggestItems = [];    // current suggestions/history strip entries (strings)
let suggestIdx = 0;
let suggestKind = 'history'; // 'history' | 'suggest' -- drives chip styling
let suggestTimer = null;     // debounce timer for live suggestions

// ---------- on-screen keyboard (search) ----------

// Search key sits top-left; navigation/edit keys form a left column so a
// single row of suggestions/history can live above the top row.
const OSK_ROWS = [
  [{ k: 'search', label: 'Search', w: 3 }, '1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  [{ k: 'caretleft', label: '◀' }, { k: 'caretright', label: '▶' }, 'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  [{ k: 'clear', label: 'Clear', w: 2 }, 'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  [{ k: 'back', label: '⌫' }, { k: 'space', label: 'Space', w: 3 }, 'z', 'x', 'c', 'v', 'b', 'n', 'm']
];

function buildOsk() {
  const osk = $('osk');
  osk.innerHTML = '';
  oskKeys = [];
  for (const row of OSK_ROWS) {
    const rowEl = document.createElement('div');
    rowEl.className = 'osk-row';
    const rowKeys = [];
    for (const key of row) {
      const def = typeof key === 'string' ? { k: key, label: key } : key;
      const btn = document.createElement('button');
      btn.className = 'osk-key' + (def.w ? ' osk-w' + def.w : '');
      btn.dataset.key = def.k;
      btn.textContent = def.label;
      rowEl.appendChild(btn);
      rowKeys.push(btn);
    }
    osk.appendChild(rowEl);
    oskKeys.push(rowKeys);
  }
}

function applyOskFocus() {
  const active = oskZone === 'osk'; // dim the keyboard while the strip has focus
  for (let r = 0; r < oskKeys.length; r++)
    for (let c = 0; c < oskKeys[r].length; c++)
      oskKeys[r][c].classList.toggle('focused', active && r === oskRow && c === oskCol);
}

function oskMove(dir) {
  if (dir === 'up') oskRow = Math.max(0, oskRow - 1);
  else if (dir === 'down') oskRow = Math.min(oskKeys.length - 1, oskRow + 1);
  else if (dir === 'left') oskCol = Math.max(0, oskCol - 1);
  else if (dir === 'right') oskCol = Math.min(oskKeys[oskRow].length - 1, oskCol + 1);
  if (oskCol > oskKeys[oskRow].length - 1) oskCol = oskKeys[oskRow].length - 1; // clamp after a row change
  applyOskFocus();
}

function oskKey(name) {
  for (const row of oskKeys) for (const b of row) if (b.dataset.key === name) return b;
  return null;
}

// The OSK serves two purposes: search, and generic command text entry.
// setOskMode relabels the submit key + the field placeholder to match.
function setOskMode(m) {
  oskMode = m;
  const sk = oskKey('search');
  if (sk) sk.textContent = m === 'command' ? 'Save' : 'Search';
  $('search-input').placeholder = m === 'command' ? 'Enter command…' : 'Search YouTube…';
  // The suggestions/history strip only makes sense for real searching.
  if (m !== 'search') { suggestItems = []; $('search-suggest').innerHTML = ''; $('search-suggest').classList.add('hidden'); }
}

// Render the per-field reference (variables + examples) shown below the
// keyboard. Variable definitions ("{name} - description") are laid out in TWO
// columns so the block stays short on small laptop screens; headings and
// example command lines span the full width. Parses the plain-text reference
// string so callers keep passing a simple string.
function renderExamples(host, text) {
  host.innerHTML = '';
  let grid = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) { grid = null; continue; } // blank line ends a variable group
    const m = line.match(/^(\{[^}]+\})\s*-\s*(.+)$/);
    if (m) {
      if (!grid) { grid = document.createElement('div'); grid.className = 'osk-var-grid'; host.appendChild(grid); }
      const cell = document.createElement('div');
      cell.className = 'osk-var';
      const code = document.createElement('code'); code.textContent = m[1];
      const desc = document.createElement('span'); desc.textContent = ' ' + m[2];
      cell.appendChild(code); cell.appendChild(desc);
      grid.appendChild(cell);
      continue;
    }
    grid = null;
    const div = document.createElement('div');
    div.className = /:$/.test(line) ? 'osk-ex-head' : 'osk-ex-line';
    div.textContent = line;
    host.appendChild(div);
  }
}

// Generic OSK text entry (Settings command rows). Reuses the search overlay;
// hides the settings dialog underneath (same z-index) while typing and
// restores it on commit/cancel. Works with a physical keyboard too.
export function openTextEntry(title, current, cb, examples) {
  textEditCb = cb || null;
  hide('settings-overlay');
  state.mode = 'search';
  setOskMode('command');
  // Keep the input itself clean (just the field title as placeholder). Any
  // per-field examples are shown BELOW the keyboard so they stay clearly
  // visible and never crowd the value you are typing.
  $('search-input').placeholder = title || 'Enter text';
  const ex = $('osk-examples');
  if (ex) {
    if (examples) { renderExamples(ex, examples); ex.classList.remove('hidden'); }
    else { ex.innerHTML = ''; ex.classList.add('hidden'); }
  }
  $('search-input').value = current || '';
  oskZone = 'osk'; oskRow = 0; oskCol = 0;   // land on the Save key
  applyOskFocus();
  $('search-suggest').classList.add('hidden');
  show('search-overlay');
  $('search-input').focus();
  oskSetCaret(($('search-input').value || '').length);
}
function finishTextEntry(val) {
  hide('search-overlay');
  setOskMode('search');
  const ex = $('osk-examples'); if (ex) { ex.innerHTML = ''; ex.classList.add('hidden'); }
  $('search-input').value = '';
  show('settings-overlay');
  state.mode = 'settings';
  const cb = textEditCb; textEditCb = null;
  if (cb && val !== null) cb(val);
}
function submitCommandText() { finishTextEntry($('search-input').value.trim()); }
function cancelCommandText() { finishTextEntry(null); }

function oskSubmit() {
  if (oskMode === 'command') return submitCommandText();
  return doSearch();
}

function oskSetCaret(p) {
  const input = $('search-input');
  oskCaret = Math.max(0, Math.min(input.value.length, p));
  try { input.setSelectionRange(oskCaret, oskCaret); } catch (e) {}
}

function oskInsert(str) {
  const input = $('search-input');
  const v = input.value;
  input.value = v.slice(0, oskCaret) + str + v.slice(oskCaret);
  oskSetCaret(oskCaret + str.length);
}

function oskActivate() {
  const input = $('search-input');
  const key = oskKeys[oskRow][oskCol].dataset.key;
  if (key === 'search') return oskSubmit();
  if (key === 'back') {
    if (oskCaret > 0) {
      const v = input.value;
      input.value = v.slice(0, oskCaret - 1) + v.slice(oskCaret);
      oskSetCaret(oskCaret - 1);
    }
  } else if (key === 'clear') { input.value = ''; oskSetCaret(0); }
  else if (key === 'caretleft') oskSetCaret(oskCaret - 1);
  else if (key === 'caretright') oskSetCaret(oskCaret + 1);
  else if (key === 'space') oskInsert(' ');
  else oskInsert(key);
  if (oskMode === 'search') scheduleSuggest(); // refresh the strip after an edit
}

export function openSearchOsk() {
  state.mode = 'search';
  setOskMode('search');
  $('search-input').value = '';
  oskCaret = 0;
  oskZone = 'osk';
  oskRow = 0; oskCol = 0;   // land on the Search key
  suggestItems = []; renderSuggest(); // reserve the (empty) strip up front -> no shift
  applyOskFocus();
  show('search-overlay');
  $('search-input').focus();
  refreshSuggestStrip();   // empty field -> show recent searches (if enabled)
}

// ---------- search suggestions / history strip ----------
// One horizontal, scrollable line above the OSK. History shows when the field
// is empty; live suggestions replace it while typing. Both honour the Search
// settings (searchHistory / searchAutocomplete).

function renderSuggest() {
  const box = $('search-suggest');
  box.innerHTML = '';
  // In search mode keep the row VISIBLE (reserved via CSS min-height) even
  // when empty, so the keyboard never shifts when chips appear/disappear.
  box.classList.remove('hidden');
  if (!suggestItems.length) return;
  for (const q of suggestItems) {
    const chip = document.createElement('button');
    chip.className = 'suggest-chip' + (suggestKind === 'history' ? ' hist' : '');
    chip.textContent = q;
    box.appendChild(chip);
  }
  applySuggestFocus();
}

function applySuggestFocus() {
  const active = oskZone === 'suggest';
  const kids = $('search-suggest').children;
  for (let i = 0; i < kids.length; i++) {
    kids[i].classList.toggle('focused', active && i === suggestIdx);
    if (active && i === suggestIdx) kids[i].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

// Rebuild the strip for the CURRENT field text.
async function refreshSuggestStrip() {
  if (oskMode !== 'search') return;
  const q = $('search-input').value.trim();
  if (!q) {
    if (Settings.get('searchHistory') === false) { suggestItems = []; renderSuggest(); return; }
    let hist = [];
    try { hist = await window.tv.searchHistory(); } catch (e) {}
    suggestItems = (hist || []).slice(0, 20);
    suggestKind = 'history';
    suggestIdx = 0;
    renderSuggest();
    return;
  }
  if (Settings.get('searchAutocomplete') === false) { suggestItems = []; renderSuggest(); return; }
  let list = [];
  try { list = await window.tv.searchSuggest(q); } catch (e) {}
  if ($('search-input').value.trim() !== q) return; // the field moved on -- drop stale results
  suggestItems = (list || []).slice(0, 20);
  suggestKind = 'suggest';
  suggestIdx = 0;
  renderSuggest();
}

function scheduleSuggest() {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(refreshSuggestStrip, 180);
}

// Run the focused suggestion/history chip as a search.
function runSuggest() {
  const q = suggestItems[suggestIdx];
  if (q == null) return;
  $('search-input').value = q;
  oskSetCaret(q.length);
  doSearch();
}

async function doSearch() {
  const q = $('search-input').value.trim();
  hide('search-overlay');
  state.mode = 'browse';
  oskZone = 'osk';
  $('search-suggest').classList.add('hidden');
  if (!q) { Nav.apply(); return; }
  if (Settings.get('searchHistory') !== false) window.tv.searchHistoryAdd(q).catch(() => {});
  state.currentSection = 'search';
  const my = ++state.loadToken;
  state.gridSection = null;
  state.currentPlaylistId = null; state.currentPlaylistName = null;
  moreExhausted.delete('search');
  title.textContent = 'Searching…';
  grid.innerHTML = '';
  shelvesBox.innerHTML = '';
  try {
    const res = await window.tv.search(q);
    if (my !== state.loadToken) return;
    renderVideoGrid(res);
    state.gridSection = 'search'; // search now supports continuation load-more
  } catch (err) {
    if (my !== state.loadToken) return;
    title.textContent = 'Search failed: ' + err.message; feedErrorHint(err);
  }
}

// ---------- companion remote (Phase 2) ----------
// Set the search box to `query` and, unless submit===false, run the search
// immediately (renders results into the browse grid). Lets the phone type a
// full string and go, instead of key-by-key. submit===false just stashes the
// text into an open search box (live typing).
export function searchFor(query, submit) {
  const inp = $('search-input');
  if (inp) inp.value = String(query == null ? '' : query);
  if (submit === false) return;
  return doSearch();
}
// Editing ops on the search box from the phone: backspace / clear / enter.
export function editSearch(op) {
  const inp = $('search-input');
  if (!inp) return;
  if (op === 'backspace') inp.value = inp.value.slice(0, -1);
  else if (op === 'clear') inp.value = '';
  else if (op === 'enter') return doSearch();
}

// ---------- input router (search overlay) ----------
// app.js delegates its whole mode==='search' branch here.
export function handleSearchInput(a) {
  if (a === 'back') {
    if (oskMode === 'command') return cancelCommandText();
    // From the strip, Back drops to the keyboard; from the keyboard it closes.
    if (oskZone === 'suggest') { oskZone = 'osk'; applySuggestFocus(); applyOskFocus(); return; }
    hide('search-overlay'); state.mode = 'browse'; setOskMode('search');
    oskZone = 'osk'; suggestItems = []; $('search-suggest').classList.add('hidden');
    Nav.apply(); return;
  }
  if (a === 'submit-search') return oskSubmit();
  if (oskZone === 'suggest') {
    if (a === 'left') { suggestIdx = Math.max(0, suggestIdx - 1); return applySuggestFocus(); }
    if (a === 'right') { suggestIdx = Math.min(suggestItems.length - 1, suggestIdx + 1); return applySuggestFocus(); }
    if (a === 'down') { oskZone = 'osk'; applySuggestFocus(); applyOskFocus(); return; }
    if (a === 'select') return runSuggest();
    return; // 'up' -- already at the top
  }
  // keyboard zone: Up from the top row enters the strip (if it has entries)
  if (a === 'up') {
    if (oskRow === 0 && suggestItems.length) {
      oskZone = 'suggest';
      suggestIdx = Math.min(suggestIdx, suggestItems.length - 1);
      applyOskFocus(); applySuggestFocus();
      return;
    }
    return oskMove('up');
  }
  if (a === 'down' || a === 'left' || a === 'right') return oskMove(a);
  if (a === 'select') return oskActivate();
}

// ---------- boot ----------
// Builds the key grid and wires the physical-keyboard caret sync. app.js calls
// this once at startup, passing the shared moreExhausted Set + feedErrorHint.
export function initOsk(deps) {
  moreExhausted = deps.moreExhausted;
  if (deps.feedErrorHint) feedErrorHint = deps.feedErrorHint;
  buildOsk();
  // Keep the OSK caret in sync when the user types or moves on a physical keyboard.
  const si = $('search-input');
  const sync = () => { oskCaret = si.selectionStart || 0; };
  si.addEventListener('input', () => { sync(); scheduleSuggest(); });
  si.addEventListener('keyup', sync);
  si.addEventListener('click', sync);
}
