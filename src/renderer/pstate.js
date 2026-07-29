// SPDX-License-Identifier: GPL-3.0-or-later
// Player / transport shared state (renderer split, s107). A player-scoped
// sibling of state.js: the reassignable scalars the player + transport code
// passes around, hoisted out of app.js so the player clusters (playback,
// transport/HUD, slide-up menus, queue/background, suggestions drawer,
// captions/chapters) can each be extracted into their own module later and
// still read/write the SAME state. Only reassignable state lives here;
// constants (SPEEDS/ASPECTS/REPEAT_MODES/P_ICONS/P_LABELS/SVG_*/...) stay with
// their owning code until the cluster that uses them moves out.

export const pstate = {
  // --- playback core ---
  shakaPlayer: null,
  currentPoToken: null,     // GVS PoToken for the current video (live segment auth)
  currentVideoId: null,     // the video currently in the player
  currentChannelId: null,   // channel of the current video (for Subscribe)
  currentVideoObj: null,    // { id, title, author } of the playing video
  playedThisSession: false, // gates the pre-roll 'first video of session' trigger

  // --- transport / HUD / button row ---
  hudTimer: null,
  P_BUTTONS: ['prev', 'rw', 'playpause', 'stop', 'ff', 'next', 'like', 'dislike', 'subscribe', 'cc', 'audio', 'speed', 'quality', 'save', 'sb', 'repeat', 'aspect', 'stats', 'screenoff', 'openchannel', 'livechat', 'comments', 'download', 'cog'],
  pRow: 'buttons',
  pCol: 2,                  // default focus: play/pause
  _btnOrderSig: null,

  // --- slide-up option menus ---
  pMenu: null,              // open slide-up option menu: { kind, items, index }
  speedIdx: 1,              // default 1x (index into SPEEDS; 0.5x sits above it in the menu)
  qualityIdx: 0,
  qualityLabel: 'Auto',
  qualityOptions: [],       // current quality-menu options ('auto' + heights)
  aspectIdx: 0,
  playbackMode: 'next',

  // --- rating / subscribe (optimistic, per session) ---
  currentRating: 'none',    // 'none' | 'like' | 'dislike'
  currentSubscribed: false,

  // --- captions / audio / chapters / seek-preview ---
  captionTracks: [],        // available caption tracks for the current video
  captionIdx: 0,            // 0 = Off; else (index into captionTracks) + 1
  addedCaptions: new Map(), // caption url -> Shaka text track (added lazily)
  audioLangs: [],           // audio languages offered by the current stream (Shaka-side, single-audio path)
  audioTracks: [],          // [{code,variant,name,original,default}] audio options (language + processing variant) from SABR
  audioLang: '',            // primary code of the currently playing audio language
  audioVariant: '',         // '' (normal) | 'drc' (Stable Volume) | 'vb' (Voice Boost)
  storyboard: null,         // seek-preview storyboard spec for the current video
  chapters: [],             // [{ start (sec), title }] for the current video

  // --- background play + queue ---
  bgPlaying: false,         // true while a video plays in the background (mini/audio)
  userQueue: [],            // explicit user queue (survives stop; plays before related)
  upNext: [],               // up-next queue (related videos) for autoplay + Next
  railCtrlIdx: 0,           // focused control in the in-rail now-playing controls row
  prevStack: [],            // videos navigated away from, for Previous

  // --- in-player suggestions drawer ---
  relatedVideos: [],        // full related list for the drawer (not drained by Next)
  suggestOpen: false,       // in-player suggestions drawer visible
  suggestSel: 0,            // focused suggestion index in the drawer
  suggestLoading: false,    // a getMoreRelated fetch is in flight
  suggestExhausted: false,  // no more related to load for this video

  // --- live chat (read-only) ---
  hasLiveChat: false,       // current video has a live chat (gates the transport button)
  chatIsReplay: false,      // that chat is a VOD replay (offset-gated) vs a live stream
  chatOpen: false,          // the chat panel is visible
  isLiveVideo: false,       // current video is a live stream (hides the Comments button)

  // --- comments (read-only) ---
  commentsOpen: false,      // the comments panel is visible + capturing input
};
