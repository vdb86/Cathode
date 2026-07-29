// SPDX-License-Identifier: GPL-3.0-or-later
// Player slide-up menus (renderer split, s113). The cog (overflow) menu + the
// slide-up option menus (speed / quality / aspect / repeat / captions / audio)
// that replace cycling toggles. Menu state lives on pstate (pMenu, speedIdx,
// aspectIdx, qualityIdx/Label/Options, captionTracks/captionIdx, audioLangs,
// playbackMode, shakaPlayer, hudTimer). The transport row stays in app.js; the
// few row helpers this engine drives (pBtn, activatePlayerButton, applyAspect,
// applyPlaybackMode, applyCaption, updateControlLabels) are injected at boot via
// initPlayerMenu. cogMenuActs is also imported by app.js's pbtnRowHidden.

import { $, show, hide, toast } from './util.js';
import { video } from './dom.js';
import { pstate } from './pstate.js';
import { SPEEDS, ASPECTS, REPEAT_MODES, P_LABELS, P_WITH_LABEL, COG_STATEFUL } from './pconst.js';

let pBtn, activatePlayerButton, applyAspect, applyPlaybackMode, applyCaption, updateControlLabels, switchAudio;

// Shaka audio-language codes ('ja', 'pt', 'en') -> full display names for the
// audio menu. Empty code = the stream default. Falls back to the raw code.
let _langNames = null;
function langLabel(code) {
  if (!code) return 'Default';
  try {
    if (!_langNames) _langNames = new Intl.DisplayNames(['en'], { type: 'language' });
    return _langNames.of(code) || code;
  } catch (e) { return code; }
}

export function initPlayerMenu(deps) {
  ({ pBtn, activatePlayerButton, applyAspect, applyPlaybackMode, applyCaption, updateControlLabels, switchAudio } = deps);
}

// Shaka lists a separate audio track per CODEC group (AAC m4a + Opus webm), so a
// language/variant shows up twice with the same label. Collapse to one row per
// label (+ language + roles) so each language appears once; switching by label
// (selectVariantsByLabel) then keeps every codec as an ABR candidate - no forced
// mid-stream codec switch (which the SABR server rejects with an empty UMP).
function dedupeAudioByLabel(list) {
  const byKey = new Map();
  for (const a of list) {
    const key = (a.label || '') + '|' + (a.language || '') + '|' + ((a.roles || []).join(','));
    if (!byKey.has(key) || a.active) byKey.set(key, a);
  }
  return [...byKey.values()];
}

// The buttons currently reachable through the cog (overflow) menu: cog-
// assigned, not hidden, and - for Stop - only when background playback is on.
export function cogMenuActs() {
  const hidden = Settings.get('hiddenPlayerButtons') || [];
  const cog = Settings.get('cogButtons') || [];
  const bgOff = !Settings.get('bgPlay');
  return cog.filter((act) => !hidden.includes(act) && !(act === 'stop' && bgOff));
}

