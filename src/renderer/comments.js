// SPDX-License-Identifier: GPL-3.0-or-later
// Comments (read-only) panel (s119). A docked, D-pad-FOCUSABLE list of a video's
// comments -- the lean-in counterpart to the ambient live-chat ticker. Reuses
// the same docked-panel shell + the shared appendRuns text/emoji renderer, but
// has its own navigation (unlike chat, which is a non-focusable ticker):
//   up/down  -- move between top-level comments (or replies)
//   left/right -- toggle sort (Top / Newest), refetching
//   select   -- open a comment's replies (if any)
//   back     -- replies view: back to the list; list: close the panel
//   down at the end -- load the next page
// Static + paginated (no poller). Data via window.tv.comments/moreComments/
// commentReplies. Shown by a 'comments' transport button, gated to non-live
// videos. Posting/liking need account writes (M5) -- view-only here.

import { $, show, hide, appendRuns } from './util.js';
import { video } from './dom.js';
import { state } from './state.js';
import { pstate } from './pstate.js';

let togglePlay = () => {};
let applyAspect = () => {};

let threads = [];      // serialized top-level comment threads
let sel = 0;           // focused index in the list
let sort = 'top';      // 'top' | 'new' (session sort; the setting is the default)
let count = '';        // total comment count (from the header)
let loading = false;
let exhausted = false;

let view = 'list';     // 'list' | 'replies'
let replies = [];      // serialized replies for the open thread
let replySel = 0;
let listSel = 0;       // remembered list position while in the replies view

export function initComments(deps) {
  if (deps && deps.togglePlay) togglePlay = deps.togglePlay;
  if (deps && deps.applyAspect) applyAspect = deps.applyAspect;
}

function panel() { return $('player-comments'); }

export function isCommentsOpen() { return pstate.commentsOpen; }

export function commentsOnPlay() {
  resetState();
  hide('player-comments');
  $('player-overlay').classList.remove('commenting');
  clearPanel();
  // Auto-open on non-live videos if the user asked for it (comments fetch on open).
  if (!pstate.isLiveVideo && Settings.get('commentsAutoOpen')) openComments();
}

export function commentsOnStop() {
  resetState();
  hide('player-comments');
  $('player-overlay').classList.remove('commenting');
  clearPanel();
}

function resetState() {
  pstate.commentsOpen = false;
  threads = []; replies = []; sel = 0; replySel = 0; listSel = 0;
  view = 'list'; loading = false; exhausted = false; count = '';
}

export function toggleComments() {
  if (pstate.isLiveVideo) return; // no comments while a stream is live
  if (pstate.commentsOpen) closeComments(); else openComments();
}

export function openComments() {
  if (pstate.commentsOpen || pstate.isLiveVideo) return;
  pstate.commentsOpen = true;
  threads = []; replies = []; sel = 0; replySel = 0; view = 'list'; exhausted = false;
  sort = Settings.get('commentsSort') || 'top';
  applyLayout();
  video.style.transform = ''; video.style.objectFit = ''; // let the .commenting CSS size the video
  $('player-overlay').classList.add('commenting');
  hide('player-hud'); // focus is in the comments list, not the transport row
  show('player-comments');
  fetchComments();
}

export function closeComments() {
  if (!pstate.commentsOpen) return;
  pstate.commentsOpen = false;
  hide('player-comments');
  $('player-overlay').classList.remove('commenting');
  applyAspect(); // restore the chosen aspect after the shrink
}

// Router delegate (app.js sends all player input here while the panel is open).
export function handleCommentsInput(a) {
  if (a === 'play') return togglePlay();
  if (view === 'replies') {
    if (a === 'back' || a === 'left') return backToList();
    if (a === 'up') { replySel = Math.max(0, replySel - 1); applyReplyFocus(); return; }
    if (a === 'down') { replySel = Math.min(replies.length - 1, replySel + 1); applyReplyFocus(); return; }
    return;
  }
  if (a === 'back') return closeComments();
  if (a === 'left' || a === 'right') return toggleSort();
  if (a === 'up') { sel = Math.max(0, sel - 1); applyListFocus(); return; }
  if (a === 'down') {
    if (sel >= threads.length - 1) loadMore();
    sel = Math.min(threads.length - 1, sel + 1); applyListFocus(); return;
  }
  if (a === 'select') {
    const c = threads[sel];
    if (c && c.hasReplies) openReplies(c);
    return;
  }
}

function fetchComments() {
  loading = true;
  showNote('Loading comments…');
  const id = pstate.currentVideoId;
  window.tv.comments(id, sort).then((r) => {
    loading = false;
    if (!pstate.commentsOpen || pstate.currentVideoId !== id) return;
    if (!r || !r.ok) { showNote('Comments unavailable'); return; }
    threads = r.comments || [];
    count = r.count || '';
    exhausted = !r.hasMore;
    sel = 0;
    if (!threads.length) { showNote('No comments'); return; }
    renderList();
  }).catch(() => { if (pstate.commentsOpen) showNote('Comments unavailable'); });
}

function toggleSort() {
  sort = (sort === 'top') ? 'new' : 'top';
  threads = []; sel = 0; exhausted = false;
  fetchComments();
}

