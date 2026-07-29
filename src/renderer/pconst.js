// SPDX-License-Identifier: GPL-3.0-or-later
// Player constants (renderer split, s113). Immutable transport/menu data shared
// between the transport row (still in app.js) and the slide-up menu engine
// (playermenu.js): speeds, aspects, repeat modes, the button SVG icons, and the
// label/flag lookups. A pure-data leaf - no imports, no state.

export const SPEEDS = [0.5, 1, 1.25, 1.5, 2];
export const ASPECTS = [
  { k: 'fit', label: 'Fit', fit: 'contain', tf: '' },
  { k: 'fill', label: 'Fill', fit: 'cover', tf: '' },
  { k: 'stretch', label: 'Stretch', fit: 'fill', tf: '' },
  { k: 'zoom', label: 'Zoom', fit: 'cover', tf: 'scale(1.15)' }
];
// Playback mode. 'next' autoplays the up-next video at the
// end; 'one' loops the current video (native <video> loop); 'pause' pauses at
// the end; 'stop' closes the player at the end. Init from the setting at play().
export const REPEAT_MODES = [
  { v: 'next', label: 'Play next video' },
  { v: 'one', label: 'Repeat this video' },
  { v: 'pause', label: 'Pause when finished' },
  { v: 'stop', label: 'Stop when finished' }
];
export const SVG_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
export const SVG_PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
export const SVG_STOP = '<svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>';
export const SVG_TRASH = '<svg viewBox="0 0 24 24"><path d="M6 7h12l-1 13a2 2 0 01-2 2H9a2 2 0 01-2-2L6 7zm3-3h6l1 2H8l1-2z"/></svg>';
export const P_ICONS = {
  rw: '<svg viewBox="0 0 24 24"><path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"/></svg>',
  playpause: SVG_PAUSE,
  ff: '<svg viewBox="0 0 24 24"><path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6h2v12h-2z"/></svg>',
  cc: '<svg viewBox="0 0 24 24"><path d="M19 4H5a2 2 0 00-2 2v12a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-4a1 1 0 011-1h3a1 1 0 011 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 01-1 1h-3a1 1 0 01-1-1v-4a1 1 0 011-1h3a1 1 0 011 1v1z"/></svg>',
  audio: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05A4.47 4.47 0 0016.5 12zM14 3.23v2.06a7 7 0 010 13.42v2.06a9 9 0 000-17.54z"/></svg>',
  like: '<svg viewBox="0 0 24 24"><path d="M2 20h2V9H2v11zm20-11a2 2 0 00-2-2h-6.31l.95-4.57.03-.32a1.5 1.5 0 00-.44-1.06L13.17 0 6.59 6.59A2 2 0 006 8v10a2 2 0 002 2h9a2 2 0 001.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73V9z"/></svg>',
  dislike: '<svg viewBox="0 0 24 24"><path d="M22 4h-2v11h2V4zM2 15a2 2 0 002 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L10.83 24l6.58-6.59A2 2 0 0018 16V6a2 2 0 00-2-2H7a2 2 0 00-1.84 1.22L2.14 12.27c-.09.23-.14.47-.14.73v2z"/></svg>',
  subscribe: '<svg viewBox="0 0 24 24"><path d="M12 22a2 2 0 002-2h-4a2 2 0 002 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4a1.5 1.5 0 00-3 0v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>',
  speed: '<svg viewBox="0 0 24 24"><path d="M12 4a8 8 0 108 8 8 8 0 00-8-8zm0 14a6 6 0 116-6 6 6 0 01-6 6zm1-9h-2v4l3 2 .9-1.5-1.9-1.1z"/></svg>',
  quality: '<svg viewBox="0 0 24 24"><path d="M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M17 3H7a2 2 0 00-2 2v16l7-3 7 3V5a2 2 0 00-2-2z"/></svg>',
  sb: '<svg viewBox="0 0 24 24"><path d="M12 2L4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5z"/></svg>',
  repeat: '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z"/></svg>',
  aspect: '<svg viewBox="0 0 24 24"><path d="M19 12h-2v3h-3v2h5zM7 9h3V7H5v5h2zm14-6H3a2 2 0 00-2 2v14a2 2 0 002 2h18a2 2 0 002-2V5a2 2 0 00-2-2zm0 16.01H3V4.99h18z"/></svg>',
  stats: '<svg viewBox="0 0 24 24"><path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9a10 10 0 1010 10A10 10 0 0012 2zm0 18a8 8 0 118-8 8 8 0 01-8 8z"/></svg>',
  screenoff: '<svg viewBox="0 0 24 24"><path d="M21 3H3a2 2 0 00-2 2v12a2 2 0 002 2h6v2h6v-2h6a2 2 0 002-2V5a2 2 0 00-2-2zm0 14H3V5h18z"/></svg>',
  openchannel: '<svg viewBox="0 0 24 24"><path d="M4 4h7v7H4zm9 0h7v7h-7zm-9 9h7v7H4zm9 0h7v7h-7z"/></svg>',
  livechat: '<svg viewBox="0 0 24 24"><path d="M21 6h-2v9H6v2a1 1 0 001 1h11l4 4V7a1 1 0 00-1-1zm-4 6V4a1 1 0 00-1-1H3a1 1 0 00-1 1v14l4-4h10a1 1 0 001-1z"/></svg>',
  comments: '<svg viewBox="0 0 24 24"><path d="M3 5h18v2H3zm0 5h18v2H3zm0 5h12v2H3z"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg>',
  stop: SVG_STOP,
  cog: '<svg viewBox="0 0 24 24"><path d="M19.14 12.94a7.49 7.49 0 000-1.88l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.61-.22l-2.39.96a7 7 0 00-1.62-.94l-.36-2.54a.5.5 0 00-.5-.42h-3.84a.5.5 0 00-.5.42l-.36 2.54a7 7 0 00-1.62.94l-2.39-.96a.5.5 0 00-.61.22L2.68 8.84a.5.5 0 00.12.64l2.03 1.58a7.49 7.49 0 000 1.88l-2.03 1.58a.5.5 0 00-.12.64l1.92 3.32a.5.5 0 00.61.22l2.39-.96a7 7 0 001.62.94l.36 2.54a.5.5 0 00.5.42h3.84a.5.5 0 00.5-.42l.36-2.54a7 7 0 001.62-.94l2.39.96a.5.5 0 00.61-.22l1.92-3.32a.5.5 0 00-.12-.64zM12 15.5A3.5 3.5 0 1115.5 12 3.5 3.5 0 0112 15.5z"/></svg>'
};
export const P_WITH_LABEL = new Set(['speed', 'quality', 'aspect', 'audio']);
// Human labels for the cog (overflow) menu items.
export const P_LABELS = { prev: 'Previous', rw: 'Rewind', playpause: 'Play/Pause', stop: 'Stop', ff: 'Fast-forward', next: 'Next', like: 'Like', dislike: 'Dislike', subscribe: 'Subscribe', cc: 'Subtitles', audio: 'Audio track', speed: 'Speed', quality: 'Quality', save: 'Save', sb: 'SponsorBlock', repeat: 'Repeat', aspect: 'Aspect ratio', stats: 'Stats', screenoff: 'Screen off', openchannel: 'Open channel', livechat: 'Live chat', comments: 'Comments', download: 'Download' };
// Player buttons whose On/Off state matters and must stay visible in the cog
// menu. All use the .pbtn 'on' class EXCEPT stats (-> #player-stats visible).
export const COG_STATEFUL = new Set(['like', 'dislike', 'subscribe', 'save', 'sb', 'cc', 'stats', 'repeat']);
