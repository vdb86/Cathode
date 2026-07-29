// SPDX-License-Identifier: GPL-3.0-or-later
// Small DOM + formatting helpers shared across the renderer.
// Extracted from app.js (renderer ES-module split, s92).

export const $ = (id) => document.getElementById(id);

export function toast(msg, ms = 3000) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), ms);
  // Mirror user-facing toasts to any connected companion phone (main drops it
  // when no phone is listening). Guarded so it is a no-op outside the app.
  try { if (window.tv && window.tv.companionNotice) window.tv.companionNotice(msg); } catch (e) { /* ignore */ }
}

export function show(id) { $(id).classList.remove('hidden'); }
export function hide(id) { $(id).classList.add('hidden'); }

// Lightweight busy indicator for slow load-more pulls (reuses the toast).
export function busy(on) {
  const t = $('toast');
  if (on) { t.textContent = 'Loading more…'; t.classList.remove('hidden'); clearTimeout(t._timer); }
  else if (t.textContent === 'Loading more…') t.classList.add('hidden');
}

export function fmtTime(s) {
  s = Math.floor(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(sec).padStart(2, '0');
}

// Render a serialized text as a mix of word runs + inline custom emoji images
// into a container. Shared by live chat and comments (both get { text } /
// { emoji, alt } run arrays from the main process).
export function appendRuns(container, runs) {
  for (const r of (runs || [])) {
    if (r.emoji) {
      const e = new Image();
      e.className = 'chat-emoji';
      e.src = r.emoji; e.alt = r.alt || '';
      container.appendChild(e);
    } else if (r.text) {
      container.appendChild(document.createTextNode(r.text));
    }
  }
}