function loadMore() {
  if (loading || exhausted) return;
  loading = true;
  window.tv.moreComments(pstate.currentVideoId).then((r) => {
    loading = false;
    if (!pstate.commentsOpen || view !== 'list') return;
    const fresh = (r && r.comments) || [];
    if (!fresh.length) { exhausted = true; return; }
    const box = panel();
    fresh.forEach((c) => { threads.push(c); box.appendChild(renderComment(c, false)); });
    exhausted = !(r && r.hasMore);
    applyListFocus();
  }).catch(() => { loading = false; });
}

function openReplies(c) {
  view = 'replies';
  listSel = sel;
  replies = []; replySel = 0;
  const box = panel();
  box.innerHTML = '';
  const back = document.createElement('div');
  back.className = 'comments-hdr';
  back.textContent = '◂ Back to comments';
  box.appendChild(back);
  box.appendChild(renderComment(c, false)); // parent for context
  showNote('Loading replies…');
  const id = pstate.currentVideoId;
  window.tv.commentReplies(id, c.id).then((r) => {
    if (!pstate.commentsOpen || view !== 'replies' || pstate.currentVideoId !== id) return;
    replies = (r && r.replies) || [];
    renderReplies(c);
  }).catch(() => { if (view === 'replies') showNote('Replies unavailable'); });
}

function backToList() {
  view = 'list';
  renderList();
  sel = listSel;
  applyListFocus();
}

function renderList() {
  const box = panel();
  box.innerHTML = '';
  const hdr = document.createElement('div');
  hdr.className = 'comments-hdr';
  hdr.textContent = (count ? count + ' ' : '') + 'Comments · ' + (sort === 'new' ? 'Newest' : 'Top') + '  ◂▸';
  box.appendChild(hdr);
  threads.forEach((c) => box.appendChild(renderComment(c, false)));
  applyListFocus();
}

function renderReplies(parent) {
  const box = panel();
  const note = box.querySelector('.chat-note');
  if (note) note.remove();
  if (!replies.length) { showNote('No replies'); return; }
  replies.forEach((rp) => box.appendChild(renderComment(rp, true)));
  applyReplyFocus();
}

function renderComment(c, isReply) {
  const row = document.createElement('div');
  row.className = 'comment-row' + (isReply ? ' comment-reply' : '');
  row.dataset.cid = c.id;
  if (c.avatar) {
    const img = new Image();
    img.className = 'comment-avatar';
    img.decoding = 'async'; img.loading = 'lazy';
    img.src = c.avatar;
    row.appendChild(img);
  }
  const body = document.createElement('div');
  body.className = 'comment-body';
  const meta = document.createElement('div');
  meta.className = 'comment-meta';
  if (c.pinned) { const p = document.createElement('span'); p.className = 'comment-pin'; p.textContent = '📌 Pinned'; meta.appendChild(p); }
  const author = document.createElement('span');
  author.className = 'comment-author' + (c.owner ? ' is-owner' : '');
  author.textContent = c.author;
  meta.appendChild(author);
  if (c.verified) { const v = document.createElement('span'); v.className = 'chat-verified'; v.textContent = '✓'; meta.appendChild(v); }
  if (c.time) { const t = document.createElement('span'); t.className = 'comment-time'; t.textContent = c.time; meta.appendChild(t); }
  body.appendChild(meta);
  const txt = document.createElement('div');
  txt.className = 'comment-text';
  appendRuns(txt, c.runs);
  body.appendChild(txt);
  const foot = document.createElement('div');
  foot.className = 'comment-foot';
  let footTxt = '👍 ' + (c.likes || '0');
  if (c.hearted) footTxt += '  ♥';
  if (!isReply && c.hasReplies && c.replyCount) footTxt += '   💬 ' + c.replyCount + ' ▸';
  foot.textContent = footTxt;
  body.appendChild(foot);
  row.appendChild(body);
  return row;
}

function applyListFocus() {
  const rows = panel().querySelectorAll('.comment-row:not(.comment-reply)');
  rows.forEach((r, i) => {
    r.classList.toggle('focused', i === sel);
    if (i === sel) r.scrollIntoView({ block: 'nearest' });
  });
}

function applyReplyFocus() {
  const rows = panel().querySelectorAll('.comment-row.comment-reply');
  rows.forEach((r, i) => {
    r.classList.toggle('focused', i === replySel);
    if (i === replySel) r.scrollIntoView({ block: 'nearest' });
  });
}

function clearPanel() { const box = panel(); if (box) box.innerHTML = ''; }

function showNote(text) {
  const box = panel();
  if (!box) return;
  let n = box.querySelector('.chat-note');
  if (!n) { n = document.createElement('div'); n.className = 'chat-note'; box.appendChild(n); }
  n.textContent = text;
}

function applyLayout() {
  const box = panel();
  if (!box) return;
  const side = Settings.get('commentsSide') || 'right';
  const width = Settings.get('commentsWidth') || 'med';
  box.dataset.side = side;
  box.dataset.width = width;
  box.dataset.size = Settings.get('commentsFontSize') || 'med';
  const overlay = $('player-overlay');
  overlay.dataset.commentsSide = side;
  overlay.dataset.commentsWidth = width;
}
