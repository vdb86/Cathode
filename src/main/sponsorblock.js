// SPDX-License-Identifier: GPL-3.0-or-later
// SponsorBlock integration - public API at sponsor.ajay.app.
// Uses the k-anonymity hash-prefix lookup so the
// exact videoID is never sent. Runs in the main process (Node fetch, no CORS).
// Fails open: any error returns [] and playback proceeds unskipped.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app } = require('electron');
const activeaccount = require('./activeaccount');

const API = 'https://sponsor.ajay.app';

// Per-account (account isolation, s76): SponsorBlock settings live in the active
// account's folder, so each account (incl. Guest) keeps its own preferences.
const settingsPath = () => activeaccount.file('sb_settings.json');

// Per-category skip settings. Edit sb_settings.json in the userData folder to
// change (settings UI comes with Milestone 2). Categories per SponsorBlock docs.
const DEFAULTS = {
  enabled: true,
  categories: {
    sponsor: true,
    selfpromo: true,
    interaction: true,
    intro: false,
    outro: false,
    preview: false,
    music_offtopic: false,
    filler: false
  }
};

function getSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return {
      ...DEFAULTS,
      ...raw,
      categories: { ...DEFAULTS.categories, ...(raw.categories || {}) }
    };
  } catch {
    // First run (or corrupt file): write defaults so the user can edit them.
    try { fs.writeFileSync(settingsPath(), JSON.stringify(DEFAULTS, null, 2)); } catch {}
    return DEFAULTS;
  }
}

// Merge a partial patch into sb_settings.json (categories merged one level
// deep). Used by the Settings UI via the sb:set IPC. Returns the merged result.
function setSettings(patch) {
  const cur = getSettings();
  const next = {
    ...cur,
    ...(patch || {}),
    categories: { ...cur.categories, ...((patch && patch.categories) || {}) }
  };
  try { fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2)); } catch {}
  return next;
}

// opts.force  - ignore the player's SB enabled setting (used by downloads, which
//               have their own SponsorBlock toggle in download_settings).
// opts.categories - override the category list (default: the player's enabled set,
//               or ALL categories when force is set without an explicit list).
const ALL_SB_CATEGORIES = ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'preview', 'music_offtopic', 'filler'];
async function getSegments(videoId, opts) {
  opts = opts || {};
  const s = getSettings();
  if (!s.enabled && !opts.force) return [];

  const enabled = Array.isArray(opts.categories) && opts.categories.length
    ? opts.categories
    : (opts.force ? ALL_SB_CATEGORIES : Object.keys(s.categories).filter((c) => s.categories[c]));
  if (!enabled.length) return [];

  const hash = crypto.createHash('sha256').update(videoId).digest('hex');
  const url = `${API}/api/skipSegments/${hash.slice(0, 4)}` +
    `?categories=${encodeURIComponent(JSON.stringify(enabled))}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return []; // 404 = no segments known for this prefix
    const arr = await res.json();
    const entry = Array.isArray(arr) ? arr.find((e) => e.videoID === videoId) : null;
    if (!entry || !Array.isArray(entry.segments)) return [];

    return entry.segments
      .filter((seg) => !seg.actionType || seg.actionType === 'skip')
      .map((seg) => ({
        start: seg.segment[0],
        end: seg.segment[1],
        category: seg.category,
        uuid: seg.UUID
      }));
  } catch (e) {
    console.error('SponsorBlock lookup failed:', e.message);
    return [];
  }
}

module.exports = { getSegments, getSettings, setSettings };
