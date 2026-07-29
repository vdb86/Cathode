// SPDX-License-Identifier: GPL-3.0-or-later
// Like / dislike counts via the Return YouTube Dislike public API. YouTube no
// longer exposes dislikes, and its like count is unreliable on the TV client we
// use for account state, so we read BOTH counts from RYD (its like figure
// mirrors YouTube's; the dislike figure is its estimate). Read-only; this does
// NOT change the user's own like/subscribe state (that stays optimistic).
//
// Results are cached in-memory per videoId with a TTL, and concurrent lookups
// for the same id are de-duped, so the "all cards" mode does not hammer the API.

const logger = require('./logger');

const TTL_MS = 6 * 60 * 60 * 1000; // 6h
const cache = new Map();   // videoId -> { at, data }
const inflight = new Map(); // videoId -> Promise

// RYD is a community API that 503s / times out in bursts, and we fire one lookup
// per feed card, so logging each failure floods the log (dozens of lines per feed
// page). Aggregate instead: count failures and emit ONE summary line per window
// with the last error seen. Purely informational - lookups are best-effort.
let failCount = 0;
let lastFailMsg = '';
let failTimer = null;
function noteFailure(msg) {
  failCount++;
  lastFailMsg = msg || 'error';
  if (failTimer) return;
  failTimer = setTimeout(() => {
    logger.info('[ryd] ' + failCount + ' lookup(s) failed in the last 10s (last: ' + lastFailMsg + ')');
    failCount = 0; lastFailMsg = ''; failTimer = null;
  }, 10000);
  if (failTimer.unref) failTimer.unref();
}

// 12345 -> "12K", 1200000 -> "1.2M". Small numbers stay exact.
function abbrev(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 1000000) { const v = n / 1000; return (v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')) + 'K'; }
  const v = n / 1000000; return (v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')) + 'M';
}

async function fetchVotes(videoId) {
  const url = 'https://returnyoutubedislikeapi.com/votes?videoId=' + encodeURIComponent(videoId);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const likes = Number(j.likes) || 0;
    const dislikes = Number(j.dislikes) || 0;
    return { ok: true, likes, dislikes, likesText: abbrev(likes), dislikesText: abbrev(dislikes) };
  } finally {
    clearTimeout(t);
  }
}

// Return { ok, likes, dislikes, likesText, dislikesText } or { ok:false }.
async function getVotes(videoId) {
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return { ok: false };
  const hit = cache.get(videoId);
  if (hit && (Date.now() - hit.at) < TTL_MS) return hit.data;
  if (inflight.has(videoId)) return inflight.get(videoId);
  const p = fetchVotes(videoId)
    .then((data) => { cache.set(videoId, { at: Date.now(), data }); return data; })
    .catch((e) => { noteFailure(e && e.message); return { ok: false }; })
    .finally(() => { inflight.delete(videoId); });
  inflight.set(videoId, p);
  return p;
}

module.exports = { getVotes };
