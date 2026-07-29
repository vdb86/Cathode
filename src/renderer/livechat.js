// SPDX-License-Identifier: GPL-3.0-or-later
// Live chat (read-only) panel (s118). A right/left-docked ticker that shows the
// current video's chat while it keeps playing; the video shrinks toward the
// other side (same keep-playing shrink the suggestions drawer / mini-player
// use). NON-focusable by design -- it's ambient: the transport 'livechat'
// button toggles it, Back closes it, and it never takes D-pad focus.
//
// Two modes, driven by the main-side poller (innertube.js):
//   LIVE   -- messages arrive over yt:live-chat and are appended as they come.
//   REPLAY -- messages carry a video offset (offsetMs); they're buffered and
//             revealed by chatReplayTick() as playback passes their offset, and
//             re-synced by chatReplaySeek() when the user seeks. youtubei.js's
//             own replay timing is rough, so we gate on the player clock here.
//
// The poller only runs while the panel is open (opened via liveChatStart,
// stopped via liveChatStop); availability for the button comes from a cheap
// probe at play time (chatOnPlay).

import { $, show, hide, appendRuns } from './util.js';
import { video } from './dom.js';
import { state } from './state.js';
import { pstate } from './pstate.js';

const CAP = 150;              // max message nodes kept in the DOM (busy streams)
const IDLE_MS = 15000;        // dim the panel after this long with no new message

let applyAspect = () => {};
let refreshButtons = () => {};

let replayBuf = [];           // all replay messages received (arrival ~= time order)
let replayIdx = 0;            // index of the next replay message not yet shown
let idleTimer = null;
let probeToken = null;        // guards against a stale probe resolving late
let bannerEl = null;          // current pinned-banner DOM node (kept above the ticker)

export function initLiveChat(deps) {
  if (deps && deps.applyAspect) applyAspect = deps.applyAspect;
  if (deps && deps.refreshPlayerButtons) refreshButtons = deps.refreshPlayerButtons;
  if (window.tv && window.tv.onLiveChat) window.tv.onLiveChat(onChatEvent);
}

function panel() { return $('player-chat'); }

export function isChatOpen() { return pstate.chatOpen; }

// Called from play() for every video: reset, then probe whether this video has
// a chat so the transport button can show. Re-opens the panel if it was open on
// the previous video (queue/Next continuity) or if auto-open is set.
export function chatOnPlay(videoId) {
  const wasOpen = pstate.chatOpen;
  try { window.tv.liveChatStop(); } catch { /* nothing running */ }
  pstate.hasLiveChat = false;
  pstate.chatIsReplay = false;
  pstate.chatOpen = false;
  replayBuf = []; replayIdx = 0;
  bannerEl = null;
  clearTimeout(idleTimer);
  hide('player-chat');
  $('player-overlay').classList.remove('chatting');
  clearPanel();
  const id = videoId;
  probeToken = id;
  if (!window.tv || !window.tv.liveChatProbe) return;
  window.tv.liveChatProbe(id).then((r) => {
    if (probeToken !== id || pstate.currentVideoId !== id) return; // moved on
    pstate.hasLiveChat = !!(r && r.available);
    pstate.chatIsReplay = !!(r && r.isReplay);
    if (state.mode === 'player') refreshButtons();
    if (pstate.hasLiveChat && (wasOpen || Settings.get('chatAutoOpen'))) openChat();
  }).catch(() => {});
}

// Called from stopPlayback(): tear the poller down and hide everything.
export function chatOnStop() {
  probeToken = null;
  try { window.tv.liveChatStop(); } catch { /* nothing running */ }
  pstate.chatOpen = false;
  pstate.hasLiveChat = false;
  pstate.chatIsReplay = false;
  replayBuf = []; replayIdx = 0;
  bannerEl = null;
  clearTimeout(idleTimer);
  hide('player-chat');
  $('player-overlay').classList.remove('chatting');
  clearPanel();
}

export function toggleChat() {
  if (!pstate.hasLiveChat) return; // button shouldn't be reachable, but guard
  if (pstate.chatOpen) closeChat(); else openChat();
}

export function openChat() {
  if (!pstate.hasLiveChat || pstate.chatOpen) return;
  pstate.chatOpen = true;
  replayBuf = []; replayIdx = 0;
  bannerEl = null;
  clearPanel();
  applyChatLayout();
  // Let the .chatting CSS size the video (like the suggestions drawer does).
  video.style.transform = ''; video.style.objectFit = '';
  $('player-overlay').classList.add('chatting');
  show('player-chat');
  showNote('Loading chat…');
  resetIdle();
  const id = pstate.currentVideoId;
  window.tv.liveChatStart(id, Settings.get('chatFilter')).then((r) => {
    if (pstate.currentVideoId !== id || !pstate.chatOpen) { try { window.tv.liveChatStop(); } catch {} return; }
    if (!r || !r.ok) { showNote('Chat unavailable'); return; }
    pstate.chatIsReplay = !!r.isReplay;
    if (pstate.chatIsReplay) chatReplayTick(); // reveal anything already due at the current position
  }).catch(() => { if (pstate.chatOpen) showNote('Chat unavailable'); });
}

