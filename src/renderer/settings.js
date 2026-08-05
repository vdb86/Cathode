// SPDX-License-Identifier: GPL-3.0-or-later
// Settings screen - "card grid -> dialog" pattern.
//
// The rail "Settings" item opens a GRID of category cards (rendered into the
// normal #grid, so the existing spatial nav handles it). Selecting a category
// card opens a modal DIALOG (#settings-overlay) that is a vertical list of
// option rows. Row input while the dialog is open:
//   Up/Down  -> move between rows
//   Left/Right + A -> change the focused row's value (bool toggles; enums cycle)
//   B/Esc    -> close the dialog, back to the category grid
//
// Persistence: most settings live in ui_settings.json (window.tv.getUiSettings/
// setUiSettings). SponsorBlock settings live in sb_settings.json (read by the
// main process for the segment lookup) via window.tv.getSbSettings/setSbSettings.
//
// Effects: applyAll() pushes the visual settings into CSS (custom properties on
// :root, body classes, the #grid template, a dynamic ::cue <style>, and rail
// item visibility). SponsorBlock behaviour (action/markers/min-duration) and
// bootSection / recordHistory are read live by app.js via Settings.get / .sb.
//
// This file owns ALL settings-screen logic so app.js only needs small hooks
// (see the "Settings hooks" comments in app.js).

