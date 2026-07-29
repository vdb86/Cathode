// SPDX-License-Identifier: GPL-3.0-or-later
// Scannable QR for the device-code sign-in (phone camera). Encodes the
// pre-filled verification URL so the phone opens Google's device page with the
// code already entered; the on-screen code stays as the fallback. Uses the
// global `qrcode` from vendor/qrcode.js (a classic script loaded before this
// module). Extracted from app.js (renderer ES-module split, s93).

import { $, show, hide } from './util.js';

export function renderAuthQr(link) {
  const box = $('auth-qr');
  if (!box) return;
  box.innerHTML = '';
  if (!link || typeof qrcode === 'undefined') { hide('auth-qr'); hide('auth-qr-hint'); return; }
  try {
    const qr = qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    const count = qr.getModuleCount();
    const cell = 6, margin = 4 * cell, size = count * cell + margin * 2;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(margin + c * cell, margin + r * cell, cell, cell);
    }
    box.appendChild(canvas);
    show('auth-qr');
    show('auth-qr-hint');
  } catch (e) {
    hide('auth-qr'); hide('auth-qr-hint');
  }
}
