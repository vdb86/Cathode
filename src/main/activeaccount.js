// SPDX-License-Identifier: GPL-3.0-or-later
// Active-account path resolver (account isolation, s76).
//
// Every account -- including the always-present Guest (id 'guest') -- gets its
// own folder Data/accounts/<id>/ holding that account's ui_settings.json,
// sb_settings.json, search_history.json and feed snapshots. This module just
// tracks WHICH account is active and resolves its folder, so the per-account
// settings consumers (index.js ui:*/search:*, sponsorblock.js) don't each need
// to know the account id -- they call file()/dir() and follow the active id.
//
// innertube.js is the single writer of the active id: it calls set() whenever
// the selected account changes (init, selectAccount, guest, addAccount,
// removeAccount). The OAuth credentials themselves stay in the encrypted
// registry (yt_accounts.json), NOT in these folders.

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const GUEST_ID = 'guest';
let id = GUEST_ID;

function set(v) { id = v || GUEST_ID; }
function get() { return id; }

// Resolve (and create) an account's folder. Pass an explicit id to target a
// specific account; omit it for the active one.
function dir(forId) {
  const p = path.join(app.getPath('userData'), 'accounts', forId || id);
  try { fs.mkdirSync(p, { recursive: true }); } catch (e) {}
  return p;
}

function file(name, forId) { return path.join(dir(forId), name); }

module.exports = { set, get, dir, file, GUEST_ID };