const Settings = (function () {
  const $ = (id) => document.getElementById(id);

  // ---- defaults (ui_settings.json) ----
  const UI_DEFAULTS = {
    // interface
    cardTitleLines: 2,        // 1..3
    roundedCards: true,
    uiScale: 100,             // 80..130 (%)
    gridCols: 4,              // 3..6
    channelSort: 'default',   // default | az
    playlistLayout: 'grid',   // grid | list
    railMini: false,          // collapse the side rail to icons (expands on focus)
    cardAutoscroll: false,    // scroll long card titles when focused (titles go single-line)
    theme: 'dark',            // colour scheme: dark | oled | grey | light (see THEMES)
    accent: 'blue',           // accent / focus colour (see ACCENTS)
    padBinds: {},             // controller rebinds: action -> [button index]; {} = defaults (gamepad.js)
    keyBinds: {},             // keyboard rebinds: action -> [key]; {} = defaults (gamepad.js)
    view: 'grid',             // Home layout: 'grid' (flat) | 'shelves' (categories)
    // language / country (InnerTube hl / gl). '' = youtubei.js default (en / US)
    contentLang: '',          // hl
    contentCountry: '',       // gl
    // about
    autoUpdateNotify: true,   // toast on launch when a newer GitHub release exists (opt-out in About)
    // search
    searchAutocomplete: true, // live suggestions as you type
    searchHistory: true,      // remember + show recent searches
    // general
    bootSection: 'home',
    feedSnapshots: true,      // paint last session's feed instantly on startup (off = always fresh)
    // per-section feed-cache TTL in minutes (how long loaded content is reused
    // before a refetch); read live main-side by innertube.js cachedFeed.
    ttlHome: 5, ttlSubs: 5, ttlHistory: 5, ttlMusic: 5, ttlPlaylists: 5,
    recordHistory: true,
    disabledSections: [],     // rail sections hidden by the user
    appExit: 'double',        // double | single (Back on the rail)
    // screen dimming (General): fade a black overlay in after inactivity
    dimEnabled: false,
    dimAmount: 40,            // 20/40/60/80 (percent black)
    dimTimeout: 5,            // minutes of inactivity before dimming
    // background playback
    bgPlay: false,            // keep playing after leaving a video (Back minimizes instead of stops)
    bgSelectAction: 'replace',// replace (play the new video) | queue (add to up-next)
    bgSelectView: 'fullscreen',// on replace: fullscreen | mini (stay in the mini-player)
    // subtitles
    subScale: 100,            // 75..200 (%)
    subBackground: true,
    // player
    hudTimeout: 3,            // seconds; 0 = never auto-hide
    playerButtonTips: true,   // show the focused player button's name as a tooltip
    rememberSpeed: false,
    lastSpeed: 1,
    defaultAspect: 'fit',     // fit | fill | stretch | zoom
    timeDisplay: 'elapsed',   // elapsed | remaining
    playbackMode: 'next',     // next | one | pause | stop (playback mode; also the autoplay switch: 'next' autoplays, the rest don't)
    seekPreview: true,
    maxRes: 0,                // 0 = auto; else max height
    maxFps: 0,                // 0 = auto; else 30/60
    prefAudioLang: '',        // '' = auto; else ISO code
    hiddenPlayerButtons: [],
    cogButtons: ['quality', 'speed', 'audio', 'aspect', 'sb', 'stats'],
    playerButtonOrder: [],    // custom transport-button order ([] = default order)
    // seeking
    seekMode: 'instant',              // instant | delayed | accelerated
    seekSteps: [10, 30, 60, 180, 600],// enabled accelerated ladder (seconds)
    seekSkipDelay: 750,               // ms of no input before a scrub commits
    bumperAccel: false,               // FF/RW bumpers follow the scrub (else fixed 10s)
    // clock / date on screen
    clockEnabled: false,      // master on/off
    clockShowHome: true,      // show on Home / browse screens (top-right)
    clockShowPlayer: true,    // show in the player HUD
    clockContent: 'time',     // time | date | datetime (what is shown)
    clockOrder: 'time',       // when datetime: 'time' first | 'date' first
    clockTimeFormat: '24',    // '24' | '12'
    clockSeconds: false,      // include seconds in the time
    clockDateFormat: 'dow-dm', // see clockDateStr() in app.js for the full list
    // live chat (read-only)
    chatFilter: 'top',        // top | live (Top chat = filtered/calmer; Live chat = full firehose)
    chatSide: 'right',        // right | left (which side the panel docks)
    chatWidth: 'med',         // narrow | med | wide
    chatFontSize: 'med',      // sm | med | lg
    chatSuperchats: true,     // show Super Chats / paid messages
    chatHideMembers: false,   // hide membership / new-member notices
    chatAutoOpen: false,      // open the chat panel automatically when a video has one
    chatAutoHide: false,      // dim the panel after a stretch with no new messages
    // comments (read-only)
    commentsSort: 'top',      // top | new (default sort order)
    commentsSide: 'right',    // right | left
    commentsWidth: 'med',     // narrow | med | wide
    commentsFontSize: 'med',  // sm | med | lg
    commentsAutoOpen: false,  // open the comments panel automatically on non-live videos
    // playback commands (pre-roll / post-roll; run main-side via child_process)
    preCmdEnabled: false,
    preCmd: '',
    preCmdTrigger: 'every',   // every | first (first play of the session)
    startCmdEnabled: false,   // run when playback actually starts (vars populated)
    startCmd: '',
    startCmdTrigger: 'every', // every | first
    postCmdEnabled: false,
    postCmd: '',
    postCmdTrigger: 'end',    // end | stop | both
    // like / dislike counts (Return YouTube Dislike for dislikes). Two
    // independent toggles: in the player (Player card) and on cards (Interface).
    ratingCountsPlayer: true, // show counts under the player title
    ratingCountsCards: false, // show counts on video cards (one RYD lookup each)
    hideShorts: false,        // hide Shorts tiles + the Shorts shelf from feeds
    // network: optional proxy + custom DNS-over-HTTPS (applied main-side by network.js)
    proxyEnabled: false,
    proxyServer: '',          // e.g. http://host:port or socks5://host:port
    proxyBypass: '',          // comma / space separated no-proxy hosts (optional)
    dohEnabled: false,
    dohServer: ''             // e.g. https://dns.google/dns-query
  };

  // ---- defaults (sb_settings.json) mirror sponsorblock.js DEFAULTS + a few
  //      renderer-only keys (action / colorMarkers / minDuration). The main
  //      process only reads enabled + categories; the rest are honoured here. ----
  const SB_DEFAULTS = {
    enabled: true,
    action: 'notify',         // 'skip' | 'notify' | 'ask'
    askDuration: 5,           // 'ask' prompt seconds on screen; 0 = until the segment ends
    colorMarkers: true,
    minDuration: 0,           // ignore segments shorter than N seconds
    categories: {
      sponsor: true, selfpromo: true, interaction: true, intro: false,
      outro: false, preview: false, music_offtopic: false, filler: false
    }
  };

  // ---- defaults (dearrow_settings.json) mirror dearrow.js DEFAULTS. The main
  //      process reads these to decide whether to look up / apply branding. ----
  const DA_DEFAULTS = { enabled: false, titles: true, thumbnails: true };

  const OPTIONAL_SECTIONS = [
    { key: 'subscriptions', label: 'Subscriptions' },
    { key: 'music', label: 'Music' },
    { key: 'playlists', label: 'Playlists' },
    { key: 'watchlater', label: 'Watch Later' },
    { key: 'history', label: 'History' }
  ];

  const SB_CATS = [
    { key: 'sponsor', label: 'Sponsor' },
    { key: 'selfpromo', label: 'Self-promotion' },
    { key: 'interaction', label: 'Interaction reminder' },
    { key: 'intro', label: 'Intro / intermission' },
    { key: 'outro', label: 'Outro / endcards' },
    { key: 'preview', label: 'Preview / recap' },
    { key: 'music_offtopic', label: 'Non-music section' },
    { key: 'filler', label: 'Filler / tangent' }
  ];

  // Player transport buttons that can be shown/hidden (play/pause is always on).
  const PLAYER_BUTTONS = [
    { act: 'prev', label: 'Previous' }, { act: 'rw', label: 'Rewind' },
    { act: 'ff', label: 'Fast-forward' }, { act: 'next', label: 'Next' },
    { act: 'like', label: 'Like' }, { act: 'dislike', label: 'Dislike' },
    { act: 'subscribe', label: 'Subscribe' }, { act: 'cc', label: 'Subtitles' },
    { act: 'audio', label: 'Audio track' }, { act: 'speed', label: 'Speed' },
    { act: 'quality', label: 'Quality' }, { act: 'save', label: 'Save' },
    { act: 'sb', label: 'SponsorBlock' }, { act: 'repeat', label: 'Repeat' },
    { act: 'aspect', label: 'Aspect ratio' }, { act: 'stats', label: 'Stats' },
    { act: 'screenoff', label: 'Screen off' }, { act: 'stop', label: 'Stop' },
    { act: 'openchannel', label: 'Open channel' }, { act: 'livechat', label: 'Live chat' },
    { act: 'comments', label: 'Comments' }, { act: 'download', label: 'Download' }
  ];

  // Reorderable transport buttons (play/pause and the cog/More button included;
  // cog defaults to last). Also the labels shown in the reorder popup.
  const BUTTON_ORDER_DEFAULT = ['prev', 'rw', 'playpause', 'stop', 'ff', 'next', 'like', 'dislike', 'subscribe', 'cc', 'audio', 'speed', 'quality', 'save', 'sb', 'repeat', 'aspect', 'stats', 'screenoff', 'openchannel', 'livechat', 'comments', 'cog'];
  const BUTTON_LABELS = { playpause: 'Play/Pause', prev: 'Previous', rw: 'Rewind', stop: 'Stop', ff: 'Fast-forward', next: 'Next', like: 'Like', dislike: 'Dislike', subscribe: 'Subscribe', cc: 'Subtitles', audio: 'Audio track', speed: 'Speed', quality: 'Quality', save: 'Save', sb: 'SponsorBlock', repeat: 'Repeat', aspect: 'Aspect ratio', stats: 'Stats', screenoff: 'Screen off', openchannel: 'Open channel', livechat: 'Live chat', comments: 'Comments', cog: 'More (cog)' };

  // Accelerated-seek ladder values (seconds). The user enables a subset; the
  // step climbs through the enabled values as they keep scrubbing one way.
  const SEEK_STEPS = [
    { v: 5, label: '5s' }, { v: 10, label: '10s' }, { v: 15, label: '15s' },
    { v: 30, label: '30s' }, { v: 60, label: '1m' }, { v: 180, label: '3m' },
    { v: 300, label: '5m' }, { v: 600, label: '10m' }, { v: 900, label: '15m' },
    { v: 1800, label: '30m' }
  ];

  // Per-section feed-cache TTL options (minutes). Used by the Cache category.
  const TTL_OPTS = [
    { v: 1, label: '1 min' }, { v: 2, label: '2 min' }, { v: 5, label: '5 min' },
    { v: 10, label: '10 min' }, { v: 15, label: '15 min' }, { v: 30, label: '30 min' },
    { v: 60, label: '1 hour' }
  ];

  // Content language (InnerTube hl) options. '' = default (English / auto).
  const LANGS = [
    { v: '', label: 'Default (English)' }, { v: 'en', label: 'English' },
    { v: 'es', label: 'Spanish' }, { v: 'pt', label: 'Portuguese' },
    { v: 'fr', label: 'French' }, { v: 'de', label: 'German' },
    { v: 'it', label: 'Italian' }, { v: 'nl', label: 'Dutch' },
    { v: 'pl', label: 'Polish' }, { v: 'ru', label: 'Russian' },
    { v: 'uk', label: 'Ukrainian' }, { v: 'sr', label: 'Serbian' },
    { v: 'hr', label: 'Croatian' }, { v: 'tr', label: 'Turkish' },
    { v: 'ar', label: 'Arabic' }, { v: 'hi', label: 'Hindi' },
    { v: 'ja', label: 'Japanese' }, { v: 'ko', label: 'Korean' },
    { v: 'zh', label: 'Chinese' }
  ];
  // Content country (InnerTube gl). '' = default (US / auto).
  const COUNTRIES = [
    { v: '', label: 'Default (US)' }, { v: 'US', label: 'United States' },
    { v: 'GB', label: 'United Kingdom' }, { v: 'CA', label: 'Canada' },
    { v: 'AU', label: 'Australia' }, { v: 'DE', label: 'Germany' },
    { v: 'FR', label: 'France' }, { v: 'ES', label: 'Spain' },
    { v: 'IT', label: 'Italy' }, { v: 'NL', label: 'Netherlands' },
    { v: 'PT', label: 'Portugal' }, { v: 'PL', label: 'Poland' },
    { v: 'RU', label: 'Russia' }, { v: 'UA', label: 'Ukraine' },
    { v: 'RS', label: 'Serbia' }, { v: 'HR', label: 'Croatia' },
    { v: 'TR', label: 'Turkey' }, { v: 'BR', label: 'Brazil' },
    { v: 'MX', label: 'Mexico' }, { v: 'IN', label: 'India' },
    { v: 'JP', label: 'Japan' }, { v: 'KR', label: 'South Korea' }
  ];

  let ui = {};          // live ui_settings
  let sb = {};          // live sb_settings
  let da = {};          // live dearrow_settings
  let sys = {};         // live system_settings (global: tray + startup + companion)
  const SYS_DEFAULTS = { exitToTray: false, launchOnStartup: false, startMinimized: false, companionEnabled: false, companionPort: 8878 };
  // Live companion-remote status (server state + paired/connected devices),
  // fetched when the Remote card opens and refreshed on the device-change push.
  let companionData = { running: false, enabled: false, connected: 0, pairing: null, devices: [] };
  let aboutInfo = null; // { version, electron, chrome, node } fetched at init
  // App self-update (About card). updateInfo = last check {newer, latest};
  // updateStaged = {version} once downloaded + ready to apply; updateBusy while a
  // download runs; updateProgressText patched live onto the progress row. canSelf
  // reflects whether in-place update is possible (packaged + writable folder).
  let updateInfo = null;
  let updateStaged = null;
  let updateBusy = false;
  let updateProgressText = '';
  let updateCanSelf = false;
  const UPDATE_PROGRESS_LABEL = 'Downloading update';
  let debugOn = false;  // Settings > About debug switch (global; via tv.debugGet/Set)
  let hooks = {};       // { toast, onOpenDialog, onCloseDialog, onLaunchAccounts, onLocaleChange }

  // dialog state
  let dialogCat = null; // current category id while a dialog is open
  let rows = [];        // [{ ...spec, valueText, kind }]
  let rowIdx = 0;
  let picker = null;    // open option-picker popup: { rowIdx, index, options }
  let backupCache = []; // last-fetched list of backups (for the Backup card)
  let backupCadence = 'off'; // last-fetched auto-backup cadence (global, main-side)
  let dlState = null;    // last-fetched yt-dlp/ffmpeg binary state (Downloads card)
  let dlSettings = null; // last-fetched GLOBAL download settings (main-side)
  let dlUpdateInfo = null; // last yt-dlp update check {current,latest,upToDate}; gates the Update row
  // Per-binary install progress: which ('ytdlp'|'ffmpeg'|'deno') -> live text. A
  // key present means that binary is installing; all three can run in parallel.
  let dlInstalls = {};
  const DENO_ROW_LABEL = 'Deno (faster downloads)'; // row label + onDlBinProgress patch key
  const DL_ROW_LABEL = { ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg', deno: DENO_ROW_LABEL };

  // ---------- store helpers ----------
  function uiGet(k) { return (k in ui) ? ui[k] : UI_DEFAULTS[k]; }
  function uiSet(patch) { Object.assign(ui, patch); window.tv.setUiSettings(patch).catch(() => {}); }
  function sbGet(k) { return (k in sb) ? sb[k] : SB_DEFAULTS[k]; }
  function sbSet(patch) {
    Object.assign(sb, patch);
    if (window.tv.setSbSettings) window.tv.setSbSettings(patch).catch(() => {});
  }
  function daGet(k) { return (k in da) ? da[k] : DA_DEFAULTS[k]; }
  function daSet(patch) {
    Object.assign(da, patch);
    if (window.tv.setDearrowSettings) window.tv.setDearrowSettings(patch).catch(() => {});
  }
  // System prefs are GLOBAL (not per-account): tray + launch-on-startup.
  function sysGet(k) { return (k in sys) ? sys[k] : SYS_DEFAULTS[k]; }
  function sysSet(patch) {
    Object.assign(sys, patch);
    if (window.tv.setSystemPrefs) window.tv.setSystemPrefs(patch).catch(() => {});
  }

  // ---------- theming (Interface > Colour scheme + Accent colour) ----------
  // Each THEME is a coherent surface palette; the chosen ACCENT recolours the
  // focus ring + every translucent focus fill (those derive from --focus via
  // color-mix in styles.css). applyAll() writes these onto :root. The player
  // HUD re-declares dark surface vars locally (styles.css) so a Light scheme
  // stays readable over video.
  const THEMES = {
    dark:  { '--bg': '#0f0f0f', '--card': '#1f1f1f', '--text': '#f1f1f1', '--text-dim': '#aaaaaa', '--accent': '#ffffff', '--overlay-bg': 'rgba(0,0,0,0.92)',    '--popup-bg': 'rgba(20,20,20,0.98)', '--chip-bg': 'rgba(0,0,0,0.45)',       '--rail-grad': 'rgba(0,0,0,0.85)' },
    oled:  { '--bg': '#000000', '--card': '#121212', '--text': '#f1f1f1', '--text-dim': '#9a9a9a', '--accent': '#ffffff', '--overlay-bg': 'rgba(0,0,0,0.96)',    '--popup-bg': 'rgba(8,8,8,0.99)',    '--chip-bg': 'rgba(0,0,0,0.6)',        '--rail-grad': 'rgba(0,0,0,0.9)' },
    light: { '--bg': '#f4f4f5', '--card': '#ffffff', '--text': '#141414', '--text-dim': '#5f6368', '--accent': '#141414', '--overlay-bg': 'rgba(240,240,242,0.95)', '--popup-bg': 'rgba(255,255,255,0.99)', '--chip-bg': 'rgba(255,255,255,0.72)', '--rail-grad': 'rgba(0,0,0,0.06)' },
    midnight: { '--bg': '#0d1b2a', '--card': '#1b2a3d', '--text': '#e6edf3', '--text-dim': '#9fb3c8', '--accent': '#ffffff', '--overlay-bg': 'rgba(6,12,20,0.94)',   '--popup-bg': 'rgba(20,32,48,0.99)', '--chip-bg': 'rgba(0,0,0,0.45)',       '--rail-grad': 'rgba(0,0,0,0.7)' },
    dracula:  { '--bg': '#282a36', '--card': '#3b3e52', '--text': '#f8f8f2', '--text-dim': '#b3b6cc', '--accent': '#ffffff', '--overlay-bg': 'rgba(18,19,28,0.94)',  '--popup-bg': 'rgba(52,56,74,0.99)', '--chip-bg': 'rgba(0,0,0,0.45)',       '--rail-grad': 'rgba(0,0,0,0.6)' },
    solarized:{ '--bg': '#002b36', '--card': '#0a3a46', '--text': '#eee8d5', '--text-dim': '#8ea3a3', '--accent': '#ffffff', '--overlay-bg': 'rgba(0,18,24,0.94)',   '--popup-bg': 'rgba(8,52,64,0.99)',  '--chip-bg': 'rgba(0,0,0,0.45)',       '--rail-grad': 'rgba(0,0,0,0.6)' },
    forest:   { '--bg': '#0e1a12', '--card': '#1b2c20', '--text': '#e7f0e8', '--text-dim': '#9db3a2', '--accent': '#ffffff', '--overlay-bg': 'rgba(5,14,9,0.94)',    '--popup-bg': 'rgba(22,42,30,0.99)', '--chip-bg': 'rgba(0,0,0,0.45)',       '--rail-grad': 'rgba(0,0,0,0.7)' },
    wine:     { '--bg': '#1c0e13', '--card': '#2e1a21', '--text': '#f3e7ea', '--text-dim': '#c4a3ac', '--accent': '#ffffff', '--overlay-bg': 'rgba(16,6,10,0.94)',   '--popup-bg': 'rgba(44,24,31,0.99)', '--chip-bg': 'rgba(0,0,0,0.45)',       '--rail-grad': 'rgba(0,0,0,0.7)' },
    sepia:    { '--bg': '#f4ecd8', '--card': '#fbf6ea', '--text': '#3a2f22', '--text-dim': '#7a6a52', '--accent': '#3a2f22', '--overlay-bg': 'rgba(244,236,216,0.95)', '--popup-bg': 'rgba(251,246,234,0.99)', '--chip-bg': 'rgba(255,255,255,0.7)', '--rail-grad': 'rgba(0,0,0,0.06)' }
  };
  const ACCENTS = {
    blue:   '#3ea6ff', red:    '#ff5252', green:  '#3ddc84', purple: '#b388ff',
    orange: '#ff9e3d', pink:   '#ff6ec7', teal:   '#26c6da', yellow: '#ffd24d'
  };
  const THEME_OPTS = [
    { v: 'dark', label: 'Dark' }, { v: 'oled', label: 'OLED Black' },
    { v: 'midnight', label: 'Midnight Blue' }, { v: 'dracula', label: 'Dracula' },
    { v: 'solarized', label: 'Solarized Dark' }, { v: 'forest', label: 'Forest' },
    { v: 'wine', label: 'Wine' }, { v: 'light', label: 'Light' },
    { v: 'sepia', label: 'Sepia' }
  ];
  const ACCENT_OPTS = [
    { v: 'blue', label: 'Blue' }, { v: 'red', label: 'Red' },
    { v: 'green', label: 'Green' }, { v: 'purple', label: 'Purple' },
    { v: 'orange', label: 'Orange' }, { v: 'pink', label: 'Pink' },
    { v: 'teal', label: 'Teal' }, { v: 'yellow', label: 'Yellow' }
  ];

  // ---------- category / row definitions ----------
  // Each category: { id, icon, label, launch? , build() -> rows }
  // Row kinds:
  //   bool  { label, get()->bool, toggle() }
  //   enum  { label, options:[{v,label}], get()->v, set(v) }
  const CATEGORIES = [
    {
      id: 'interface', icon: '🎨', label: 'Interface',
      build: () => [
        viewRow(),
        enumRow('Card title lines', 'cardTitleLines', [
          { v: 1, label: '1 line' }, { v: 2, label: '2 lines' }, { v: 3, label: '3 lines' }
        ]),
        boolRow('Rounded card corners', 'roundedCards'),
        enumRow('UI scale', 'uiScale', pct([80, 90, 100, 110, 120, 130])),
        enumRow('Video grid columns', 'gridCols', [
          { v: 3, label: '3' }, { v: 4, label: '4' }, { v: 5, label: '5' }, { v: 6, label: '6' }
        ]),
        enumRow('Subscription channel sorting', 'channelSort', [
          { v: 'default', label: 'Default' }, { v: 'az', label: 'A - Z' }
        ]),
        enumRow('Playlists layout', 'playlistLayout', [
          { v: 'grid', label: 'Grid' }, { v: 'list', label: 'List' }
        ]),
        boolRow('Minimize side rail (icons only)', 'railMini'),
        boolRow('Card text autoscroll', 'cardAutoscroll'),
        enumRow('Colour scheme', 'theme', THEME_OPTS),
        enumRow('Accent colour', 'accent', ACCENT_OPTS),
        boolRow('Hide Shorts', 'hideShorts'),
        boolRow('Like / dislike counts on cards', 'ratingCountsCards'),
        // Clock & date (folded in from the old Clock & date category).
        noteRow('Clock & date'),
        boolRow('Show clock', 'clockEnabled'),
        boolRow('On Home / browse screens', 'clockShowHome'),
        boolRow('In the video player', 'clockShowPlayer'),
        Object.assign(enumRow('Show', 'clockContent', [
          { v: 'time', label: 'Time only' },
          { v: 'date', label: 'Date only' },
          { v: 'datetime', label: 'Time and date' }
        ]), { rebuild: true }),
        ...(uiGet('clockContent') === 'datetime' ? [enumRow('Show first', 'clockOrder', [
          { v: 'time', label: 'Time' }, { v: 'date', label: 'Date' }
        ])] : []),
        enumRow('Time format', 'clockTimeFormat', [
          { v: '24', label: '24-hour' }, { v: '12', label: '12-hour' }
        ]),
        boolRow('Show seconds', 'clockSeconds'),
        enumRow('Date format', 'clockDateFormat', [
          { v: 'dow-dm', label: 'Wed 22 Jul' },
          { v: 'dow-md', label: 'Wed Jul 22' },
          { v: 'dm', label: '22 Jul' },
          { v: 'md', label: 'Jul 22' },
          { v: 'dmy-short', label: '22 Jul 2026' },
          { v: 'mdy-short', label: 'Jul 22, 2026' },
          { v: 'dmy-long', label: '22 July 2026' },
          { v: 'mdy-long', label: 'July 22, 2026' },
          { v: 'full', label: 'Wednesday, 22 July 2026' },
          { v: 'full-us', label: 'Wednesday, July 22, 2026' },
          { v: 'dmy', label: '22/07/2026' },
          { v: 'mdy', label: '07/22/2026' },
          { v: 'ymd', label: '2026/07/22' },
          { v: 'dmy-dot', label: '22.07.2026' },
          { v: 'iso', label: '2026-07-22' }
        ])
      ]
    },
    {
      id: 'general', icon: '⚙️', label: 'General',
      build: () => {
        const list = [];
        list.push(enumRow('Start on section', 'bootSection', [
          { v: 'home', label: 'Home' }, { v: 'subscriptions', label: 'Subscriptions' },
          { v: 'music', label: 'Music' }, { v: 'playlists', label: 'Playlists' },
          { v: 'watchlater', label: 'Watch Later' }, { v: 'history', label: 'History' }
        ]));
        list.push(boolRow('Instant feed from last session', 'feedSnapshots'));
        list.push(noteRow('On: shows last session’s videos instantly, then refreshes (brief change).'));
        list.push(noteRow('Off: always loads fresh on startup - no flash, slightly slower first paint.'));
        list.push(boolRow('Record watch history', 'recordHistory'));
        list.push(enumRow('Exit on Back', 'appExit', [
          { v: 'double', label: 'Press twice' }, { v: 'single', label: 'Press once' }
        ]));
        const dimRow = boolRow('Screen dimming', 'dimEnabled');
        dimRow.rebuild = true; // toggling shows / hides the amount + timeout below
        list.push(dimRow);
        if (uiGet('dimEnabled')) {
          list.push(enumRow('Dimming amount', 'dimAmount', [
            { v: 20, label: '20%' }, { v: 40, label: '40%' },
            { v: 60, label: '60%' }, { v: 80, label: '80%' }
          ]));
          list.push(enumRow('Dim after', 'dimTimeout', [
            { v: 1, label: '1 min' }, { v: 2, label: '2 min' }, { v: 5, label: '5 min' },
            { v: 10, label: '10 min' }, { v: 15, label: '15 min' }, { v: 30, label: '30 min' }
          ]));
        }
        const bgRow = boolRow('Background playback', 'bgPlay');
        bgRow.rebuild = true; // toggling shows / hides the options below
        list.push(bgRow);
        if (uiGet('bgPlay')) {
          list.push(enumRow('Playing a new video', 'bgSelectAction', [
            { v: 'replace', label: 'Play it now' }, { v: 'queue', label: 'Add to queue' }
          ]));
          list.push(enumRow('New video opens', 'bgSelectView', [
            { v: 'fullscreen', label: 'Fullscreen' }, { v: 'mini', label: 'In the rail window' }
          ]));
        }
        // Language & region (folded in from the old Language & Country category).
        list.push(noteRow('Language & region'));
        list.push(localeRow('Content language', 'contentLang', LANGS));
        list.push(localeRow('Content country', 'contentCountry', COUNTRIES));
        // (Preferred audio language lives in the Player category as `prefAudioLang`;
        // it drives both the A-collapse target and Shaka's native preferred track.)
        // Search (folded in from the old Search category).
        list.push(noteRow('Search'));
        list.push(boolRow('Autocomplete suggestions', 'searchAutocomplete'));
        list.push(boolRow('Remember search history', 'searchHistory'));
        list.push(actionRow('Clear search history', async () => {
          try { await window.tv.searchHistoryClear(); } catch (e) {}
          if (hooks.toast) hooks.toast('Search history cleared');
        }));
        // Cache (folded in from the old Cache category).
        list.push(noteRow('Cache'));
        list.push(noteRow('How long each section reuses loaded content before refetching.'));
        list.push(enumRow('Home', 'ttlHome', TTL_OPTS));
        list.push(enumRow('Subscriptions', 'ttlSubs', TTL_OPTS));
        list.push(enumRow('History', 'ttlHistory', TTL_OPTS));
        list.push(noteRow('History also refreshes right after you watch a video.'));
        list.push(enumRow('Music', 'ttlMusic', TTL_OPTS));
        list.push(enumRow('Playlists', 'ttlPlaylists', TTL_OPTS));
        // Network (folded in from the old standalone Network category): optional
        // proxy + custom DNS, applied main-side by network.js.
        list.push(noteRow('Network'));
        list.push(netBoolRow('Use a proxy', 'proxyEnabled', true));
        if (uiGet('proxyEnabled')) {
          list.push(netTextRow('Proxy server', 'proxyServer', 'http://192.168.1.2:8080  ·  socks5://192.168.1.2:1080'));
          list.push(netTextRow('Bypass list (optional)', 'proxyBypass', 'localhost, 192.168.0.0/16'));
        }
        list.push(netBoolRow('Custom DNS (DoH)', 'dohEnabled', true));
        if (uiGet('dohEnabled')) {
          list.push(netTextRow('DoH server URL', 'dohServer', 'https://dns.google/dns-query'));
        }
        list.push(noteRow('Proxy + DNS apply to everything (feeds, streams, metadata) as soon as they are set. A video already playing keeps its connection until you replay it.'));
        // System (global, account-independent): run-in-tray + launch-on-startup.
        list.push(noteRow('System'));
        list.push(sysBoolRow('Exit to system tray', 'exitToTray'));
        list.push(noteRow('On: closing hides the app to the tray and it keeps running. Off: closing quits.'));
        list.push(sysBoolRow('Launch on Windows startup', 'launchOnStartup', true));
        if (sysGet('launchOnStartup')) {
          list.push(sysBoolRow('Start minimized to tray', 'startMinimized'));
          list.push(noteRow('On a Windows-startup launch, open hidden in the tray instead of on screen. Manual launches always open normally.'));
        }
        // Enable / disable rail sections (a disabled section is hidden from the
        // rail). Search / Home / Settings / Sign in / Exit are always shown.
        list.push(noteRow('Sidebar sections'));
        for (const s of OPTIONAL_SECTIONS) list.push(sectionRow(s));
        return list;
      }
    },
    {
      id: 'controls', icon: '🎮', label: 'Controls',
      build: () => {
        const list = [];
        const T = window.TVInput;
        if (!T) { list.push(noteRow('Input system not ready.')); return list; }
        const acts = T.rebindable();
        list.push(noteRow('Controller - press OK on an action, then press a button to add it (press a bound one to remove; B cancels). Multiple buttons per action are allowed. Hold OK on a row to reset just that action. Only OK (A) stays fixed.'));
        for (const a of acts) list.push(bindRow(T.actionLabel(a), 'pad', a));
        list.push(noteRow('Keyboard - press OK on an action, then press a key to add it (press a bound one to remove; Esc cancels). Multiple keys per action are allowed. Hold OK on a row to reset just that action. Only Enter (OK) stays fixed.'));
        for (const a of acts) list.push(bindRow(T.actionLabel(a), 'key', a));
        list.push(actionRow('Reset controls to defaults', () => {
          if (window.TVInput) window.TVInput.resetDefaults();
          if (hooks.toast) hooks.toast('Controls reset to defaults');
          rebuildDialog();
        }));
        return list;
      }
    },
    {
      id: 'chatcomments', icon: '💬', label: 'Live chat & comments',
      build: () => [
        noteRow('Live chat'),
        noteRow('Read-only chat for live streams and past-stream replays. Toggle it in the player with the Live chat button (enable it under Player if it is hidden).'),
        enumRow('Chat mode', 'chatFilter', [
          { v: 'top', label: 'Top chat (filtered)' }, { v: 'live', label: 'Live chat (all)' }
        ]),
        enumRow('Chat panel side', 'chatSide', [
          { v: 'right', label: 'Right' }, { v: 'left', label: 'Left' }
        ]),
        enumRow('Chat panel width', 'chatWidth', [
          { v: 'narrow', label: 'Narrow' }, { v: 'med', label: 'Medium' }, { v: 'wide', label: 'Wide' }
        ]),
        enumRow('Chat text size', 'chatFontSize', [
          { v: 'sm', label: 'Small' }, { v: 'med', label: 'Medium' }, { v: 'lg', label: 'Large' }
        ]),
        boolRow('Show Super Chats', 'chatSuperchats'),
        boolRow('Hide membership notices', 'chatHideMembers'),
        boolRow('Open chat automatically', 'chatAutoOpen'),
        boolRow('Dim chat when idle', 'chatAutoHide'),
        noteRow('Comments'),
        noteRow('Read-only comments for regular videos, opened with the Comments button in the player. Left/right toggles Top/Newest; select a comment to open its replies.'),
        enumRow('Default sort', 'commentsSort', [
          { v: 'top', label: 'Top comments' }, { v: 'new', label: 'Newest first' }
        ]),
        enumRow('Comments panel side', 'commentsSide', [
          { v: 'right', label: 'Right' }, { v: 'left', label: 'Left' }
        ]),
        enumRow('Comments panel width', 'commentsWidth', [
          { v: 'narrow', label: 'Narrow' }, { v: 'med', label: 'Medium' }, { v: 'wide', label: 'Wide' }
        ]),
        enumRow('Comments text size', 'commentsFontSize', [
          { v: 'sm', label: 'Small' }, { v: 'med', label: 'Medium' }, { v: 'lg', label: 'Large' }
        ]),
        boolRow('Open comments automatically', 'commentsAutoOpen')
      ]
    },
    {
      id: 'commands', icon: '🖥️', label: 'Playback commands',
      build: () => {
        const list = [];
        // Shown below the keyboard while editing a command (the variables get
        // substituted + auto-quoted when the command runs).
        const CMD_VARS = 'Variables:\n{videoId} - video id\n{url} - video URL\n{title} - video title\n{channel} - channel name\n{channelId} - channel id\n{duration} - length (seconds)\n{account} - active profile\n{event} - trigger (start / end / stop)\n\nExamples:\ncurl http://192.168.1.50/scene/movie\n"C:\\Tools\\notify.bat" {title} {channel}';
        const CMD_VARS_PRE = CMD_VARS + '\n\nNote: before playback, {title} / {channel} / {duration} may still be blank - use "when playback starts" for those.';
        const pre = boolRow('Run a command before playback', 'preCmdEnabled');
        pre.rebuild = true;
        list.push(pre);
        if (uiGet('preCmdEnabled')) {
          list.push(textRow('Before command', 'preCmd', CMD_VARS_PRE));
          list.push(enumRow('Run before', 'preCmdTrigger', [
            { v: 'every', label: 'Every video' },
            { v: 'first', label: 'First video of the session' }
          ]));
        }
        const start = boolRow('Run a command when playback starts', 'startCmdEnabled');
        start.rebuild = true;
        list.push(start);
        if (uiGet('startCmdEnabled')) {
          list.push(textRow('On-start command', 'startCmd', CMD_VARS));
          list.push(enumRow('Run on start', 'startCmdTrigger', [
            { v: 'every', label: 'Every video' },
            { v: 'first', label: 'First video of the session' }
          ]));
        }
        const post = boolRow('Run a command after playback', 'postCmdEnabled');
        post.rebuild = true;
        list.push(post);
        if (uiGet('postCmdEnabled')) {
          list.push(textRow('After command', 'postCmd', CMD_VARS));
          list.push(enumRow('Run after', 'postCmdTrigger', [
            { v: 'end', label: 'Video ends' },
            { v: 'stop', label: 'Playback stopped' },
            { v: 'both', label: 'Both' }
          ]));
        }
        // Read-only hints, rendered as plain text (not focusable rows).
        // Commands run through the Windows shell: quote paths with spaces;
        // chain steps with &&.
        list.push(noteRow('Examples (run via the Windows shell):'));
        list.push(noteRow('curl http://192.168.1.50/scene/movie   - web request'));
        list.push(noteRow('"C:\\Tools\\my-helper.bat" on   - run a script'));
        list.push(noteRow('Variables (substituted, auto-quoted): {videoId} {url}'));
        list.push(noteRow('{title} {channel} {channelId} {duration} {account} {event}'));
        list.push(noteRow('e.g.  "C:\\Tools\\notify.bat" {title} {channel}'));
        list.push(noteRow('Before-playback runs early: {title}/{channel}/{duration} may be blank -'));
        list.push(noteRow('use "when playback starts" for those (metadata is loaded by then).'));
        return list;
      }
    },
    {
      id: 'player', icon: '▶️', label: 'Player',
      build: () => {
        const list = [];
        list.push(enumRow('Hide controls after', 'hudTimeout', [
          { v: 2, label: '2s' }, { v: 3, label: '3s' }, { v: 5, label: '5s' },
          { v: 8, label: '8s' }, { v: 0, label: 'Never' }
        ]));
        list.push(boolRow('Show button names', 'playerButtonTips'));
        list.push(boolRow('Remember playback speed', 'rememberSpeed'));
        list.push(enumRow('Default aspect ratio', 'defaultAspect', [
          { v: 'fit', label: 'Fit' }, { v: 'fill', label: 'Fill' },
          { v: 'stretch', label: 'Stretch' }, { v: 'zoom', label: 'Zoom' }
        ]));
        list.push(enumRow('Time display', 'timeDisplay', [
          { v: 'elapsed', label: 'Total' }, { v: 'remaining', label: 'Remaining' }
        ]));
        list.push(enumRow('Playback mode', 'playbackMode', [
          { v: 'next', label: 'Play next video' },
          { v: 'one', label: 'Repeat this video' },
          { v: 'pause', label: 'Pause when finished' },
          { v: 'stop', label: 'Stop when finished' }
        ]));
        list.push(boolRow('Seek-preview thumbnails', 'seekPreview'));
        list.push(boolRow('Show like / dislike counts', 'ratingCountsPlayer'));
        list.push(enumRow('Max resolution', 'maxRes', [
          { v: 0, label: 'Auto' }, { v: 2160, label: '2160p' }, { v: 1440, label: '1440p' },
          { v: 1080, label: '1080p' }, { v: 720, label: '720p' }, { v: 480, label: '480p' },
          { v: 360, label: '360p' }
        ]));
        list.push(enumRow('Max frame rate', 'maxFps', [
          { v: 0, label: 'Auto' }, { v: 30, label: '30 fps' }, { v: 60, label: '60 fps' }
        ]));
        list.push(enumRow('Preferred audio language', 'prefAudioLang', [
          { v: '', label: 'Auto' }, { v: 'en', label: 'English' }, { v: 'es', label: 'Spanish' },
          { v: 'pt', label: 'Portuguese' }, { v: 'fr', label: 'French' }, { v: 'de', label: 'German' },
          { v: 'hi', label: 'Hindi' }, { v: 'ja', label: 'Japanese' }, { v: 'ko', label: 'Korean' },
          { v: 'ru', label: 'Russian' }, { v: 'ar', label: 'Arabic' }
        ]));
        const seekModeRow = enumRow('Seek mode', 'seekMode', [
          { v: 'instant', label: 'Instant (jump)' },
          { v: 'delayed', label: 'Delayed (target + commit)' },
          { v: 'accelerated', label: 'Accelerated (ramping)' }
        ]);
        seekModeRow.rebuild = true; // changing it shows/hides the two rows below
        list.push(seekModeRow);
        const sm = uiGet('seekMode') || 'instant';
        // Accelerated seek steps: only meaningful in Accelerated mode.
        if (sm === 'accelerated') list.push(multiRow('Accelerated seek steps', 'seekSteps', SEEK_STEPS));
        // Skip delay (commit): used by BOTH Delayed and Accelerated (hidden for Instant).
        if (sm === 'delayed' || sm === 'accelerated') list.push(numRow('Skip delay (commit)', 'seekSkipDelay', { def: 750, min: 100, max: 5000, unit: 'ms' }));
        list.push(boolRow('Bumpers follow acceleration', 'bumperAccel'));
        // Subtitles (folded in from the old Subtitles category).
        list.push(noteRow('Subtitles'));
        list.push(enumRow('Subtitle size', 'subScale', pct([75, 100, 125, 150, 175, 200])));
        list.push(boolRow('Subtitle background', 'subBackground'));
        // Reorder the transport buttons (grab with OK, move Up/Down).
        list.push(noteRow('Player buttons'));
        list.push(orderRow('Reorder buttons', 'playerButtonOrder'));
        // Setup player buttons: In row / In cog / Hidden for each.
        for (const b of PLAYER_BUTTONS) list.push(btnRow(b.act, b.label));
        // The cog itself: Shown / Hidden (Hidden only applies when it's empty).
        list.push(cogVisRow());
        list.push(noteRow('The cog can be hidden only when no buttons are In cog.'));
        return list;
      }
    },
    {
      id: 'sponsorblock', icon: '🛡️', label: 'SponsorBlock',
      build: () => {
        const list = [];
        list.push(sbBoolRow('Enable SponsorBlock', 'enabled'));
        list.push(sbEnumRow('When a segment is reached', 'action', [
          { v: 'skip', label: 'Skip silently' }, { v: 'notify', label: 'Skip + notify' },
          { v: 'ask', label: 'Ask (press OK to skip)' }
        ]));
        list.push(sbEnumRow('Ask prompt duration', 'askDuration', [
          { v: 3, label: '3s' }, { v: 5, label: '5s' }, { v: 8, label: '8s' },
          { v: 0, label: 'Until it ends' }
        ]));
        list.push(sbBoolRow('Colour markers on seek bar', 'colorMarkers'));
        list.push(sbEnumRow('Ignore short segments', 'minDuration', [
          { v: 0, label: 'Off' }, { v: 1, label: '< 1s' }, { v: 2, label: '< 2s' },
          { v: 5, label: '< 5s' }, { v: 10, label: '< 10s' }
        ]));
        for (const c of SB_CATS) list.push(sbCatRow(c));
        return list;
      }
    },
    {
      id: 'dearrow', icon: '🏹', label: 'DeArrow',
      build: () => [
        daBoolRow('Enable DeArrow', 'enabled'),
        daBoolRow('Replace titles', 'titles'),
        daBoolRow('Replace thumbnails', 'thumbnails'),
        daBoolRow('Debug logging (to cathode.log)', 'debug')
      ]
    },
    {
      id: 'backup', icon: '💾', label: 'Backup & Restore',
      build: () => {
        const list = [];
        list.push(actionRow('Back up now', doBackupNow));
        // In-app list of existing backups (auto + manual); picker:true forces
        // the popup even with 0-2 entries.
        const opts = backupCache.length
          ? backupCache.map((b) => ({ v: b.path, label: backupLabel(b) }))
          : [{ v: '', label: 'No backups yet' }];
        list.push({
          kind: 'enum', label: 'Restore a backup', options: opts, picker: true, tip: TIPS['act:Restore a backup'],
          get: () => '',
          setValue: (v) => { if (v) doRestore(v); }
        });
        list.push(actionRow('Restore from a file…', doBackupBrowse));
        list.push({
          kind: 'enum', label: 'Automatic backups', picker: true, tip: TIPS['act:Automatic backups'],
          options: [
            { v: 'off', label: 'Off' }, { v: 'daily', label: 'Daily' },
            { v: 'weekly', label: 'Weekly' }, { v: 'monthly', label: 'Monthly' }
          ],
          get: () => backupCadence,
          setValue: (v) => { backupCadence = v; if (window.tv.backupSetCadence) window.tv.backupSetCadence(v); }
        });
        list.push(noteRow('Automatic backups keep the last 5; manual backups stay until you delete them.'));
        list.push(noteRow('Restore replaces all data and restarts Cathode. A backup only restores on this same Windows user.'));
        return list;
      }
    },
    {
      // Downloads. Phase 1: yt-dlp + ffmpeg binary management (install / update /
      // version). The download-OPTION rows (quality, folder, etc.) are added in a
      // later phase and unlock only when both binaries are present (dlState.ready).
      id: 'downloads', icon: '📥', label: 'Downloads',
      build: () => {
        const list = [];
        const st = dlState;
        const ready = !!(st && st.ready);
        // Each binary row IS the install/reinstall control: press to download when
        // missing, press to reinstall when present. (Replaces the old info rows +
        // the combined Install and Reinstall buttons.)
        list.push(dlBinRow('yt-dlp', st && st.ytdlp.present, st && st.ytdlp.version, () => doInstallBinary('ytdlp'), !st, dlInstalls.ytdlp || null));
        list.push(dlBinRow('ffmpeg', st && st.ffmpeg.present && st.ffprobe.present, st && st.ffmpeg.version, () => doInstallBinary('ffmpeg'), !st, dlInstalls.ffmpeg || null));
        list.push(dlBinRow(DENO_ROW_LABEL, st && st.deno && st.deno.present, st && st.deno && st.deno.version, () => doInstallBinary('deno'), !st, dlInstalls.deno || null));
        if (st && !(st.deno && st.deno.present)) list.push(noteRow('Deno is optional but strongly recommended: it makes YouTube downloads much faster and avoids "some formats missing" errors.'));
        if (ready) {
          list.push(actionRow('Check for yt-dlp updates', doCheckDlUpdates));
          // The Update row appears ONLY after a check found a newer version.
          if (dlUpdateInfo && dlUpdateInfo.latest && !dlUpdateInfo.upToDate) {
            list.push(actionRow('Update yt-dlp to ' + dlUpdateInfo.latest, doUpdateYtdlp));
          }
        }
        list.push({
          kind: 'bool', label: 'Auto-update yt-dlp on launch', tip: TIPS['dl:autoUpdateYtdlp'],
          get: () => !!(dlSettings && dlSettings.autoUpdateYtdlp),
          toggle: () => {
            const v = !(dlSettings && dlSettings.autoUpdateYtdlp);
            if (dlSettings) dlSettings.autoUpdateYtdlp = v;
            if (window.tv.dlSetSettings) window.tv.dlSetSettings({ autoUpdateYtdlp: v }).catch(() => {});
          }
        });
        if (!ready) list.push(noteRow('Download options unlock once both yt-dlp and ffmpeg are installed. ffmpeg is required to merge video and audio.'));
        list.push(noteRow('Binaries are downloaded from the official yt-dlp and ffmpeg release pages into Cathode’s data folder.'));
        // Download options -- global; unlocked only when both binaries are present.
        if (ready) {
          list.push(noteRow('Quick download settings'));
          list.push(noteRow('Defaults used when you press Download without opening the advanced menu. Type sets whether a quick download grabs video or audio.'));
          list.push(dlFolderRow(st.saveDir || ''));
          list.push(noteRow('Press OK to change the download folder. Hold OK to reset it to the default.'));
          // Type replaces the old "Audio only" boolean; both video and audio
          // options are always listed (Type just picks which a quick download uses).
          // picker:false -> OK toggles Video <-> Audio inline (only two values).
          list.push(dlEnumRow('Type', 'type', [{ v: 'video', label: 'Video' }, { v: 'audio', label: 'Audio' }], false));
          list.push(noteRow('Video'));
          list.push(dlEnumRow('Maximum quality', 'qualityCap', DL_QUALITY));
          list.push(dlEnumRow('Container', 'container', DL_VIDEO_CONTAINER));
          list.push(noteRow('Audio'));
          list.push(dlEnumRow('Audio format', 'audioContainer', DL_AUDIO_CONTAINER));
          list.push(dlEnumRow('Audio bitrate', 'audioBitrate', DL_AUDIO_BITRATE));
          list.push(noteRow('Output'));
          list.push(dlTextRow('Filename template', 'filenameTemplate',
            'Variables:\n%(title)s - video title\n%(id)s - video id\n%(ext)s - file extension\n%(uploader)s - channel name\n%(upload_date)s - date (YYYYMMDD)\n%(resolution)s - e.g. 1080p\n%(playlist_title)s - playlist name\n\nExamples:\n%(title)s.%(ext)s\n%(uploader)s/%(title)s.%(ext)s'));
          list.push(dlBoolRow('Restrict filenames to ASCII', 'restrictFilenames'));
          list.push(dlBoolRow('Embed thumbnail', 'embedThumbnail'));
          list.push(dlBoolRow('Embed metadata', 'embedMetadata'));
          list.push(dlBoolRow('Embed chapters', 'embedChapters'));
          list.push(dlBoolRow('Download subtitles', 'subtitles', true));
          if (dlGet('subtitles')) list.push(dlTextRow('Subtitle languages', 'subLangs', 'en,es  ·  all'));
          list.push(dlEnumRow('SponsorBlock', 'sponsorblock', DL_SPONSORBLOCK));
          list.push(dlBoolRow('Skip videos already downloaded', 'skipDownloaded'));
          list.push(dlBoolRow('Never overwrite existing files', 'noOverwrite'));
          list.push(dlEnumRow('Parallel fragments (speed)', 'concurrentFragments', DL_FRAGMENTS));
          // Notifications (folded in from the old standalone category: they only
          // concern downloads).
          list.push(noteRow('Notifications'));
          list.push(dlBoolRow('In-app notifications', 'notifyInApp'));
          list.push(dlBoolRow('Windows notifications', 'notifyOs'));
          list.push(noteRow('Shown when a download finishes or fails. Windows notifications appear even when Cathode is running in the background.'));
        }
        return list;
      }
    },
    {
      id: 'remote', icon: '📱', label: 'Remote',
      build: () => {
        const list = [];
        list.push(noteRow('Control Cathode from the phone companion app over your local network.'));
        // Rows are always shown (not gated on the toggle): the toggle only
        // starts/stops the server, and "Pair a new device" starts it on demand
        // anyway. Keeping them static avoids a rebuild-on-toggle and the empty-card
        // glitch (options only appearing after exit + reopen).
        list.push(sysBoolRow('Companion remote', 'companionEnabled'));
        list.push(sysTextRow('Device name', 'companionName', 'Cathode, Living Room PC'));
        list.push(noteRow('Name shown to phones during discovery / pairing. Blank uses the default name (Cathode).'));
        list.push(sysNumRow('Port', 'companionPort', { min: 1024, max: 65535, def: 8878 }));
        list.push(noteRow('Changing the name or port restarts the server; re-pair devices if they cannot reconnect.'));
        list.push(actionRow('Pair a new device', openPair));
        const devs = (companionData && companionData.devices) || [];
        if (!devs.length) {
          list.push(noteRow('No devices paired yet. Choose "Pair a new device" to add your phone.'));
        } else {
          list.push(noteRow('Paired devices (select one to remove):'));
          for (const d of devs) {
            list.push(actionRow(d.name + (d.connected ? '  ·  connected' : ''), () => confirmUnpair(d)));
          }
          if (devs.length > 1) list.push(actionRow('Remove all devices', confirmUnpairAll));
        }
        return list;
      }
    },
    { id: 'accounts', icon: '🔑', label: 'Accounts', launch: true },
    {
      // About stays LAST in the settings grid.
      id: 'about', icon: 'ℹ️', label: 'About',
      build: () => {
        const a = aboutInfo || {};
        const list = [
          infoRow('Cathode version', a.version || '-'),
          infoRow('Electron', a.electron || '-'),
          infoRow('Chromium', a.chrome || '-'),
          infoRow('Node', a.node || '-'),
          actionRow('Check for updates', checkForUpdates)
        ];
        // Update rows appear only after a check finds a newer version.
        if (updateStaged) {
          list.push(infoRow('Update waiting for restart', 'v' + updateStaged.version));
          list.push(actionRow('Restart now', doApplyUpdate));
          list.push(noteRow('Or just keep watching - the update installs by itself the next time you close Cathode.'));
        } else if (updateBusy) {
          list.push(infoRow(UPDATE_PROGRESS_LABEL, updateProgressText || 'Starting...'));
        } else if (updateInfo && updateInfo.newer) {
          if (updateCanSelf) list.push(actionRow('Download update (v' + updateInfo.latest + ')', doDownloadUpdate));
          else list.push(actionRow('Get the update (v' + updateInfo.latest + ')', doOpenReleasePage));
        }
        list.push(boolRow('Notify me about updates', 'autoUpdateNotify'));
        list.push(noteRow('Debugging'));
        return list.concat([
          debugRow(),
          actionRow('Export debug info', doExportDebug),
          noteRow('Turn on Debug logging, reproduce the problem, then Export debug info and send us the zip. It contains logs and system info with tokens and emails removed.')
        ]);
      }
    }
  ];

  // ---- row constructors ----
  function pct(arr) { return arr.map((n) => ({ v: n, label: n + '%' })); }

  // Per-option help text shown in the right-hand tooltip panel of a settings
  // dialog when a row is focused. Keyed by the row's setting key; SponsorBlock,
  // DeArrow and Download keys are namespaced (sb: / da: / dl:) to avoid clashes,
  // and one-off action / info rows use act: / bin: prefixes. Rows with no entry
  // simply show no description. Keep each tip to a sentence or two, plain text.
  const TIPS = {
    // Interface
    view: 'Show Home as one flat grid of videos, or grouped into horizontal category shelves.',
    cardTitleLines: 'How many lines of a video title to show on its card before it is cut off.',
    roundedCards: 'Rounded or square corners on video and channel cards.',
    uiScale: 'Overall size of everything on screen. Higher zooms in but fits fewer items per screen.',
    gridCols: 'How many videos sit side by side in a row. Fewer columns means larger thumbnails.',
    channelSort: 'Order of your Subscriptions list: YouTube default, or alphabetical A to Z.',
    playlistLayout: 'Show your playlists as a grid of covers or as a vertical list.',
    railMini: 'Shrink the side rail to icons only; it expands to show labels when focused.',
    cardAutoscroll: 'Scroll a long card title sideways when it is focused instead of wrapping it.',
    theme: 'Base colour scheme for the whole app.',
    accent: 'Highlight colour used for focus outlines and selected items.',
    clockEnabled: 'Master switch for the on-screen clock.',
    clockShowHome: 'Show the clock on Home and other browse screens.',
    clockShowPlayer: 'Show the clock while a video is playing.',
    clockContent: 'Whether the clock shows the time, the date, or both.',
    clockOrder: 'When showing both time and date, which one comes first.',
    clockTimeFormat: '24-hour time, or 12-hour with AM and PM.',
    clockSeconds: 'Include seconds in the displayed time.',
    clockDateFormat: 'How the date is written out.',
    // General
    bootSection: 'Which section Cathode opens on when it starts.',
    feedSnapshots: 'Paint last session feed instantly at startup, then refresh in the background. Off always loads fresh (no flash, slightly slower first paint).',
    recordHistory: 'Report the videos you watch to your YouTube watch history.',
    appExit: 'Whether Back on the main rail exits after one press, or needs two.',
    dimEnabled: 'Fade a dark overlay in after a period with no input, to protect the screen.',
    dimAmount: 'How dark the dimming overlay becomes.',
    dimTimeout: 'How long to wait with no input before the screen dims.',
    bgPlay: 'Keep audio playing when you leave a video, with playback controls in the side rail.',
    bgSelectAction: 'When you open a new video during background playback: play it now, or add it to the queue.',
    bgSelectView: 'Whether a newly opened video fills the screen or plays in the small rail window.',
    contentLang: 'Language YouTube uses for titles and search results.',
    contentCountry: 'Country and region YouTube tailors content and trends to.',
    searchAutocomplete: 'Show live search suggestions as you type.',
    searchHistory: 'Remember and offer your recent searches.',
    ttlHome: 'How long the Home feed is reused before it refetches.',
    ttlSubs: 'How long the Subscriptions feed is reused before it refetches.',
    ttlHistory: 'How long History is reused before it refetches (it also refreshes right after you watch a video).',
    ttlMusic: 'How long the Music feed is reused before it refetches.',
    ttlPlaylists: 'How long Playlists is reused before it refetches.',
    // Live chat & comments
    chatFilter: 'Top chat is YouTube filtered stream; Live shows every message (the full firehose).',
    chatSide: 'Which side of the screen the chat panel docks to.',
    chatWidth: 'Width of the chat panel.',
    chatFontSize: 'Text size in the chat panel.',
    chatSuperchats: 'Show paid Super Chats and Super Stickers in chat.',
    chatHideMembers: 'Hide new-member and membership-milestone notices.',
    chatAutoOpen: 'Open the chat panel automatically on live streams and replays.',
    chatAutoHide: 'Dim the chat panel when you have not touched the controls for a while.',
    commentsSort: 'Default order when comments open: top comments, or newest first.',
    commentsSide: 'Which side of the screen the comments panel docks to.',
    commentsWidth: 'Width of the comments panel.',
    commentsFontSize: 'Text size in the comments panel.',
    commentsAutoOpen: 'Open the comments panel automatically on regular videos.',
    // Playback commands
    preCmdEnabled: 'Run a shell command just before a video starts playing.',
    preCmd: 'The command line to run before playback. Title, channel and duration may still be blank this early.',
    preCmdTrigger: 'Run before every video, or only the first video of the session.',
    startCmdEnabled: 'Run a shell command the moment playback actually begins.',
    startCmd: 'The command to run when playback starts. Title, channel and duration are available by now.',
    startCmdTrigger: 'Run on every video, or only the first of the session.',
    postCmdEnabled: 'Run a shell command after a video finishes or is stopped.',
    postCmd: 'The command to run after playback ends.',
    postCmdTrigger: 'Run when a video ends, when playback is stopped, or both.',
    // Player
    hudTimeout: 'How long the on-screen controls stay visible before they hide.',
    playerButtonTips: 'Show a button name label when a transport button is focused.',
    rememberSpeed: 'Keep the last playback speed you set for the next video.',
    defaultAspect: 'How video fills the screen by default: fit, fill, stretch, or zoom.',
    timeDisplay: 'Show the total video length, or the time remaining.',
    playbackMode: 'What happens when a video ends: play the next one, repeat it, pause, or stop.',
    seekPreview: 'Show a thumbnail preview above the seek bar while scrubbing.',
    maxRes: 'Cap the streaming resolution. Auto picks the best your connection allows.',
    maxFps: 'Cap the frame rate. Auto allows 60 fps where a video offers it.',
    prefAudioLang: 'On videos with dubs, prefer this audio language, falling back to the original.',
    seekMode: 'How seeking behaves: an instant jump, a delayed commit, or accelerating the longer you hold.',
    seekSteps: 'Which speeds the accelerated seek ramps through as you keep holding.',
    seekSkipDelay: 'How long after your last press before a delayed or accelerated seek commits.',
    bumperAccel: 'Let the skip-forward and skip-back bumpers speed up along with accelerated seeking.',
    subScale: 'Size of subtitle text.',
    subBackground: 'Draw a dark box behind subtitles to make them easier to read.',
    playerButtonOrder: 'Rearrange the order of the transport buttons in the player.',
    // SponsorBlock
    'sb:enabled': 'Automatically skip sponsor and other segments using SponsorBlock community data.',
    'sb:action': 'What to do at a segment: skip silently, skip with a notification, or ask you first.',
    'sb:askDuration': 'How long the press-OK-to-skip prompt stays on screen.',
    'sb:colorMarkers': 'Show coloured marks on the seek bar wherever a segment is.',
    'sb:minDuration': 'Ignore segments shorter than this, to avoid tiny distracting jumps.',
    'sb:cat': 'Skip this category of segment automatically.',
    // DeArrow
    'da:enabled': 'Replace clickbait titles and thumbnails with community-chosen ones (DeArrow).',
    'da:titles': 'Use DeArrow crowd-sourced titles.',
    'da:thumbnails': 'Use DeArrow crowd-sourced thumbnails.',
    'da:debug': 'Write DeArrow diagnostics to cathode.log.',
    // Downloads
    'bin:ytdlp': 'The downloader engine. Press to install it, or to reinstall the latest.',
    'bin:ffmpeg': 'Merges video and audio and converts formats. Required for downloads to work.',
    'bin:deno': 'Optional JavaScript runtime that makes downloads much faster and avoids missing-format errors.',
    'dl:autoUpdateYtdlp': 'Check for and install a newer yt-dlp automatically each time Cathode launches.',
    'dl:type': 'Whether a quick, one-press download grabs the full video or just the audio.',
    'dl:qualityCap': 'Highest video resolution a download will use.',
    'dl:container': 'File format for downloaded video.',
    'dl:audioContainer': 'File format for downloaded audio.',
    'dl:audioBitrate': 'Audio quality for audio downloads. Best keeps the source quality.',
    'dl:filenameTemplate': 'yt-dlp naming pattern for saved files, e.g. %(title)s.%(ext)s.',
    'dl:restrictFilenames': 'Strip spaces and non-ASCII characters from saved file names.',
    'dl:embedThumbnail': 'Embed the video thumbnail as cover art in the file.',
    'dl:embedMetadata': 'Write title, artist and other tags into the file.',
    'dl:embedChapters': 'Write chapter markers into the file.',
    'dl:subtitles': 'Download subtitle tracks alongside the video.',
    'dl:subLangs': 'Which subtitle languages to fetch, e.g. en,es (or all).',
    'dl:sponsorblock': 'Mark sponsor segments as chapters in the file, or cut them out entirely.',
    'dl:skipDownloaded': 'Skip a video if its file is already in the download folder.',
    'dl:noOverwrite': 'Never replace a file that already exists.',
    'dl:concurrentFragments': 'How many pieces to download at once. Higher is faster on fast connections.',
    'dl:notifyInApp': 'Show an in-app toast when a download finishes or fails.',
    'dl:notifyOs': 'Show a Windows notification when a download finishes or fails, even in the background.',
    // Backup & restore
    'act:Back up now': 'Save a backup of all your Cathode data right now.',
    'act:Restore a backup': 'Pick a saved backup to restore. This replaces all current data and restarts the app.',
    'act:Restore from a file…': 'Restore from a backup file you choose from disk.',
    'act:Automatic backups': 'How often Cathode backs itself up. The last 5 automatic backups are kept.',
    // one-off actions
    'act:Clear search history': 'Delete all your remembered searches.',
    'act:Reset controls to defaults': 'Undo every controller and keyboard rebinding.',
    'act:Check for updates': 'Check whether a newer version of Cathode is available.',
    'act:Debug logging': 'Record extra detail (renderer errors, network failures, raw feed dumps) to the log so we can diagnose a problem. Leave off for normal use.',
    'act:Export debug info': 'Bundle the logs and system info into a zip you can send us. Tokens and email addresses are removed first.',
    'act:Check for yt-dlp updates': 'Check whether a newer yt-dlp is available.',
    // rows shared by many entries
    section: 'Show or hide this section in the side rail.',
    btnPlacement: 'Where this button lives: in the control row, tucked into the cog (More) menu, or hidden.',
    cogVis: 'Show or hide the cog (More) menu. Hiding only applies when no buttons are inside it.',
    bindPad: 'Controller binding for this action. Press OK, then a button to add or remove it.',
    bindKey: 'Keyboard binding for this action. Press OK, then a key to add or remove it.',
    autoUpdateNotify: 'Tell me when a newer version of Cathode is available.',
    // Rating counts + Shorts
    ratingCountsPlayer: 'Show like and dislike counts under the title in the player. Dislikes come from the Return YouTube Dislike service.',
    ratingCountsCards: 'Show like and dislike counts on every video card. Needs one Return YouTube Dislike lookup per card, so feeds load a little slower.',
    hideShorts: 'Hide Shorts (vertical short videos) and the Shorts shelf from all feeds.',
    // Network
    proxyEnabled: 'Route Cathode traffic through a proxy server.',
    proxyServer: 'Proxy address, e.g. http://host:port or socks5://host:port.',
    proxyBypass: 'Hosts that should skip the proxy (comma or space separated). Optional.',
    dohEnabled: 'Resolve names through a custom DNS-over-HTTPS server instead of the system resolver.',
    dohServer: 'DoH endpoint URL, e.g. https://dns.google/dns-query.'
  };

  // Bool row backed by GLOBAL system prefs (window.tv.get/setSystemPrefs) rather
  // than the per-account ui_settings store.
  function sysBoolRow(label, key, rebuild) {
    return {
      kind: 'bool', label, tip: TIPS[key], rebuild: !!rebuild,
      get: () => !!sysGet(key),
      toggle: () => sysSet({ [key]: !sysGet(key) })
    };
  }
  // Numeric row backed by GLOBAL system prefs (e.g. the companion port).
  function sysNumRow(label, key, cfg) {
    return {
      kind: 'num', label, cfg, tip: TIPS[key],
      get: () => { const v = sysGet(key); return (v == null ? cfg.def : v); },
      setValue: (v) => { sysSet({ [key]: v }); }
    };
  }
  // Free-text row backed by GLOBAL system prefs (e.g. the companion device name).
  function sysTextRow(label, key, examples) {
    return {
      kind: 'text', label, key, tip: TIPS[key], examples,
      get: () => sysGet(key) || '',
      setValue: (v) => { sysSet({ [key]: String(v || '').slice(0, 40) }); }
    };
  }
  function boolRow(label, key) {
    return {
      kind: 'bool', label, key, tip: TIPS[key],
      get: () => uiGet(key) !== false,
      toggle: () => { uiSet({ [key]: !(uiGet(key) !== false) }); applyAll(); }
    };
  }
  function enumRow(label, key, options) {
    return {
      kind: 'enum', label, options, key, tip: TIPS[key],
      get: () => uiGet(key),
      step: (dir) => { uiSet({ [key]: cycle(options, uiGet(key), dir) }); applyAll(); },
      setValue: (v) => { uiSet({ [key]: v }); applyAll(); }
    };
  }
  // ---- Downloads: rows backed by the GLOBAL download settings (dlSettings,
  // persisted via window.tv.dlSetSettings), NOT ui_settings. ----
  function dlGet(key) { return dlSettings ? dlSettings[key] : undefined; }
  function dlSet(patch) {
    if (dlSettings) Object.assign(dlSettings, patch);
    if (window.tv.dlSetSettings) window.tv.dlSetSettings(patch).catch(() => {});
  }
  function dlBoolRow(label, key, rebuild) {
    return { kind: 'bool', label, rebuild: !!rebuild, tip: TIPS['dl:' + key], get: () => !!dlGet(key), toggle: () => dlSet({ [key]: !dlGet(key) }) };
  }
  // picker defaults true (opens the value-list dialog). Pass picker=false for a
  // short 2-3 value row that should just toggle/step inline on OK (like Type).
  function dlEnumRow(label, key, options, picker) {
    return {
      kind: 'enum', label, options, picker: picker !== false, tip: TIPS['dl:' + key],
      get: () => dlGet(key),
      step: (dir) => dlSet({ [key]: cycle(options, dlGet(key), dir) }),
      setValue: (v) => dlSet({ [key]: v })
    };
  }
  function dlTextRow(label, key, examples) {
    return { kind: 'text', label, tip: TIPS['dl:' + key], examples, get: () => dlGet(key) || '', setValue: (v) => dlSet({ [key]: v }) };
  }
  // Binary row (yt-dlp / ffmpeg): pressable. Shows install state and doubles as
  // the install / reinstall control. checking = state not fetched yet (inert).
  function dlBinRow(label, installed, version, run, checking, installingText) {
    const value = installingText ? installingText
      : checking ? 'Checking…'
      : installed ? ((version || 'Installed') + ' - press to reinstall')
      : 'Not installed - press to download';
    const binKey = /yt-?dlp/i.test(label) ? 'bin:ytdlp' : /ffmpeg/i.test(label) ? 'bin:ffmpeg' : /deno/i.test(label) ? 'bin:deno' : null;
    return { kind: 'dlbin', label, value, run, checking: !!checking, installing: !!installingText, tip: binKey ? TIPS[binKey] : undefined };
  }
  // Download-folder row: OK changes the folder, HOLD OK resets it to default.
  function dlFolderRow(value) {
    return { kind: 'dlfolder', label: 'Download folder', value: String(value || ''), tip: 'Where downloaded files are saved. Press OK to change it, hold OK to reset to the default.', run: doChooseDownloadDir, reset: doResetDownloadDir };
  }
  const DL_QUALITY = [
    { v: 0, label: 'Best available' }, { v: 2160, label: '2160p (4K)' },
    { v: 1440, label: '1440p' }, { v: 1080, label: '1080p' },
    { v: 720, label: '720p' }, { v: 480, label: '480p' }, { v: 360, label: '360p' }
  ];
  // Full yt-dlp container sets, split by mode. Video = --merge-output-format
  // targets; audio = --audio-format targets (used when Audio only is on).
  const DL_VIDEO_CONTAINER = [
    { v: 'mp4', label: 'MP4 (most compatible)' },
    { v: 'mkv', label: 'MKV (any codec)' },
    { v: 'webm', label: 'WebM' },
    { v: 'mov', label: 'MOV' },
    { v: 'avi', label: 'AVI' },
    { v: 'flv', label: 'FLV' }
  ];
  const DL_AUDIO_CONTAINER = [
    { v: 'mp3', label: 'MP3 (most compatible)' },
    { v: 'm4a', label: 'M4A (AAC)' },
    { v: 'opus', label: 'Opus' },
    { v: 'aac', label: 'AAC' },
    { v: 'flac', label: 'FLAC (lossless)' },
    { v: 'wav', label: 'WAV (lossless)' },
    { v: 'vorbis', label: 'Vorbis (Ogg)' }
  ];
  const DL_AUDIO_BITRATE = [
    { v: '', label: 'Best (source)' }, { v: '320K', label: '320 kbps' }, { v: '256K', label: '256 kbps' },
    { v: '192K', label: '192 kbps' }, { v: '128K', label: '128 kbps' }, { v: '96K', label: '96 kbps' }, { v: '64K', label: '64 kbps' }
  ];
  const DL_SPONSORBLOCK = [{ v: 'off', label: 'Off' }, { v: 'mark', label: 'Mark as chapters' }, { v: 'remove', label: 'Remove from file' }];
  const DL_FRAGMENTS = [1, 2, 3, 4, 6, 8].map((n) => ({ v: n, label: String(n) }));

  // Home layout (categories vs grid). Persists to ui_settings.view AND asks
  // app.js to re-render Home live via the onViewChange hook (applyAll alone
  // does not re-render the feed). Was formerly a hidden Y-button toggle.
  function viewRow() {
    const opts = [{ v: 'shelves', label: 'Categories' }, { v: 'grid', label: 'Grid' }];
    const apply = (v) => { uiSet({ view: v }); if (hooks.onViewChange) hooks.onViewChange(v); };
    return {
      kind: 'enum', label: 'Home layout', options: opts, key: 'view', tip: TIPS.view,
      get: () => uiGet('view') || 'grid',
      step: (dir) => apply(cycle(opts, uiGet('view') || 'grid', dir)),
      setValue: (v) => apply(v)
    };
  }
  function sectionRow(s) {
    return {
      kind: 'bool', label: 'Show ' + s.label, tip: TIPS.section,
      get: () => !(uiGet('disabledSections') || []).includes(s.key),
      toggle: () => {
        const cur = (uiGet('disabledSections') || []).slice();
        const at = cur.indexOf(s.key);
        if (at >= 0) cur.splice(at, 1); else cur.push(s.key);
        uiSet({ disabledSections: cur }); applyAll();
      }
    };
  }
  // Player > setup player buttons: each button can live In the row, In the cog
  // (overflow) menu, or be Hidden. Placement is derived from two mutually-
  // exclusive lists in ui_settings - hiddenPlayerButtons and cogButtons.
  // (play/pause is not listed - it is always in the row.)
  const PLACE_OPTS = [
    { v: 'row', label: 'In row' },
    { v: 'cog', label: 'In cog' },
    { v: 'hidden', label: 'Hidden' }
  ];
  function placementOf(act) {
    if ((uiGet('hiddenPlayerButtons') || []).includes(act)) return 'hidden';
    if ((uiGet('cogButtons') || []).includes(act)) return 'cog';
    return 'row';
  }
  function setPlacement(act, v) {
    const hidden = (uiGet('hiddenPlayerButtons') || []).slice();
    const cog = (uiGet('cogButtons') || []).slice();
    const h = hidden.indexOf(act); if (h >= 0) hidden.splice(h, 1);
    const c = cog.indexOf(act); if (c >= 0) cog.splice(c, 1);
    if (v === 'hidden') hidden.push(act);
    else if (v === 'cog') cog.push(act);
    uiSet({ hiddenPlayerButtons: hidden, cogButtons: cog }); // player reads live
  }
  function btnRow(act, label) {
    return {
      kind: 'enum', label: label, options: PLACE_OPTS, tip: TIPS.btnPlacement,
      get: () => placementOf(act),
      step: (dir) => { setPlacement(act, cycle(PLACE_OPTS, placementOf(act), dir)); },
      setValue: (v) => { setPlacement(act, v); }
    };
  }
  // The cog (More) button is a normal reorderable button. It can be shown or
  // hidden, but the hide only takes effect when it holds NO options (buttons
  // moved 'In cog') - while it holds any, the player keeps it visible. Reuses
  // hiddenPlayerButtons (via setPlacement) with only Shown / Hidden.
  const COG_VIS_OPTS = [{ v: 'row', label: 'Shown' }, { v: 'hidden', label: 'Hidden' }];
  function cogVisRow() {
    const cur = () => (placementOf('cog') === 'hidden' ? 'hidden' : 'row');
    return {
      kind: 'enum', label: 'More (cog) button', options: COG_VIS_OPTS, tip: TIPS.cogVis,
      get: cur,
      step: (dir) => { setPlacement('cog', cycle(COG_VIS_OPTS, cur(), dir)); },
      setValue: (v) => { setPlacement('cog', v); }
    };
  }
  // Multi-select row: value is an array of enabled option values. Toggled in a
  // checkbox popup; persists immediately as items are toggled.
  function multiRow(label, key, options) {
    return {
      kind: 'multi', label, options, tip: TIPS[key],
      get: () => uiGet(key) || [],
      setValues: (arr) => { uiSet({ [key]: arr }); }
    };
  }
  // Reorder row: opens a popup where each entry is grabbed with OK and moved
  // Up/Down; the full order is persisted to ui_settings under `key`. get()
  // returns the saved order reconciled against BUTTON_ORDER_DEFAULT (drops
  // unknown entries, appends any new buttons in their default position).
  function orderRow(label, key) {
    return {
      kind: 'order', label, key, tip: TIPS[key],
      get: () => {
        const saved = (uiGet(key) || []).filter((a) => BUTTON_ORDER_DEFAULT.includes(a));
        BUTTON_ORDER_DEFAULT.forEach((a) => { if (!saved.includes(a)) saved.push(a); });
        return saved;
      },
      setOrder: (arr) => { uiSet({ [key]: arr }); }
    };
  }
  // Action row: no stored value; select() runs a one-off action (e.g. clear).
  function actionRow(label, run) {
    return { kind: 'action', label, run, tip: TIPS['act:' + label] };
  }
  // Info row: read-only label + value (e.g. version numbers). No interaction.
  function infoRow(label, value) {
    return { kind: 'info', label, value: String(value) };
  }
  // Note row: read-only descriptive text rendered as a plain line (no row box,
  // no value chip) and SKIPPED by up/down navigation. For hints / examples.
  function noteRow(text) {
    return { kind: 'note', text: String(text) };
  }
  // Free-text row: value entered via the on-screen keyboard (hooks.editText,
  // implemented in app.js). Used for the pre/post-roll command strings.
  function textRow(label, key, examples) {
    return { kind: 'text', label, key, tip: TIPS[key], examples, get: () => uiGet(key) || '' };
  }
  // Network rows: persist to ui_settings, then ask the main process to re-apply
  // the proxy / DoH config live (network.apply). Default OFF (plain truthiness,
  // unlike boolRow which defaults ON).
  function netBoolRow(label, key, rebuild) {
    return {
      kind: 'bool', label, key, tip: TIPS[key], rebuild: !!rebuild,
      get: () => !!uiGet(key),
      toggle: () => { uiSet({ [key]: !uiGet(key) }); if (window.tv.netApply) window.tv.netApply().catch(() => {}); }
    };
  }
  function netTextRow(label, key, examples) {
    return {
      kind: 'text', label, key, tip: TIPS[key], examples,
      get: () => uiGet(key) || '',
      setValue: (v) => { uiSet({ [key]: v }); if (window.tv.netApply) window.tv.netApply().catch(() => {}); }
    };
  }
  // Input rebind row (Controls). device = 'pad' | 'key'; action is the abstract
  // action name. get() reads the current binding label live from gamepad.js.
  function bindRow(label, device, action) {
    return {
      kind: 'bind', label, device, action, tip: (device === 'pad' ? TIPS.bindPad : TIPS.bindKey),
      get: () => (device === 'pad' ? window.TVInput.labelForPad(action) : window.TVInput.labelForKey(action))
    };
  }
  // Language / country rows: persist to ui_settings, then rebuild the InnerTube
  // sessions (main) and reload the current view so feeds come back localized.
  function localeRow(label, key, options) {
    return {
      kind: 'enum', label, options, key, tip: TIPS[key],
      get: () => uiGet(key),
      step: (dir) => changeLocale(key, cycle(options, uiGet(key), dir)),
      setValue: (v) => changeLocale(key, v)
    };
  }
  async function changeLocale(key, v) {
    ui[key] = v; // reflect immediately in the row label
    // Persist BEFORE setLocale: init() re-reads contentLang/contentCountry
    // from ui_settings.json on disk, so the write must land first.
    try { await window.tv.setUiSettings({ [key]: v }); } catch (e) {}
    if (hooks.toast) hooks.toast('Applying language / country…');
    try { if (window.tv.setLocale) await window.tv.setLocale(); } catch (e) {}
    if (hooks.onLocaleChange) hooks.onLocaleChange();
  }
  // About > check for updates. Best-effort: reports up-to-date / available /
  // not-configured via a toast. When newer, it reveals the in-app "Download
  // update" button (or, where in-place update is not possible, a row that opens
  // the release page). It does NOT auto-open a browser any more.
  async function checkForUpdates() {
    let r = null;
    try { r = await window.tv.checkUpdate(); } catch (e) {}
    const ver = (aboutInfo && aboutInfo.version) || '?';
    if (!r || r.configured === false) { if (hooks.toast) hooks.toast('Update checking is not set up yet (v' + ver + ')'); return; }
    if (!r.ok) { if (hooks.toast) hooks.toast('Could not check for updates'); return; }
    updateInfo = r; // remembered so the build() can reveal the Download row
    if (r.newer) {
      if (hooks.toast) hooks.toast('Update available: v' + r.latest);
    } else if (hooks.toast) {
      hooks.toast('You are up to date (v' + (r.current || ver) + ')');
    }
    if (dialogCat === 'about') {
      rebuildDialog();
      // Update found: land the cursor on the download (or release-page) button.
      if (r.newer) focusRowByLabel(updateCanSelf ? 'Download update' : 'Get the update');
    }
  }
  // Download + stage the update in the background, showing live progress on the
  // "Downloading update" row. On success the row set switches to "Restart now",
  // and the update will otherwise install on the next close.
  async function doDownloadUpdate() {
    if (updateBusy || updateStaged) return;
    updateBusy = true;
    updateProgressText = 'Starting...';
    if (dialogCat === 'about') rebuildDialog();
    let r = null;
    try { r = await window.tv.downloadUpdate(); } catch (e) {}
    updateBusy = false;
    if (r && r.ok) {
      updateStaged = { version: r.version };
      if (dialogCat === 'about') { rebuildDialog(); focusRowByLabel('Restart now'); }
      if (hooks.toast) hooks.toast('Update downloaded. Restart now, or it installs when you next close Cathode.', 6000);
    } else {
      if (dialogCat === 'about') rebuildDialog();
      if (hooks.toast) hooks.toast('Update download failed' + (r && r.error ? ': ' + r.error : ''));
    }
  }
  // Restart now: main launches the (hidden) applier and quits; the app closes,
  // the update installs, and the new version relaunches itself.
  async function doApplyUpdate() {
    if (!updateStaged) return;
    if (hooks.toast) hooks.toast('Updating and restarting...');
    try { await window.tv.applyUpdateNow(); } catch (e) {}
  }
  // Fallback for installs that cannot self-update (dev run / read-only folder):
  // open the GitHub release page so the user can download manually.
  async function doOpenReleasePage() {
    if (updateInfo && updateInfo.url && window.tv.openExternal) {
      try { await window.tv.openExternal(updateInfo.url); } catch (e) {}
    }
  }
  // Live download/extract progress -> patch the progress row's value in place
  // (no full rebuild, so no flicker or focus jump on frequent events).
  function onUpdateProgress(p) {
    if (!p) return;
    updateProgressText = p.phase === 'extract' ? 'Extracting...'
      : p.phase === 'ready' ? 'Ready'
      : (p.pct != null ? p.pct + '%' : 'Downloading...');
    if (dialogCat !== 'about') return;
    const kids = $('settings-list').children;
    for (const el of kids) {
      const lab = el.querySelector && el.querySelector('.settings-row-label');
      if (lab && lab.textContent === UPDATE_PROGRESS_LABEL) {
        const val = el.querySelector('.settings-row-value');
        if (val) val.textContent = updateProgressText;
        break;
      }
    }
  }
  // About > Debug logging. Custom bool row: the flag is GLOBAL (not per-account
  // ui_settings) so it is read/written via window.tv.debugGet/debugSet, and the
  // renderer console mirror is flipped live via window.CTDebug.
  function debugRow() {
    return {
      kind: 'bool', label: 'Debug logging', tip: TIPS['act:Debug logging'],
      get: () => debugOn,
      toggle: () => {
        debugOn = !debugOn;
        if (window.CTDebug) window.CTDebug.setEnabled(debugOn);
        if (window.tv.debugSet) window.tv.debugSet(debugOn).catch(() => {});
        if (hooks.toast) hooks.toast(debugOn ? 'Debug logging ON' : 'Debug logging off');
      }
    };
  }
  // About > Export debug info. Builds the redacted zip main-side and opens the
  // folder it landed in.
  async function doExportDebug() {
    if (hooks.toast) hooks.toast('Preparing debug info…');
    let r = null;
    try { r = await window.tv.debugExport(); } catch (e) {}
    if (r && r.ok) { if (hooks.toast) hooks.toast('Saved ' + (r.name || 'debug bundle') + ' - folder opened'); }
    else if (hooks.toast) hooks.toast('Could not export debug info' + (r && r.error ? ': ' + r.error : ''));
  }
  // ---- Downloads (yt-dlp / ffmpeg) actions ----
  // Fetch binary state + global download settings, then rebuild so the card fills
  // in. Kept out of the synchronous open() path (mirrors refreshBackupData).
  async function refreshDownloadData() {
    dlUpdateInfo = null; // a fresh open requires an explicit check before the Update row shows
    try { dlState = (window.tv.dlState ? await window.tv.dlState() : null); } catch (e) { dlState = null; }
    try { dlSettings = (window.tv.dlGetSettings ? await window.tv.dlGetSettings() : null); } catch (e) { dlSettings = null; }
    if (dialogCat === 'downloads') rebuildDialog();
  }
  // Install progress is shown INLINE in the binary's own row (no full-screen
  // overlay now that each row is its own install control). Main sends an absolute
  // { label, pct }; we patch just that row's value text so there's no flicker or
  // focus jump on the frequent progress events.
  function onDlBinProgress(p) {
    if (!p || !p.which || !(p.which in dlInstalls)) return;
    const text = (p.label || 'Downloading…') + (p.pct != null ? ' ' + p.pct + '%' : '');
    dlInstalls[p.which] = text;
    if (dialogCat !== 'downloads') return;
    const rowLabel = DL_ROW_LABEL[p.which];
    const kids = $('settings-list').children;
    for (const el of kids) {
      const lab = el.querySelector && el.querySelector('.settings-row-label');
      if (lab && lab.textContent === rowLabel) {
        const val = el.querySelector('.settings-row-value');
        if (val) val.textContent = text;
        break;
      }
    }
  }
  // Install (or reinstall) one binary: 'ytdlp' | 'ffmpeg' | 'deno'. Each runs
  // independently, so the three can download in parallel; the pressed row shows its
  // own live progress and, on finish, its new version.
  async function doInstallBinary(which) {
    if (dlInstalls[which] != null) return; // already installing this one
    const name = which === 'ffmpeg' ? 'ffmpeg' : which === 'deno' ? 'Deno' : 'yt-dlp';
    dlInstalls[which] = 'Preparing…';
    rebuildDialog(); // the pressed row now reads "Preparing…" (others keep their state)
    try { await window.tv.dlInstall(which); } catch (e) {}
    delete dlInstalls[which];
    await refreshDownloadData(); // rebuild -> row shows the installed version
    const st = dlState;
    const ok = which === 'ffmpeg' ? !!(st && st.ffmpeg.present && st.ffprobe.present)
      : which === 'deno' ? !!(st && st.deno && st.deno.present)
      : !!(st && st.ytdlp.present);
    if (hooks.toast) hooks.toast(ok ? (name + ' installed') : (name + ' install failed. Check your connection and try again.'));
  }
  async function doChooseDownloadDir() {
    let r = null;
    try { r = await window.tv.dlChooseDir(); } catch (e) { r = null; }
    if (r && r.ok) { await refreshDownloadData(); if (hooks.toast) hooks.toast('Download folder set'); }
  }
  async function doResetDownloadDir() {
    dlSet({ saveDir: '' });
    await refreshDownloadData();
    if (hooks.toast) hooks.toast('Download folder reset to default');
  }
  async function doCheckDlUpdates() {
    if (hooks.toast) hooks.toast('Checking for updates…');
    let r = null;
    try { r = await window.tv.dlCheckUpdates(); } catch (e) { r = null; }
    if (!r) { if (hooks.toast) hooks.toast('Could not check for updates'); return; }
    dlUpdateInfo = r; // reveals the Update row (via build) when there's a newer version
    if (dialogCat === 'downloads') rebuildDialog();
    if (r.upToDate) { if (hooks.toast) hooks.toast('yt-dlp is up to date (' + (r.current || '?') + ')'); }
    else if (r.latest) { if (hooks.toast) hooks.toast('Update available: ' + (r.current || '?') + ' → ' + r.latest); }
    else if (hooks.toast) hooks.toast('Current version: ' + (r.current || 'unknown'));
  }
  async function doUpdateYtdlp() {
    if (hooks.toast) hooks.toast('Updating yt-dlp…');
    let r = null;
    try { r = await window.tv.dlUpdateYtdlp(); } catch (e) { r = null; }
    if (r && r.ok) { if (hooks.toast) hooks.toast(r.message || 'yt-dlp updated'); }
    else if (hooks.toast) hooks.toast('Update failed' + (r && r.message ? ': ' + r.message : ''));
    await refreshDownloadData(); // clears dlUpdateInfo -> Update row disappears
  }

  // ---- Backup & Restore actions ----
  function backupLabel(b) {
    const dt = new Date(b.mtime).toLocaleString();
    const kb = b.size / 1024;
    const sz = kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(kb)) + ' KB';
    return dt + ' · ' + sz + (b.auto ? ' · auto' : '');
  }
  // Full-screen progress overlay, driven by main's backup:progress events.
  function onBackupProgress(p) {
    const ov = document.getElementById('backup-progress');
    if (!ov) return;
    const fill = document.getElementById('backup-bar-fill');
    const lab = document.getElementById('backup-progress-label');
    if (p.phase === 'done') { // leave the overlay up; doBackupNow hides it after a beat
      if (fill) fill.style.width = '100%';
      if (lab) lab.textContent = 'Done';
      return;
    }
    ov.classList.remove('hidden');
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    if (fill) fill.style.width = pct + '%';
    if (lab) lab.textContent = p.total ? (pct + '%  (' + p.done + ' / ' + p.total + ' files)') : 'Preparing…';
  }
  async function doBackupNow() {
    const ov = document.getElementById('backup-progress');
    const shownAt = Date.now();
    if (ov) {
      const fill = document.getElementById('backup-bar-fill'); if (fill) fill.style.width = '0%';
      const lab = document.getElementById('backup-progress-label'); if (lab) lab.textContent = 'Preparing…';
      ov.classList.remove('hidden');
    }
    let r = null;
    try { r = await window.tv.backupNow(); } catch (e) {}
    // Backups are usually tiny (allowlist) and finish in a blink -- keep the bar
    // on screen for a brief minimum so the user actually sees it complete.
    const wait = 700 - (Date.now() - shownAt);
    if (ov && wait > 0) await new Promise((res) => setTimeout(res, wait));
    if (ov) ov.classList.add('hidden');
    if (r && r.ok) { if (hooks.toast) hooks.toast('Backup saved'); }
    else if (hooks.toast) hooks.toast('Backup failed' + (r && r.error ? ': ' + r.error : ''));
  }
  async function doRestore(zipPath) {
    if (!zipPath) return;
    if (hooks.toast) hooks.toast('Restoring… Cathode will restart');
    try { await window.tv.backupRestore(zipPath); } catch (e) {}
  }
  async function doBackupBrowse() {
    let r = null;
    try { r = await window.tv.backupBrowse(); } catch (e) {}
    if (r && r.ok) { if (hooks.toast) hooks.toast('Restoring… Cathode will restart'); }
    else if (r && r.canceled) { /* user backed out */ }
    else if (hooks.toast) hooks.toast('Restore failed' + (r && r.error ? ': ' + r.error : ''));
  }
  // Numeric row: free ms/number entry via a keypad popup, clamped to cfg.
  function numRow(label, key, cfg) {
    return {
      kind: 'num', label, cfg, tip: TIPS[key],
      get: () => { const v = uiGet(key); return (v == null ? cfg.def : v); },
      setValue: (v) => { uiSet({ [key]: v }); }
    };
  }
  function sbBoolRow(label, key) {
    return {
      kind: 'bool', label, tip: TIPS['sb:' + key],
      get: () => sbGet(key) !== false,
      toggle: () => { sbSet({ [key]: !(sbGet(key) !== false) }); }
    };
  }
  function sbEnumRow(label, key, options) {
    return {
      kind: 'enum', label, options, tip: TIPS['sb:' + key],
      get: () => sbGet(key),
      step: (dir) => { sbSet({ [key]: cycle(options, sbGet(key), dir) }); },
      setValue: (v) => { sbSet({ [key]: v }); }
    };
  }
  function daBoolRow(label, key) {
    return {
      kind: 'bool', label, tip: TIPS['da:' + key],
      get: () => daGet(key) !== false,
      toggle: () => { daSet({ [key]: !(daGet(key) !== false) }); }
    };
  }
  function sbCatRow(c) {
    return {
      kind: 'bool', label: 'Skip: ' + c.label, tip: TIPS['sb:cat'],
      get: () => (sbGet('categories') || {})[c.key] !== false && !!(sbGet('categories') || {})[c.key],
      toggle: () => {
        const cats = Object.assign({}, sbGet('categories'));
        cats[c.key] = !cats[c.key];
        sbSet({ categories: cats });
      }
    };
  }
  function cycle(options, cur, dir) {
    let i = options.findIndex((o) => o.v === cur);
    if (i < 0) i = 0;
    i = (i + dir + options.length) % options.length;
    return options[i].v;
  }
  function labelFor(row) {
    if (row.kind === 'action') return 'Press OK (A / Enter)';
    if (row.kind === 'order') return 'Press OK to arrange';
    if (row.kind === 'bind') return row.get();
    if (row.kind === 'info') return row.value;
    if (row.kind === 'dlbin') return row.value;
    if (row.kind === 'dlfolder') { const v = row.value; return v ? (v.length > 34 ? '…' + v.slice(-33) : v) : 'Default'; }
    if (row.kind === 'text') { const v = row.get(); return v ? (v.length > 30 ? v.slice(0, 30) + '…' : v) : 'Not set'; }
    if (row.kind === 'bool') return row.get() ? 'On' : 'Off';
    if (row.kind === 'num') return row.get() + (row.cfg && row.cfg.unit ? ' ' + row.cfg.unit : '');
    if (row.kind === 'multi') {
      const sel = row.get();
      const on = row.options.filter((o) => sel.includes(o.v));
      return on.length ? on.map((o) => o.label).join(', ') : 'None';
    }
    const o = row.options.find((o) => o.v === row.get());
    return o ? o.label : String(row.get());
  }

  // ---------- effects ----------
  function applyAll() {
    const root = document.documentElement;
    // Colour scheme + accent (Interface). Write the palette onto :root; the
    // translucent focus fills derive from --focus via color-mix in styles.css.
    const theme = THEMES[uiGet('theme')] || THEMES.dark;
    for (const k in theme) root.style.setProperty(k, theme[k]);
    root.style.setProperty('--focus', ACCENTS[uiGet('accent')] || ACCENTS.blue);
    root.style.setProperty('--card-title-lines', String(uiGet('cardTitleLines') || 2));
    root.style.setProperty('--ui-zoom', String((uiGet('uiScale') || 100) / 100));
    document.body.classList.toggle('no-round', uiGet('roundedCards') === false);
    document.body.classList.toggle('rail-mini', uiGet('railMini') === true);
    document.body.classList.toggle('card-autoscroll', uiGet('cardAutoscroll') === true);
    const gridEl = $('grid');
    if (gridEl) gridEl.style.gridTemplateColumns = 'repeat(' + (uiGet('gridCols') || 4) + ', 1fr)';

    // Subtitles: drive #video::cue off a dynamic <style>.
    let st = $('tv-cue-style');
    if (!st) { st = document.createElement('style'); st.id = 'tv-cue-style'; document.head.appendChild(st); }
    const bg = uiGet('subBackground') === false ? 'transparent' : 'rgba(0,0,0,0.75)';
    st.textContent = '#video::cue{font-size:' + (uiGet('subScale') || 100) + '%;background-color:' + bg + ';color:#fff;}';

    // Rail section visibility.
    const disabled = uiGet('disabledSections') || [];
    for (const s of OPTIONAL_SECTIONS) {
      const item = document.querySelector('.rail-item[data-section="' + s.key + '"]');
      if (item) item.classList.toggle('hidden', disabled.includes(s.key));
    }
  }

  // ---------- category grid ----------
  function openScreen() {
    const grid = $('grid');
    const shelves = $('shelves');
    $('section-title').textContent = 'Settings';
    if (shelves) shelves.innerHTML = '';
    grid.innerHTML = '';
    document.body.classList.remove('pl-list');
    for (const cat of CATEGORIES) {
      const card = document.createElement('div');
      card.className = 'card settings-card';
      card.dataset.cat = cat.id;
      card.innerHTML = '<div class="settings-icon">' + cat.icon + '</div>' +
        '<div class="settings-label"></div>';
      card.querySelector('.settings-label').textContent = cat.label;
      grid.appendChild(card);
    }
    // Fit ALL category cards on screen without scrolling: pick a column count
    // that keeps the grid to ~3 rows, and let the CSS (body.settings-cats) flex
    // #grid to fill the viewport and shrink the cards. Removed on the next
    // section load (feeds.loadSection).
    const cols = Math.max(4, Math.min(6, Math.ceil(CATEGORIES.length / 3)));
    grid.style.setProperty('--set-cols', cols);
    document.body.classList.add('settings-cats');
    grid.classList.remove('hidden');
    if (shelves) shelves.classList.add('hidden');
    Nav.setLayout('grid');
    Nav.resetContent();
    $('content').scrollTop = 0;
    Nav.enterFirst();
  }

  // ---------- dialog ----------
  function openCard(catId) {
    const cat = CATEGORIES.find((c) => c.id === catId);
    if (!cat) return;
    if (cat.launch) { if (hooks.onLaunchAccounts) hooks.onLaunchAccounts(); return; }
    dialogCat = catId;
    rows = cat.build();
    rowIdx = focusable(0) ? 0 : stepRow(0, 1);
    renderDialog(cat);
    // Reveal the overlay BEFORE resetting scroll + focus. A display:none list
    // ignores scrollTop / scrollIntoView, so doing it while hidden left the
    // shared #settings-list scrolled where the PREVIOUS card left it -- the
    // first option ended up scrolled off the top on the 2nd card opened. Now
    // the list has layout when we reset it.
    $('settings-overlay').classList.remove('hidden');
    const list = $('settings-list'); if (list) list.scrollTop = 0;
    applyFocus(); // cursor starts on the first option
    if (hooks.onOpenDialog) hooks.onOpenDialog();
    // Backup card: fetch the (async) backup list + cadence in the background,
    // then rebuild -- the dialog opens instantly and fills in when ready. Kept
    // out of the synchronous open path so input-mode flips before any await.
    if (catId === 'backup') refreshBackupData();
    if (catId === 'downloads') refreshDownloadData();
    if (catId === 'remote') refreshCompanionData();
  }
  async function refreshBackupData() {
    try { backupCache = (window.tv.backupList ? await window.tv.backupList() : []) || []; } catch (e) { backupCache = []; }
    try { backupCadence = (window.tv.backupGetCadence ? await window.tv.backupGetCadence() : 'off') || 'off'; } catch (e) { backupCadence = 'off'; }
    if (dialogCat === 'backup') rebuildDialog();
  }

  // ---------- companion remote (Remote card) ----------
  async function refreshCompanionData() {
    try { if (window.tv.companionStatus) companionData = (await window.tv.companionStatus()) || companionData; }
    catch { /* keep last */ }
    if (dialogCat === 'remote') rebuildDialog();
  }
  // Enter pairing mode and show a modal with the QR + PIN. The server is started
  // if it was not already (companion:startPairing forces it). Closed by Back, or
  // automatically when a device pairs (the onCompanionDevices push).
  async function openPair() {
    let info = null;
    try { if (window.tv.companionStartPairing) info = await window.tv.companionStartPairing(); }
    catch { /* fall through */ }
    if (!info || !info.pin) { if (hooks.toast) hooks.toast('Could not start pairing'); return; }
    picker = { type: 'pair', info };
    $('settings-picker').classList.remove('hidden');
    renderPickerBox();
    // Auto-close when the one-time PIN expires (server-provided TTL).
    if (info.ttlMs) picker.timer = setTimeout(() => {
      if (picker && picker.type === 'pair') { if (hooks.toast) hooks.toast('Pairing timed out'); closePair(); }
    }, info.ttlMs);
  }
  function closePair() {
    const standalone = !!(picker && picker.standalone);
    if (picker && picker.timer) clearTimeout(picker.timer);
    try { if (window.tv.companionStopPairing) window.tv.companionStopPairing(); } catch { /* ignore */ }
    $('settings-picker').classList.add('hidden');
    $('settings-picker').classList.remove('pair');
    picker = null;
    // Standalone (phone-initiated) modal: we opened the settings overlay + hid the
    // dialog body ourselves, so undo that now.
    if (standalone) {
      $('settings-body').classList.remove('hidden');
      $('settings-overlay').classList.add('hidden');
    }
    if (dialogCat === 'remote') { refreshCompanionData(); }
  }
  // Phone-initiated pairing: the server already minted the PIN and pushed its
  // info here (via app.js). Show the SAME modal as openPair, but standalone -
  // it can appear over ANY screen (browse, player, etc.), so app.js routes Back
  // to closeCompanionPair while it is open. Auto-closes on pair (the
  // onCompanionDevices push -> closePair) or when the PIN TTL expires.
  function openCompanionPair(info) {
    if (!info || !info.pin) return;
    // Idempotent: a pair modal may ALREADY be open - either the user tapped Pair
    // in Settings (openPair, non-standalone) or the phone sent `pairRequest` more
    // than once (each one triggers this). In that case just refresh the PIN/QR +
    // TTL timer IN PLACE; do NOT open a second modal or re-hide the body / re-show
    // the overlay, and do NOT flip a Settings-opened modal to standalone. Stacking
    // those is what drew the pairing window twice and trapped focus on an
    // invisible element after pairing (needing several Back presses to clear).
    if (picker && picker.type === 'pair') {
      if (picker.timer) clearTimeout(picker.timer);
      picker.info = info;
      renderPickerBox();
      if (info.ttlMs) picker.timer = setTimeout(() => {
        if (picker && picker.type === 'pair') { if (hooks.toast) hooks.toast('Pairing timed out'); closePair(); }
      }, info.ttlMs);
      return;
    }
    // The picker lives inside #settings-overlay, which is normally shown only
    // while a settings dialog is open. For a phone-initiated pair from ANY screen
    // we must show the overlay ourselves (else the PIN is invisible but input is
    // still trapped) and hide the empty/stale dialog body so only the PIN shows.
    $('settings-overlay').classList.remove('hidden');
    $('settings-body').classList.add('hidden');
    picker = { type: 'pair', info, standalone: true };
    $('settings-picker').classList.remove('hidden');
    renderPickerBox();
    if (info.ttlMs) picker.timer = setTimeout(() => {
      if (picker && picker.type === 'pair') { if (hooks.toast) hooks.toast('Pairing timed out'); closePair(); }
    }, info.ttlMs);
  }
  function isCompanionPairOpen() { return !!(picker && picker.type === 'pair' && picker.standalone); }
  async function confirmUnpair(d) {
    try { if (window.tv.companionUnpair) { const devs = await window.tv.companionUnpair(d.id); companionData.devices = devs || []; } }
    catch { /* ignore */ }
    if (hooks.toast) hooks.toast('Removed ' + d.name);
    if (dialogCat === 'remote') rebuildDialog();
  }
  async function confirmUnpairAll() {
    try { if (window.tv.companionUnpairAll) { companionData.devices = (await window.tv.companionUnpairAll()) || []; } }
    catch { /* ignore */ }
    if (hooks.toast) hooks.toast('All devices removed');
    if (dialogCat === 'remote') rebuildDialog();
  }
  // Draw a QR for `text` into `container` using the global qrcode (vendor script,
  // same one the sign-in QR uses). Silently no-ops if the lib is absent.
  function drawQr(container, text) {
    container.innerHTML = '';
    if (!text || typeof window.qrcode === 'undefined') return;
    try {
      const qr = window.qrcode(0, 'M'); qr.addData(text); qr.make();
      const count = qr.getModuleCount();
      const cell = 5, margin = 4 * cell, size = count * cell + margin * 2;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      canvas.style.width = '240px'; canvas.style.height = '240px';
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#000';
      for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(margin + c * cell, margin + r * cell, cell, cell);
      }
      container.appendChild(canvas);
    } catch { /* draw failed: leave empty */ }
  }

  // Focused position among the focusable (non-note) rows, as "i / N", shown in
  // the dialog title so the user knows how many options a category holds.
  function focusPosition() {
    let pos = 0, total = 0;
    for (let i = 0; i < rows.length; i++) {
      if (!focusable(i)) continue;
      total++;
      if (i <= rowIdx) pos++;
    }
    return total ? (pos + ' / ' + total) : '';
  }
  function updateDialogCount() {
    const el = $('settings-dialog-count');
    if (el) el.textContent = focusPosition();
  }

  function renderDialog(cat) {
    $('settings-dialog-label').textContent = cat.icon + '  ' + cat.label;
    const list = $('settings-list');
    list.innerHTML = '';
    rows.forEach((row, i) => {
      if (row.kind === 'note') {
        const n = document.createElement('div');
        n.className = 'settings-note';
        n.textContent = row.text;
        list.appendChild(n);
        return;
      }
      const el = document.createElement('div');
      el.className = 'settings-row' + (i === rowIdx ? ' focused' : '');
      const lab = document.createElement('div');
      lab.className = 'settings-row-label';
      lab.textContent = row.label;
      const val = document.createElement('div');
      val.className = 'settings-row-value' + (row.kind === 'bool' ? (row.get() ? ' on' : '') : '');
      val.textContent = labelFor(row);
      el.appendChild(lab); el.appendChild(val);
      list.appendChild(el);
    });
  }

  function refreshRow(i) {
    const el = $('settings-list').children[i];
    if (!el) return;
    const row = rows[i];
    const val = el.querySelector('.settings-row-value');
    val.textContent = labelFor(row);
    if (row.kind === 'bool') val.classList.toggle('on', row.get());
  }

  // Some rows (e.g. Seek mode) change which OTHER rows are visible. After such
  // a change, rebuild the dialog from the category so rows appear/disappear,
  // keeping the cursor clamped in range.
  function rebuildDialog() {
    const cat = CATEGORIES.find((c) => c.id === dialogCat);
    if (!cat) return;
    rows = cat.build();
    if (rowIdx > rows.length - 1) rowIdx = Math.max(0, rows.length - 1);
    if (!focusable(rowIdx)) rowIdx = stepRow(rowIdx, -1);
    renderDialog(cat);
    applyFocus();
  }

  function applyFocus() {
    const kids = $('settings-list').children;
    for (let i = 0; i < kids.length; i++) {
      kids[i].classList.toggle('focused', i === rowIdx);
      if (i === rowIdx) kids[i].scrollIntoView({ block: 'nearest' });
    }
    updateDialogCount();
    updateTip();
  }
  // Fill the right-side help panel with the focused row's label + description,
  // then position it vertically beside the focused row.
  function updateTip() {
    const el = $('settings-tip');
    if (!el) return;
    const row = rows[rowIdx];
    el.innerHTML = '';
    if (!row) { el.style.transform = ''; return; }
    const t = document.createElement('div');
    t.className = 'settings-tip-title';
    t.textContent = row.label || '';
    const b = document.createElement('div');
    b.className = 'settings-tip-body';
    b.textContent = row.tip || '';
    el.appendChild(t);
    el.appendChild(b);
    positionTip();
  }
  // Align the tip box's vertical centre with the focused row's centre, clamped
  // so it stays within the dialog body. Height follows the tip's own content.
  function positionTip() {
    const el = $('settings-tip');
    const body = $('settings-body');
    const list = $('settings-list');
    if (!el || !body || !list) return;
    const focusedEl = list.children[rowIdx];
    if (!focusedEl) { el.style.transform = ''; return; }
    const bodyRect = body.getBoundingClientRect();
    const rowRect = focusedEl.getBoundingClientRect();
    let top = (rowRect.top + rowRect.height / 2) - bodyRect.top - (el.offsetHeight / 2);
    const maxTop = Math.max(0, body.clientHeight - el.offsetHeight);
    top = Math.max(0, Math.min(top, maxTop));
    el.style.transform = 'translateY(' + top + 'px)';
  }
  // Rows the cursor can land on (note rows are display-only).
  // Read-only rows (notes AND info rows like version numbers / binary status)
  // are skipped by up/down: they have no action, so they should never be a
  // focus stop / look like a selectable button.
  function focusable(i) { return rows[i] && rows[i].kind !== 'note' && rows[i].kind !== 'info'; }
  // Move dialog focus to the first focusable row whose label STARTS WITH `prefix`
  // (labels carry version suffixes, e.g. "Download update (v1.2.3)"). Call AFTER
  // rebuildDialog() so `rows` is current. Returns false (no-op) if not found.
  function focusRowByLabel(prefix) {
    for (let i = 0; i < rows.length; i++) {
      if (focusable(i) && rows[i].label && rows[i].label.indexOf(prefix) === 0) {
        rowIdx = i; applyFocus(); return true;
      }
    }
    return false;
  }
  // Move the cursor by dir, skipping non-focusable (note) rows; stay put at an
  // edge if nothing focusable lies beyond.
  function stepRow(from, dir) {
    let i = from;
    for (let k = 0; k < rows.length; k++) {
      i += dir;
      if (i < 0) i = rows.length - 1;          // wrap: Up at the top -> bottom
      else if (i > rows.length - 1) i = 0;     // wrap: Down at the bottom -> top
      if (focusable(i)) return i;
    }
    return from;
  }

  function closeDialog() {
    if (picker) {
      if (picker.type === 'bind' && window.TVInput) window.TVInput.cancelCapture();
      if (picker.type === 'pair') { if (picker.timer) clearTimeout(picker.timer); try { if (window.tv.companionStopPairing) window.tv.companionStopPairing(); } catch { /* ignore */ } }
      $('settings-picker').classList.add('hidden');
      $('settings-picker').classList.remove('kp', 'bind', 'pair');
      picker = null;
    }
    $('settings-overlay').classList.add('hidden');
    dialogCat = null; rows = []; rowIdx = 0;
    if (hooks.onCloseDialog) hooks.onCloseDialog();
  }

  // Popup modal over the dialog. Three types: 'enum' (single choice), 'multi'
  // (checkbox multi-select), 'num' (numeric keypad). picker holds the type.
  const KEYPAD = [['7', '8', '9'], ['4', '5', '6'], ['1', '2', '3'], ['0', 'back', 'clear'], ['default', 'ok']];

  function usesPicker(row) { return row && row.kind === 'enum' && row.options && (row.picker || row.options.length > 2); }

  function openPicker(i) {
    const row = rows[i];
    if (!row || !row.options) return;
    let cur = row.options.findIndex((o) => o.v === row.get());
    if (cur < 0) cur = 0;
    picker = { type: 'enum', rowIdx: i, index: cur, options: row.options };
    $('settings-picker').classList.remove('hidden'); // reveal first so the initial scroll-to-selection has layout
    renderPickerBox();
  }
  function openMulti(i) {
    const row = rows[i];
    if (!row || !row.options) return;
    picker = { type: 'multi', rowIdx: i, index: 0, options: row.options, sel: new Set(row.get()) };
    $('settings-picker').classList.remove('hidden'); // reveal first so the initial scroll-to-selection has layout
    renderPickerBox();
  }
  function openKeypad(i) {
    const row = rows[i];
    if (!row || !row.cfg) return;
    picker = { type: 'num', rowIdx: i, krow: 0, kcol: 0, value: String(row.get()), cfg: row.cfg };
    renderPickerBox();
    $('settings-picker').classList.remove('hidden');
  }
  function openOrder(i) {
    const row = rows[i];
    if (!row || !row.get) return;
    picker = { type: 'order', rowIdx: i, index: 0, grabbed: false, order: row.get().slice() };
    $('settings-picker').classList.remove('hidden');
    renderPickerBox();
  }
  // Persist the working order as the user rearranges (moves take effect live).
  function commitOrder() {
    const row = rows[picker.rowIdx];
    if (row && row.setOrder) row.setOrder(picker.order.slice());
  }
  // Rebind capture (Controls): show a waiting popup and ask gamepad.js for the
  // next raw press on this row's device. The callback fires from gamepad.js
  // (poll loop / keydown), outside the normal input flow -- dispatch is
  // suppressed there while capturing, so handleInput is not called meanwhile.
  function openBind(i) {
    const row = rows[i];
    if (!row || !window.TVInput) return;
    picker = { type: 'bind', rowIdx: i, device: row.device };
    $('settings-picker').classList.remove('hidden');
    renderPickerBox();
    window.TVInput.captureNext(row.device, (val) => {
      if (val != null) window.TVInput.setBind(row.device, row.action, val);
      $('settings-picker').classList.add('hidden');
      $('settings-picker').classList.remove('bind');
      picker = null;
      refreshRow(i);
    });
  }

  function renderPickerBox() {
    const box = $('settings-picker');
    box.innerHTML = '';
    box.classList.toggle('kp', picker.type === 'num');
    box.classList.toggle('bind', picker.type === 'bind');
    box.classList.toggle('pair', picker.type === 'pair');
    if (picker.type === 'pair') {
      const info = picker.info || {};
      const wrap = document.createElement('div');
      wrap.className = 'pair-box';
      wrap.style.textAlign = 'center';
      const title = document.createElement('div');
      title.className = 'settings-pick-title';
      title.textContent = 'Pair a device';
      title.style.marginBottom = '12px';
      wrap.appendChild(title);
      const qrDiv = document.createElement('div');
      qrDiv.style.display = 'flex'; qrDiv.style.justifyContent = 'center';
      drawQr(qrDiv, info.qr);
      wrap.appendChild(qrDiv);
      const pin = document.createElement('div');
      pin.textContent = info.pin || '';
      pin.style.cssText = 'font-size:2rem;letter-spacing:0.25em;font-weight:700;margin:14px 0 4px;';
      wrap.appendChild(pin);
      const addr = document.createElement('div');
      addr.textContent = (info.host || '') + ':' + (info.port || '');
      addr.style.cssText = 'opacity:0.7;font-size:0.95rem;';
      wrap.appendChild(addr);
      const hint = document.createElement('div');
      hint.textContent = 'Scan with the companion app or enter the code. Waiting for a device - Back to cancel.';
      hint.style.cssText = 'opacity:0.6;font-size:0.85rem;margin-top:12px;max-width:300px;';
      wrap.appendChild(hint);
      box.appendChild(wrap);
      return;
    }
    if (picker.type === 'bind') {
      const row = rows[picker.rowIdx];
      const wrap = document.createElement('div');
      wrap.className = 'bind-cap';
      const act = document.createElement('div');
      act.className = 'bind-cap-action';
      act.textContent = (row && row.label) || '';
      const prompt = document.createElement('div');
      prompt.className = 'bind-cap-prompt';
      prompt.textContent = picker.device === 'pad' ? 'Press a button to add / remove…' : 'Press a key to add / remove…';
      const cur = document.createElement('div');
      cur.className = 'bind-cap-cur';
      cur.textContent = 'Current: ' + (row ? row.get() : '') + '   ·   ' + (picker.device === 'pad' ? 'B' : 'Esc') + ' to cancel';
      wrap.appendChild(act); wrap.appendChild(prompt); wrap.appendChild(cur);
      box.appendChild(wrap);
      return;
    }
    if (picker.type === 'order') {
      const total = picker.order.length;
      const head = document.createElement('div');
      head.className = 'settings-pick-head';
      const title = document.createElement('span');
      title.className = 'settings-pick-title';
      title.textContent = (rows[picker.rowIdx] && rows[picker.rowIdx].label) || '';
      const count = document.createElement('span');
      count.className = 'settings-pick-count';
      count.textContent = picker.grabbed ? 'Moving - Up/Down, OK to drop' : (picker.index + 1) + ' / ' + total;
      head.appendChild(title); head.appendChild(count);
      box.appendChild(head);
      const up = document.createElement('div');
      up.className = 'settings-pick-hint'; up.textContent = '▲';
      box.appendChild(up);
      const list = document.createElement('div');
      list.className = 'settings-pick-list';
      let focusedEl = null;
      picker.order.forEach((act, i) => {
        const d = document.createElement('div');
        const grabbed = picker.grabbed && i === picker.index;
        d.className = 'settings-pick' + (i === picker.index ? ' focused' : '') + (grabbed ? ' grabbed' : '');
        d.textContent = (grabbed ? '↕  ' : '') + (BUTTON_LABELS[act] || act);
        list.appendChild(d);
        if (i === picker.index) focusedEl = d;
      });
      box.appendChild(list);
      const down = document.createElement('div');
      down.className = 'settings-pick-hint'; down.textContent = '▼';
      box.appendChild(down);
      if (focusedEl) focusedEl.scrollIntoView({ block: 'nearest' });
      up.classList.toggle('off', list.scrollTop <= 1);
      down.classList.toggle('off', list.scrollTop + list.clientHeight >= list.scrollHeight - 1);
      return;
    }
    if (picker.type === 'enum' || picker.type === 'multi') {
      const total = picker.options.length;
      // Fixed header: the row's label + a position counter ("5 / 19") so it is
      // obvious the list is longer than what's on screen.
      const head = document.createElement('div');
      head.className = 'settings-pick-head';
      const title = document.createElement('span');
      title.className = 'settings-pick-title';
      title.textContent = (rows[picker.rowIdx] && rows[picker.rowIdx].label) || '';
      const count = document.createElement('span');
      count.className = 'settings-pick-count';
      count.textContent = (picker.index + 1) + ' / ' + total;
      head.appendChild(title); head.appendChild(count);
      box.appendChild(head);
      // Up chevron (visibility set from real scroll overflow, below).
      const up = document.createElement('div');
      up.className = 'settings-pick-hint';
      up.textContent = '▲';
      box.appendChild(up);
      // Scrollable option list.
      const list = document.createElement('div');
      list.className = 'settings-pick-list';
      let focusedEl = null;
      picker.options.forEach((o, i) => {
        const d = document.createElement('div');
        d.className = 'settings-pick' + (i === picker.index ? ' focused' : '');
        const mark = picker.type === 'multi' ? (picker.sel.has(o.v) ? '☑  ' : '☐  ') : '';
        d.textContent = mark + o.label;
        list.appendChild(d);
        if (i === picker.index) focusedEl = d;
      });
      box.appendChild(list);
      // Down chevron (visibility set from real scroll overflow, below).
      const down = document.createElement('div');
      down.className = 'settings-pick-hint';
      down.textContent = '▼';
      box.appendChild(down);
      if (focusedEl) focusedEl.scrollIntoView({ block: 'nearest' });
      // Show each chevron only when the list actually has hidden items in that
      // direction (accurate for short lists that fully fit too). '.off' keeps
      // the row height so nothing shifts.
      up.classList.toggle('off', list.scrollTop <= 1);
      down.classList.toggle('off', list.scrollTop + list.clientHeight >= list.scrollHeight - 1);
      return;
    }
    // numeric keypad
    const disp = document.createElement('div');
    disp.className = 'kp-display';
    disp.textContent = (picker.value || '0') + (picker.cfg.unit ? ' ' + picker.cfg.unit : '');
    box.appendChild(disp);
    const lbl = (k) => k === 'back' ? '⌫' : k === 'clear' ? 'Clear' : k === 'default' ? 'Default' : k === 'ok' ? 'OK' : k;
    KEYPAD.forEach((r, ri) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'kp-row';
      r.forEach((k, ci) => {
        const b = document.createElement('div');
        const wide = (k === 'default' || k === 'ok');
        b.className = 'kp-key' + (wide ? ' kp-wide' : '') + (ri === picker.krow && ci === picker.kcol ? ' focused' : '');
        b.textContent = lbl(k);
        rowEl.appendChild(b);
      });
      box.appendChild(rowEl);
    });
  }

  function closePicker(apply) {
    if (apply && picker && picker.type === 'enum') {
      const row = rows[picker.rowIdx];
      const opt = picker.options[picker.index];
      if (row && opt && row.setValue) row.setValue(opt.v);
      if (row && row.rebuild) rebuildDialog(); else refreshRow(picker.rowIdx);
    }
    $('settings-picker').classList.add('hidden');
    $('settings-picker').classList.remove('kp');
    picker = null;
  }

  function multiToggle() {
    const o = picker.options[picker.index];
    if (picker.sel.has(o.v)) picker.sel.delete(o.v); else picker.sel.add(o.v);
    const row = rows[picker.rowIdx];
    const arr = picker.options.filter((x) => picker.sel.has(x.v)).map((x) => x.v);
    if (row && row.setValues) row.setValues(arr);
    renderPickerBox();
    refreshRow(picker.rowIdx);
  }

  function clampKeyCol() {
    const len = KEYPAD[picker.krow].length;
    if (picker.kcol > len - 1) picker.kcol = len - 1;
  }
  function keypadActivate() {
    const k = KEYPAD[picker.krow][picker.kcol];
    const cfg = picker.cfg;
    if (k === 'ok') {
      let v = parseInt(picker.value, 10);
      if (!isFinite(v)) v = cfg.def;
      v = Math.max(cfg.min, Math.min(cfg.max, v));
      const row = rows[picker.rowIdx];
      if (row && row.setValue) row.setValue(v);
      refreshRow(picker.rowIdx);
      return closePicker(false);
    }
    if (k === 'default') { picker.value = String(cfg.def); return renderPickerBox(); }
    if (k === 'clear') { picker.value = ''; return renderPickerBox(); }
    if (k === 'back') { picker.value = picker.value.slice(0, -1); return renderPickerBox(); }
    if (picker.value.length < 6) picker.value += k;
    renderPickerBox();
  }

  function handleInput(a) {
    // Block input while the backup progress overlay is up (it is modal).
    const bp = document.getElementById('backup-progress');
    if (bp && !bp.classList.contains('hidden')) return;
    // A popup (enum / multi / keypad) is modal over the dialog.
    if (picker) {
      // Bind capture consumes raw input in gamepad.js (dispatch is suppressed
      // there while capturing), so ignore any abstract action that leaks here.
      if (picker.type === 'bind') return;
      if (picker.type === 'pair') { if (a === 'back') return closePair(); return; }
      if (picker.type === 'num') {
        if (a === 'back') return closePicker(false);
        if (a === 'up') { picker.krow = Math.max(0, picker.krow - 1); clampKeyCol(); return renderPickerBox(); }
        if (a === 'down') { picker.krow = Math.min(KEYPAD.length - 1, picker.krow + 1); clampKeyCol(); return renderPickerBox(); }
        if (a === 'left') { picker.kcol = Math.max(0, picker.kcol - 1); return renderPickerBox(); }
        if (a === 'right') { picker.kcol = Math.min(KEYPAD[picker.krow].length - 1, picker.kcol + 1); return renderPickerBox(); }
        if (a === 'select') return keypadActivate();
        return;
      }
      if (picker.type === 'order') {
        if (a === 'back') return closePicker(false);
        const _rn = picker.order.length;
        if (a === 'up') {
          if (picker.grabbed && picker.index > 0) { const o = picker.order, t = o[picker.index - 1]; o[picker.index - 1] = o[picker.index]; o[picker.index] = t; picker.index--; commitOrder(); }
          else if (!picker.grabbed) { if (_rn) picker.index = (picker.index - 1 + _rn) % _rn; } // wrap: top -> bottom
          return renderPickerBox();
        }
        if (a === 'down') {
          if (picker.grabbed && picker.index < picker.order.length - 1) { const o = picker.order, t = o[picker.index + 1]; o[picker.index + 1] = o[picker.index]; o[picker.index] = t; picker.index++; commitOrder(); }
          else if (!picker.grabbed) { if (_rn) picker.index = (picker.index + 1) % _rn; } // wrap: bottom -> top
          return renderPickerBox();
        }
        if (a === 'select') { picker.grabbed = !picker.grabbed; return renderPickerBox(); }
        return;
      }
      if (a === 'back') return closePicker(false);
      // Wrap around at the ends (Up on the first option -> last, Down on last -> first).
      const _on = picker.options.length;
      if (a === 'up') { if (_on) picker.index = (picker.index - 1 + _on) % _on; return renderPickerBox(); }
      if (a === 'down') { if (_on) picker.index = (picker.index + 1) % _on; return renderPickerBox(); }
      if (a === 'select') return picker.type === 'multi' ? multiToggle() : closePicker(true);
      return;
    }
    if (a === 'back') return closeDialog();
    if (a === 'up') { rowIdx = stepRow(rowIdx, -1); applyFocus(); return; }
    if (a === 'down') { rowIdx = stepRow(rowIdx, 1); applyFocus(); return; }
    const row = rows[rowIdx];
    if (!row) return;
    // Only OK/select changes a value now. Left/Right no longer edit options --
    // they were too easy to trigger by accident and are reserved for future
    // column nav; A/OK (and the controller's OK) is the sole change trigger.
    if (row.kind === 'multi') { if (a === 'select') openMulti(rowIdx); return; }
    if (row.kind === 'num') { if (a === 'select') openKeypad(rowIdx); return; }
    if (row.kind === 'order') { if (a === 'select') openOrder(rowIdx); return; }
    if (row.kind === 'bind') {
      if (a === 'select') openBind(rowIdx);
      else if (a === 'longpress' && window.TVInput) { window.TVInput.resetAction(row.device, row.action); refreshRow(rowIdx); if (hooks.toast) hooks.toast('Reset to default'); }
      return;
    }
    if (row.kind === 'text') { if (a === 'select' && hooks.editText) hooks.editText(row.label, row.get(), (val) => { if (row.setValue) row.setValue(val); else uiSet({ [row.key]: val }); rebuildDialog(); }, row.examples); return; }
    if (row.kind === 'info') return; // read-only
    if (row.kind === 'dlbin') { if (a === 'select' && !row.checking && !row.installing) row.run(); return; }
    if (row.kind === 'dlfolder') {
      if (a === 'select') row.run();
      else if (a === 'longpress') row.reset();
      return;
    }
    if (row.kind === 'action') { if (a === 'select') row.run(); return; }
    if (usesPicker(row)) { if (a === 'select') openPicker(rowIdx); return; }
    if (a === 'select') { if (row.kind === 'bool') row.toggle(); else row.step(1); if (row.rebuild) rebuildDialog(); else refreshRow(rowIdx); return; }
  }

  // ---------- public ----------
  async function init(opts) {
    hooks = opts || {};
    if (window.tv.onBackupProgress) window.tv.onBackupProgress(onBackupProgress);
    if (window.tv.onDlBinProgress) window.tv.onDlBinProgress(onDlBinProgress);
    if (window.tv.onUpdateProgress) window.tv.onUpdateProgress(onUpdateProgress);
    // Companion device-change push: a phone paired or (dis)connected. If the
    // pairing modal is open, a new device means success - close it. Otherwise
    // just refresh the Remote card's device list if it is showing.
    if (window.tv.onCompanionDevices) window.tv.onCompanionDevices((devices) => {
      const prevCount = (companionData.devices || []).length;
      companionData.devices = devices || [];
      // Only treat this as a successful pairing (toast + auto-close the modal) when
      // the paired-device COUNT actually grew. A device merely dis/connecting (e.g.
      // the phone cancelling) also fires this push but must NOT say "Device paired".
      const gained = (companionData.devices.length > prevCount);
      if (gained && picker && picker.type === 'pair') { if (hooks.toast) hooks.toast('Device paired'); closePair(); }
      else if (dialogCat === 'remote') rebuildDialog();
    });
    try { ui = (await window.tv.getUiSettings()) || {}; } catch { ui = {}; }
    if (window.tv.getSbSettings) {
      try { sb = (await window.tv.getSbSettings()) || {}; } catch { sb = {}; }
    }
    if (window.tv.getDearrowSettings) {
      try { da = (await window.tv.getDearrowSettings()) || {}; } catch { da = {}; }
    }
    if (window.tv.getSystemPrefs) {
      try { sys = (await window.tv.getSystemPrefs()) || {}; } catch { sys = {}; }
    }
    if (window.tv.about) {
      try { aboutInfo = await window.tv.about(); } catch { aboutInfo = null; }
    }
    if (window.tv.updateStatus) {
      try {
        const us = await window.tv.updateStatus();
        updateCanSelf = !!(us && us.canSelfUpdate);
        // A staged update from earlier this session (user chose "later") should
        // still show the Restart row when Settings is reopened.
        if (us && us.staged) { updateStaged = us.staged; updateInfo = { ok: true, configured: true, newer: true, latest: us.staged.version }; }
      } catch { updateCanSelf = false; }
    }
    if (window.tv.debugGet) {
      try { const r = await window.tv.debugGet(); debugOn = !!(r && r.enabled); } catch { debugOn = false; }
      if (window.CTDebug) window.CTDebug.setEnabled(debugOn);
    }
    applyAll();
  }

  // Re-read this account's settings from disk and re-apply (account isolation):
  // called after an account switch so the newly-active account's ui + SB
  // preferences take effect immediately. Does NOT re-fetch aboutInfo (static).
  async function reload() {
    if (window.TVInput && window.TVInput.reload) window.TVInput.reload();
    try { ui = (await window.tv.getUiSettings()) || {}; } catch { ui = {}; }
    if (window.tv.getSbSettings) {
      try { sb = (await window.tv.getSbSettings()) || {}; } catch { sb = {}; }
    }
    if (window.tv.getDearrowSettings) {
      try { da = (await window.tv.getDearrowSettings()) || {}; } catch { da = {}; }
    }
    applyAll();
  }

  return {
    init, reload, applyAll, openScreen, openCard, handleInput,
    openCompanionPair, isCompanionPairOpen, closeCompanionPair: closePair,
    dialogOpen: () => dialogCat !== null,
    get: (k) => uiGet(k),
    set: (patch) => uiSet(patch),
    sb: (k) => sbGet(k),
    da: (k) => daGet(k)
  };
})();