// The cog (overflow) menu lists the buttons the user moved into it; picking
// one runs that button's normal action (which may open its own sub-menu).
// Stateful buttons (like/subscribe/save/SponsorBlock/captions/stats/repeat)
// show their current On/Off, and speed/quality/aspect show their value, so
// state stays visible even when a button lives in the cog.
export function openCogMenu() {
  const acts = cogMenuActs();
  if (!acts.length) return;
  const items = [], on = [];
  acts.forEach((a) => { const info = cogItemInfo(a); items.push(info.label); on.push(info.on); });
  pstate.pMenu = { kind: 'cog', acts: acts, items: items, on: on, index: 0 };
  renderPlayerMenu();
  show('player-menu');
  clearTimeout(pstate.hudTimer); // keep the HUD up while the menu is open
}
// Menu label + current-state suffix for a cog entry; on = highlight it.
function cogItemInfo(act) {
  const btn = pBtn(act);
  const isOn = act === 'stats'
    ? !$('player-stats').classList.contains('hidden')
    : !!(btn && btn.classList.contains('on'));
  let state = '';
  if (P_WITH_LABEL.has(act)) {
    const pl = btn && btn.querySelector('.plabel');
    state = (pl && pl.textContent) || '';
  } else if (COG_STATEFUL.has(act)) {
    state = isOn ? 'On' : 'Off';
  }
  return {
    label: (P_LABELS[act] || act) + (state ? '   ·   ' + state : ''),
    on: COG_STATEFUL.has(act) && isOn
  };
}
// Slide-up option menus (speed / quality / aspect) replace cycling toggles.
export function openPlayerMenu(kind) {
  let items = [], cur = 0, audioNative = false, audioObjs = null;
  if (kind === 'speed') {
    items = SPEEDS.map((s) => s + 'x');
    cur = pstate.speedIdx;
  } else if (kind === 'aspect') {
    items = ASPECTS.map((a) => a.label);
    cur = pstate.aspectIdx;
  } else if (kind === 'repeat') {
    items = REPEAT_MODES.map((m) => m.label);
    cur = Math.max(0, REPEAT_MODES.findIndex((m) => m.v === pstate.playbackMode));
  } else if (kind === 'quality') {
    if (!pstate.shakaPlayer) { toast('Quality needs an adaptive (DASH) stream'); return; }
    const tracks = pstate.shakaPlayer.getVariantTracks();
    const heights = [...new Set(tracks.map((t) => t.height).filter(Boolean))].sort((a, b) => b - a);
    pstate.qualityOptions = ['auto', ...heights];
    items = pstate.qualityOptions.map((h) => (h === 'auto' ? 'Auto' : h + 'p'));
    cur = Math.min(pstate.qualityIdx, pstate.qualityOptions.length - 1);
  } else if (kind === 'cc') {
    if (!pstate.shakaPlayer) { toast('Captions need an adaptive stream'); return; }
    if (!pstate.captionTracks.length) { toast('No captions for this video'); return; }
    items = ['Off'].concat(pstate.captionTracks.map((t) => t.name));
    cur = pstate.captionIdx;
  } else if (kind === 'audio') {
    // With multi-audio on, drive the menu from Shaka's OWN audio tracks: it lists
    // every language AND processing variant (Stable Volume / Voice Boost carry
    // distinct labels from the manifest), and selectAudioTrack switches in-stream
    // while keeping video adaptive. Multi-audio off -> the per-variant reload
    // list; only one track -> the plain single-track fallback.
    const atracks = (pstate.shakaPlayer && pstate.shakaPlayer.getAudioTracks)
      ? dedupeAudioByLabel(pstate.shakaPlayer.getAudioTracks()) : [];
    if (atracks.length > 1) {
      audioObjs = atracks;
      items = atracks.map((a) => a.label || langLabel(a.language));
      cur = Math.max(0, atracks.findIndex((a) => a.active));
    } else if (pstate.audioTracks && pstate.audioTracks.length > 1) {
      items = pstate.audioTracks.map((t) => t.name);
      cur = Math.max(0, pstate.audioTracks.findIndex((t) => t.code === pstate.audioLang && (t.variant || '') === pstate.audioVariant));
    } else {
      if (!pstate.shakaPlayer || !pstate.shakaPlayer.getAudioLanguages) { toast('Audio tracks need an adaptive stream'); return; }
      pstate.audioLangs = pstate.shakaPlayer.getAudioLanguages();
      if (pstate.audioLangs.length <= 1) { toast('Only one audio track'); return; }
      items = pstate.audioLangs.map(langLabel);
      const active = pstate.shakaPlayer.getVariantTracks().find((t) => t.active);
      cur = Math.max(0, pstate.audioLangs.indexOf(active && active.language));
      audioNative = true; // single-source Shaka fallback (no per-variant list)
    }
  }
  if (!items.length) return;
  // activeIndex = the row that is CURRENTLY in effect (starts under the cursor);
  // marked distinctly so it stays identifiable after the cursor moves. Not for
  // the cog menu (a list of actions, nothing single-selected).
  pstate.pMenu = { kind: kind, items: items, index: cur, audioNative: audioNative, audioObjs: audioObjs, activeIndex: (kind === 'cog' ? -1 : cur) };
  renderPlayerMenu();
  show('player-menu');
  clearTimeout(pstate.hudTimer); // keep the HUD up while the menu is open
}

function renderPlayerMenu() {
  const box = $('player-menu');
  box.innerHTML = '';
  // Sticky "i / N" counter (only worth showing when the list can be long).
  if (pstate.pMenu.items.length > 1) {
    const c = document.createElement('div');
    c.className = 'pmenu-count';
    box.appendChild(c);
  }
  pstate.pMenu.items.forEach((label, i) => {
    const d = document.createElement('div');
    d.className = 'pmenu-item' + (i === pstate.pMenu.index ? ' focused' : '') +
      (i === pstate.pMenu.activeIndex ? ' active' : '') +
      (pstate.pMenu.on && pstate.pMenu.on[i] ? ' on' : '');
    d.textContent = label;
    box.appendChild(d);
  });
  updatePlayerMenuCount();
  scrollPlayerMenuFocusIntoView();
}

// Refresh the "i / N" counter text.
function updatePlayerMenuCount() {
  const c = $('player-menu').querySelector('.pmenu-count');
  if (c) c.textContent = (pstate.pMenu.index + 1) + ' / ' + pstate.pMenu.items.length;
}

