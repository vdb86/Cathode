// SPDX-License-Identifier: GPL-3.0-or-later
// Shared mutable renderer state. Feature modules can't reassign an imported
// binding, so cross-module mutable values live on this object (e.g.
// state.currentFeed = feed). Extracted from app.js (renderer ES-module split,
// s95); more fields will migrate here as further clusters are split out.

export const state = {
  viewMode: 'grid',      // 'grid' (flat 4-col) | 'shelves' (Home categories)
  currentFeed: null,     // last rendered video feed (kept so toggling re-renders)

  // Core router / navigation state (migrated s96 so the OSK/search + menu
  // clusters can move out; app.js still owns the functions that mutate these).
  mode: 'browse',            // browse | search | auth | player | menu | error
  currentSection: 'home',    // home | subscriptions | channel | search
  gridSection: null,         // section that supports load-more (null = none)
  loadToken: 0,              // bumped per navigation; a stale async load checks it before rendering/stealing focus
  currentPlaylistId: null,   // set while viewing a specific playlist / Watch Later
  currentPlaylistName: null,
  currentAccountName: 'Guest', // active profile name, for the {account} command var (migrated s102)

  // SponsorBlock (migrated s103; the skip/notify/ask logic lives in sb.js).
  sbSegments: [],   // current video's fetched segments (set by play(), drawn by renderSbMarkers)
  sbEnabled: true,  // per-playback auto-skip toggle (toggleSb)
  sbAskSeg: null,   // segment awaiting a manual OK-to-skip (action = 'ask')

  // Account-scoped caches (migrated s100). resetAccountScopedCaches() in app.js
  // nulls these on account switch/remove so a switched account never shows the
  // previous one's data.
  subsChannels: null,    // cached subscription channel list
  currentPlaylists: null, // cached playlist list
  currentMusic: null,    // cached real-YT-Music items (songs + playlists)
  wlIds: null,           // Set of video ids currently in Watch Later (lazy)
};