export function closeChat() {
  if (!pstate.chatOpen) return;
  pstate.chatOpen = false;
  try { window.tv.liveChatStop(); } catch { /* nothing running */ }
  clearTimeout(idleTimer);
  hide('player-chat');
  $('player-overlay').classList.remove('chatting');
  applyAspect(); // restore the chosen aspect after the shrink
}

// Reveal buffered replay messages up to the current playback position. Called
// from the <video> timeupdate loop in app.js (~4x/sec).
export function chatReplayTick() {
  if (!pstate.chatOpen || !pstate.chatIsReplay) return;
  const nowMs = (video.currentTime || 0) * 1000;
  while (replayIdx < replayBuf.length && replayBuf[replayIdx].offsetMs <= nowMs) {
    appendMessage(replayBuf[replayIdx]);
    replayIdx++;
  }
}

// Re-sync the replay panel after a seek (either direction): jump the pointer to
// the seek position and re-render the last CAP messages that lead up to it.
export function chatReplaySeek() {
  if (!pstate.chatOpen || !pstate.chatIsReplay) return;
  const nowMs = (video.currentTime || 0) * 1000;
  let i = 0;
  while (i < replayBuf.length && replayBuf[i].offsetMs <= nowMs) i++;
  replayIdx = i;
  clearPanel();
  for (let k = Math.max(0, i - CAP); k < i; k++) appendMessage(replayBuf[k]);
}

function onChatEvent(data) {
  if (!pstate.chatOpen || !data) return;
  if (data.kind === 'end') { showNote(pstate.chatIsReplay ? 'End of chat replay' : 'Chat ended'); return; }
  if (data.kind === 'delete') { removeMsg((n) => n.dataset.mid === data.id, (m) => m.id === data.id); return; }
  if (data.kind === 'delete-author') { removeMsg((n) => n.dataset.author === data.channelId, (m) => m.channelId === data.channelId); return; }
  if (data.kind === 'banner') { setBanner(data.banner); return; }
  if (data.kind === 'banner-remove') { removeBannerEl(); return; }
  if (data.kind !== 'item' || !data.msg) return;
  const m = data.msg;
  if (!passesFilter(m)) return;
  if (pstate.chatIsReplay && typeof m.offsetMs === 'number') replayBuf.push(m); // shown by the tick
  else appendMessage(m);                                                        // live: append now
}

function passesFilter(m) {
  if (m.kind === 'membership' && Settings.get('chatHideMembers')) return false;
  if ((m.kind === 'paid' || m.kind === 'sticker') && Settings.get('chatSuperchats') === false) return false;
  return true;
}

function clearPanel() {
  const box = panel();
  if (!box) return;
  box.innerHTML = '';
  if (bannerEl) box.appendChild(bannerEl); // keep the pinned banner across seek re-renders
}

// Moderation: remove matching messages from the DOM (nodePred) and drop them
// from the replay buffer (msgPred) so they don't reappear on a seek re-render.
// Filtering the buffer shifts indices, so re-derive replayIdx from the current
// position (= count of remaining items already due) to keep the tick correct.
function removeMsg(nodePred, msgPred) {
  const box = panel();
  if (box) Array.from(box.children).forEach((n) => { if (n.classList && n.classList.contains('chat-msg') && nodePred(n)) n.remove(); });
  if (msgPred && pstate.chatIsReplay) {
    replayBuf = replayBuf.filter((m) => !msgPred(m));
    const nowMs = (video.currentTime || 0) * 1000;
    let i = 0;
    while (i < replayBuf.length && replayBuf[i].offsetMs <= nowMs) i++;
    replayIdx = i;
  }
}

function showNote(text) {
  const box = panel();
  if (!box) return;
  let n = box.querySelector('.chat-note');
  if (!n) { n = document.createElement('div'); n.className = 'chat-note'; box.appendChild(n); }
  n.textContent = text;
  box.scrollTop = box.scrollHeight;
}

function appendMessage(m) {
  const box = panel();
  if (!box) return;
  const note = box.querySelector('.chat-note');
  if (note) note.remove(); // first real message clears the "Loading…" note
  box.appendChild(renderMessage(m));
  const msgs = box.querySelectorAll('.chat-msg'); // count messages only -- never trim the banner
  for (let i = 0; i < msgs.length - CAP; i++) msgs[i].remove();
  box.scrollTop = box.scrollHeight;
  resetIdle();
}

