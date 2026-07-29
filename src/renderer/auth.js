// SPDX-License-Identifier: GPL-3.0-or-later
// Account sign-in overlay (renderer split, s117). The device-code sign-in flow:
// the #auth-overlay (verification URL + user code + scannable QR), its Copy/Open
// buttons, D-pad focus, the mode==='auth' input router branch, and the three
// auth-lifecycle IPC handlers (pending / success / restored). A self-contained
// leaf: one-way imports from util/state/authqr + refreshAccountLabel (accounts)
// and loadSection (feeds); nothing imports back. app.js calls initAuth() once at
// boot to register the IPC listeners, and delegates its mode==='auth' router
// branch to handleAuthInput.

import { $, toast, show, hide } from './util.js';
import { state } from './state.js';
import { renderAuthQr } from './authqr.js';
import { refreshAccountLabel } from './accounts.js';
import { loadSection } from './feeds.js';

let authFocus = 0;

function authButtons() {
  return Array.from(document.querySelectorAll('.auth-btn'));
}

function applyAuthFocus() {
  authButtons().forEach((b, i) => b.classList.toggle('focused', i === authFocus));
}

async function activateAuthButton() {
  const btn = authButtons()[authFocus];
  if (!btn) return;
  if (btn.dataset.auth === 'copy') {
    const ok = await window.tv.authCopyCode();
    toast(ok ? 'Code copied to clipboard' : 'No code to copy yet');
  } else if (btn.dataset.auth === 'open') {
    const ok = await window.tv.authOpenUrl();
    toast(ok ? 'Sign-in page opened in your browser' : 'No sign-in link yet');
  }
}

// mode==='auth' input router branch (delegated from app.js).
export function handleAuthInput(a) {
  if (a === 'back') { hide('auth-overlay'); state.mode = 'browse'; }
  if (a === 'left' || a === 'up') { authFocus = Math.max(0, authFocus - 1); applyAuthFocus(); }
  if (a === 'right' || a === 'down') { authFocus = Math.min(authButtons().length - 1, authFocus + 1); applyAuthFocus(); }
  if (a === 'select') activateAuthButton();
}

// Register the auth-lifecycle IPC listeners once at boot.
export function initAuth() {
  window.tv.onAuthPending((data) => {
    const url = data.url, code = data.code;
    state.mode = 'auth';
    $('auth-url').textContent = url || 'google.com/device';
    $('auth-code').textContent = code || '';
    // Prefer a pre-filled URL from main; else build one from url + code.
    const link = data.urlComplete || (url && code ? url + '?user_code=' + encodeURIComponent(code) : url || '');
    renderAuthQr(link);
    authFocus = 0;
    applyAuthFocus();
    show('auth-overlay');
  });

  window.tv.onAuthSuccess(() => {
    hide('auth-overlay');
    state.mode = 'browse';
    refreshAccountLabel();
    loadSection('home');
  });

  // Stored session restored at boot (every normal start). Unlike a fresh
  // sign-in this must NOT reload Home -- the home loader already awaits the
  // restore internally (s53). Just reflect the signed-in account's name.
  window.tv.onAuthRestored(() => {
    refreshAccountLabel();
  });
}
