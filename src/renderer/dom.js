// SPDX-License-Identifier: GPL-3.0-or-later
// Shared DOM handles for the renderer's fixed elements. Extracted from app.js
// (renderer ES-module split, s95) so app.js and feature modules reference the
// same nodes. Resolved at module load (module scripts run after DOM parse).

import { $ } from './util.js';

export const grid = $('grid');
export const shelvesBox = $('shelves');
export const title = $('section-title');
export const video = $('video');