// Keep the focused row visible when the list overflows (the menu scrolls).
function scrollPlayerMenuFocusIntoView() {
  const items = $('player-menu').querySelectorAll('.pmenu-item');
  const el = items[pstate.pMenu.index];
  if (el) el.scrollIntoView({ block: 'nearest' });
}

export function applyPlayerMenuFocus() {
  const items = $('player-menu').querySelectorAll('.pmenu-item');
  for (let i = 0; i < items.length; i++) items[i].classList.toggle('focused', i === pstate.pMenu.index);
  updatePlayerMenuCount();
  scrollPlayerMenuFocusIntoView();
}

export function closePlayerMenu() {
  pstate.pMenu = null;
  hide('player-menu');
}

export function playerMenuActivate() {
  const kind = pstate.pMenu.kind, index = pstate.pMenu.index;
  if (kind === 'cog') {
    const act = pstate.pMenu.acts[index];
    closePlayerMenu();
    activatePlayerButton(act); // may open a further sub-menu (quality/speed/…)
    return;
  }
  if (kind === 'speed') {
    pstate.speedIdx = index;
    video.playbackRate = SPEEDS[index];
    if (Settings.get('rememberSpeed')) Settings.set({ lastSpeed: SPEEDS[index] });
    updateControlLabels();
    toast('Speed: ' + SPEEDS[index] + 'x');
  } else if (kind === 'aspect') {
    pstate.aspectIdx = index;
    applyAspect();
    toast('Aspect: ' + ASPECTS[index].label);
  } else if (kind === 'repeat') {
    pstate.playbackMode = REPEAT_MODES[index].v;
    Settings.set({ playbackMode: pstate.playbackMode }); // persist as the new default
    applyPlaybackMode();
    toast('Playback: ' + REPEAT_MODES[index].label);
  } else if (kind === 'quality') {
    pstate.qualityIdx = index;
    const choice = pstate.qualityOptions[index];
    try {
      if (choice === 'auto') {
        pstate.shakaPlayer.configure({ abr: { enabled: true } });
        pstate.qualityLabel = 'Auto';
      } else {
        pstate.shakaPlayer.configure({ abr: { enabled: false } });
        const tracks = pstate.shakaPlayer.getVariantTracks();
        const best = tracks.filter((t) => t.height === choice).sort((a, b) => b.bandwidth - a.bandwidth)[0];
        if (best) pstate.shakaPlayer.selectVariantTrack(best, true);
        pstate.qualityLabel = choice + 'p';
      }
      updateControlLabels();
      toast('Quality: ' + pstate.qualityLabel);
    } catch (err) { toast('Quality unavailable'); }
  } else if (kind === 'cc') {
    pstate.captionIdx = index;
    applyCaption();
  } else if (kind === 'audio') {
    // Multi-audio on: select the exact Shaka audio track (in-stream, keeps video
    // adaptive). Works for languages AND processing variants (vb resolves via the
    // vb-aware SABR key in sabr.js).
    if (pstate.pMenu.audioObjs) {
      const a = pstate.pMenu.audioObjs[index];
      closePlayerMenu();
      if (a) {
        try {
          // Switch by LABEL so every codec of that language stays an ABR candidate
          // (no forced codec change, which the SABR server rejects); fall back to
          // the exact track only if the label is missing.
          if (a.label && pstate.shakaPlayer.selectVariantsByLabel) pstate.shakaPlayer.selectVariantsByLabel(a.label, true);
          else pstate.shakaPlayer.selectAudioTrack(a);
          pstate.audioLang = a.language || pstate.audioLang;
          pstate.audioVariant = /stable volume/i.test(a.label || '') ? 'drc' : /voice boost/i.test(a.label || '') ? 'vb' : '';
          updateControlLabels();
          toast('Audio: ' + (a.label || langLabel(a.language)));
        } catch (err) { toast('Audio unavailable'); }
      }
      return;
    }
    // Multi-audio off: reload collapsed to the chosen (language, variant).
    if (!pstate.pMenu.audioNative && pstate.audioTracks && pstate.audioTracks.length > 1) {
      const t = pstate.audioTracks[index];
      closePlayerMenu();
      if (t && (t.code !== pstate.audioLang || (t.variant || '') !== pstate.audioVariant)) switchAudio(t.code, t.variant || 'plain');
      return;
    }
    const lang = pstate.audioLangs[index];
    try {
      pstate.shakaPlayer.selectAudioLanguage(lang);
      pstate.audioLang = lang || pstate.audioLang; // keep the button label in sync
      updateControlLabels();
      toast('Audio: ' + langLabel(lang));
    } catch (err) { toast('Audio unavailable'); }
  }
  closePlayerMenu();
}