function renderMessage(m) {
  const row = document.createElement('div');
  row.className = 'chat-msg'
    + (m.kind === 'paid' || m.kind === 'sticker' ? ' chat-paid' : '')
    + (m.kind === 'sticker' ? ' chat-sticker' : '')
    + (m.kind === 'membership' ? ' chat-membership' : '');
  if (m.id) row.dataset.mid = m.id;             // for single-message moderation removal
  if (m.channelId) row.dataset.author = m.channelId; // for delete-all-by-author removal
  if (m.avatar) {
    const img = new Image();
    img.className = 'chat-avatar';
    img.decoding = 'async'; img.loading = 'lazy';
    img.src = m.avatar;
    row.appendChild(img);
  }
  const body = document.createElement('div');
  body.className = 'chat-body';
  if (m.kind === 'membership' && m.header) {
    const h = document.createElement('div');
    h.className = 'chat-memhdr';
    h.textContent = m.header;
    body.appendChild(h);
  }
  const author = document.createElement('span');
  author.className = 'chat-author';
  if (m.badges && m.badges.moderator) author.classList.add('is-mod');
  if (m.badges && m.badges.member) author.classList.add('is-member');
  author.textContent = m.author;
  body.appendChild(author);
  if (m.badges && m.badges.verified) {
    const v = document.createElement('span');
    v.className = 'chat-verified';
    v.textContent = '✓';
    body.appendChild(v);
  }
  if ((m.kind === 'paid' || m.kind === 'sticker') && m.amount) {
    const amt = document.createElement('span');
    amt.className = 'chat-amount';
    amt.textContent = m.amount;
    body.appendChild(amt);
  }
  const txt = document.createElement('span');
  txt.className = 'chat-text';
  appendRuns(txt, m.runs);
  body.appendChild(txt);
  if (m.kind === 'sticker' && m.sticker) {
    const s = new Image();
    s.className = 'chat-sticker-img';
    s.decoding = 'async'; s.loading = 'lazy';
    s.src = m.sticker;
    body.appendChild(s);
  }
  if (m.kind === 'paid' || m.kind === 'sticker') {
    if (m.bodyBg) row.style.background = m.bodyBg;
    if (m.bodyText) row.style.color = m.bodyText;
  }
  row.appendChild(body);
  return row;
}

// Pinned banner: a streamer-pinned message or a live poll, kept at the top of
// the panel (sticky) above the scrolling ticker. A new banner replaces the old;
// banner-remove clears it.
function setBanner(banner) {
  if (!banner) return;
  removeBannerEl();
  bannerEl = renderBanner(banner);
  const box = panel();
  if (box && bannerEl) box.insertBefore(bannerEl, box.firstChild);
}

function removeBannerEl() {
  if (bannerEl && bannerEl.parentNode) bannerEl.parentNode.removeChild(bannerEl);
  bannerEl = null;
}

function renderBanner(banner) {
  const el = document.createElement('div');
  el.className = 'chat-banner';
  if (banner.kind === 'poll') {
    const q = document.createElement('div');
    q.className = 'chat-banner-q';
    q.textContent = banner.question || 'Poll';
    el.appendChild(q);
    for (const c of (banner.choices || [])) {
      const o = document.createElement('div');
      o.className = 'chat-poll-opt';
      o.textContent = c;
      el.appendChild(o);
    }
  } else {
    if (banner.header) {
      const h = document.createElement('div');
      h.className = 'chat-banner-hdr';
      h.textContent = banner.header;
      el.appendChild(h);
    }
    if (banner.msg) {
      const line = document.createElement('div');
      line.className = 'chat-banner-msg';
      const a = document.createElement('span');
      a.className = 'chat-author';
      a.textContent = banner.msg.author || '';
      line.appendChild(a);
      const tx = document.createElement('span');
      tx.className = 'chat-text';
      appendRuns(tx, banner.msg.runs);
      line.appendChild(tx);
      el.appendChild(line);
    }
  }
  return el;
}

// Push the chosen side / width / font-size onto the panel + overlay via data
// attributes (styled in styles.css). Called on open so setting changes take
// effect the next time chat is shown.
function applyChatLayout() {
  const box = panel();
  if (!box) return;
  const side = Settings.get('chatSide') || 'right';
  const width = Settings.get('chatWidth') || 'med';
  box.dataset.side = side;
  box.dataset.width = width;
  box.dataset.size = Settings.get('chatFontSize') || 'med';
  const overlay = $('player-overlay');
  overlay.dataset.chatSide = side;
  overlay.dataset.chatWidth = width; // drives the #video shrink calc in styles.css
}

// "Dim when idle": fade the panel down after a stretch with no new messages; a
// new message (or a seek re-render) removes the class and it snaps back.
function resetIdle() {
  clearTimeout(idleTimer);
  const box = panel();
  if (box) box.classList.remove('chat-idle');
  if (!Settings.get('chatAutoHide')) return;
  idleTimer = setTimeout(() => { if (pstate.chatOpen && panel()) panel().classList.add('chat-idle'); }, IDLE_MS);
}
