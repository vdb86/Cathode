// SPDX-License-Identifier: GPL-3.0-or-later
// DeArrow integration - crowdsourced, non-clickbait video titles + thumbnails
// from the DeArrow project (same team / server as SponsorBlock).
// Runs in the main process (Node fetch, no CORS). Fails open: any error or
// missing data returns nulls and the card keeps YouTube's own title/thumbnail.
//
// Privacy: like our SponsorBlock lookup, branding is fetched with the
// k-anonymity hash-prefix endpoint (/api/branding/<sha256 first 4 hex>), so the
// exact videoID is never sent for the metadata lookup. The generated-thumbnail
// image request (dearrow-thumb) unavoidably includes the videoID, since it must
// render that specific video's frame; that request only happens when the user
// has thumbnail replacement enabled.

const fs = require('fs');
const crypto = require('crypto');
const activeaccount = require('./activeaccount');
const logger = require('./logger');

const API = 'https://sponsor.ajay.app';
const THUMB = 'https://dearrow-thumb.ajay.app/api/v1/getThumbnail';

// Per-account (account isolation, s76): DeArrow preferences live in the active
// account's folder, so each account (incl. Guest) keeps its own settings.
const settingsPath = () => activeaccount.file('dearrow_settings.json');

const DEFAULTS = {
  enabled: false,     // master switch (off until the user opts in)
  titles: true,       // replace clickbait titles
  thumbnails: true,   // replace clickbait thumbnails (dearrow-thumb generator)
  debug: false        // log every lookup + thumbnail HTTP status to couchtube.log
};

// Raw branding responses cached in-memory (per videoID) so re-rendering a feed
// or re-opening a video doesn't refetch. Output is recomputed from the current
// settings on every call, so toggling titles/thumbnails takes effect at once.
const cache = new Map();

function getSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    try { fs.writeFileSync(settingsPath(), JSON.stringify(DEFAULTS, null, 2)); } catch {}
    return DEFAULTS;
  }
}

function setSettings(patch) {
  const next = { ...getSettings(), ...(patch || {}) };
  try { fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2)); } catch {}
  return next;
}

// DeArrow title formatting: submitters may prefix a word with '>' to force it
// to keep the exact casing they typed (bypass auto-title-casing). Strip that
// marker for display. Collapse any leftover double spaces.
function cleanTitle(t) {
  return String(t || '')
    .replace(/(^|\s)>/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pick the winning entry from a DeArrow titles/thumbnails array: a locked entry
// always wins; otherwise the highest-voted one with a non-negative score.
function pickBest(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const locked = arr.find((e) => e && e.locked);
  if (locked) return locked;
  let best = null;
  for (const e of arr) {
    if (!e || (typeof e.votes === 'number' && e.votes < 0)) continue;
    if (!best || (e.votes || 0) > (best.votes || 0)) best = e;
  }
  return best;
}

async function fetchBranding(videoId) {
  if (cache.has(videoId)) return cache.get(videoId);
  const hash = crypto.createHash('sha256').update(videoId).digest('hex');
  const url = `${API}/api/branding/${hash.slice(0, 4)}`;
  let entry = null;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const map = await res.json();
      if (map && typeof map === 'object') entry = map[videoId] || null;
    }
  } catch (e) {
    console.error('DeArrow lookup failed:', e.message);
    return null; // don't cache transient failures
  }
  cache.set(videoId, entry); // cache even a null (no data) to avoid refetching
  return entry;
}

// Resolve DeArrow branding for a video, honouring the current settings.
// Returns { title, thumbnail } where each field is a string or null.
async function getBranding(videoId) {
  const s = getSettings();
  if (!s.enabled || !videoId) return { title: null, thumbnail: null };

  const b = await fetchBranding(videoId);
  if (!b) {
    if (s.debug) logger.info('[DeArrow] ' + videoId + ': no branding data (keeping YouTube title/thumbnail)');
    return { title: null, thumbnail: null };
  }

  // A real, non-original title submission means the community has flagged this
  // video. We use that both to replace the title AND to gate the random-frame
  // thumbnail fallback -- otherwise we'd swap (and hammer the generator for) a
  // random frame on videos that have NO submissions at all, just because the
  // server returns a consistent randomTime for every video.
  const bt = pickBest(b.titles);
  const hasTitleSub = !!(bt && !bt.original && bt.title);

  let title = null;
  if (s.titles && hasTitleSub) title = cleanTitle(bt.title);

  let thumbnail = null;
  if (s.thumbnails) {
    const th = pickBest(b.thumbnails);
    if (th && !th.original && typeof th.timestamp === 'number') {
      // Community-chosen frame at a specific timestamp.
      thumbnail = `${THUMB}?videoID=${encodeURIComponent(videoId)}&time=${th.timestamp}`;
    } else if (hasTitleSub && typeof b.randomTime === 'number' && b.videoDuration) {
      // No custom thumbnail but the video IS flagged (has a title submission):
      // fall back to a neutral, deterministic random frame instead of the
      // uploader's clickbait frame.
      const t = b.randomTime * b.videoDuration;
      thumbnail = `${THUMB}?videoID=${encodeURIComponent(videoId)}&time=${t.toFixed(3)}`;
    }
  }

  if (s.debug) {
    const nt = Array.isArray(b.titles) ? b.titles.length : 0;
    const nth = Array.isArray(b.thumbnails) ? b.thumbnails.length : 0;
    logger.info('[DeArrow] ' + videoId + ': ' + nt + ' title(s), ' + nth + ' thumb(s)' +
      ' -> title=' + (title ? JSON.stringify(title) : 'none') +
      ' thumb=' + (thumbnail || 'none') + ' (videoDuration=' + (b.videoDuration == null ? 'null' : b.videoDuration) + ')');
    // In debug, probe the generator so the log shows 200 vs 204 (queued / could
    // not generate) -- the usual reason a DeArrow thumbnail comes back blank.
    if (thumbnail) {
      try {
        const tr = await fetch(thumbnail);
        logger.info('[DeArrow] thumb ' + videoId + ' HTTP ' + tr.status +
          ' type=' + (tr.headers.get('content-type') || '?') +
          (tr.status === 204 ? ' reason=' + (tr.headers.get('x-failure-reason') || 'unknown') : ''));
      } catch (e) { logger.info('[DeArrow] thumb ' + videoId + ' fetch failed: ' + e.message); }
    }
  }

  return { title, thumbnail };
}

module.exports = { getBranding, getSettings, setSettings };
