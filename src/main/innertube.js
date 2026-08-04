// SPDX-License-Identifier: GPL-3.0-or-later
// Data layer: wraps youtubei.js (InnerTube).
// Runs in Electron's main process (Node), like FreeTube does.
//
// SESSIONS:
//   tubeAnon   - WEB client, never authenticated. Search, anonymous 'Popular'
//                feed, attestation challenges. Best parser support.
//   tubeAuth   - TV client (TVHTML5) carrying the OAuth tokens. Personalized
//                Home + Subscriptions. (OAuth is TV-client-scoped; sending the
//                token on WEB requests caused 400s.)
//
// TV FEED PARSING (session 10): youtubei.js 17.2.0 has NO parser classes for
// the TV grid renderers (tvSurfaceContentRenderer / tileRenderer) - parsed
// responses show a nav shell with content:null while the RAW JSON carries the
// full grid (proven by Data/debug_subs_raw.json). Authenticated feeds are
// therefore fetched RAW, run through youtubei.js' Parser for the node types
// it knows (LockupView shelves), AND walked directly for tileRenderer
// shelves; continuation tokens are followed for a full grid (session 12).
//
// FEED CACHE (session 13): feeds are cached in-memory for 5 minutes with
// in-flight dedupe - boot was fetching Home twice (auth-restore event and
// boot both load it) and every section switch refetched everything.
//
// STREAMS (session 13): YouTube's server-side-ABR (SABR) rollout means some
// clients return adaptive formats WITHOUT URLs (WEB does; a DASH manifest is
// impossible from those). getStreams hunts across clients for one that still
// returns URL-ful adaptive formats (IOS is the usual holdout), and only
// settles for a progressive muxed stream when no client can produce DASH.
//
// JS EVALUATOR (required by youtubei.js v17+): the library ships NO default
// evaluator for the player-script snippets that decipher stream URLs - the
// default just throws. We install one at init(): the extracted snippet
// (data.output, a function body ending in `return process(...)`) runs in an
// isolated node:vm context with the { sig, sp, n } env vars, 10s timeout.

const path = require('path');
const fs = require('fs');
const vm = require('node:vm');
const { app, safeStorage, net } = require('electron');
const logger = require('./logger');
const potoken = require('./potoken');
const activeaccount = require('./activeaccount');
const network = require('./network');

// When the user has set a proxy or custom DNS (Settings > Network), route our
// InnerTube HTTP through Electron's net stack (Chromium) instead of Node's
// global fetch, so the proxy + DoH resolver apply to FEEDS too - not just the
// Chromium-side video streams. Off by default: returns null so youtubei.js and
// legacyInnertubeFetch keep using the plain global fetch (no behaviour change).
function networkFetch() {
  try {
    if (network.isActive() && net && typeof net.fetch === 'function') {
      return (input, init) => net.fetch(input, init);
    }
  } catch (e) { /* fall through to default fetch */ }
  return null;
}
// InnerTube fetch used by our hand-rolled requests (legacyInnertubeFetch): the
// net-routed fetch when network config is active, else the global fetch.
function ytFetch(url, init) { const f = networkFetch(); return f ? f(url, init) : fetch(url, init); }

// The always-present, logged-out account. Guest keeps any real account's OAuth
// tokens intact (no revoke on switch) but reports NOT signed in, so feeds fall
// back to anonymous and account writes are blocked.
const GUEST_ID = 'guest';

// Diagnostic dumps (raw feed / player / manifest captures) are gated behind a
// flag so normal runs don't scatter debug_*.json into the Data folder. Enable
// with the env var CATHODE_DEBUG_DUMPS=1 when investigating a feed/parse/stream
// issue. debugDump writes safeDump(data) (or a raw string) to userData/<name>.
let DEBUG_DUMPS = process.env.CATHODE_DEBUG_DUMPS === '1';
// Toggled live from Settings > About (via the debug module) so a user can
// capture raw feed/player dumps without setting an env var + restarting.
function setDebugDumps(on) { DEBUG_DUMPS = !!on || process.env.CATHODE_DEBUG_DUMPS === '1'; }
function debugDump(name, data) {
  if (!DEBUG_DUMPS) return;
  try { fs.writeFileSync(path.join(app.getPath('userData'), name), typeof data === 'string' ? data : safeDump(data)); } catch (e) {}
}

// Content language (hl) + country (gl) for BOTH sessions. Read from
// ui_settings.json (the same file the renderer settings write) so a change
// there is picked up when the sessions are (re)built. Empty values -> let
// youtubei.js use its defaults (en / US). See setLocale() for live changes.
function localePrefs() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'ui_settings.json'), 'utf8'));
    const out = {};
    if (s && typeof s.contentLang === 'string' && s.contentLang) out.lang = s.contentLang;
    if (s && typeof s.contentCountry === 'string' && s.contentCountry) out.location = s.contentCountry;
    return out;
  } catch (e) { return {}; }
}

let ytMod = null;      // youtubei.js module (ESM, dynamically imported)
let sharedCache = null;
let tubeAnon = null;
let tubeAuth = null;

// --- Account registry (multi-account, encrypted at rest) ---
// yt_accounts.json holds EVERY signed-in account (OAuth credentials + display
// name/handle/avatar) plus which one is selected. The whole registry is
// encrypted together via Electron safeStorage (Windows DPAPI, keyed to the
// Windows user) exactly like the old single-credential file, so a copied Data
// folder still can't be decrypted elsewhere. A legacy single-account
// yt_credentials.json is migrated into a one-account registry on first load.
const registryPath = () => path.join(app.getPath('userData'), 'yt_accounts.json');
const legacyCredsPath = () => path.join(app.getPath('userData'), 'yt_credentials.json');
// Plaintext sidecar (NO credentials) written alongside the encrypted registry.
// DPAPI-encrypted yt_accounts.json can't be decrypted after a backup is
// restored on a different Windows machine/user, so without this the whole
// account LIST would vanish. This index survives the move: it keeps just the
// display metadata (id/name/handle/avatar) so the accounts can be shown and
// re-logged-in (addAccount() re-attaches to the surviving per-account folder).
const indexPath = () => path.join(app.getPath('userData'), 'yt_accounts_index.json');

// { selected: id|null, accounts: [{ id, name, handle, avatar, creds }] }
let registry = { selected: null, accounts: [] };
let currentAccountId = null;
let latestCredentials = null; // most recent live credentials from the active session

function genAccountId() {
  return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Returns true when the encrypted file was written. SECURITY (s83): if
// safeStorage/DPAPI is unavailable we REFUSE to persist rather than fall back
// to plaintext -- tokens then live in-memory for this session only and the
// user just signs in again next launch. (decryptFromFile keeps read-compat
// for a {v:2, plain} file written by an old build; the next successful save
// re-encrypts it.)
function encryptToFile(p, obj) {
  if (!safeStorage.isEncryptionAvailable()) {
    logger.error('safeStorage unavailable -- NOT persisting credentials (kept in-memory for this session only)');
    return false;
  }
  const blob = safeStorage.encryptString(JSON.stringify(obj)).toString('base64');
  fs.writeFileSync(p, JSON.stringify({ v: 2, dpapi: blob }));
  return true;
}

function decryptFromFile(p) {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (raw && raw.v === 2 && raw.dpapi) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable for decryption');
    return JSON.parse(safeStorage.decryptString(Buffer.from(raw.dpapi, 'base64')));
  }
  if (raw && raw.v === 2 && raw.plain) return raw.plain;
  throw new Error('unrecognized registry format');
}

// Read a legacy single-account credentials file (v1 dpapi / plaintext), or null.
function loadLegacyCreds() {
  if (!fs.existsSync(legacyCredsPath())) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(legacyCredsPath(), 'utf8'));
    if (raw && raw.v === 1 && raw.dpapi) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable');
      return JSON.parse(safeStorage.decryptString(Buffer.from(raw.dpapi, 'base64')));
    }
    return raw; // legacy plaintext
  } catch (e) {
    logger.error('Legacy credentials unreadable:', e.message);
    return null;
  }
}

// Write the plaintext sidecar (display metadata only, NEVER creds). Called
// after every saveRegistry() and once after a successful decrypt (to backfill
// the sidecar for existing users so their next cross-machine restore works).
function writeIndex(reg) {
  try {
    const idx = {
      v: 1,
      selected: reg.selected || null,
      startup: reg.startup || 'ask',
      defaultId: reg.defaultId || null,
      accounts: (reg.accounts || []).map((a) => ({
        id: a.id, name: a.name || 'Account', handle: a.handle || '', avatar: a.avatar || null
      }))
    };
    fs.writeFileSync(indexPath(), JSON.stringify(idx));
  } catch (e) {
    logger.error('Failed to write account index sidecar:', e.message);
  }
}

// Read the plaintext sidecar, or null if it is missing/unreadable.
function readIndex() {
  try {
    if (!fs.existsSync(indexPath())) return null;
    return JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
  } catch (e) {
    return null;
  }
}

// Set when loadRegistry() falls back to the plaintext sidecar because the
// encrypted registry couldn't be decrypted (backup restored on another
// machine/user): the recovered accounts have no creds and need re-login.
let registryRecovered = false;

function loadRegistry() {
  if (fs.existsSync(registryPath())) {
    try {
      const reg = decryptFromFile(registryPath());
      if (reg && Array.isArray(reg.accounts)) { writeIndex(reg); return reg; }
    } catch (e) {
      // Decrypt failed (typically a backup restored on another Windows
      // machine/user, so DPAPI can't unseal it). Recover the account LIST from
      // the plaintext sidecar instead of losing every account: boot as Guest
      // (no creds), flag the accounts so the renderer routes them to re-login.
      const idx = readIndex();
      if (idx && Array.isArray(idx.accounts) && idx.accounts.length) {
        registryRecovered = true;
        logger.error(`Account registry undecryptable; recovered ${idx.accounts.length} accounts from plaintext index (need re-login)`);
        return {
          selected: null,
          accounts: idx.accounts.map((a) => ({ id: a.id, name: a.name, handle: a.handle || '', avatar: a.avatar || null, creds: null })),
          startup: idx.startup || 'ask',
          defaultId: idx.defaultId || null
        };
      }
      logger.error('Account registry unreadable (moved machine/user?), starting fresh:', e.message);
      return { selected: null, accounts: [] };
    }
  }
  // Migrate a legacy single-account file into a one-account registry.
  const legacy = loadLegacyCreds();
  if (legacy) {
    const id = genAccountId();
    const reg = { selected: id, accounts: [{ id, name: 'Account', handle: '', avatar: null, creds: legacy }] };
    try {
      if (encryptToFile(registryPath(), reg)) {
        logger.info('Migrated legacy credentials into the account registry');
        // The legacy file is now redundant (and may even be plaintext from a
        // very old build) -- delete it so no stale credential copy lingers (s83).
        try { fs.unlinkSync(legacyCredsPath()); logger.info('Deleted legacy yt_credentials.json after migration'); }
        catch (e) { logger.error('could not delete legacy yt_credentials.json:', e.message); }
      }
    }
    catch (e) { logger.error('registry migration save failed:', e.message); }
    return reg;
  }
  return { selected: null, accounts: [] };
}

function saveRegistry() {
  try { encryptToFile(registryPath(), registry); } catch (e) { logger.error('Failed to save account registry:', e); }
  writeIndex(registry); // keep the plaintext sidecar in sync (survives cross-machine restore)
}

function accountById(id) { return registry.accounts.find((a) => a.id === id) || null; }

// Persist the active session's latest credentials into its account entry.
function saveCredsForAccount(id, credentials) {
  latestCredentials = credentials;
  const acct = accountById(id);
  if (!acct) return;
  acct.creds = credentials;
  saveRegistry();
}

// --- Deferred auth (s53): boot no longer blocks on the OAuth restore ---
// init() returns as soon as the sessions exist; the credential restore runs in
// the background. Everything that needs the signed-in session awaits
// authReady() first, so personalized feeds still wait for the restore -- but
// the UI doesn't.
let authReadyPromise = Promise.resolve();
let authRestoring = false;   // boot restore in flight -- feeds treat it as signed-in
let authMode = 'idle';       // how to interpret the next 'auth' event: 'restore'|'signin'|'switch'|'idle'
let cbAuthPending = null, cbAuthSuccess = null, cbAuthRestored = null; // renderer callbacks (set in init)

async function authReady() {
  try { await authReadyPromise; } catch (e) { /* logged in init */ }
}

// --- Renderer push channel (s53) ---
// main -> renderer streaming: background feed chunks (yt:feed-chunk) and
// snapshot refreshes (yt:feed-fresh). Wired by index.js after window creation.
let pushSender = null;
function setPushSender(fn) { pushSender = fn; }
function pushToRenderer(channel, payload) {
  if (!pushSender) return;
  try { pushSender(channel, payload); } catch (e) { logger.error('push to renderer failed:', e.message); }
}

// --- Feed snapshots (s53) ---
// The last Home/History feed is persisted to disk so a cold boot paints
// instantly from the snapshot; the real feed loads in the background and
// replaces it via yt:feed-fresh. Deleted on sign-out (personalized data).
// Snapshots are PER-ACCOUNT (multi-account): the filename carries the selected
// account id so switching accounts never shows the wrong Home/History from
// disk. 'anon' when signed out.
const snapshotPath = (name, id) => path.join(activeaccount.dir(id || currentAccountId || GUEST_ID), `snapshot_${name}.json`);
function readSnapshot(name) {
  try { return JSON.parse(fs.readFileSync(snapshotPath(name), 'utf8')); } catch (e) { return null; }
}
function saveSnapshot(name, data) {
  try { fs.writeFileSync(snapshotPath(name), JSON.stringify(data)); } catch (e) { logger.error('snapshot save failed:', e.message); }
}
function deleteSnapshots(id) {
  for (const n of ['home', 'history']) { try { fs.unlinkSync(snapshotPath(n, id || currentAccountId || 'anon')); } catch (e) {} }
}
// User setting (per account, ui_settings.feedSnapshots, default ON): whether to
// paint the last session's disk snapshot instantly on a cold boot. When OFF the
// feeds skip the snapshot and load fresh, so there is no snapshot->fresh swap
// (the startup "flash"). Snapshots are still SAVED so turning it back on is
// instant. Read live at serve time (the active account is known by then).
function useFeedSnapshots() {
  try {
    const s = JSON.parse(fs.readFileSync(activeaccount.file('ui_settings.json'), 'utf8'));
    return s.feedSnapshots !== false;
  } catch (e) { return true; }
}

// Fetch the current YouTube player id ourselves -- the same /iframe_api check
// Innertube.create performs internally -- so it can OVERLAP the (slow) ESM
// import instead of running serially inside session creation. Fetched fresh
// every boot (no staleness); on failure returns null and youtubei.js falls
// back to its own check. The id sits in the script as 'player\/<id>\/' with
// JSON-escaped slashes.
async function fetchPlayerId() {
  try {
    const res = await fetch('https://www.youtube.com/iframe_api');
    if (!res.ok) return null;
    const js = await res.text();
    const m = /player\\\/([0-9a-zA-Z_-]+?)\\\//.exec(js);
    return (m && m[1]) || null;
  } catch (e) {
    return null;
  }
}

// youtubei.js player-script evaluator (see header). data.output is a
// function body with a top-level `return`, so wrap it in an IIFE. env holds
// { sig?, sp?, n? } string values the snippet may reference by name.
function installEvaluator() {
  ytMod.Platform.shim.eval = (data, env) => {
    const source = `(() => { ${data.output ?? String(data)} })()`;
    return vm.runInNewContext(source, Object.assign({ console }, env), { timeout: 10000 });
  };
}

// youtubei.js prints a big multi-line "<Class> not found! This is a bug..." dump
// (plus a JIT-generated class) to the console for EVERY unknown feed node it
// meets -- and the TV grid alone throws dozens per feed (Tile, TileHeader,
// Line, LineItem, GridButton...), which is precisely why we raw-parse feeds
// ourselves. Those nodes are expected and not ones we render, so we SWALLOW the
// handler entirely: logging even a terse line per node floods the log AND, since
// logger.info writes synchronously on the main (input-routing) thread, the
// volume caused visible input jank while feeds parsed. Set CATHODE_DEBUG_DUMPS=1
// to see them again while debugging a parser issue.
function installParserErrorHandler() {
  try {
    if (ytMod.Parser && typeof ytMod.Parser.setParserErrorHandler === 'function') {
      ytMod.Parser.setParserErrorHandler((ctx) => {
        if (!DEBUG_DUMPS) return; // swallow the flood on normal runs
        const what = (ctx && (ctx.classname || ctx.error_type)) || 'node';
        logger.debug('youtubei parser skipped unknown node:', what);
      });
    }
  } catch (e) { /* non-fatal: keep youtubei's default handler */ }
}

// --- Feed cache: per-section TTL + in-flight dedupe ---

const FEED_TTL_MS = 5 * 60 * 1000; // default / fallback for unmapped keys
const feedCache = new Map(); // key → { ts, data, promise }

// Cache keys that map to a user-configurable per-section TTL (minutes) stored in
// the active account's ui_settings (see settings.js "Cache" category). Anything
// not listed (search, misc sections) uses FEED_TTL_MS.
const FEED_TTL_SETTING = {
  'home:auth': 'ttlHome', 'home:anon': 'ttlHome',
  'subs': 'ttlSubs', 'sect:history': 'ttlHistory',
  'music': 'ttlMusic', 'playlists': 'ttlPlaylists'
};
function ttlMsForKey(key) {
  const settingKey = FEED_TTL_SETTING[key];
  if (!settingKey) return FEED_TTL_MS;
  try {
    const s = JSON.parse(fs.readFileSync(activeaccount.file('ui_settings.json'), 'utf8'));
    const v = s[settingKey];
    if (typeof v === 'number' && v > 0) return v * 60 * 1000;
  } catch (e) { /* fall through to default */ }
  return FEED_TTL_MS;
}

function clearFeedCache() {
  feedCache.clear();
}

function cachedFeed(key, loader) {
  const entry = feedCache.get(key);
  if (entry && entry.data && Date.now() - entry.ts < ttlMsForKey(key)) {
    return Promise.resolve(entry.data);
  }
  if (entry && entry.promise) return entry.promise; // dedupe concurrent loads
  const promise = loader()
    .then((data) => {
      feedCache.set(key, { ts: Date.now(), data });
      return data;
    })
    .catch((e) => {
      feedCache.delete(key);
      throw e;
    });
  feedCache.set(key, { ...(entry || {}), promise });
  return promise;
}

async function init(onAuthPending, onAuthSuccess, onAuthRestored) {
  // Kick the /iframe_api player-version check FIRST so it overlaps the slow
  // ESM import below (it used to run serially inside Innertube.create).
  const playerIdPromise = fetchPlayerId();

  // youtubei.js is ESM; import dynamically from CJS.
  ytMod = await import('youtubei.js');
  const { Innertube, UniversalCache, ClientType } = ytMod;

  installEvaluator();
  installParserErrorHandler();

  registry = loadRegistry();
  // Self-heal a CROSS-MACHINE restore. safeStorage on Windows is Chromium
  // OSCrypt: the AES master key lives DPAPI-wrapped in 'Local State'. A backup
  // carries that file, but on another Windows user/machine DPAPI can't unwrap
  // it, so OSCrypt has no usable key (isEncryptionAvailable() === false) and the
  // registry decrypt fell back to the plaintext sidecar (registryRecovered).
  // Chromium will NOT replace a present-but-undecryptable key on its own, so
  // without intervention new logins here could never persist. Delete the
  // poisoning 'Local State' so a fresh, valid key is generated next launch; the
  // re-login then persists. (Same-machine restores decrypt fine and never reach
  // this branch, so their key is left untouched.)
  if (registryRecovered && !safeStorage.isEncryptionAvailable()) {
    try {
      const ls = path.join(app.getPath('userData'), 'Local State');
      if (fs.existsSync(ls)) {
        fs.unlinkSync(ls);
        logger.error('Restored Local State key is unusable on this machine (cross-machine restore); removed it so a fresh safeStorage key is generated next launch -- re-login will then persist.');
      }
    } catch (e) { logger.error('could not remove unusable Local State:', e.message); }
  }
  if (typeof registry.startup !== 'string') registry.startup = 'ask'; // ask | last | default
  if (!('defaultId' in registry)) registry.defaultId = null;         // account id or 'guest' for skip-picker
  currentAccountId = registry.selected || GUEST_ID;
  activeaccount.set(currentAccountId);
  // Recovered from the plaintext sidecar (encrypted registry undecryptable):
  // the accounts have no creds, so boot as Guest and skip the restore block
  // (it guards on selected.creds, and registry.selected is null here anyway).
  if (registryRecovered) {
    currentAccountId = GUEST_ID;
    activeaccount.set(GUEST_ID);
  }

  sharedCache = new UniversalCache(true, path.join(app.getPath('userData'), 'yt_cache'));

  const playerId = await playerIdPromise;
  if (playerId) logger.debug('Player id prefetched:', playerId);

  // Create BOTH sessions in PARALLEL (s53; was serial). tubeAnon gets the
  // prefetched player id (skips its own /iframe_api round trip). tubeAuth
  // skips the player ENTIRELY (retrieve_player: false): it never deciphers
  // stream URLs -- feeds/raw browse, getBasicInfo (live manifest URLs +
  // history-tracking pings; neither is ciphered) and account writes only --
  // so the player fetch+parse was pure boot cost.
  const locale = localePrefs(); // { lang?, location? } content language + country
  const nf = networkFetch(); // custom (Chromium) fetch when a proxy / DoH is set, else null
  const fetchOpt = nf ? { fetch: nf } : {};
  if (nf) logger.info('[network] routing InnerTube feeds through the proxy / custom DNS');
  const [anon, auth] = await Promise.all([
    Innertube.create({ cache: sharedCache, generate_session_locally: true, ...locale, ...fetchOpt, ...(playerId ? { player_id: playerId } : {}) }),
    Innertube.create({
      cache: sharedCache,
      generate_session_locally: true,
      retrieve_player: false,
      ...locale,
      ...fetchOpt,
      client_type: ClientType.TV // OAuth tokens are only valid for the TV client
    })
  ]);
  tubeAnon = anon;
  tubeAuth = auth;

  // tubeAuth is created retrieve_player:false (boot speed) so it has NO player of
  // its own -- but a TV /player request without a signatureTimestamp comes back
  // UNPLAYABLE: no streaming formats (the persistent "TV: 0 formats" that forces
  // SABR->IOS->seek-403) AND no playbackTracking (so watch history never
  // records). Lend it tubeAnon's already-loaded player (identical script, same
  // YouTube; no second fetch) so TV requests carry a signatureTimestamp and the
  // TV client can be playable again. No-op if tubeAnon's player didn't load.
  if (tubeAnon.session.player && !tubeAuth.session.player) {
    try { tubeAuth.session.player = tubeAnon.session.player; logger.info('Shared the WEB player with the TV session (signatureTimestamp for TV /player)'); }
    catch (e) { logger.error('Could not share player with TV session:', e.message); }
  }

  cbAuthPending = onAuthPending; cbAuthSuccess = onAuthSuccess; cbAuthRestored = onAuthRestored;

  // --- Auth events (TV device-code flow), on the TV session only ---
  tubeAuth.session.on('auth-pending', (data) => cbAuthPending && cbAuthPending(data));

  // youtubei.js fires 'auth' on EVERY credential apply (OAuth2.init emits after
  // setTokens, refresh or not). authMode says how to treat this one:
  //   'restore' -- boot restore of the selected account (label only)
  //   'switch'  -- user picked another account (persist + drop caches)
  //   'signin'  -- a NEW account via device flow; addAccount() enrolls it, so
  //                here we only stash the credentials
  tubeAuth.session.on('auth', ({ credentials }) => {
    latestCredentials = credentials;
    if (authMode === 'signin') return; // addAccount() persists + notifies
    saveCredsForAccount(currentAccountId, credentials);
    if (authMode === 'switch') {
      clearFeedCache();
      logger.info('Account switched');
    } else {
      logger.info('Session restored (stored credentials)');
      // Only hit the network for the display name if we don't have one yet
      // (keeps the s53 fast-boot -- no extra call once the name is cached).
      const acct = accountById(currentAccountId);
      if (!acct || !acct.name || acct.name === 'Account') refreshAccountMeta().catch(() => {});
    }
    cbAuthRestored && cbAuthRestored();
  });

  tubeAuth.session.on('update-credentials', ({ credentials }) => {
    saveCredsForAccount(currentAccountId, credentials);
    logger.info('Credentials refreshed');
  });

  // Restore the SELECTED account WITHOUT blocking boot (s53). The renderer gets
  // its init reply now; authed loaders await authReady() internally. Within
  // ~1h of the last run the restore is instant (no token refresh needed).
  const selected = accountById(registry.selected);
  if (selected && selected.creds) {
    authMode = 'restore';
    authRestoring = true;
    authReadyPromise = tubeAuth.session.signIn(selected.creds)
      .catch((e) => logger.error('Stored credentials rejected, sign in again:', e))
      .finally(() => { authMode = 'idle'; authRestoring = false; });
  }

  return { signedIn: isSignedIn(), restoring: !!selected, accountName: selected ? selected.name : null, accountCount: registry.accounts.length, startup: registry.startup || 'ask', defaultId: registry.defaultId || null, recovered: registryRecovered };
}

function isSignedIn() {
  // Guest mode keeps the OAuth session's tokens live (so switching back needs no
  // re-login) but reports NOT signed in. Every auth gate -- feeds AND account
  // writes -- routes through here, so this single check makes Guest fully
  // anonymous without revoking anything.
  return currentAccountId !== GUEST_ID && !!(tubeAuth && tubeAuth.session.logged_in);
}

// --- Accounts (multi-account) ---
// Read the ACTIVE session's display name / handle / avatar from the TV accounts
// endpoint (best-effort; a single Google login = one account here).
async function fetchAccountMeta() {
  const info = await tubeAuth.account.getInfo();
  const items = (info && info.contents && info.contents.contents) || [];
  const acct = items.find((a) => a.is_selected) || items[0];
  if (!acct) return null;
  return {
    name: textOf(acct.account_name) || 'Account',
    handle: textOf(acct.channel_handle) || '',
    avatar: Array.isArray(acct.account_photo) ? bestOf(acct.account_photo) : null
  };
}

// Refresh the CURRENT account's stored name/handle/avatar from the network.
async function refreshAccountMeta() {
  if (!currentAccountId || !isSignedIn()) return;
  try {
    const meta = await fetchAccountMeta();
    const acct = accountById(currentAccountId);
    if (meta && acct) {
      acct.name = meta.name || acct.name;
      acct.handle = meta.handle || acct.handle;
      acct.avatar = meta.avatar || acct.avatar;
      saveRegistry();
    }
  } catch (e) {
    logger.error('account meta refresh failed:', e.message);
  }
}

function listAccounts() {
  const activeId = currentAccountId || GUEST_ID;
  // Guest is a first-class, always-present entry (the logged-out user).
  const guest = { id: GUEST_ID, name: 'Guest', handle: '', avatar: null, guest: true, selected: activeId === GUEST_ID };
  return {
    selectedId: activeId,
    startup: registry.startup || 'ask',
    defaultId: registry.defaultId || null,
    accounts: [
      guest,
      ...registry.accounts.map((a) => ({
        id: a.id, name: a.name || 'Account', handle: a.handle || '', avatar: a.avatar || null,
        selected: a.id === activeId,
        needsRelogin: !a.creds // recovered-from-sidecar accounts have no creds -> route to sign-in
      }))
    ]
  };
}

// Startup preference: 'ask' (Who's watching picker every launch), 'last'
// (resume the last-used account), or 'default' (always a specific account,
// registry.defaultId). Read at boot by the renderer.
function setStartup(mode) {
  if (['ask', 'last', 'default'].includes(mode)) { registry.startup = mode; saveRegistry(); }
  return { startup: registry.startup, defaultId: registry.defaultId || null };
}
function setDefaultAccount(id) {
  // Choosing a specific default implies 'default' startup. id is an account id
  // or 'guest'; null clears the default (leaves startup as-is).
  registry.defaultId = id || null;
  if (id) registry.startup = 'default';
  saveRegistry();
  return { startup: registry.startup, defaultId: registry.defaultId };
}
function getStartupInfo() {
  return { startup: registry.startup || 'ask', defaultId: registry.defaultId || null, selectedId: currentAccountId || GUEST_ID };
}

// Add a NEW account via the TV device-code flow. cbAuthPending drives the
// renderer's code overlay; resolves once the user completes sign-in.
async function addAccount() {
  authMode = 'signin';
  try {
    await tubeAuth.session.signIn(); // resolves on the 'auth' event
  } finally {
    authMode = 'idle';
  }
  const creds = latestCredentials;
  let meta = null;
  try { meta = await fetchAccountMeta(); } catch (e) { logger.error('new-account meta failed:', e.message); }
  // De-dupe: signing into an already-enrolled Google account UPDATES it rather
  // than adding a duplicate row.
  let acct = null;
  if (meta && meta.handle) acct = registry.accounts.find((a) => a.handle && a.handle === meta.handle);
  if (!acct && meta && meta.name && meta.name !== 'Account') acct = registry.accounts.find((a) => a.name === meta.name);
  if (!acct) { acct = { id: genAccountId() }; registry.accounts.push(acct); }
  acct.name = (meta && meta.name) || acct.name || 'Account';
  acct.handle = (meta && meta.handle) || acct.handle || '';
  acct.avatar = (meta && meta.avatar) || acct.avatar || null;
  acct.creds = creds;
  registry.selected = acct.id;
  currentAccountId = acct.id;
  activeaccount.set(acct.id);
  saveRegistry();
  clearFeedCache();
  logger.info('Account added/selected:', acct.name);
  return { id: acct.id, name: acct.name };
}

// Switch the active session to a stored account.
async function selectAccount(id) {
  if (id === GUEST_ID) return selectGuest();
  const acct = accountById(id);
  if (!acct) throw new Error('Account not found');
  // Recovered account with no creds (registry couldn't be decrypted): don't
  // throw -- tell the renderer to route it through the sign-in flow. addAccount()
  // de-dupes by handle/name and re-attaches to this account's surviving folder.
  if (!acct.creds) return { id, name: acct.name, needsRelogin: true };
  if (id === currentAccountId && isSignedIn()) return { id, name: acct.name };
  authMode = 'switch';
  currentAccountId = id;          // set first so the 'auth' handler persists to the right entry
  activeaccount.set(id);
  registry.selected = id;
  saveRegistry();
  authReadyPromise = tubeAuth.session.signIn(acct.creds)
    .catch((e) => logger.error('account switch sign-in failed:', e.message))
    .finally(() => { authMode = 'idle'; });
  await authReadyPromise;
  clearFeedCache();
  refreshAccountMeta().catch(() => {});
  logger.info('Switched to account:', acct.name);
  return { id, name: acct.name };
}

// Switch to Guest (logged-out / anonymous). Keeps any real account's tokens on
// the session (isSignedIn() returns false purely because the active id is
// GUEST_ID), so switching back later needs no re-login. registry.selected is
// cleared so a 'last used' startup resumes Guest.
async function selectGuest() {
  if (currentAccountId === GUEST_ID) { activeaccount.set(GUEST_ID); return { id: GUEST_ID, name: 'Guest' }; }
  currentAccountId = GUEST_ID;
  activeaccount.set(GUEST_ID);
  registry.selected = null;
  saveRegistry();
  clearFeedCache();
  logger.info('Switched to Guest (anonymous)');
  return { id: GUEST_ID, name: 'Guest' };
}

// Forget a stored account. If it was selected, switch to another (or go signed
// out). The removed account's tokens are dropped locally + its snapshots.
async function removeAccount(id) {
  const idx = registry.accounts.findIndex((a) => a.id === id);
  if (idx === -1) return { removed: false, signedIn: isSignedIn() };
  const wasSelected = registry.selected === id;
  registry.accounts.splice(idx, 1);
  deleteSnapshots(id);
  if (registry.defaultId === id) { registry.defaultId = null; if (registry.startup === 'default') registry.startup = 'ask'; }
  saveRegistry();
  if (!wasSelected) return { removed: true, signedIn: isSignedIn(), selectedId: registry.selected };

  const next = registry.accounts[0];
  if (next) {
    const r = await selectAccount(next.id);
    return { removed: true, signedIn: true, selectedId: next.id, name: r.name };
  }
  // No accounts left: sign the session out (revoke best-effort) and fall
  // through to Guest.
  registry.selected = null;
  currentAccountId = GUEST_ID;
  activeaccount.set(GUEST_ID);
  saveRegistry();
  try { if (tubeAuth && tubeAuth.session.logged_in) await tubeAuth.session.signOut(); } catch (e) { logger.error('signOut on last-account removal failed:', e.message); }
  clearFeedCache();
  logger.info('Last account removed; now Guest');
  return { removed: true, signedIn: false, selectedId: GUEST_ID };
}

// --- Back-compat shims (the rail + old IPC still call these) ---
async function signIn() { return addAccount(); }

async function signOut() {
  // "Sign out" = remove + revoke the CURRENT account (falls through to the next
  // account if there is one).
  if (currentAccountId) return removeAccountRevoking(currentAccountId);
  clearFeedCache();
  return true;
}

// removeAccount variant that also REVOKES the (active) account's tokens.
async function removeAccountRevoking(id) {
  if (id === currentAccountId) {
    try { if (isSignedIn()) await tubeAuth.session.signOut(); } catch (e) { logger.error('signOut revoke failed:', e.message); }
  }
  const r = await removeAccount(id);
  return r;
}

// --- Shelf/feed serialization: reduce youtubei.js objects to plain JSON the UI can render ---

function textOf(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  return x.text ?? '';
}

function normThumbUrl(u) {
  if (!u) return null;
  return u.startsWith('//') ? 'https:' + u : u;
}

// Pick the LARGEST thumbnail in a list (youtubei.js sorts largest-first,
// but don't rely on it) - small ones look broken on a TV-sized grid.
function bestOf(list) {
  const t = list.reduce((a, b) => (((b && b.width) || 0) > ((a && a.width) || 0) ? b : a), list[0]);
  return t && t.url ? normThumbUrl(t.url) : null;
}

// Shape-agnostic fallback: depth-limited scan for the first array of
// { url, width } objects anywhere inside the node. Covers TV renderer
// shapes we haven't enumerated yet.
function deepThumb(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val) && val.length && val[0] && typeof val[0].url === 'string' && 'width' in val[0]) {
      const url = bestOf(val);
      if (url) return url;
    }
  }
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const r = deepThumb(val, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function thumbOf(v) {
  const lists = [
    v.thumbnails,
    v.best_thumbnail && [v.best_thumbnail],
    Array.isArray(v.thumbnail) ? v.thumbnail : null,
    v.thumbnail?.thumbnails,
    v.header?.thumbnail,
    v.content_image?.image,                    // LockupView → ThumbnailView
    v.content_image?.primary_thumbnail?.image  // LockupView → CollectionThumbnailView
  ];
  for (const list of lists) {
    if (Array.isArray(list) && list.length) {
      const url = bestOf(list);
      if (url) return url;
    }
  }
  return deepThumb(v);
}

// LockupView metadata -> ordered text parts (channel, then "views . date").
// Confirmed shape (youtubei.js 17.x, verified against the installed dist):
// LockupView.metadata is a LockupMetadataView whose .metadata is a
// ContentMetadataView with .metadata_rows[].metadata_parts[].text (a Text
// node). serializeVideo's WEB-renderer field reads miss these entirely, so
// lockup cards rendered with no channel/views/date line.
function lockupMetaParts(lockupMeta) {
  const out = [];
  const rows = lockupMeta?.metadata?.metadata_rows || lockupMeta?.metadata?.metadataRows;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      for (const part of (row?.metadata_parts || row?.metadataParts || [])) {
        const t = textOf(part?.text);
        if (t) out.push(t);
      }
    }
  }
  return out;
}

// Diagnostics: keep the last raw node that serialized WITHOUT a thumbnail so
// extractFeedVideos can dump it (tells us which renderer shape we're missing).
let lastNoThumbNode = null;
let lastNoMetaNode = null; // last node that serialized WITHOUT a channel/meta line

function serializeVideo(v) {
  if (!v) return null;
  // Field names differ between WEB and TV client renderers - try both.
  // Accept ONLY 11-char video IDs: LockupView.content_id is a PLAYLIST id
  // for mix/playlist cards (e.g. 'RD...' - 13+ chars), which getInfo can't
  // play ('This video is unavailable'). For those, the on_tap endpoint's
  // videoId (first video of the mix) is used instead; if there is none,
  // the card is skipped (playlist/mix support is Milestone 2).
  const candidates = [
    v.id, v.video_id,
    v.renderer_context?.command_context?.on_tap?.payload?.videoId,
    v.endpoint?.payload?.videoId,
    v.content_id
  ];
  const id = candidates.find((c) => typeof c === 'string' && /^[A-Za-z0-9_-]{11}$/.test(c)) || null;
  const title = textOf(v.title) || textOf(v.metadata?.title) || textOf(v.header?.title);
  if (!id || !title) return null;
  const thumbnail = thumbOf(v);
  if (!thumbnail) lastNoThumbNode = v;
  const durText = textOf(v.duration) || textOf(v.length_text);
  const isLive = !!(v.is_live || v.is_live_content ||
    (Array.isArray(v.badges) && v.badges.some((b) => /live/i.test(textOf(b?.label) || b?.style || ''))) ||
    /^live$/i.test(durText));

  let author = v.author?.name ?? '';
  let views = textOf(v.view_count) || textOf(v.short_view_count);
  let published = textOf(v.published);
  let channelId = v.author?.id ?? null;

  // LockupView (TV ViewModel) cards leave the fields above empty because they
  // keep author/views/date under metadata.metadata.metadata_rows instead.
  // Pull those parts and classify them the way rawTileToVideo classifies a
  // tile's metadata lines (SEP/VIEWS/DATE regexes are defined below; they are
  // only referenced at call time, so ordering is fine).
  if (!author || !views || !published) {
    for (const txt of lockupMetaParts(v.metadata)) {
      if (SEP_RE.test(txt)) continue;
      if (!views && VIEWS_RE.test(txt)) { views = txt; continue; }
      if (!published && DATE_RE.test(txt)) { published = txt; continue; }
      if (!author) author = txt;
    }
  }
  if (!channelId) channelId = findChannelId(v);
  if (!author) lastNoMetaNode = v; // diagnostic: capture a shape we still can't read

  return {
    id,
    title,
    author,
    duration: isLive ? '' : durText,
    published,
    views,
    isLive,
    channelId,
    feedbackToken: findFeedbackToken(v), // history removal token (parsed-node path; raw tiles get theirs in rawTileToVideo)
    thumbnail
  };
}

const KNOWN_VIDEO_TYPES = new Set(['Video', 'CompactVideo', 'GridVideo', 'ReelItem', 'Tile', 'VideoCard', 'LockupView']);

// feed.videos is often an EMPTY ARRAY for TV-client responses (it filters
// for WEB renderer types), and [] short-circuits `??` - so prefer the first
// NON-EMPTY collection instead.
function itemsOf(feed) {
  if (Array.isArray(feed?.videos) && feed.videos.length) return feed.videos;
  if (Array.isArray(feed?.contents) && feed.contents.length) return feed.contents;
  if (Array.isArray(feed?.results) && feed.results.length) return feed.results;
  return [];
}

// Memo of parsed nodes: Feed instances expose `.memo`, raw parsed responses
// (from Parser.parseResponse / parse:true calls) expose `.contents_memo`.
function memoOf(feed) {
  return feed?.memo ?? feed?.contents_memo ?? null;
}

// Extract videos straight from the parsed-node memo. The memo is a Map keyed
// by renderer class-name (e.g. 'Video', 'LockupView', 'Tile'); values are
// arrays of node instances. Iterating it is renderer-shape-agnostic, so it
// catches TV-client renderers the tree walk and feed.videos miss.
function collectFromMemo(feed, out = []) {
  const memo = memoOf(feed);
  if (!memo || typeof memo.forEach !== 'function') return out;
  const seen = new Set(out.map((v) => v.id));
  memo.forEach((nodes) => {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      const s = serializeVideo(n);
      if (s && !seen.has(s.id)) {
        seen.add(s.id);
        out.push(s);
      }
    }
  });
  return out;
}

// JSON.stringify that survives circular refs (Feed objects hold session refs).
function safeDump(obj, maxBytes = 2 * 1024 * 1024) {
  const seen = new WeakSet();
  let out = JSON.stringify(obj, (k, v) => {
    if (typeof v === 'function') return undefined;
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
    }
    return v;
  }, 2);
  if (out && out.length > maxBytes) out = out.slice(0, maxBytes) + '\n/* truncated */';
  return out ?? 'null';
}

// Structure dump for parser work: node-type inventory + one sample per type,
// read straight from the memo Map (keyed by renderer class-name).
function dumpFeedStructure(feed, dumpPath) {
  try {
    const memo = memoOf(feed);
    const payload = { top_keys: Object.keys(feed ?? {}), memo_types: [], samples: {} };
    if (memo && typeof memo.forEach === 'function') {
      memo.forEach((nodes, type) => {
        payload.memo_types.push(`${type} x${Array.isArray(nodes) ? nodes.length : 0}`);
        if (Array.isArray(nodes) && nodes[0] && !payload.samples[type]) payload.samples[type] = nodes[0];
      });
    } else {
      payload.raw = feed?.page ?? feed;
    }
    fs.writeFileSync(dumpPath, safeDump(payload));
    logger.error('Feed structure dump written to:', dumpPath);
  } catch (e) {
    logger.error('Feed dump failed:', e);
  }
}

function collectVideos(items, out = [], depth = 0) {
  if (!items || depth > 8) return out;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const known = KNOWN_VIDEO_TYPES.has(item?.type);
    const s = known ? serializeVideo(item) : null;
    if (s) {
      out.push(s);
      continue;
    }
    if (!known && (item.content_id || item.video_id)) {
      // Unknown-but-video-shaped node (TV renderers the WEB parser list
      // doesn't cover) - best-effort extraction.
      const g = serializeVideo(item);
      if (g) { out.push(g); continue; }
    }
    // Recurse into any container-shaped child collections.
    for (const key of ['contents', 'items', 'videos', 'content', 'grid', 'rows', 'shelf', 'target']) {
      const child = item[key];
      if (Array.isArray(child)) collectVideos(child, out, depth + 1);
      else if (child && typeof child === 'object') collectVideos([child], out, depth + 1);
    }
  }
  return out;
}

function extractFeedVideos(feed) {
  lastNoThumbNode = null;
  lastNoMetaNode = null;
  let videos = collectVideos(itemsOf(feed));
  // feed.contents on the TV HomeFeed is a RichGrid node (not an array) -
  // walk it explicitly.
  if (!videos.length && feed?.contents) videos = collectVideos([feed.contents]);
  // feed.videos getter (memo-based, all known video renderers).
  if (!videos.length && Array.isArray(feed?.videos)) videos = collectVideos(feed.videos);
  // Last resort: every parsed node in the memo.
  if (!videos.length) videos = collectFromMemo(feed);

  // Thumbnail diagnostics - a raw sample of the offending renderer shape
  // goes to Data/debug_nothumb.json for parser work.
  const missing = videos.filter((v) => !v.thumbnail).length;
  if (missing) {
    logger.error(`Feed: ${missing}/${videos.length} items have no thumbnail (renderer shape gap)`);
    if (lastNoThumbNode) debugDump('debug_nothumb.json', lastNoThumbNode);
  }
  return videos;
}

// --- Raw-JSON extraction for TV grid renderers youtubei.js can't parse ---

function rawTextOf(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (t.simpleText) return t.simpleText;
  if (Array.isArray(t.runs)) return t.runs.map((r) => r.text || '').join('');
  if (typeof t.content === 'string') return t.content; // ViewModel-style text
  return '';
}

// Find a channel id (UC + 22 chars) anywhere in a node - used to surface the
// author's channel from a tile's 'Go to channel' menu endpoint.
function findChannelId(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null;
  const bid = node.browseEndpoint && node.browseEndpoint.browseId;
  if (typeof bid === 'string' && /^UC[A-Za-z0-9_-]{22}$/.test(bid)) return bid;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object') { const r = findChannelId(v, depth + 1); if (r) return r; }
  }
  return null;
}

// Find a watch-history removal token anywhere in a node (history tiles carry a
// feedbackEndpoint.feedbackToken in their menu/long-press command). Used to
// power 'Remove from history'. Walks BOTH raw JSON and parsed youtubei.js
// nodes (a parsed NavigationEndpoint keeps the raw endpoint under .payload, so
// payload.feedbackToken is caught by the string check); 'session'/'actions'/
// 'client' subtrees are skipped so a parsed node can't drag the walk into the
// whole session graph.
function findFeedbackToken(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 24) return null;
  if (node.feedbackEndpoint && typeof node.feedbackEndpoint.feedbackToken === 'string') return node.feedbackEndpoint.feedbackToken;
  if (typeof node.feedbackToken === 'string') return node.feedbackToken;
  if (typeof node.feedback_token === 'string') return node.feedback_token;
  if (Array.isArray(node.feedbackTokens) && typeof node.feedbackTokens[0] === 'string') return node.feedbackTokens[0];
  for (const k of Object.keys(node)) {
    if (k === 'session' || k === 'actions' || k === 'client') continue;
    const v = node[k];
    if (v && typeof v === 'object') { const r = findFeedbackToken(v, depth + 1); if (r) return r; }
  }
  return null;
}
const VIEWS_RE = /\bviews?\b|watching|viewers/i;
const DATE_RE = /\bago\b|^Streamed|^Premiered|^Scheduled|yesterday|just now/i;
const SEP_RE = /^[\u2022\u00b7|\-\u2013\u2014\s]+$/; // bullet / dot / dash separators only

// tileRenderer → plain video JSON (shape documented in Data/debug_subs_raw.json).
function rawTileToVideo(tile) {
  const reelId = tile.onSelectCommand?.reelWatchEndpoint?.videoId;
  const candidates = [tile.onSelectCommand?.watchEndpoint?.videoId, tile.contentId, reelId];
  const id = candidates.find((c) => typeof c === 'string' && /^[A-Za-z0-9_-]{11}$/.test(c)) || null;
  if (!id) return null;
  // Shorts tiles open a reelWatchEndpoint (vertical Shorts player) rather than a
  // normal watchEndpoint, and/or carry a SHORTS content type. Flag them so the
  // renderer can hide Shorts when the user opts to (Settings > Interface).
  const isShort = !!tile.onSelectCommand?.reelWatchEndpoint || /shorts?/i.test(String(tile.contentType || ''));
  const meta = tile.metadata?.tileMetadataRenderer || {};
  const title = rawTextOf(meta.title);
  if (!title) return null;

  // Duration / live badge from the thumbnail time-status overlay
  // (style 'DEFAULT' = duration text, style 'LIVE' = live stream).
  const header = tile.header?.tileHeaderRenderer || {};
  const thumbs = header.thumbnail?.thumbnails || [];
  let duration = '';
  let isLive = false;
  for (const o of header.thumbnailOverlays || []) {
    const ts = o.thumbnailOverlayTimeStatusRenderer;
    if (!ts) continue;
    const style = (ts.style || '').toUpperCase();
    const txt = rawTextOf(ts.text);
    if (style === 'LIVE' || /^live$/i.test(txt)) { isLive = true; duration = ''; break; }
    if (txt) duration = txt;
  }
  // Watched progress: YouTube decorates already-watched tiles (History, and
  // some Home/Subs rows for the signed-in account) with a resume-playback
  // overlay carrying percentDurationWatched (0-100). Surface it so the card can
  // draw a progress bar + "watched" mark. Absent on unwatched tiles.
  let percentWatched = 0;
  for (const o of header.thumbnailOverlays || []) {
    const r = o.thumbnailOverlayResumePlaybackRenderer;
    const p = r && r.percentDurationWatched;
    if (typeof p === 'number' && p > 0) { percentWatched = Math.min(100, Math.max(0, p)); break; }
  }

  // Metadata lines: line 0 is the channel/author; the next line carries
  // "<views> • <relative date>" (with an optional leading quality badge and
  // '•' separators). Classify by content, not fixed positions.
  let author = '';
  let views = '';
  let published = '';
  (meta.lines || []).forEach((l, li) => {
    for (const it of l.lineRenderer?.items || []) {
      const txt = rawTextOf(it.lineItemRenderer?.text);
      if (!txt || SEP_RE.test(txt)) continue;
      if (li === 0 && !author) { author = txt; continue; }
      if (!views && VIEWS_RE.test(txt)) { views = txt; continue; }
      if (!published && DATE_RE.test(txt)) { published = txt; continue; }
      if (!author) author = txt; // fallback if line 0 had no text
    }
  });

  if (!author) lastNoMetaNode = tile; // diagnostic: raw-tile card with no channel/meta
  return {
    id,
    title,
    author,
    duration,
    published,
    views,
    isLive,
    isShort,
    percentWatched: isLive ? 0 : percentWatched,
    channelId: findChannelId(tile),
    feedbackToken: findFeedbackToken(tile),
    thumbnail: thumbs.length ? bestOf(thumbs) : null
  };
}

// Walk arbitrary raw response JSON collecting every tileRenderer.
function collectRawTiles(node, out = [], seen = new Set(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 24) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectRawTiles(n, out, seen, depth + 1);
    return out;
  }
  if (node.tileRenderer) {
    const v = rawTileToVideo(node.tileRenderer);
    if (v && !seen.has(v.id)) { seen.add(v.id); out.push(v); }
  }
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (val && typeof val === 'object') collectRawTiles(val, out, seen, depth + 1);
  }
  return out;
}

function mergeVideos(a, b) {
  const seen = new Set(a.map((v) => v.id));
  for (const v of b) {
    if (!seen.has(v.id)) { seen.add(v.id); a.push(v); }
  }
  return a;
}

// tileRenderer -> playlist card. Playlist tiles carry a non-11-char content id
// (PL.../LL/WL) or a VL... browse target, often with contentType PLAYLIST.
function rawTileToPlaylist(tile) {
  const bid = tile.onSelectCommand?.browseEndpoint?.browseId;
  const id = tile.contentId
    || tile.onSelectCommand?.watchEndpoint?.playlistId
    || (typeof bid === 'string' && bid.startsWith('VL') ? bid.slice(2) : null);
  const ct = tile.contentType || '';
  const looksPlaylist = /PLAYLIST/i.test(ct) || (typeof id === 'string' && id && !/^[A-Za-z0-9_-]{11}$/.test(id));
  if (!id || !looksPlaylist) return null;
  const title = rawTextOf(tile.metadata?.tileMetadataRenderer?.title);
  if (!title) return null;
  const header = tile.header?.tileHeaderRenderer || {};
  const thumbs = header.thumbnail?.thumbnails || [];
  let count = '';
  for (const o of header.thumbnailOverlays || []) {
    const t = o.thumbnailOverlayBottomPanelRenderer?.text || o.thumbnailOverlayTimeStatusRenderer?.text;
    if (t) { count = rawTextOf(t); break; }
  }
  return { id, title, count, thumbnail: thumbs.length ? bestOf(thumbs) : null };
}

function collectRawPlaylists(node, out = [], seen = new Set(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 24) return out;
  if (Array.isArray(node)) { for (const n of node) collectRawPlaylists(n, out, seen, depth + 1); return out; }
  if (node.tileRenderer) {
    const p = rawTileToPlaylist(node.tileRenderer);
    if (p && !seen.has(p.id)) { seen.add(p.id); out.push(p); }
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object') collectRawPlaylists(v, out, seen, depth + 1);
  }
  return out;
}

// --- Shelf-aware extraction (Milestone 2 categorised feeds) ---
// TV browse responses group videos into titled shelves:
//   shelfRenderer { title, content.horizontalListRenderer.items[].tileRenderer }
// The flat `videos` list (parser lockups + raw tiles) stays the source of
// truth for the grid view; shelves add row grouping for the categories view.
// Any flat video not captured by a titled shelf lands in a trailing 'More'
// row so the categories view still shows everything.

// Broad title reader for a shelf header (depth-capped so it can't reach the
// cards' own titles).
function headerText(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 3) return '';
  const t = rawTextOf(node.title) || rawTextOf(node.text) || rawTextOf(node.headerText);
  if (t) return t;
  for (const k of Object.keys(node)) {
    const r = headerText(node[k], depth + 1);
    if (r) return r;
  }
  return '';
}

function shelfTitleOf(shelf) {
  return rawTextOf(shelf.title)
    || rawTextOf(shelf.headerRenderer?.shelfHeaderRenderer?.title)
    || rawTextOf(shelf.header?.shelfHeaderRenderer?.title)
    || headerText(shelf.headerRenderer)
    || headerText(shelf.header)
    || '';
}

// Collect every 11-char video id anywhere in a subtree (tiles, lockups, and
// watch endpoints alike) - renderer-agnostic. Playlist/mix ids (RD..., 13+
// chars) don't match the gate and are ignored.
function collectIdsInSubtree(node, ids, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 24) return ids;
  if (Array.isArray(node)) { for (const n of node) collectIdsInSubtree(n, ids, depth + 1); return ids; }
  const push = (c) => { if (typeof c === 'string' && /^[A-Za-z0-9_-]{11}$/.test(c)) ids.add(c); };
  push(node.videoId);
  push(node.contentId);
  if (node.watchEndpoint) push(node.watchEndpoint.videoId);
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (val && typeof val === 'object') collectIdsInSubtree(val, ids, depth + 1);
  }
  return ids;
}

// Find shelf-ish container nodes (any key matching /shelf/i), read their
// title, and record the video ids in their subtree. Stops descending once a
// shelf is matched so a shelf nested in a section isn't double-counted.
function collectRawShelves(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 24) return out;
  if (Array.isArray(node)) { for (const n of node) collectRawShelves(n, out, depth + 1); return out; }
  const shelfKey = Object.keys(node).find((k) => /shelf/i.test(k) && node[k] && typeof node[k] === 'object');
  if (shelfKey) {
    const shelf = node[shelfKey];
    const title = shelfTitleOf(shelf);
    const ids = collectIdsInSubtree(shelf, new Set());
    if (title && ids.size) {
      // Capture the shelf's OWN continuation token(s) (they live inside its
      // horizontal list) so a thin shelf can be topped up from its own feed
      // rather than folded into 'More' (session 25).
      const tokens = collectContinuationTokens(shelf);
      out.push({ title, ids, tokens });
    }
    return out; // don't descend into a matched shelf
  }
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (val && typeof val === 'object') collectRawShelves(val, out, depth + 1);
  }
  return out;
}

// Per-category target (session 25): each Home shelf should show at least this
// many videos. If a shelf's initial slice is thinner, we follow ITS OWN
// continuation token(s) to top it up BEFORE displaying it, instead of folding
// thin shelves into 'More' (that fold was why a scroll pull sometimes added
// no visible category). Top-up fetches are bounded by a budget so first paint
// and each scroll pull stay responsive.
const TARGET_SHELF = 10;              // top-up goal per shelf
const MIN_SHELF_DISPLAY = 10;         // a shelf must reach this to be its own row; else it folds into 'More' (kills 1-2-3 rows)
const TOP_UP_ROUNDS_PER_SHELF = 3;    // max continuation hops for one shelf
const TOP_UP_BUDGET_INITIAL = 12;     // max shelf-continuation fetches on first load
const TOP_UP_BUDGET_MORE = 10;        // ... and per scroll load-more

// Group raw shelf descriptors ({title, ids, tokens}) by title into a map
// (title -> { ids:Set, tokens:[] }) plus an ordered title list. Rows that
// repeat a title merge their ids and tokens.
function groupShelves(rawShelves) {
  const map = new Map();
  const order = [];
  for (const s of rawShelves) {
    if (!map.has(s.title)) { map.set(s.title, { ids: new Set(), tokens: [] }); order.push(s.title); }
    const g = map.get(s.title);
    for (const id of s.ids) g.ids.add(id);
    for (const t of s.tokens || []) if (!g.tokens.includes(t)) g.tokens.push(t);
  }
  return { map, order };
}

// Follow ONE shelf's own continuation token(s), attributing every returned
// video back to that shelf (a shelf continuation carries only that shelf's
// items), until it reaches TARGET_SHELF mapped videos or its tokens / the
// budget run out. Mutates the shelf group's ids + tokens and the shared flat
// list; returns the number of continuation fetches spent (callers honour a
// budget across shelves).
async function topUpShelf(title, group, flat, flatIds, seenTokens, budget, debugName) {
  const mapped = () => { let n = 0; for (const id of group.ids) if (flatIds.has(id)) n++; return n; };
  let spent = 0;
  let rounds = 0;
  while (group.tokens.length && mapped() < TARGET_SHELF && rounds < TOP_UP_ROUNDS_PER_SHELF && spent < budget) {
    const token = group.tokens.shift();
    if (seenTokens.has(token)) continue;
    seenTokens.add(token);
    rounds++; spent++;
    let contData;
    try {
      const res = await tubeAuth.actions.execute('/browse', { continuation: token });
      contData = res && res.data ? res.data : res;
    } catch (e) {
      logger.error(`${debugName}: shelf '${title}' top-up failed:`, e.message);
      break;
    }
    for (const v of extractAllFromRaw(contData, debugName + '-shelf')) {
      group.ids.add(v.id);
      if (!flatIds.has(v.id)) { flatIds.add(v.id); flat.push(v); }
    }
    // A shelf continuation may carry the shelf's next token(s); keep them so
    // the row can grow further.
    for (const t of collectContinuationTokens(contData)) {
      if (!seenTokens.has(t) && group.tokens.length < 20) group.tokens.push(t);
    }
  }
  return spent;
}

// Build ordered shelf rows from grouped shelves, mapping each shelf's ids back
// onto the flat serialized video list. minDisplay gates how many videos a
// shelf needs to be its own row (thinner ones fold into 'More'). The streaming
// first-page path (s53) passes 1: rows appear immediately however thin and
// GROW as background chunks / horizontal load-more arrive.
function assembleShelves(order, map, flat, minDisplay = MIN_SHELF_DISPLAY) {
  const byId = new Map(flat.map((v) => [v.id, v]));
  const placed = new Set();
  const shelves = [];
  for (const title of order) {
    const g = map.get(title);
    if (!g) continue;
    const vids = [];
    for (const id of g.ids) {
      const v = byId.get(id);
      if (v && !placed.has(id)) vids.push(v);
    }
    if (vids.length >= minDisplay) {
      for (const v of vids) placed.add(v.id);
      shelves.push({ title, videos: vids });
    }
  }
  const rest = flat.filter((v) => !placed.has(v.id));
  if (rest.length) shelves.push({ title: 'More', videos: rest });
  return shelves;
}

async function fetchRawBrowse(tube, browseId, extra = {}) {
  const res = await tube.actions.execute('/browse', { browseId, ...extra });
  return res && res.data ? res.data : res;
}

// s68d: History 'Remove from history' fix. ROOT CAUSE (confirmed): youtubei.js
// sends FEhistory with its full modern context, and YouTube's modern-context
// history response ships tiles with NO menu/feedbackEndpoint -- so there was no
// removal token to extract. THE FIX that works (log-confirmed, mode 'tv-zylon')
// is the REQUEST SHAPE, not the client version: a MINIMAL legacy-TV-style
// context (our own TVHTML5 clientVersion is fine) with context.tvAppInfo
// .zylonLeftNav set makes YouTube serve the legacy history response WITH the
// per-item feedback tokens. (the v5 TV_DOWNGRADED cver was a red herring --
// it uses v5 only for /player; on /browse v5 400s with INVALID_ARGUMENT, s68c.)
//
// Kept as a self-calibrating PROBE so a future server change can't silently
// break it: on the first history load it tries, in order, tv-zylon (the winner
// today), tv-newest-zylon (the current TV cver as a spare), and
// web-bearer (WEB context + the TV OAuth bearer -- WEB history always has the
// menus), and locks onto the first whose response carries feedbackTokens. Each
// logs `history browse probe '<label>': OK, ~N video id(s), feedbackTokens=
// YES/no`. The winning mode is cached and serves the continuations AND the
// /feedback redemption, so issue/redeem identities always match. If some day
// none carries tokens, the first OK response still serves History (tokenless)
// and an error line says so. youtubei.js is bypassed for these requests because
// its HTTPClient force-replaces the payload context with the modern one (the
// exact thing that suppresses the tokens, and what 400'd the earlier v5 try).
// NB: the winning fix is the request SHAPE (minimal context + tvAppInfo
// .zylonLeftNav), NOT a client-version downgrade -- hence the LEGACY/MINIMAL
// naming. TV_LEGACY_UA + the Cobalt referer complete the legacy TV
// identity; TV_CLIENT_VERSION + the tv-newest-zylon / web-bearer probe
// modes are kept as auto-failover spares (untested against a real
// token-bearing response -- first to drop if the probe is ever slimmed).
const TV_LEGACY_UA = 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version';
const TV_CLIENT_VERSION = '7.20260707.07.00'; // TVHTML5 client version (July 2026)
const MINIMAL_CONTEXT_FEEDS = new Set(['history']);
function needsMinimalContext(debugName) { return MINIMAL_CONTEXT_FEEDS.has(debugName); }

let historyBrowseMode = null; // winning probe identity, discovered once per run

function historyProbeModes() {
  const tv = tubeAuth.session.context.client;
  const web = (tubeAnon && tubeAnon.session && tubeAnon.session.context.client) || null;
  return [
    { label: 'tv-zylon', clientName: 'TVHTML5', clientVersion: tv.clientVersion, nameId: '7', tv: true, ua: TV_LEGACY_UA, referer: 'https://www.youtube.com/tv' },
    { label: 'tv-newest-zylon', clientName: 'TVHTML5', clientVersion: TV_CLIENT_VERSION, nameId: '7', tv: true, ua: TV_LEGACY_UA, referer: 'https://www.youtube.com/tv' },
    { label: 'web-bearer', clientName: 'WEB', clientVersion: (web && web.clientVersion) || '2.20260701.01.00', nameId: '1', tv: false, ua: (web && web.userAgent) || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', referer: 'https://www.youtube.com/feed/history' }
  ];
}

async function historyOauthToken() {
  const oauth = tubeAuth.session.oauth;
  if (oauth && typeof oauth.shouldRefreshToken === 'function' && oauth.shouldRefreshToken()) {
    try { await oauth.refreshAccessToken(); } catch (e) { logger.error('history browse: token refresh failed:', e.message); }
  }
  const token = oauth && oauth.oauth2_tokens && oauth.oauth2_tokens.access_token;
  if (!token) throw new Error('history browse: no OAuth access token');
  return token;
}

// Hand-rolled innertube POST with a MINIMAL per-mode context. youtubei.js is
// bypassed on purpose: its HTTPClient force-replaces the payload's context
// with the session's full modern context (that is what 400'd the v5 attempt).
// The body mirrors the minimal legacy TV browse payload (+ the browse-TV extras for
// TV modes).
async function legacyInnertubeFetch(mode, endpoint, payload, token) {
  const c = tubeAuth.session.context.client;
  const client = {
    clientName: mode.clientName,
    clientVersion: mode.clientVersion,
    userAgent: mode.ua,
    hl: c.hl || 'en',
    gl: c.gl || 'US',
    utcOffsetMinutes: c.utcOffsetMinutes ?? 0,
    visitorData: c.visitorData || ''
  };
  const context = { client, user: { enableSafetyMode: false, lockedSafetyMode: false } };
  if (mode.tv) {
    client.clientScreen = 'WATCH';
    context.tvAppInfo = { appQuality: 'TV_APP_QUALITY_FULL_ANIMATION', zylonLeftNav: true };
    context.webpSupport = false;
    context.animatedWebpSupport = true;
  }
  const res = await ytFetch(`https://www.youtube.com/youtubei/v1${endpoint}?prettyPrint=false&alt=json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'User-Agent': mode.ua,
      'X-Goog-Visitor-Id': c.visitorData || '',
      'X-Youtube-Client-Name': mode.nameId,
      'X-Youtube-Client-Version': mode.clientVersion,
      'X-Origin': 'https://www.youtube.com',
      'Origin': 'https://www.youtube.com',
      'Referer': mode.referer
    },
    body: JSON.stringify({ context, racyCheckOk: true, contentCheckOk: true, ...payload })
  });
  if (!res.ok) {
    let t = '';
    try { t = (await res.text()).slice(0, 200); } catch (e) {}
    throw new Error(`HTTP ${res.status}${t ? ' ' + t : ''}`);
  }
  return await res.json();
}

async function execBrowseTv(payload, minimal) {
  if (!minimal) {
    const res = await tubeAuth.actions.execute('/browse', payload);
    return res && res.data ? res.data : res;
  }
  const token = await historyOauthToken();
  if (historyBrowseMode) return legacyInnertubeFetch(historyBrowseMode, '/browse', payload, token);
  let fallback = null;
  for (const mode of historyProbeModes()) {
    let data;
    try {
      data = await legacyInnertubeFetch(mode, '/browse', payload, token);
    } catch (e) {
      logger.error(`history browse probe '${mode.label}' failed: ${e.message}`);
      continue;
    }
    let vids = 0;
    try { vids = new Set(JSON.stringify(data).match(/"videoId":"[A-Za-z0-9_-]{11}"/g) || []).size; } catch (e) {}
    const hasToken = !!findFeedbackToken(data);
    logger.debug(`history browse probe '${mode.label}': OK, ~${vids} video id(s), feedbackTokens=${hasToken ? 'YES' : 'no'}`);
    if (hasToken) { historyBrowseMode = mode; return data; }
    if (!fallback) fallback = data;
  }
  if (fallback) {
    logger.error('history browse: NO probed mode carried feedbackTokens -- serving tokenless history');
    return fallback;
  }
  throw new Error('history browse: all probe modes failed');
}

// Collect EVERY continuation token in a raw response. TV pages carry one
// token PER SHELF (row) plus a page-level one; following only the first
// token found exhausted a single shelf and made Home look capped at ~100
// items. Handles both styles: nextContinuationData.continuation (old) and
// continuationCommand.token (new).
function collectContinuationTokens(node, out = [], seen = new Set(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 24) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectContinuationTokens(n, out, seen, depth + 1);
    return out;
  }
  const push = (t) => {
    if (typeof t === 'string' && t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  if (node.nextContinuationData) push(node.nextContinuationData.continuation);
  if (node.continuationCommand) push(node.continuationCommand.token);
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (val && typeof val === 'object') collectContinuationTokens(val, out, seen, depth + 1);
  }
  return out;
}

// One raw payload → parser pass (LockupView shelves) + raw tile walk
// (tileRenderer shelves), merged.
function extractAllFromRaw(rawData, debugName) {
  let videos = [];
  try {
    videos = extractFeedVideos(ytMod.Parser.parseResponse(rawData));
  } catch (e) {
    logger.error(`Parser failed on raw ${debugName} response:`, e.message);
  }
  // Raw tiles carry the FULL tile metadata (author/views/date/duration/live).
  // youtubei.js ALSO parses some tileRenderers into `Tile` nodes but WITHOUT
  // that meta, and those were shadowing the good raw-tile version in the merge
  // (the s29 debug_nometa dump proved the data is all present in the tile).
  // So let raw tiles WIN duplicate ids; parser-only nodes (LockupView shelves)
  // are still appended.
  const merged = mergeVideos(collectRawTiles(rawData), videos);
  return merged;
}

// Infinite-scroll + shelf state per feed. Two kinds of continuation token:
//   pageQueue  - PAGE-LEVEL tokens that reveal MORE shelves (new categories),
//                drained here and later by loadMoreTv.
//   map/order  - grouped shelves (title -> { ids, tokens }); each shelf's
//                SHELF-LOCAL tokens extend that one shelf (topUpShelf).
const feedState = new Map(); // debugName -> { pageQueue, seenTokens, ids, map, order }

// Locate the deepest raw card renderer (tile/lockup) whose subtree contains a
// given video id -- used to attach a raw sample to the no-meta diagnostic.
function findRawCardById(node, id, depth = 0, best = { node: null, depth: -1 }) {
  if (!node || typeof node !== 'object' || depth > 30) return best.node;
  if (Array.isArray(node)) {
    for (const n of node) findRawCardById(n, id, depth + 1, best);
    return best.node;
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object') {
      if (/tile.?renderer|lockup/i.test(k)) {
        const ids = collectIdsInSubtree(v, new Set());
        if (ids.has(id) && depth > best.depth) { best.node = v; best.depth = depth; }
      }
      findRawCardById(v, id, depth + 1, best);
    }
  }
  return best.node;
}

// Guaranteed no-meta diagnostic: operates on the FINAL serialized list (what
// actually renders), so it fires whenever any card comes out with an empty
// meta line. Writes the offending serialized cards + a raw sample of the first
// one (found in the initial page) to debug_nometa.json.
function dumpNoMeta(videos, rawData, debugName) {
  const bad = videos.filter((v) => !v.author && !v.views && !v.published);
  if (!bad.length) return;
  logger.error(`${debugName}: ${bad.length}/${videos.length} cards have NO meta line (author+views+date empty)`);
  const payload = { debugName, count: bad.length, of: videos.length, serialized_samples: bad.slice(0, 8) };
  try {
    const raw = bad[0].id ? findRawCardById(rawData, bad[0].id) : null;
    if (raw) payload.raw_sample = raw;
  } catch {}
  debugDump('debug_nometa.json', payload);
}

// Raw browse -- FIRST PAGE ONLY (s53 speed rework). The old version blocked on
// up to 6 page-continuation rounds + 12 shelf top-up fetches (~19 serial round
// trips) before returning anything, which is why Home/History felt slow. Now:
// the first /browse response is extracted and RETURNED IMMEDIATELY (first
// paint = one round trip); when opts.push names a renderer section, a bounded
// BACKGROUND drain (startBackgroundDrain) keeps pulling deeper content and
// streams it to the renderer as yt:feed-chunk payloads, merged into the feed
// cache too. Shelves are assembled WITHOUT the old MIN-size gate (minDisplay
// 1): thin rows appear immediately and grow as chunks / horizontal load-more
// arrive, instead of being folded into 'More' (which would duplicate videos
// across rows once the shelf later grew).
async function getTvFeedVideos(browseId, debugName, extra = {}, opts = {}) {
  const rawData = await execBrowseTv({ browseId, ...extra }, needsMinimalContext(debugName));
  const videos = extractAllFromRaw(rawData, debugName);
  const flatIds = new Set(videos.map((v) => v.id));

  // Document-order id index: ordered feeds (History) keep the response's
  // newest-first order. Continuation batches arrive later via the drain /
  // load-more and are appended after (older) -- order preserved by arrival.
  const orderIndex = new Map();
  if (opts.ordered) {
    for (const id of collectIdsInSubtree(rawData, new Set())) if (!orderIndex.has(id)) orderIndex.set(id, orderIndex.size);
  }

  const rawShelves = collectRawShelves(rawData, []);

  // Separate page-level tokens (reveal new shelves) from shelf-local tokens
  // (attributed to a shelf in rawShelves) so a shelf's cursor isn't followed
  // twice, dropping its items into 'More'.
  const seenTokens = new Set();
  const shelfTokenSet = new Set();
  for (const s of rawShelves) for (const t of s.tokens) shelfTokenSet.add(t);
  const pageQueue = collectContinuationTokens(rawData).filter((t) => !shelfTokenSet.has(t));

  if (opts.ordered) {
    videos.sort((a, b) => (orderIndex.has(a.id) ? orderIndex.get(a.id) : Infinity) - (orderIndex.has(b.id) ? orderIndex.get(b.id) : Infinity));
    feedState.set(debugName, { pageQueue, seenTokens, ids: flatIds, map: new Map(), order: [], ordered: true });
    logger.debug(`${debugName}: ${videos.length} videos (first page, document order); ${pageQueue.length} page cursor(s) queued`);
    if (!videos.length) {
      logger.debug(`${debugName}: 0 videos (feed may legitimately be empty)`);
      debugDump(`debug_${debugName}_raw.json`, rawData);
    }
    dumpNoMeta(videos, rawData, debugName);
    // History removal needs a per-item feedbackToken. Videos present but ZERO
    // tokens = the TV response shape changed (the tile feedbackEndpoint moved
    // or went away) -- dump the raw page so the new shape can be read and the
    // extractor extended (s68: the user lost 'Remove from history').
    if (videos.length && videos.every((vv) => !vv.feedbackToken)) {
      // Tripwire: history came back tokenless again (the s68 minimal-context
      // fix regressed or YouTube changed the shape). Set CATHODE_DEBUG_DUMPS=1
      // to capture the raw page.
      logger.error(`${debugName}: 0/${videos.length} items carry a feedbackToken (Remove-from-history may be broken)`);
      debugDump(`debug_${debugName}_notoken_raw.json`, rawData);
    }
    if (opts.push) startBackgroundDrain(debugName, opts.push);
    return { videos, shelves: [] };
  }

  const { map, order } = groupShelves(rawShelves);
  feedState.set(debugName, { pageQueue, seenTokens, ids: flatIds, map, order });

  // Grid view renders flat `videos`; categories view renders these rows.
  const shelves = assembleShelves(order, map, videos, 1);

  logger.debug(`${debugName}: ${videos.length} videos (first page); ${pageQueue.length} page cursor(s) queued; ${order.length} shelf(s)`);

  if (!videos.length) {
    logger.debug(`${debugName}: parser AND raw tile walk found 0 videos (feed may legitimately be empty)`);
    debugDump(`debug_${debugName}_raw.json`, rawData);
  }
  dumpNoMeta(videos, rawData, debugName);
  if (opts.push) startBackgroundDrain(debugName, opts.push);
  return { videos, shelves };
}

// Bounded background drain (s53): after the first page returned, keep pulling
// deeper content OFF the critical path and stream it to the renderer. Reuses
// loadMoreTv wholesale (page cursors + round-robin shelf tokens + top-ups) so
// the dedupe/exhaustion logic stays single-sourced. Every chunk is also merged
// into the feed cache, so re-entering the section within the TTL keeps the
// accumulated feed, and (home/history) the result is persisted as the
// cold-boot snapshot. One drain per feed at a time.
const FEED_CACHE_KEY = { home: 'home:auth', subs: 'subs', history: 'sect:history' };
const FEED_SNAPSHOT = { home: 'home', history: 'history' };
const BG_PULLS = 2; // loadMoreTv pulls per drain (each is itself budget-bounded)
const bgDraining = new Set();
async function startBackgroundDrain(debugName, pushSection) {
  if (bgDraining.has(debugName)) return;
  bgDraining.add(debugName);
  try {
    for (let i = 0; i < BG_PULLS; i++) {
      const { videos, shelves, exhausted } = await loadMoreTv(debugName);
      if (videos.length || shelves.length) {
        const entry = feedCache.get(FEED_CACHE_KEY[debugName]);
        if (entry && entry.data) {
          if (Array.isArray(entry.data.videos)) entry.data.videos.push(...videos);
          if (Array.isArray(entry.data.shelves)) mergeShelvesInto(entry.data.shelves, shelves);
        }
        pushToRenderer('yt:feed-chunk', { section: pushSection, videos, shelves });
        logger.debug(`${debugName}: background drain +${videos.length} videos, +${shelves.length} shelf chunk(s) (streamed)`);
      }
      if (exhausted) break;
    }
    const snapName = FEED_SNAPSHOT[debugName];
    if (snapName) {
      const entry = feedCache.get(FEED_CACHE_KEY[debugName]);
      if (entry && entry.data && Array.isArray(entry.data.videos) && entry.data.videos.length) saveSnapshot(snapName, entry.data);
    }
  } catch (e) {
    logger.error(`${debugName}: background drain failed:`, e.message);
  } finally {
    bgDraining.delete(debugName);
  }
}

// Merge incoming shelf chunks into an existing ordered shelf list, keeping
// 'More' as the last row. A chunk whose title already exists extends that
// row; a new title is inserted just before 'More'.
function mergeShelvesInto(target, incoming) {
  const findIdx = (t) => target.findIndex((s) => s.title === t);
  for (const chunk of incoming) {
    const at = findIdx(chunk.title);
    if (at >= 0) {
      target[at].videos.push(...chunk.videos);
    } else if (chunk.title === 'More') {
      target.push({ title: 'More', videos: chunk.videos.slice() });
    } else {
      const moreIdx = findIdx('More');
      target.splice(moreIdx >= 0 ? moreIdx : target.length, 0, { title: chunk.title, videos: chunk.videos.slice() });
    }
  }
}

// Fetch the next batch for an already-loaded feed (infinite scroll). Follows
// page-level tokens to reveal NEW shelves, tops each thin shelf found this
// round up to TARGET_SHELF from its OWN continuation (so a scroll pull always
// adds a full-looking category, never a folded-away thin one - session 25),
// and returns the new flat videos (grid) + the topped-up shelf chunks
// (categories). Leftover flat videos become a 'More' chunk.
async function loadMoreTv(debugName, opts = {}) {
  const st = feedState.get(debugName);
  // No feed state yet = the section is showing a disk snapshot while the real
  // feed still loads (s53). NOT exhausted -- the renderer must keep retrying
  // instead of latching, or a fast scroll would permanently kill load-more.
  if (!st || !Array.isArray(st.pageQueue)) return { videos: [], shelves: [], exhausted: false };
  logger.debug(`${debugName} load-more: pageQueue=${st.pageQueue.length}, shelves=${st.order.length}`);
  const added = [];
  const addedIds = new Set();
  const roundShelves = [];
  let rounds = 0;

  while (st.pageQueue.length && rounds < 2 && added.length < 30) {
    const token = st.pageQueue.shift();
    if (st.seenTokens.has(token)) continue;
    st.seenTokens.add(token);
    rounds++;
    let contData;
    try {
      contData = await execBrowseTv({ continuation: token }, needsMinimalContext(debugName));
    } catch (e) {
      logger.error(`${debugName} load-more failed:`, e.message);
      break;
    }
    for (const v of extractAllFromRaw(contData, debugName + '-more')) {
      if (!st.ids.has(v.id)) st.ids.add(v.id);
      if (!addedIds.has(v.id)) { addedIds.add(v.id); added.push(v); }
    }
    const contShelves = collectRawShelves(contData, []);
    const roundShelfTokens = new Set();
    for (const s of contShelves) { roundShelves.push(s); for (const t of s.tokens) roundShelfTokens.add(t); }
    for (const t of collectContinuationTokens(contData)) {
      if (!st.seenTokens.has(t) && !roundShelfTokens.has(t) && st.pageQueue.length < 50) st.pageQueue.push(t);
    }
  }

  if (!st.pageQueue.length) logger.debug(`${debugName}: feed exhausted - no page cursors left`);

  // Ordered feeds (History): no shelf grouping/top-up - return the flat batch
  // in its fetched (document) order so chronology is preserved.
  if (st.ordered) return { videos: added, shelves: [], exhausted: st.pageQueue.length === 0 };

  // TV Home's PAGE-level cursor chain is short (often just 1), so once it's
  // drained the grid would stall even though each of the ~22 shelves has its
  // OWN deep continuation chain (left over after the initial top-up). Drain
  // those chains ROUND-ROBIN across ALL shelves, rotating st.shelfCursor so
  // each pull continues where the last stopped -- this taps every shelf's chain
  // over successive pulls instead of hammering the first shelf's (already dry)
  // chain, burning the budget, and returning an empty pull the renderer latches
  // as 'exhausted'. Only stops when a FULL lap over all shelves yields nothing
  // new (or the per-pull fetch budget runs out). Bounded so a pull stays snappy.
  const grownByTitle = new Map(); // title -> new videos the round-robin adds this pull (feed the category rows, not just the flat grid)
  if (added.length < 15) {
    const order = st.order.filter((t) => t !== 'More'); // 'More' has no own tokens
    if (order.length) {
      if (typeof st.shelfCursor !== 'number') st.shelfCursor = 0;
      const MAX_FETCHES = 8; // network hops per pull
      let fetches = 0;
      let dry = 0;           // consecutive shelves that added nothing; a full lap = done
      while (fetches < MAX_FETCHES && added.length < 20 && dry < order.length) {
        const title = order[st.shelfCursor % order.length];
        st.shelfCursor++;
        const g = st.map.get(title);
        // Pull the next UNSEEN token for this shelf (skip already-fetched ones).
        let token = null;
        if (g) { while (g.tokens.length) { const t = g.tokens.shift(); if (!st.seenTokens.has(t)) { token = t; break; } } }
        if (!token) { dry++; continue; }
        st.seenTokens.add(token);
        fetches++;
        let gotNew = false;
        try {
          const r = await tubeAuth.actions.execute('/browse', { continuation: token });
          const cd = r && r.data ? r.data : r;
          for (const v of extractAllFromRaw(cd, debugName + '-shelfmore')) {
            g.ids.add(v.id);
            if (!st.ids.has(v.id)) {
              st.ids.add(v.id);
              if (!addedIds.has(v.id)) {
                addedIds.add(v.id); added.push(v); gotNew = true;
                if (!grownByTitle.has(title)) grownByTitle.set(title, []);
                grownByTitle.get(title).push(v); // attribute to its row so categories view grows it
              }
            }
          }
          for (const t of collectContinuationTokens(cd)) { if (!st.seenTokens.has(t) && g.tokens.length < 20) g.tokens.push(t); }
        } catch (e) { logger.error(`${debugName}: shelf-more '${title}' failed:`, e.message); }
        dry = gotNew ? 0 : dry + 1;
      }
    }
    if (added.length) logger.debug(`${debugName}: ${added.length} flat video(s) after shelf-cursor drain (round-robin, page queue dry)`);
  }

  // Merge this round's shelves into the persistent group map, tracking which
  // titles were touched so we top up + return just those rows.
  const touched = [];
  for (const s of roundShelves) {
    if (!st.map.has(s.title)) { st.map.set(s.title, { ids: new Set(), tokens: [] }); st.order.push(s.title); }
    const g = st.map.get(s.title);
    for (const id of s.ids) g.ids.add(id);
    for (const t of s.tokens || []) if (!g.tokens.includes(t)) g.tokens.push(t);
    if (!touched.includes(s.title)) touched.push(s.title);
  }

  // Top up each touched shelf from its own continuation. New videos land in
  // this flat pool (also folded back into `added` so the grid grows too).
  const flatPool = added.slice();
  const flatPoolIds = new Set(added.map((v) => v.id));
  let budget = TOP_UP_BUDGET_MORE;
  for (const title of touched) {
    if (budget <= 0) break;
    const g = st.map.get(title);
    let mapped = 0; for (const id of g.ids) if (flatPoolIds.has(id)) mapped++;
    if (mapped < TARGET_SHELF && g.tokens.length) {
      budget -= await topUpShelf(title, g, flatPool, flatPoolIds, st.seenTokens, budget, debugName);
    }
  }
  for (const v of flatPool) {
    if (!addedIds.has(v.id)) { addedIds.add(v.id); added.push(v); }
    if (!st.ids.has(v.id)) st.ids.add(v.id);
  }

  // Build shelf chunks for the touched titles, mapped onto the flat pool.
  // (Only this round's videos map here, so chunks never duplicate videos
  // already shown in an existing row when the renderer merges by title.)
  const byId = new Map(flatPool.map((v) => [v.id, v]));
  const placed = new Set();
  const shelves = [];
  for (const title of touched) {
    const g = st.map.get(title);
    const vids = [];
    for (const id of g.ids) {
      const v = byId.get(id);
      if (v && !placed.has(id)) vids.push(v);
    }
    if (vids.length >= MIN_SHELF_DISPLAY) { for (const v of vids) placed.add(v.id); shelves.push({ title, videos: vids }); }
  }
  // Round-robin-grown rows (existing categories that got deeper this pull):
  // emit their new videos as chunks so the categories view appends them to the
  // visible row. No MIN gate -- these rows are already displayed; the renderer
  // dedupes + appends (or creates the row if it wasn't shown yet).
  for (const [title, vids] of grownByTitle) {
    if (touched.includes(title)) continue; // already emitted above
    const chunk = vids.filter((v) => !placed.has(v.id));
    if (chunk.length) { for (const v of chunk) placed.add(v.id); shelves.push({ title, videos: chunk }); }
  }
  const leftover = added.filter((v) => !placed.has(v.id));
  if (leftover.length) shelves.push({ title: 'More', videos: leftover });

  // Exhausted signal for the renderer's load-more latch: done only when the
  // page-cursor chain (new rows) is empty AND no shelf has an unseen token
  // (rows can't grow deeper). Applies to BOTH views -- vertical scroll now
  // grows the rows directly (grownByTitle chunks), so a dry-pageQueue pull with
  // live shelf tokens is NOT exhausted.
  const shelfTokensLeft = () => {
    for (const t of st.order) { const g = st.map.get(t); if (g && g.tokens.some((tk) => !st.seenTokens.has(tk))) return true; }
    return false;
  };
  const exhausted = st.pageQueue.length === 0 && !shelfTokensLeft();

  return { videos: added, shelves, exhausted };
}

// Section -> feedState debugName (shared by getMoreFeed + loadMoreShelf).
const SECTION_FEED_NAME = {
  home: 'home', subscriptions: 'subs', channel: 'chan', history: 'history',
  trending: 'trending', music: 'music', playlist: 'playlist', channelpage: 'channelpage'
};

// Horizontal (within-row) load-more: grow ONE category shelf from its OWN
// continuation token(s) when the user scrolls to the right end of that row
// Returns only videos NOT already shown in that row. The
// shelf-local tokens live in feedState[name].map[title].tokens (captured at
// load + refilled from each continuation). 'More' (the leftover bucket) has no
// own tokens, so it returns nothing here -- it grows via the vertical grid
// load-more instead.
async function loadMoreShelf(section, title) {
  const name = SECTION_FEED_NAME[section];
  if (!name) { logger.debug(`shelf load-more: unknown section '${section}'`); return { videos: [], ids: [], exhausted: true }; }
  const st = feedState.get(name);
  if (!st || !st.map || !st.map.has(title)) { logger.debug(`${name}: shelf '${title}' load-more skipped (no feed state / unknown row)`); return { videos: [], ids: [], exhausted: true }; }
  const g = st.map.get(title);

  // Try to grow the shelf from its own UNSEEN continuation tokens (deeper
  // content). Videos are deduped only within this call; g.ids accumulates.
  const fresh = [];
  const freshIds = new Set();
  let budget = 2; // hops per pull -- keep it snappy
  let fetches = 0;
  while (g.tokens.length && budget > 0 && fresh.length < 24) {
    const token = g.tokens.shift();
    if (st.seenTokens.has(token)) continue;
    st.seenTokens.add(token);
    budget--; fetches++;
    let cd;
    try {
      const r = await tubeAuth.actions.execute('/browse', { continuation: token });
      cd = r && r.data ? r.data : r;
    } catch (e) {
      logger.error(`${name}: shelf '${title}' horizontal load-more failed:`, e.message);
      break;
    }
    for (const v of extractAllFromRaw(cd, name + '-shelfrow')) {
      g.ids.add(v.id);
      if (!st.ids.has(v.id)) st.ids.add(v.id);
      if (!freshIds.has(v.id)) { freshIds.add(v.id); fresh.push(v); }
    }
    for (const t of collectContinuationTokens(cd)) {
      if (!st.seenTokens.has(t) && g.tokens.length < 20) g.tokens.push(t);
    }
  }

  // Return the shelf's FULL id set alongside the freshly-fetched objects. Many
  // of a shelf's videos get pulled into the flat grid by the vertical grid
  // drain / initial top-up (they land in g.ids + the flat list but were never
  // re-assembled into the row's strip), and once those tokens are consumed the
  // row can't refetch them. The renderer maps these ids to video objects it
  // already holds (currentFeed.videos) and appends the ones the row hasn't
  // shown -- so a row with 0 fresh tokens still grows from already-fetched
  // content. exhausted=true only when no unseen tokens remain.
  const unseenLeft = g.tokens.filter((t) => !st.seenTokens.has(t)).length;
  logger.debug(`${name}: shelf '${title}' +${fresh.length} fetched (${fetches} fetch(es)); ${g.ids.size} shelf ids; ${unseenLeft} fresh token(s) left`);
  return { videos: fresh, ids: Array.from(g.ids), exhausted: unseenLeft === 0 };
}

// IPC entry: more content for a UI section; also merges into the feed cache
// so re-entering the section within the TTL keeps the longer grid/rows.
async function getMoreFeed(section, view) {
  if (section === 'search') return getMoreSearch();
  if (section === 'music') {
    const { items, exhausted } = await getMoreMusic();
    if (items.length) {
      const entry = feedCache.get('music');
      if (entry && entry.data && Array.isArray(entry.data.items)) entry.data.items.push(...items);
      logger.debug(`music: +${items.length} items (scroll load-more)`);
    }
    return { items, exhausted };
  }
  const map = {
    home: { name: 'home', cacheKey: 'home:auth' },
    subscriptions: { name: 'subs', cacheKey: 'subs' },
    channel: { name: 'chan', cacheKey: null },
    history: { name: 'history', cacheKey: 'sect:history' },
    trending: { name: 'trending', cacheKey: 'sect:trending' },
    music: { name: 'music', cacheKey: 'sect:music' },
    playlist: { name: 'playlist', cacheKey: null },
    channelpage: { name: 'channelpage', cacheKey: null }
  };
  const m = map[section];
  if (!m) return { videos: [], shelves: [], exhausted: true };
  // Both views drain shelf continuations; the drained videos are returned as
  // BOTH flat videos (grid view) AND per-row chunks (categories view), so
  // scrolling grows content in either view from the same tokens.
  const { videos, shelves, exhausted } = await loadMoreTv(m.name);
  if (videos.length || shelves.length) {
    const entry = feedCache.get(m.cacheKey);
    if (entry && entry.data) {
      if (Array.isArray(entry.data.videos)) entry.data.videos.push(...videos);
      if (Array.isArray(entry.data.shelves)) mergeShelvesInto(entry.data.shelves, shelves);
    }
    logger.debug(`${m.name}: +${videos.length} videos, +${shelves.length} shelf chunk(s) (scroll load-more, view=${view || 'grid'})`);
  }
  return { videos, shelves, exhausted };
}

// Home (s53): the signed-in home paints INSTANTLY from the last disk snapshot
// (when one exists) while the real feed loads in the background and replaces
// it via a yt:feed-fresh push; without a snapshot it awaits the auth restore
// and returns the FIRST PAGE (deeper content then streams in as
// yt:feed-chunk). This is what substitutes for the warm process a resident
// TV app keeps on Android -- our Electron app cold-boots on every open.
async function getHomeFeed() {
  if (isSignedIn() || (authRestoring && currentAccountId !== GUEST_ID)) {
    return cachedFeed('home:auth', async () => {
      const snap = useFeedSnapshots() ? readSnapshot('home') : null;
      if (snap && Array.isArray(snap.videos) && snap.videos.length) {
        refreshHomeInBackground();
        return { title: 'Home', ...snap, signedIn: true, fromCache: true };
      }
      return loadFreshHome();
    });
  }

  return cachedFeed('home:anon', async () => {
    const feed = await tubeAnon.getHomeFeed();
    return { title: 'Popular', videos: extractFeedVideos(feed), signedIn: false };
  });
}

async function loadFreshHome() {
  await authReady();
  if (isSignedIn()) {
    try {
      const { videos, shelves } = await getTvFeedVideos('FEwhat_to_watch', 'home', {}, { push: 'home' });
      if (videos.length) {
        const feed = { title: 'Home', videos, shelves, signedIn: true };
        // First-page snapshot now; the background drain re-saves it with the
        // deeper content once it finishes.
        saveSnapshot('home', feed);
        return feed;
      }
      logger.error('Authenticated home feed yielded 0 videos, falling back to anonymous.');
    } catch (e) {
      logger.error('Authenticated home feed failed, falling back to anonymous:', e);
    }
  }
  const feed = await tubeAnon.getHomeFeed();
  return { title: 'Popular', videos: extractFeedVideos(feed), signedIn: isSignedIn(), fallback: true };
}

// Replace a served snapshot with the real feed: fetch fresh, overwrite the
// cache entry, and push yt:feed-fresh so the renderer re-renders in place.
let homeRefreshing = false;
async function refreshHomeInBackground() {
  if (homeRefreshing) return;
  homeRefreshing = true;
  try {
    const feed = await loadFreshHome();
    feedCache.set('home:auth', { ts: Date.now(), data: feed });
    pushToRenderer('yt:feed-fresh', { section: 'home', feed });
    logger.debug(`home: snapshot refreshed in background (${feed.videos.length} videos)`);
  } catch (e) {
    logger.error('home background refresh failed:', e.message);
  } finally {
    homeRefreshing = false;
  }
}

async function getSubscriptionsFeed() {
  await authReady();
  if (!isSignedIn()) throw new Error('Sign in to see your subscriptions');
  return cachedFeed('subs', async () => {
    try {
      const { videos, shelves } = await getTvFeedVideos('FEsubscriptions', 'subs');
      return { title: 'Subscriptions', videos, shelves };
    } catch (e) {
      logger.error('Subscriptions feed failed:', e);
      throw e;
    }
  });
}

// Subscriptions as a CHANNEL LIST. The raw TV subscriptions response carries
// the channel tabs at:
//   contents.tvBrowseRenderer.content.tvSecondaryNavRenderer.sections[]
//     .tvSecondaryNavSectionRenderer.tabs[].tabRenderer
// Each tabRenderer has a title (channel name), a browseEndpoint
// (FEsubscriptions + params) and a channel avatar thumbnail. The first tab is
// 'All' (no params). Read straight from raw - the parser exposes its nodes as
// contents_memo, and the nav renderers aren't reliably surfaced there.
function collectChannelTabs(node, out, seen, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 30) return out;
  if (Array.isArray(node)) { for (const n of node) collectChannelTabs(n, out, seen, depth + 1); return out; }
  const nav = node.tvSecondaryNavSectionRenderer;
  if (nav && Array.isArray(nav.tabs)) {
    for (const item of nav.tabs) {
      const tr = item && item.tabRenderer;
      if (!tr) continue;
      const name = rawTextOf(tr.title) || (typeof tr.title === 'string' ? tr.title : '');
      if (!name) continue;
      const params = tr.endpoint?.browseEndpoint?.params || '';
      const key = name + '|' + params;
      if (seen.has(key)) continue;
      seen.add(key);
      const thumbs = tr.thumbnail?.thumbnails;
      out.push({ name, params, avatar: Array.isArray(thumbs) && thumbs.length ? bestOf(thumbs) : null });
    }
    return out;
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object') collectChannelTabs(v, out, seen, depth + 1);
  }
  return out;
}

async function getSubscriptionChannels() {
  await authReady();
  if (!isSignedIn()) throw new Error('Sign in to see your subscriptions');
  return cachedFeed('subs:channels', async () => {
    const raw = await fetchRawBrowse(tubeAuth, 'FEsubscriptions');
    const channels = collectChannelTabs(raw, [], new Set());
    if (!channels.some((c) => !c.params)) channels.unshift({ name: 'All', params: '', avatar: null });
    if (channels.length <= 1) {
      logger.error('Only the All channel tab resolved (subscription channel list may be incomplete)');
      debugDump('debug_subs_channels.json', raw);
    }
    logger.debug(`subscriptions: ${channels.length} channel tab(s)`);
    return { channels };
  });
}

// Videos for one subscription channel tab. `params` comes from
// getSubscriptionChannels; empty params = the combined 'All' feed.
async function getChannelFeed(params, name) {
  await authReady();
  const extra = params ? { params } : {};
  const { videos } = await getTvFeedVideos('FEsubscriptions', 'chan', extra);
  return { title: name || 'Channel', videos };
}

// Open an arbitrary channel by its UC id (from a video's author). Browses the
// channel's TV page and returns its videos.
async function getChannelPage(channelId, name) {
  await authReady();
  const { videos } = await getTvFeedVideos(channelId, 'channelpage');
  return { title: name || 'Channel', videos };
}

// --- Generic browse-ID sections (History, Trending, Music) ---
// Same raw TV route as Home. Auth-only sections throw a sign-in prompt when
// logged out. Music points at YouTube's auto-generated Music topic channel
// (the destination the guide's 'Music' entry links to). Trending may come back
// empty: YouTube retired the Trending page in 2025.
const SECTIONS = {
  history:  { browseId: 'FEhistory',  name: 'history',  title: 'History',  requiresAuth: true, ordered: true },
  // Trending is reached with FEtrending + a tab `params` protobuf
  // (most_popular), not a bare browseId. YouTube retired Trending so it may
  // still be empty, but the params are the only shot at any content.
  trending: { browseId: 'FEtrending', name: 'trending', title: 'Trending', requiresAuth: false, params: '4gIOGgxtb3N0X3BvcHVsYXI=' },
  music:    { browseId: 'UC-9-kyTW8ZkZNDHQJ6FgpwQ', name: 'music', title: 'Music', requiresAuth: false }
};

async function getSection(key) {
  const s = SECTIONS[key];
  if (!s) throw new Error('Unknown section: ' + key);
  // During the boot auth-restore, isSignedIn() is briefly false even though
  // creds exist -- let the loader await authReady() instead of throwing.
  if (s.requiresAuth && !isSignedIn() && !(authRestoring && currentAccountId !== GUEST_ID)) throw new Error(`Sign in to see your ${s.title}`);
  return cachedFeed('sect:' + key, async () => {
    // History paints instantly from the last snapshot; the real feed replaces
    // it in the background via yt:feed-fresh (same pattern as Home).
    if (key === 'history') {
      const snap = useFeedSnapshots() ? readSnapshot('history') : null;
      if (snap && Array.isArray(snap.videos) && snap.videos.length) {
        refreshHistoryInBackground();
        return { title: 'History', ...snap, signedIn: true, fromCache: true };
      }
    }
    return loadFreshSection(key);
  });
}

async function loadFreshSection(key) {
  const s = SECTIONS[key];
  await authReady();
  if (s.requiresAuth && !isSignedIn()) throw new Error(`Sign in to see your ${s.title}`);
  try {
    const extra = s.params ? { params: s.params } : {};
    const { videos, shelves } = await getTvFeedVideos(s.browseId, s.name, extra, { ordered: !!s.ordered, push: key === 'history' ? 'history' : undefined });
    const feed = { title: s.title, videos, shelves, signedIn: isSignedIn() };
    if (key === 'history' && videos.length) saveSnapshot('history', feed);
    return feed;
  } catch (e) {
    // Public sections (Trending is retired by YouTube -> 400; Music can 404)
    // degrade to an empty feed instead of a hard error. Auth sections keep
    // surfacing real failures.
    if (s.requiresAuth) throw e;
    logger.error(`Section ${key} (${s.browseId}) failed, showing empty:`, e.message);
    return { title: s.title, videos: [], shelves: [], signedIn: isSignedIn() };
  }
}

let historyRefreshing = false;
async function refreshHistoryInBackground() {
  if (historyRefreshing) return;
  historyRefreshing = true;
  try {
    const feed = await loadFreshSection('history');
    feedCache.set('sect:history', { ts: Date.now(), data: feed });
    pushToRenderer('yt:feed-fresh', { section: 'history', feed });
    logger.debug(`history: snapshot refreshed in background (${feed.videos.length} videos)`);
  } catch (e) {
    logger.error('history background refresh failed:', e.message);
  } finally {
    historyRefreshing = false;
  }
}

// --- Playlists (the account library) ---
// FElibrary lists the user's playlists as tiles; each opens by browsing
// VL<playlistId>. If nothing parses, the raw page is dumped for inspection.
async function getPlaylists(force) {
  await authReady();
  if (!isSignedIn()) throw new Error('Sign in to see your playlists');
  if (force) feedCache.delete('playlists');
  return cachedFeed('playlists', async () => {
    const raw = await fetchRawBrowse(tubeAuth, 'FElibrary');
    const playlists = collectRawPlaylists(raw);
    if (!playlists.length) {
      logger.info('No playlists parsed from FElibrary (library may legitimately be empty)');
      debugDump('debug_library_raw.json', raw);
    }
    logger.debug(`playlists: ${playlists.length}`);
    return { playlists };
  });
}

async function getPlaylistFeed(playlistId, name) {
  await authReady();
  if (!isSignedIn()) throw new Error('Sign in to open playlists');
  const browseId = playlistId.startsWith('VL') ? playlistId : 'VL' + playlistId;
  const { videos } = await getTvFeedVideos(browseId, 'playlist');
  return { title: name || 'Playlist', videos };
}

// --- Music: REAL YouTube Music (music.youtube.com) ---
// (Replaces the old auto-generated "Music" topic channel, which surfaced only
// curated playlists.) The dedicated YT Music client (tubeAnon.music) returns a
// home feed of carousels: songs / music videos (11-char videoId -> playable)
// and playlists (drillable). Albums/artists are skipped for now. Anonymous YT
// Music home leans playlist/mood-heavy (personalized song shelves need a
// login), so we surface both. INFINITE SCROLL follows the home feed's
// getContinuation() -- each returned HomeFeed carries the cursor for the next.

function musicPlaylistId(n) {
  const bid = n.endpoint?.payload?.browseId;
  if (typeof bid === 'string' && bid.startsWith('VL')) return bid.slice(2);
  const pid = n.endpoint?.payload?.playlistId;
  if (typeof pid === 'string' && pid) return pid;
  if (typeof n.id === 'string' && /^(VLPL|PL|RDCLAK|OLAK)/.test(n.id)) return n.id.replace(/^VL/, '');
  return null;
}

function musicNodeToItem(n) {
  if (!n || typeof n !== 'object') return null;
  const title = textOf(n.title) || textOf(n.name);
  if (!title) return null;
  const it = n.item_type;
  // Music surfaces PLAYLISTS ONLY -- you drill in to play. Individual songs /
  // videos are intentionally NOT shown as directly-playable cards (per user);
  // albums/artists aren't wired for drill-in either, so both are skipped.
  if (it === 'song' || it === 'video' || it === 'album' || it === 'artist') return null;
  const pid = musicPlaylistId(n);
  if (pid) return { type: 'playlist', id: pid, title, count: textOf(n.subtitle) || 'Playlist', thumbnail: thumbOf(n) };
  return null;
}

// Walk the YT Music home sections collecting song/video + playlist items. A
// WeakSet guards the parsed nodes' internal cycles; a matched node isn't
// descended into.
function collectMusicNodes(node, out, seen, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 14) return out;
  if (seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) { for (const n of node) collectMusicNodes(n, out, seen, depth + 1); return out; }
  const it = musicNodeToItem(node);
  if (it) { out.push(it); return out; }
  for (const k of Object.keys(node)) {
    if (k === 'session' || k === 'actions' || k === 'client') continue;
    const val = node[k];
    if (val && typeof val === 'object') collectMusicNodes(val, out, seen, depth + 1);
  }
  return out;
}

// Music infinite-scroll state: the home feed + its remaining mood/genre filter
// chips (drained as the user scrolls) + the dedupe key set.
let musicState = null; // { home, filters:[], seenKeys }

function absorbMusic(sections, seenKeys, out) {
  for (const it of collectMusicNodes(sections || [], [], new WeakSet())) {
    const key = it.type + ':' + it.id;
    if (!seenKeys.has(key)) { seenKeys.add(key); out.push(it); }
  }
}

// Apply up to `n` of the remaining home mood/genre filter chips (Relax,
// Workout, Focus, ...). Each applied filter returns a feed of PLAYLIST
// carousels for that mood -- the real source of volume on anonymous YT Music
// (the bare home is only ~10 items). Drains musicState.filters so infinite
// scroll continues where the previous batch stopped; appends (deduped) to out.
async function collectMoods(out, n) {
  if (!musicState || !musicState.home) return;
  const { home, filters, seenKeys } = musicState;
  let applied = 0;
  while (filters.length && applied < n) {
    const name = filters.shift();
    applied++;
    try {
      const feed = await home.applyFilter(name);
      absorbMusic(feed.sections, seenKeys, out);
    } catch (e) { logger.error(`YT Music mood '${name}' failed:`, e.message); }
  }
}

// Music (s55): two-layer like Home/History. Layer 1 -- paint instantly from a
// disk snapshot (Data/snapshot_shared_music.json; Music is anonymous so the
// snapshot is account-INDEPENDENT) while a background refresh replaces it via
// yt:feed-fresh. Layer 2 -- first-page-first: return the YT Music home
// carousels immediately, then a bounded background drain streams the home
// continuations + the first mood/genre chips as yt:feed-chunk (section
// 'music'); the remaining chips feed the scroll load-more (getMoreMusic).
const MUSIC_SNAP_ID = 'shared';
function readMusicSnapshot() {
  try { return JSON.parse(fs.readFileSync(snapshotPath('music', MUSIC_SNAP_ID), 'utf8')); } catch (e) { return null; }
}
function saveMusicSnapshot(items) {
  try { fs.writeFileSync(snapshotPath('music', MUSIC_SNAP_ID), JSON.stringify({ items })); } catch (e) { logger.error('music snapshot save failed:', e.message); }
}

async function getMusic() {
  return cachedFeed('music', async () => {
    const snap = useFeedSnapshots() ? readMusicSnapshot() : null;
    if (snap && Array.isArray(snap.items) && snap.items.length) {
      refreshMusicInBackground();
      return { items: snap.items, fromCache: true };
    }
    return loadFreshMusic();
  });
}

// Fetch ONLY the YT Music home carousels (first paint) and arm musicState for
// the drain + scroll. Fast: one getHomeFeed round trip.
async function loadFreshMusicHome() {
  const seenKeys = new Set();
  const items = [];
  let home = null;
  try {
    home = await tubeAnon.music.getHomeFeed();
    absorbMusic(home.sections, seenKeys, items);
  } catch (e) {
    logger.error('YT Music getHomeFeed failed:', e.message);
  }
  let filters = [];
  try { filters = (home && home.filters) || []; } catch {}
  musicState = { home, filters: filters.slice(), seenKeys };

  // Diagnostic: what the anonymous home actually contains + which mood chips
  // exist (explains a thin grid). Gated behind DEBUG_DUMPS (was written every
  // fresh load).
  if (DEBUG_DUMPS) try {
    const sec = (home && home.sections) || [];
    const diag = {
      home_items: items.length,
      mood_filters: filters,
      home_section_count: sec.length,
      home_sections: sec.map((s) => {
        const list = (Array.isArray(s.contents) && s.contents) || (Array.isArray(s.items) && s.items) || [];
        const i0 = list[0];
        return {
          type: s && s.constructor && s.constructor.name,
          title: textOf(s && s.title) || textOf(s && s.header && s.header.title) || '',
          item_count: list.length,
          first_item: i0 ? { type: i0.constructor && i0.constructor.name, item_type: i0.item_type, id: i0.id, has_playlist_id: !!musicPlaylistId(i0) } : null
        };
      })
    };
    debugDump('debug_music_raw.json', diag);
  } catch (e) { logger.error('music diag dump failed:', e.message); }

  logger.debug(`music: ${items.length} home item(s), ${filters.length} mood chip(s) available`);
  return { items };
}

async function loadFreshMusic() {
  const data = await loadFreshMusicHome();
  startMusicDrain(); // stream home continuations + first moods in the background
  return data;
}

// Bounded background drain (s55): stream deeper Music content OFF the critical
// path -- home continuations then the first mood chips -- as yt:feed-chunk, and
// save the accumulated set as the cold-boot snapshot. Leaves the remaining mood
// chips for the scroll load-more. One drain at a time.
const MUSIC_BG_MOODS = 6; // mood chips the drain pulls (the rest go to scroll)
let musicDraining = false;
function pushMusicChunk(items) {
  if (!items || !items.length) return;
  const entry = feedCache.get('music');
  if (entry && entry.data && Array.isArray(entry.data.items)) entry.data.items.push(...items);
  pushToRenderer('yt:feed-chunk', { section: 'music', items });
  logger.debug(`music: background drain +${items.length} item(s) (streamed)`);
}
async function startMusicDrain() {
  if (musicDraining) return;
  musicDraining = true;
  try {
    // Home continuations (more carousels) first.
    if (musicState && musicState.home) {
      let f = musicState.home, rounds = 0;
      while (f && f.has_continuation && rounds < 3) {
        rounds++;
        const batch = [];
        try { f = await f.getContinuation(); absorbMusic(f.sections, musicState.seenKeys, batch); }
        catch (e) { logger.error('YT Music home continuation failed:', e.message); break; }
        pushMusicChunk(batch);
      }
    }
    // Then the first mood chips, streamed a couple at a time.
    let pulled = 0;
    while (musicState && musicState.filters.length && pulled < MUSIC_BG_MOODS) {
      const before = musicState.filters.length;
      const batch = [];
      await collectMoods(batch, 2);
      pulled += (before - musicState.filters.length);
      if (!batch.length && before === musicState.filters.length) break; // no progress
      pushMusicChunk(batch);
    }
    // Persist the accumulated set as the cold-boot snapshot.
    const entry = feedCache.get('music');
    if (entry && entry.data && Array.isArray(entry.data.items) && entry.data.items.length) saveMusicSnapshot(entry.data.items);
  } catch (e) {
    logger.error('music background drain failed:', e.message);
  } finally {
    musicDraining = false;
  }
}

// Full fresh Music build (home + the first mood chips) -- used by the
// background refresh so a served snapshot is replaced in ONE swap. The anon YT
// Music home alone is thin (~10 items), so pushing home-only as feed-fresh
// would shrink-then-regrow the grid; building the full set first avoids that
// flash. (The cold no-snapshot path streams instead -- nothing to shrink from.)
async function loadFreshMusicFull() {
  const data = await loadFreshMusicHome();
  try { await collectMoods(data.items, MUSIC_BG_MOODS); } catch (e) { logger.error('music moods (full) failed:', e.message); }
  if (data.items.length) saveMusicSnapshot(data.items);
  return data;
}

// Replace a served snapshot with a fresh Music feed in one swap (home + first
// moods), pushed as yt:feed-fresh. No mid-refresh streaming (the snapshot
// already gave instant paint; streaming is the cold-path job).
let musicRefreshing = false;
async function refreshMusicInBackground() {
  if (musicRefreshing) return;
  musicRefreshing = true;
  try {
    const data = await loadFreshMusicFull();
    feedCache.set('music', { ts: Date.now(), data });
    pushToRenderer('yt:feed-fresh', { section: 'music', items: data.items });
    logger.debug(`music: snapshot refreshed in background (${data.items.length} items)`);
  } catch (e) {
    logger.error('music background refresh failed:', e.message);
  } finally {
    musicRefreshing = false;
  }
}

// Infinite scroll: apply the next few mood/genre chips and return their new
// playlists. exhausted only once every chip has been pulled AND musicState is
// ready -- while a snapshot is showing pre-refresh musicState may be unset, in
// which case we report NOT-exhausted so the row retries after the refresh arms
// it (mirrors loadMoreTv's exhausted:false-when-no-state guard).
async function getMoreMusic() {
  const items = [];
  await collectMoods(items, 4);
  const exhausted = !!(musicState && musicState.filters && musicState.filters.length === 0);
  return { items, exhausted };
}

// Add a video to a playlist (playlistId 'WL' = Watch Later). Account action via
// the logged-in TV session; clears the cached playlist feed so a re-open shows
// the new item.
async function addToPlaylist(playlistId, videoId) {
  await authReady();
  if (!isSignedIn()) throw new Error('Sign in to edit playlists');
  await tubeAuth.playlist.addVideos(playlistId, [videoId]);
  feedCache.delete('playlists');
  return true;
}

// Remove a video from a playlist (playlistId 'WL' = Watch Later). youtubei.js
// removeVideos fetches the playlist to resolve each item's setVideoId, so the
// playlist must be editable (owned / WL). Best-effort; errors bubble up for a
// graceful toast.
async function removeFromPlaylist(playlistId, videoId) {
  await authReady();
  if (!isSignedIn()) throw new Error('Sign in to edit playlists');
  // youtubei.js removeVideos() first fetches + PARSES the playlist to resolve
  // each item's setVideoId, which fails on the TV client ('There are no
  // continuations'). Instead reuse the SAME playlistEditEndpoint that
  // addVideos uses (confirmed working on TV) with the by-video-id remove
  // action -- no playlist read needed.
  const NavigationEndpoint = ytMod.YTNodes.NavigationEndpoint;
  const ep = new NavigationEndpoint({
    playlistEditEndpoint: {
      playlistId,
      actions: [{ action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoId }]
    }
  });
  await ep.call(tubeAuth.actions);
  feedCache.delete('playlists');
  return true;
}

// Delete / unsave a whole playlist: owned playlists are deleted, a saved
// (not-owned) one that can't be deleted is removed from the library instead.
async function removePlaylist(playlistId) {
  await authReady();
  if (!isSignedIn()) throw new Error('Sign in to edit playlists');
  try {
    await tubeAuth.playlist.delete(playlistId);
  } catch (e1) {
    try {
      await tubeAuth.playlist.removeFromLibrary(playlistId);
    } catch (e2) {
      logger.error('removePlaylist failed (delete + removeFromLibrary):', e1.message, '/', e2.message);
      if (/status code 400/.test(e1.message) || /status code 400/.test(e2.message))
        throw new Error('YouTube refused playlist removal on the TV client');
      throw e2;
    }
  }
  feedCache.delete('playlists');
  return true;
}

// Record a watch in the signed-in account's History. Uses getBasicInfo (player
// response ONLY) on the TV session, which skips the watch-next parse that
// crashes VideoInfo on the TV client; addToWatchHistory then pings the
// account's playback-tracking URL. The stream getInfo is anonymous (tubeAnon)
// and can't attribute to the account, so THIS is what makes cathode-played
// videos appear in History. Fire-and-forget from the renderer at play start.
async function recordHistory(videoId) {
  await authReady();
  if (!isSignedIn()) return false;
  // Record the watch by pinging YouTube's playback-tracking (videostats) URL.
  // Attribution is the crux: a URL minted by the ANONYMOUS WEB session doesn't
  // attribute to the account even when pinged with the account's auth (s65:
  // 'tracking via WEB' logged but nothing appeared in History). Only the
  // ACCOUNT's own (authed TV) player response attributes. youtubei.js'
  // getBasicInfo dropped playbackTracking from its PARSED result, but the RAW
  // TV /player response may still carry it -- so try the authed TV /player
  // FIRST (with a real playbackContext) and read it raw; fall back to the
  // attested WEB response only if TV genuinely lacks it.
  try {
    const trackFrom = (pr) => (pr && (pr.playbackTracking || (pr.playerResponse && pr.playerResponse.playbackTracking))) || null;
    const urlFromRaw = (pr) => {
      const pt = trackFrom(pr);
      const u = pt && pt.videostatsPlaybackUrl && pt.videostatsPlaybackUrl.baseUrl;
      return (typeof u === 'string' && u) ? u : null;
    };

    let trackUrl = null, src = '';
    // 1) AUTHED TV /player -- the account's own videostats URL (the only one
    // that attributes). TVHTML5 uses no pot; send a playbackContext like a real
    // TV play.
    try {
      const sigTs = (tubeAuth.session.player && tubeAuth.session.player.signature_timestamp) || (tubeAnon.session.player && tubeAnon.session.player.signature_timestamp) || undefined;
      const tv = await tubeAuth.actions.execute('/player', {
        videoId, contentCheckOk: true, racyCheckOk: true,
        playbackContext: { contentPlaybackContext: { vis: 0, splay: false, lactMilliseconds: '-1', signatureTimestamp: sigTs } }
      });
      const td = tv && tv.data ? tv.data : tv;
      trackUrl = urlFromRaw(td);
      if (trackUrl) src = 'TV';
      else { const p = (td && td.playabilityStatus) || {}; logger.error('recordHistory: TV /player playability=' + (p.status || '?') + ' reason=' + JSON.stringify(p.reason || '').slice(0, 160) + ' sigTs=' + !!sigTs + ' hasKey=' + !!trackFrom(td)); }
    } catch (e) { logger.error('recordHistory: TV /player failed:', e.message); }

    // 2) Fallback: attested anon WEB /player (content-bound pot + playbackContext
    // like getInfo, so it carries playbackTracking). May not attribute, but it's
    // better than nothing and tells us TV is the blocker.
    if (!trackUrl) {
      let poToken = null;
      try { poToken = (await potoken.getPoToken(tubeAnon, videoId)).poToken; } catch (e) { logger.error('recordHistory: pot mint failed:', e.message); }
      const sigTs = tubeAnon.session.player && tubeAnon.session.player.signature_timestamp;
      const webArgs = {
        videoId, contentCheckOk: true, racyCheckOk: true, client: 'WEB',
        playbackContext: { contentPlaybackContext: { vis: 0, splay: false, lactMilliseconds: '-1', signatureTimestamp: sigTs } }
      };
      if (poToken) webArgs.serviceIntegrityDimensions = { poToken };
      try {
        const web = await tubeAnon.actions.execute('/player', webArgs);
        const wd = web && web.data ? web.data : web;
        trackUrl = urlFromRaw(wd);
        if (trackUrl) src = 'WEB';
        else logger.error('recordHistory: WEB /player had no playbackTracking (playability=' + ((wd && wd.playabilityStatus && wd.playabilityStatus.status) || '?') + ', pot=' + !!poToken + ')');
      } catch (e) { logger.error('recordHistory: WEB /player failed:', e.message); }
    }

    if (!trackUrl) { logger.error('Watch-history record failed for', videoId + ': no videostats URL in the player response'); return false; }
    const cpn = ytMod.Utils.generateRandomString(16);
    const client = tubeAuth.session.context.client;
    await tubeAuth.actions.stats(
      trackUrl.replace('https://s.', 'https://www.'),
      { client_name: client.clientName, client_version: client.clientVersion },
      { cpn, fmt: 251, rtn: 0, rt: 0 }
    );
    feedCache.delete('sect:history');
    logger.info(`Recorded watch history for ${videoId} (tracking via ${src})`);
    return true;
  } catch (e) {
    logger.error('Watch-history record failed for', videoId + ':', e.message);
    return false;
  }
}

// Remove a single watched video from the account's History via its
// feedbackToken (surfaced on the history card by findFeedbackToken). Redeems
// with the SAME identity that issued the token (the probe-winning history
// mode) -- feedback tokens are minted per-client and a mismatched redeem can
// no-op or 400. Falls back to the plain authed TV session when no mode is set.
async function removeFromHistory(feedbackToken) {
  await authReady();
  if (!isSignedIn()) throw new Error('Sign in to edit history');
  if (!feedbackToken) throw new Error('No removal token for this item');
  const payload = { feedbackTokens: [feedbackToken], isFeedbackTokenUnencrypted: false, shouldMerge: false };
  if (historyBrowseMode) {
    const token = await historyOauthToken();
    const res = await legacyInnertubeFetch(historyBrowseMode, '/feedback', payload, token);
    const responses = res && res.feedbackResponses;
    if (Array.isArray(responses) && responses.some((r) => r && r.isProcessed === false)) {
      logger.error('removeFromHistory: feedback accepted but NOT processed', JSON.stringify(responses).slice(0, 200));
    }
  } else {
    await tubeAuth.actions.execute('/feedback', payload);
  }
  feedCache.delete('sect:history');
  return true;
}

// --- Rate (like / dislike) + Subscribe, via RAW InnerTube TV endpoints ---
// These run on the tubeAuth (TVHTML5) session so they carry the OAuth Bearer
// AND the TV client context. Native TV clients perform the same actions on the same
// device-code TV login, so they ARE feasible here -- our earlier '400' was
// youtubei.js' helper defaulting to the WEB client (wrong context for a
// TV-scoped token). Calling actions.execute directly keeps the native TV
// context. rating: 'like' | 'dislike' | 'none' (none = removelike, clears both
// a like and a dislike).
async function rateVideo(videoId, rating) {
  await authReady();
  if (!isSignedIn()) throw new Error('Sign in to rate videos');
  const endpoint = rating === 'like' ? '/like/like'
    : rating === 'dislike' ? '/like/dislike'
    : '/like/removelike';
  await tubeAuth.actions.execute(endpoint, { target: { videoId } });
  logger.info(`rate ${videoId}: ${rating}`);
  return true;
}

// Subscribe / unsubscribe a channel by its UC id. subscribe=true subscribes,
// false unsubscribes. Clears the subs cache so the Subscriptions list reflects
// the change on next open.
async function setSubscribed(channelId, subscribe) {
  await authReady();
  if (!isSignedIn()) throw new Error('Sign in to subscribe');
  if (!channelId) throw new Error('No channel for this video');
  const endpoint = subscribe ? '/subscription/subscribe' : '/subscription/unsubscribe';
  await tubeAuth.actions.execute(endpoint, { channelIds: [channelId] });
  feedCache.delete('subs');
  feedCache.delete('subs:channels');
  logger.info(`${subscribe ? 'subscribe' : 'unsubscribe'} ${channelId}`);
  return true;
}

let searchState = null; // { feed, seen } for search infinite scroll

async function search(query) {
  const res = await tubeAnon.search(query, { type: 'video' });
  const videos = extractFeedVideos(res);
  searchState = { feed: res, seen: new Set(videos.map((v) => v.id)) };
  return { title: `Search: ${query}`, videos };
}

// Live autocomplete suggestions for the search field (anonymous WEB client).
// Returns a plain string[] (best-effort; [] on any error so the UI never breaks).
async function searchSuggest(query) {
  const q = (query || '').trim();
  if (!q) return [];
  try {
    const out = await tubeAnon.getSearchSuggestions(q);
    return Array.isArray(out) ? out.filter((s) => typeof s === 'string') : [];
  } catch (e) {
    logger.info('searchSuggest failed:', e.message);
    return [];
  }
}

// Search infinite scroll: follow the Search feed's continuation cursor.
async function getMoreSearch() {
  if (!searchState || !searchState.feed || !searchState.feed.has_continuation) return { videos: [] };
  try {
    const next = await searchState.feed.getContinuation();
    searchState.feed = next;
    const fresh = extractFeedVideos(next).filter((v) => !searchState.seen.has(v.id));
    for (const v of fresh) searchState.seen.add(v.id);
    return { videos: fresh };
  } catch (e) {
    logger.error('Search continuation failed:', e.message);
    return { videos: [] };
  }
}

// --- Player Phase 2 extras: captions, storyboards, chapters, up-next queue ---
// Collected in getStreams from whichever client info carries them (WEB is the
// richest), returned on the streams payload as `extras`. Each is best-effort:
// a missing/failed field just yields [] / null and the UI hides that feature.

function serializeCaptions(info) {
  const tracks = info?.captions?.caption_tracks || [];
  const out = [];
  for (const t of tracks) {
    const base = t.base_url || t.baseUrl;
    if (!base) continue;
    // Request WebVTT (Shaka parses it natively); YouTube honours &fmt=vtt.
    out.push({
      url: base + (base.includes('?') ? '&' : '?') + 'fmt=vtt',
      name: textOf(t.name) || t.language_code || 'CC',
      lang: t.language_code || '',
      kind: t.kind || ''
    });
  }
  return out;
}

function serializeStoryboards(info) {
  const sb = info?.storyboards;
  const boards = (sb && (sb.boards || (Array.isArray(sb) ? sb : null))) || [];
  if (!boards.length) return null;
  // Highest-resolution board = the widest thumbnail.
  const b = boards.reduce((a, c) => (((c.thumbnail_width || 0) > (a.thumbnail_width || 0)) ? c : a), boards[0]);
  const templateUrl = b.template_url || b.templateUrl;
  if (!templateUrl) return null;
  return {
    templateUrl,
    level: (typeof b.level === 'number') ? b.level : boards.indexOf(b),
    width: b.thumbnail_width || 0,
    height: b.thumbnail_height || 0,
    cols: b.columns || 0,
    rows: b.rows || 0,
    interval: b.interval || 0,        // ms per thumbnail
    // TOTAL thumbnail count -- used by the renderer to clamp the seek-preview
    // index. Must be the total, NOT storyboard_count (that is the number of
    // sprite SHEETS = ceil(total / cols*rows), ~12 for a typical video);
    // clamping the thumbnail index to the sheet count froze the preview after
    // a few seconds (s50 fix).
    count: b.thumbnail_count || 0
  };
}

// Best-effort chapters: scan for nodes carrying a title + a start time (ms).
// Returns [{ start (sec), title }] sorted, or [] when none / unrecognised.
function serializeChapters(info) {
  const out = [];
  const seen = new Set();
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) { for (const n of node) visit(n, depth + 1); return; }
    const startMs = node.time_range_start_millis ?? node.timeRangeStartMillis;
    const t = node.title;
    const titleText = typeof t === 'string' ? t : (t && (t.text ?? t.simpleText));
    if (typeof startMs === 'number' && titleText) {
      const key = startMs + '|' + titleText;
      if (!seen.has(key)) { seen.add(key); out.push({ start: startMs / 1000, title: titleText }); }
    }
    for (const k of Object.keys(node)) {
      if (k === 'session' || k === 'actions') continue;
      const v = node[k];
      if (v && typeof v === 'object') visit(v, depth + 1);
    }
  };
  try {
    visit(info?.player_overlays, 0);
    if (!out.length) visit(info?.macro_markers_list, 0);
  } catch {}
  out.sort((a, b) => a.start - b.start);
  return out;
}

// Retained WEB video info (the one carrying watch_next_feed) so the in-player
// suggestions drawer can pull MORE related videos on demand (getMoreRelated).
let lastWatchNext = null; // { id, info }
let lastDlInfo = null;    // { id, info } cache for the download-formats lister (kept
                          // separate from lastWatchNext so listing a context-menu
                          // video does not clobber the playing video's related feed)

// Build the download format list straight from the in-process youtubei.js data
// (streaming_data), so the advanced-download Quality list needs NO yt-dlp.exe spawn
// (which self-unpacks ~1-2 s each call on Windows). We only need itags + metadata
// here, not deciphered URLs, so this is fast and needs no JS runtime. Format ids are
// itags, downloaded by yt-dlp all the same. index.js falls back to yt-dlp -F if this
// returns nothing.
function dlCodecName(mime) {
  const m = /codecs="?([^";]+)"?/.exec(mime || '');
  const c = m ? m[1].split('.')[0] : '';
  return ({ avc1: 'H.264', avc3: 'H.264', vp9: 'VP9', vp09: 'VP9', av01: 'AV1', hev1: 'HEVC', hvc1: 'HEVC', mp4a: 'AAC', opus: 'Opus', vorbis: 'Vorbis', ac3: 'AC3', ec3: 'E-AC3' })[c] || c;
}
function dlExtName(mime) {
  if (/mp4/.test(mime || '')) return 'mp4';
  if (/webm/.test(mime || '')) return 'webm';
  if (/3gpp/.test(mime || '')) return '3gp';
  return '';
}
function dlHumanSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : (mb >= 100 ? String(Math.round(mb)) : mb.toFixed(1)) + ' MB';
}
async function getDownloadFormats(videoId) {
  try {
    let info = (lastWatchNext && lastWatchNext.id === videoId && lastWatchNext.info && lastWatchNext.info.streaming_data) ? lastWatchNext.info
      : (lastDlInfo && lastDlInfo.id === videoId && lastDlInfo.info) ? lastDlInfo.info : null;
    if (!info || !info.streaming_data) { info = await tubeAnon.getInfo(videoId); lastDlInfo = { id: videoId, info }; }
    const sd = info.streaming_data;
    if (!sd) return { ok: false, error: 'No formats available' };
    const all = [...(sd.adaptive_formats || []), ...(sd.formats || [])];
    const vids = [];
    for (const f of all) {
      if (!f.has_video) continue;
      const codec = dlCodecName(f.mime_type);
      const size = dlHumanSize(f.content_length);
      const prog = !!f.has_audio;
      // quality_label already carries fps for HFR (e.g. "1080p60"); only add fps
      // ourselves when falling back to a bare height.
      const fps = (f.fps && f.fps > 30) ? String(f.fps) : '';
      const q = f.quality_label || ((f.height ? f.height + 'p' : 'video') + fps);
      // No container (mp4/webm): the merge container is a separate setting and the
      // codec already implies it; resolution + codec are what the user picks by.
      vids.push({
        _h: f.height || 0, _tbr: f.bitrate || 0, _prog: prog ? 1 : 0, _itag: f.itag, kind: 'video',
        format: prog ? (f.itag + '/best') : (f.itag + '+bestaudio/best'),
        label: q + ' · ' + codec + (prog ? ' · with audio' : '') + (size ? ' · ' + size : '')
      });
    }

    // Audio. IMPORTANT: on multi-language videos YouTube reuses the SAME itag for
    // every language track, so a bare itag downloads yt-dlp's DEFAULT track (usually
    // English), not the one the user picked. So when more than one language is
    // present we offer ONE best entry per language, selected via yt-dlp's language
    // filter `ba[language^=xx]` (which resolves the correct track). Single-language
    // videos keep the per-tier itag entries (accurate + lets you pick low/med/high).
    const audioFmts = all.filter((f) => f.has_audio && !f.has_video);
    const primLang = (f) => String(f.language || '').split('-')[0];
    const distinctLangs = new Set(audioFmts.map(primLang).filter(Boolean));
    let langNames = null; try { langNames = new Intl.DisplayNames(['en'], { type: 'language' }); } catch (e) {}
    const nameOf = (c) => { if (!c) return ''; try { return (langNames && langNames.of(c)) || c; } catch (e) { return c; } };
    const auds = [];
    if (distinctLangs.size > 1) {
      // Multi-language: list EVERY audio format for EVERY language (codec / itag /
      // bitrate), so the user can pick exactly what they want. Each row carries the
      // explicit audioLang + itag + audioTrackId so the SABR downloader (which is
      // the primary audio path) targets the precise track; the `format` string is a
      // yt-dlp language selector kept only for the yt-dlp fallback.
      for (const f of audioFmts) {
        const p = primLang(f) || 'und';
        const abr = Math.round((f.bitrate || f.average_bitrate || 0) / 1000);
        const codec = dlCodecName(f.mime_type), size = dlHumanSize(f.content_length);
        const sr = f.audio_sample_rate ? Math.round(f.audio_sample_rate / 1000) + ' kHz' : '';
        const ch = f.audio_channels === 1 ? 'mono' : f.audio_channels === 2 ? 'stereo' : (f.audio_channels ? f.audio_channels + 'ch' : '');
        const role = f.is_original ? 'original' : (f.is_dubbed || f.is_auto_dubbed) ? 'dubbed' : f.is_descriptive ? 'described' : '';
        const name = nameOf(p) || (p === 'und' ? 'Default' : p);
        // Lead with language + codec + BITRATE (the real differentiator); drop the
        // container (mp4/webm) - it duplicates the codec and only confuses.
        const parts = [name + (role ? ' (' + role + ')' : ''), codec];
        if (abr) parts.push(abr + ' kbps');
        if (sr) parts.push(sr);
        if (ch) parts.push(ch);
        if (f.is_drc) parts.push('DRC');
        if (size) parts.push(size);
        const sel = (p && p !== 'und') ? ('ba[language^=' + p + ']/ba') : 'bestaudio';
        auds.push({ _abr: abr, _itag: f.itag, _lang: name, kind: 'audio', format: sel, label: parts.join(' · '),
          audioLang: p, itag: f.itag, audioTrackId: (f.audio_track && f.audio_track.id) || '' });
      }
    } else {
      for (const f of audioFmts) {
        const codec = dlCodecName(f.mime_type), size = dlHumanSize(f.content_length);
        const abr = Math.round((f.bitrate || f.average_bitrate || 0) / 1000);
        const sr = f.audio_sample_rate ? Math.round(f.audio_sample_rate / 1000) + ' kHz' : '';
        const ch = f.audio_channels === 1 ? 'mono' : f.audio_channels === 2 ? 'stereo' : (f.audio_channels ? f.audio_channels + 'ch' : '');
        const tier = ({ AUDIO_QUALITY_ULTRALOW: 'ultralow', AUDIO_QUALITY_LOW: 'low', AUDIO_QUALITY_MEDIUM: 'medium', AUDIO_QUALITY_HIGH: 'high' })[f.audio_quality] || '';
        // Lead with codec + BITRATE; drop the container (mp4/webm).
        const parts = [tier ? codec + ' ' + tier : codec];
        if (abr) parts.push(abr + ' kbps');
        if (sr) parts.push(sr);
        if (ch) parts.push(ch);
        if (f.is_drc) parts.push('DRC');
        if (size) parts.push(size);
        auds.push({ _abr: abr, _itag: f.itag, kind: 'audio', format: f.itag + '/bestaudio', label: parts.join(' · ') });
      }
    }
    vids.sort((a, b) => b._h - a._h || b._prog - a._prog || b._tbr - a._tbr);
    // Language name first (groups a language's formats together), then bitrate
    // high -> low. Single-language lists have no _lang, so this is a pure bitrate sort.
    auds.sort((a, b) => (a._lang || '').localeCompare(b._lang || '') || (b._abr - a._abr));
    const seen = new Set(); const formats = [];
    for (const v of vids.concat(auds)) {
      let label = v.label;
      if (seen.has(label)) label = label + ' · #' + (v._itag || ''); // never hide a real stream
      if (seen.has(label)) continue;
      seen.add(label);
      // Audio entries carry the explicit pick (itag / language / track id) so the
      // SABR downloader targets the exact format; video entries ignore these.
      formats.push({ format: v.format, label, kind: v.kind, itag: v._itag, audioLang: v.audioLang, audioTrackId: v.audioTrackId });
    }
    const title = (info.basic_info && info.basic_info.title) || videoId;
    // Multi-language: every audio format is listed per language, each carrying an
    // explicit audioLang/itag/audioTrackId so the SABR downloader (primary audio
    // path) targets the exact track - no need to defer to yt-dlp anymore.
    return { ok: true, title, formats, multiAudio: distinctLangs.size > 1 };
  } catch (e) {
    logger.error('getDownloadFormats failed:', e.message);
    return { ok: false, error: 'Could not read formats' };
  }
}

// Up-next queue from the watch-next feed (WEB client populates it). Serialized
// with the shared card serializer; capped so IPC stays small.
function serializeRelated(info) {
  const feed = info?.watch_next_feed;
  if (!Array.isArray(feed)) return [];
  const out = [];
  const seen = new Set();
  for (const node of feed) {
    const v = serializeVideo(node);
    if (v && !seen.has(v.id)) { seen.add(v.id); out.push(v); }
    if (out.length >= 40) break;
  }
  return out;
}

// Pull the NEXT page of related videos for the in-player suggestions drawer,
// using the retained WEB info's watch-next continuation (advanced in place).
// Returns { videos: [] } once exhausted or if the retained info doesn't match.
async function getMoreRelated(videoId, excludeIds) {
  try {
    if (!lastWatchNext || lastWatchNext.id !== videoId || !lastWatchNext.info) return { videos: [] };
    await lastWatchNext.info.getWatchNextContinuation(); // mutates in place; throws when exhausted
    const ex = new Set(excludeIds || []);
    const items = serializeRelated(lastWatchNext.info).filter((v) => !ex.has(v.id));
    return { videos: items };
  } catch (e) {
    logger.info('no more related videos:', e.message);
    return { videos: [] };
  }
}

// On-demand FIRST page of related videos for a given video, independent of what
// the stream payload happened to capture. Used by the drawer when the bundled
// related list came back empty (the anonymous WEB watch_next_feed is sometimes
// empty/sparse for a video the user doesn't normally watch, esp. when reached
// via the queue -- there was no recovery path before this). Reuses the retained
// WEB info when it matches (fast); else does a fresh WEB getInfo (which fetches
// /next) and retains it so getWatchNextContinuation can page further. If the
// first feed is empty, tries one continuation before giving up. Logs raw-vs-kept
// so a device log shows whether the feed is genuinely empty or a parse miss.
async function getRelatedFresh(videoId, excludeIds) {
  const ex = new Set(excludeIds || []);
  const rawLen = (info) => (info && Array.isArray(info.watch_next_feed) ? info.watch_next_feed.length : 0);
  try {
    let info = (lastWatchNext && lastWatchNext.id === videoId && lastWatchNext.info) ? lastWatchNext.info : null;
    let fresh = false;
    if (!info) {
      info = await tubeAnon.getInfo(videoId); // WEB default; includes the /next watch-next feed
      lastWatchNext = { id: videoId, info };
      fresh = true;
    }
    let items = serializeRelated(info).filter((v) => !ex.has(v.id));
    logger.debug(`getRelatedFresh ${videoId}: ${fresh ? 'fresh' : 'cached'} raw=${rawLen(info)} kept=${items.length}`);
    if (!items.length && typeof info.getWatchNextContinuation === 'function') {
      try {
        await info.getWatchNextContinuation();
        items = serializeRelated(info).filter((v) => !ex.has(v.id));
        logger.debug(`getRelatedFresh ${videoId}: after continuation raw=${rawLen(info)} kept=${items.length}`);
      } catch (e2) { logger.info('getRelatedFresh continuation:', e2.message); }
    }
    return { videos: items };
  } catch (e) {
    logger.info('getRelatedFresh failed:', e.message);
    return { videos: [] };
  }
}

// ---- Live chat (read-only) -------------------------------------------------
// A single active LiveChat poller (one video at a time). The renderer probes
// availability at play, then starts/stops the poller when it opens/closes the
// chat panel; serialized chat items are pushed to the renderer over the
// existing push channel (yt:live-chat). LIVE items stream as they arrive;
// REPLAY items (VOD of a past stream) carry a video offset so the renderer can
// gate them against playback position. youtubei.js drives replay on its own
// rough timer (it warns this is inaccurate without player data) -- we forward
// the offset and let the renderer decide timing instead.
let activeLiveChat = null; // { videoId, lc }

// ARGB int (as YouTube ships chat colours) -> css rgba().
function chatColor(n) {
  if (n == null || typeof n !== 'number') return null;
  const a = (n >>> 24) & 255, r = (n >>> 16) & 255, g = (n >>> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
}

// A chat message's text -> an array of runs: { text } for words, { emoji, alt }
// for custom channel emotes (rendered as inline images by the renderer). Plain
// unicode emoji stay as text.
function chatRuns(message) {
  const out = [];
  try {
    const runs = message && message.runs;
    if (Array.isArray(runs) && runs.length) {
      for (const r of runs) {
        if (r && r.emoji && r.emoji.is_custom && Array.isArray(r.emoji.image) && r.emoji.image.length) {
          const img = r.emoji.image[r.emoji.image.length - 1];
          out.push({ emoji: img && img.url, alt: (r.emoji.shortcuts && r.emoji.shortcuts[0]) || '' });
        } else {
          const t = (r && r.text != null) ? r.text : (r && typeof r.toString === 'function' ? r.toString() : '');
          if (t) out.push({ text: t });
        }
      }
      return out;
    }
    const t = message && (message.text != null ? message.text : (typeof message.toString === 'function' ? message.toString() : ''));
    if (t) out.push({ text: t });
  } catch { /* fall through to whatever we collected */ }
  return out;
}

function chatBadges(author) {
  const b = { moderator: !!(author && author.is_moderator), verified: !!(author && author.is_verified), member: false };
  try {
    for (const bd of ((author && author.badges) || [])) {
      const style = (bd && bd.style) || '';
      const tip = (bd && bd.tooltip) || '';
      if (bd && bd.custom_thumbnail) b.member = true;        // member badges carry a channel-specific icon
      if (/MODERATOR/i.test(style)) b.moderator = true;
      if (/VERIFIED/i.test(style)) b.verified = true;
      if (/member/i.test(tip)) b.member = true;
    }
  } catch { /* best effort */ }
  return b;
}

// Serialize a single chat item node to a small plain object for the renderer.
// Only the item types worth showing are kept; everything else returns null.
function serializeChatItem(item) {
  if (!item) return null;
  const type = item.type || '';
  const author = item.author || {};
  const base = {
    id: item.id || '',
    author: author.name || '',
    channelId: author.id || '',   // for moderation removals (delete all by author)
    avatar: (author.thumbnails && author.thumbnails[0] && author.thumbnails[0].url) || '',
    badges: chatBadges(author)
  };
  if (type === 'LiveChatTextMessage') {
    return Object.assign(base, { kind: 'text', runs: chatRuns(item.message) });
  }
  if (type === 'LiveChatPaidMessage') {
    return Object.assign(base, {
      kind: 'paid', runs: chatRuns(item.message), amount: item.purchase_amount || '',
      headerBg: chatColor(item.header_background_color), headerText: chatColor(item.header_text_color),
      bodyBg: chatColor(item.body_background_color), bodyText: chatColor(item.body_text_color)
    });
  }
  if (type === 'LiveChatPaidSticker') {
    const s = item.sticker && item.sticker[item.sticker.length - 1];
    let url = (s && s.url) || '';
    if (url.startsWith('//')) url = 'https:' + url; // sticker thumbs are sometimes protocol-relative
    return Object.assign(base, { kind: 'sticker', amount: item.purchase_amount || '', bodyBg: chatColor(item.background_color), sticker: url });
  }
  if (type === 'LiveChatMembershipItem') {
    let header = 'New member';
    try {
      if (item.header_primary_text) header = item.header_primary_text.toString();
      else if (item.header_subtext) header = item.header_subtext.toString();
    } catch { /* keep default */ }
    return Object.assign(base, { kind: 'membership', runs: chatRuns(item.message), header });
  }
  return null; // placeholders, mode-change, viewer-engagement, tickers, stickers -> skip
}

// Serialize a pinned banner (AddBannerToLiveChatCommand.banner): either a pinned
// text message or a live poll. Returns null for banner content we don't render.
function serializeBanner(b) {
  try {
    const c = b.contents;
    const ct = c && c.type;
    if (ct === 'LiveChatBannerPoll') {
      return { kind: 'poll', question: c.poll_question ? c.poll_question.toString() : '', choices: (c.choices || []).map((x) => x && x.text).filter(Boolean) };
    }
    if (ct === 'LiveChatTextMessage') {
      let header = '';
      try { if (b.header && b.header.text) header = b.header.text.toString(); } catch { /* no header */ }
      return { kind: 'pinned', header, msg: serializeChatItem(c) };
    }
  } catch (e) { logger.info('serializeBanner failed:', e.message); }
  return null;
}

function pushChatItem(item, offsetMs) {
  const m = serializeChatItem(item);
  if (!m) return;
  if (offsetMs != null) m.offsetMs = offsetMs;
  pushToRenderer('yt:live-chat', { kind: 'item', msg: m });
}

// Fetch (or reuse) the WEB VideoInfo and report whether it has a live chat and
// whether that chat is a replay. Reuses the retained watch-next info when it
// matches so this usually costs no extra request.
async function probeLiveChat(videoId) {
  try {
    let info = (lastWatchNext && lastWatchNext.id === videoId && lastWatchNext.info) ? lastWatchNext.info : null;
    if (!info) { info = await tubeAnon.getInfo(videoId); lastWatchNext = { id: videoId, info }; }
    if (!info.livechat) return { available: false };
    return { available: true, isReplay: !!info.livechat.is_replay };
  } catch (e) {
    logger.info('probeLiveChat failed:', e.message);
    return { available: false };
  }
}

async function startLiveChat(videoId, filter) {
  stopLiveChat(); // dispose any prior session first
  let info = (lastWatchNext && lastWatchNext.id === videoId && lastWatchNext.info) ? lastWatchNext.info : null;
  if (!info) {
    try { info = await tubeAnon.getInfo(videoId); lastWatchNext = { id: videoId, info }; }
    catch (e) { logger.error('startLiveChat getInfo failed:', e.message); return { ok: false }; }
  }
  if (!info.livechat) { logger.info(`live chat: none for ${videoId}`); return { ok: false }; }
  let lc;
  try { lc = info.getLiveChat(); } catch (e) { logger.error('getLiveChat failed:', e.message); return { ok: false }; }
  const isReplay = !!lc.is_replay;
  const session = { videoId, lc };
  activeLiveChat = session;
  // One chat action -> a push to the renderer. Adds render a message; the two
  // "mark as deleted" actions (a single message, or every message from one
  // author when a mod deletes/bans them) tell the renderer to remove nodes.
  const handleOne = (node, offsetMs) => {
    const t = node && node.type;
    if (t === 'AddChatItemAction') pushChatItem(node.item, offsetMs);
    else if (t === 'MarkChatItemAsDeletedAction') pushToRenderer('yt:live-chat', { kind: 'delete', id: node.target_item_id });
    else if (t === 'MarkChatItemsByAuthorAsDeletedAction') pushToRenderer('yt:live-chat', { kind: 'delete-author', channelId: node.external_channel_id });
    else if (t === 'AddBannerToLiveChatCommand') { const banner = node.banner ? serializeBanner(node.banner) : null; if (banner) pushToRenderer('yt:live-chat', { kind: 'banner', banner }); }
    else if (t === 'RemoveBannerForLiveChatCommand') pushToRenderer('yt:live-chat', { kind: 'banner-remove' });
  };
  lc.on('chat-update', (action) => {
    if (activeLiveChat !== session) return; // a newer session took over
    try {
      if (action && action.type === 'ReplayChatItemAction') {
        const off = parseInt(action.video_offset_time_msec, 10) || 0;
        for (const ia of (action.actions || [])) handleOne(ia, off);
      } else {
        handleOne(action, null);
      }
    } catch (e) { logger.error('chat-update parse failed:', e.message); }
  });
  lc.on('error', (e) => { if (activeLiveChat === session) logger.info('live chat error:', e && e.message); });
  lc.on('end', () => { if (activeLiveChat === session) pushToRenderer('yt:live-chat', { kind: 'end' }); });
  // Chat mode: the default continuation is "Top chat"; switch to the full "Live
  // chat" firehose only when asked, and only if that sub-menu item exists (live,
  // not replay) -- applying a missing filter would blank the continuation.
  if (filter === 'live' && !isReplay) {
    lc.on('start', (data) => {
      if (activeLiveChat !== session) return;
      try {
        const items = data && data.header && data.header.view_selector && data.header.view_selector.sub_menu_items;
        if (items && items.length > 1 && items[1] && items[1].continuation) lc.applyFilter('LIVE_CHAT');
      } catch (e) { logger.info('applyFilter failed:', e.message); }
    });
  }
  try { lc.start(); } catch (e) { logger.error('live chat start failed:', e.message); activeLiveChat = null; return { ok: false }; }
  logger.info(`live chat started ${videoId} (replay=${isReplay})`);
  return { ok: true, isReplay };
}

function stopLiveChat() {
  if (activeLiveChat) {
    try { activeLiveChat.lc.stop(); } catch { /* already stopped */ }
    activeLiveChat = null;
  }
  return { ok: true };
}

// ---- Comments (read-only) --------------------------------------------------
// The most recent Comments object is retained (for pagination) along with a map
// of comment_id -> CommentThread (for on-demand reply loading). Anonymous read;
// posting/liking would need account writes (M5).
let activeComments = null; // { videoId, comments, threads: Map }

function serializeComment(cv) {
  if (!cv) return null;
  const a = cv.author || {};
  return {
    id: cv.comment_id || '',
    author: a.name || '',
    avatar: (a.thumbnails && a.thumbnails[0] && a.thumbnails[0].url) || '',
    verified: !!a.is_verified,
    owner: !!cv.author_is_channel_owner,
    pinned: !!cv.is_pinned,
    hearted: !!cv.is_hearted,
    member: !!cv.is_member,
    time: cv.published_time || '',
    likes: cv.like_count || '',
    replyCount: cv.reply_count || '',
    runs: chatRuns(cv.content) // reuse the chat text/emoji run serializer
  };
}

function serializeThread(th) {
  const s = serializeComment(th && th.comment);
  if (!s) return null;
  s.hasReplies = !!(th.has_replies);
  return s;
}

async function getVideoComments(videoId, sort) {
  try {
    const sortBy = sort === 'new' ? 'NEWEST_FIRST' : 'TOP_COMMENTS';
    const c = await tubeAnon.getComments(videoId, sortBy);
    const threads = new Map();
    const list = [];
    for (const th of (c.contents || [])) {
      const s = serializeThread(th);
      if (s) { list.push(s); threads.set(s.id, th); }
    }
    activeComments = { videoId, comments: c, threads };
    let count = '';
    try { if (c.header && c.header.comment_count) count = c.header.comment_count.toString(); } catch { /* no count */ }
    logger.info(`getVideoComments ${videoId} (${sortBy}): ${list.length} thread(s), count=${count || '?'}`);
    return { ok: true, count, comments: list, hasMore: !!c.has_continuation };
  } catch (e) {
    logger.info('getVideoComments failed:', e.message);
    return { ok: false };
  }
}

async function getMoreComments(videoId) {
  try {
    if (!activeComments || activeComments.videoId !== videoId || !activeComments.comments) return { comments: [], hasMore: false };
    if (!activeComments.comments.has_continuation) return { comments: [], hasMore: false };
    const next = await activeComments.comments.getContinuation();
    activeComments.comments = next;
    const list = [];
    for (const th of (next.contents || [])) {
      const s = serializeThread(th);
      if (s) { list.push(s); activeComments.threads.set(s.id, th); }
    }
    return { comments: list, hasMore: !!next.has_continuation };
  } catch (e) {
    logger.info('getMoreComments failed:', e.message);
    return { comments: [], hasMore: false };
  }
}

async function getCommentReplies(videoId, commentId) {
  try {
    if (!activeComments || activeComments.videoId !== videoId) return { replies: [] };
    const th = activeComments.threads.get(commentId);
    if (!th || !th.has_replies) return { replies: [] };
    const withReplies = await th.getReplies();
    const list = [];
    for (const cv of ((withReplies && withReplies.replies) || [])) {
      const s = serializeComment(cv);
      if (s) list.push(s);
    }
    return { replies: list };
  } catch (e) {
    logger.info('getCommentReplies failed:', e.message);
    return { replies: [] };
  }
}

// Playback: DASH manifest (adaptive, 1080p+/4K, played via Shaka) with a
// progressive MP4 fallback (muxed audio+video, max 720p).
//
// SABR NOTE: WEB responses now ship adaptive formats WITHOUT URLs
// (server-side ABR) - no DASH manifest is possible from them, PoToken or
// not. IOS is the usual holdout that still returns direct URLs, so the
// hunt below keeps trying clients for DASH instead of stopping at the
// first progressive hit. If every client goes SABR-only one day, the
// upgrade path is UMP/SABR streaming via LuanRT's 'googlevideo' library.
async function getStreams(videoId) {
  await authReady(); // the TV attempt needs the restored session; settled long before a play in practice
  // Mint (or reuse cached) PoToken; CONTENT-BOUND to this videoId (YouTube now
  // binds the GVS pot to the video id -- a visitor-bound token 403s the stream,
  // esp. on seek). Passed per getInfo + set on the shared player so decipher
  // appends `pot=` to the stream URLs.
  let poToken = null;
  try {
    poToken = (await potoken.getPoToken(tubeAnon, videoId)).poToken;
  } catch (e) {
    logger.error('PoToken generation failed (will try clients without it):', e.message);
  }

  // Player.decipher only appends the googlevideo `pot=` param (needed to
  // avoid 403s) when the PLAYER carries the token - getInfo's po_token
  // option covers just the InnerTube request. Set it on the shared player.
  if (poToken && tubeAnon.session.player) tubeAnon.session.player.po_token = poToken;

  const attempts = [
    { label: 'WEB+PoT', skip: !poToken, get: () => tubeAnon.getInfo(videoId, { client: 'WEB', po_token: poToken }) },
    // TV (TVHTML5) via getBasicInfo -- the legacy TV path, and our most reliable
    // seek source. A TV can't run BotGuard, so TV stream URLs need NO GVS
    // PoToken and don't 403 on the byte-range requests Shaka issues when
    // seeking (the IOS URLs do -- the Shaka 1001 flood). This matters now that
    // WEB and ANDROID frequently return SABR-only (0 URLs), leaving IOS as the
    // only URL-ful client -- and IOS then 403s on seek. getBasicInfo fetches
    // only the player response, dodging the TV watch-next parse that crashes
    // getInfo. Needs sign-in (the OAuth TV session); anonymous falls through.
    { label: 'TV', skip: !isSignedIn(), get: () => tubeAuth.getBasicInfo(videoId) },
    // ANDROID before IOS: ANDROID VOD DASH URLs seek reliably WHEN present, but
    // ANDROID has been going SABR-only (0 URLs) too. IOS is the usual URL-ful
    // holdout but its URLs 403 on seek, so it sits below TV/ANDROID.
    { label: 'ANDROID', get: () => tubeAnon.getInfo(videoId, { client: 'ANDROID' }) },
    { label: 'IOS',     get: () => tubeAnon.getInfo(videoId, { client: 'IOS' }) },
    { label: 'WEB',     get: () => tubeAnon.getInfo(videoId) }
  ];

  let lastError = null;
  let meta = null;               // keep best title/author even if streams fail
  let progressiveFallback = null; // first attempt that yielded only a muxed URL
  let liveManifest = null;        // fallback live manifest (DASH) if no HLS is found
  let liveHls = null;             // fallback live HLS from a NON-TV client (last resort)
  let sawLive = false;            // any client reported a live stream

  // Phase 2 extras (captions/storyboards/chapters/up-next), filled from the
  // first client info that carries each (WEB is richest and runs first when a
  // PoToken is available). Returned on every payload as `extras`.
  const extras = { captions: [], storyboards: null, chapters: [], related: [] };
  const fillExtras = (info) => {
    try {
      if (!extras.captions.length) extras.captions = serializeCaptions(info);
      if (!extras.storyboards) extras.storyboards = serializeStoryboards(info);
      if (!extras.chapters.length) extras.chapters = serializeChapters(info);
      if (!extras.related.length) {
        extras.related = serializeRelated(info);
        // Retain the WEB info even when the first page is empty, so the drawer's
        // on-demand getRelatedFresh can page a continuation from it later.
        if (Array.isArray(info.watch_next_feed)) {
          lastWatchNext = { id: videoId, info };
          logger.debug(`getStreams ${videoId} related: raw=${info.watch_next_feed.length} kept=${extras.related.length}`);
        }
      }
    } catch (e) { logger.error('extras collection failed:', e.message); }
  };

  for (const attempt of attempts) {
    if (attempt.skip) continue;
    let info;
    try {
      info = await attempt.get();
    } catch (e) {
      lastError = e;
      logger.error(`getInfo(${attempt.label}) failed:`, e.message);
      continue;
    }

    if (!meta) {
      meta = {
        title: info.basic_info?.title ?? '',
        author: info.basic_info?.author ?? '',
        channelId: info.basic_info?.channel_id ?? null,
        lengthSeconds: info.basic_info?.duration ?? 0
      };
    }
    fillExtras(info);

    // Live streams: toDash() refuses to build a manifest for live, but
    // YouTube ships ready-made HLS/DASH manifest URLs in streaming_data.
    // PREFER a DASH manifest (Shaka plays it cleanly); an HLS-only client is
    // remembered and used only if no client offers DASH -- WEB+PoT often hands
    // back HLS that then 403s in Shaka (error 1001) while ANDROID gives DASH.
    const sd = info.streaming_data;
    // Only treat as LIVE when the video is actually broadcasting. In the SABR
    // era YouTube also ships hls_manifest_url/dash_manifest_url in VOD
    // streaming_data, and those server manifests 403 their segments in Shaka --
    // so keying "live" off the manifest URLs (as before) misrouted normal VODs
    // into the live/HLS path and broke playback (Shaka 1001/403). VOD now falls
    // through to the adaptive-DASH / progressive hunt below.
    if (info.basic_info?.is_live) {
      sawLive = true;
      const hlsUrl = sd?.hls_manifest_url || null;
      const dashUrl = sd?.dash_manifest_url || null;
      // Prefer DASH + /mpd_version/7 for live -- the maintained reference's
      // (LuanRT/kira) live path. Plain dash_manifest_url gives Shaka an
      // unalignable live timeline (black screen, s39); the /mpd_version/7
      // variant is one Shaka aligns, and our googlevideo request filter appends
      // the GVS pot to the DASH segments so they don't 403. HLS is kept as a
      // fallback (it 403s intermittently under pot/SABR enforcement, s36-39).
      if (dashUrl && !liveManifest) {
        liveManifest = { label: attempt.label, manifestUrl: dashUrl.replace(/\/+$/, '') + '/mpd_version/7', manifestType: 'application/dash+xml' };
        logger.debug(`${attempt.label}: live DASH manifest (mpd_version/7)`);
      }
      if (hlsUrl && !liveHls) {
        liveHls = { label: attempt.label, url: hlsUrl };
        logger.debug(`${attempt.label}: live HLS (fallback)`);
      }
      if (!hlsUrl && !dashUrl) logger.debug(`${attempt.label}: live video but no manifest URL; trying next client`);
      continue;
    }

    // SABR diagnostic: URL-less adaptive formats = server-side-ABR-only
    // client, no DASH possible from it.
    const adaptive = info.streaming_data?.adaptive_formats ?? [];
    const adaptiveWithUrl = adaptive.filter((f) => f.url || f.signature_cipher || f.cipher).length;
    logger.debug(`${attempt.label}: ${adaptive.length} adaptive formats, ${adaptiveWithUrl} with URLs`);

    // TV stream URLs must NOT carry the WEB BotGuard PoToken. A TV can't run
    // BotGuard, so its URLs are pot-free by design -- but the shared player
    // (init() lends tubeAuth tubeAnon's player) has po_token set for the
    // WEB/SABR attempts, so any decipher through that player appends the WEB
    // content-bound pot. The googlevideo edge then hands back a non-media
    // error body, which the media element rejects as "Format error"
    // (MediaError 4 / Shaka 3016). Clear the pot around the WHOLE TV attempt:
    // toDash (segment URLs) AND the progressive muxed decipher below (the s66
    // pot-clear wrapped only toDash, so the progressive fallback URL was still
    // pot-tainted). Restored after the progressive block, before any return.
    const share = tubeAnon.session.player;
    const savedPot = (attempt.label === 'TV' && share) ? share.po_token : undefined;
    if (savedPot !== undefined) share.po_token = null;

    let dash = null;
    if (adaptiveWithUrl) {
      try {
        dash = await info.toDash(); // options object API in youtubei.js v17
      } catch (e) {
        lastError = e;
        logger.error(`DASH via ${attempt.label} failed:`, e.message);
      }
    }

    let url = null;
    let mime = null;
    try {
      const formats = info.streaming_data?.formats ?? [];
      let progressive = null;
      for (const f of formats) {
        if (f.has_audio && f.has_video && (f.url || f.signature_cipher || f.cipher)) {
          if (!progressive || (f.bitrate ?? 0) > (progressive.bitrate ?? 0)) progressive = f;
        }
      }
      if (progressive) {
        // decipher() is ASYNC in v17 - without await it "succeeds" with a
        // Promise (truthy, unplayable, rejection escapes as unhandled).
        url = await progressive.decipher(info.actions?.session?.player ?? tubeAnon.session.player);
        mime = progressive.mime_type ?? null;
      }
    } catch (e) {
      lastError = e;
      logger.error(`Progressive decipher via ${attempt.label} failed:`, e.message);
    }
    if (savedPot !== undefined) share.po_token = savedPot;
    if (attempt.label === 'TV' && url && /[?&]pot=/.test(url)) logger.error('TV progressive URL STILL carries pot= (unexpected)');

    // s67c: PROBE TV URLs before trusting them. The s67b self-test proved the
    // TV client's googlevideo URLs are rejected outright (HTTP 403, empty
    // body) with AND without the WEB pot, even from the main process -- so a
    // TV "win" here hands the player dead URLs and BLOCKS the ANDROID/IOS
    // fallbacks that used to play these videos (pre-s66 behaviour). Fetch the
    // first init range once; on a definite non-2xx discard the TV streams and
    // let the client hunt continue. Probe runs for the TV attempt only.
    if (attempt.label === 'TV' && (dash || url)) {
      let probeUrl = url;
      if (dash) {
        const bm = /<BaseURL>([^<]+)<\/BaseURL>/.exec(dash);
        if (bm) probeUrl = bm[1].replace(/&amp;/g, '&');
      }
      let probeStatus = 0;
      try {
        const r = await fetch(probeUrl, { headers: { Range: 'bytes=0-1918' } });
        probeStatus = r.status;
      } catch (e) { probeStatus = -1; } // network error: keep the URLs (benefit of the doubt)
      if (probeStatus >= 200 && probeStatus < 300) {
        logger.debug(`TV URL probe OK (HTTP ${probeStatus})`);
      } else if (probeStatus > 0) {
        logger.error(`TV URLs rejected by googlevideo (HTTP ${probeStatus}) -- discarding TV streams, trying the next client`);
        if (dash) debugDump('debug_tv_dash.xml', dash);
        dash = null; url = null; mime = null;
      }
    }

    if (dash) {
      logger.info(`Streams resolved via ${attempt.label} client (dash: true, progressive: ${!!url})`);
      // Diagnostic: if the media element still rejects the TV DASH (MediaError 4
      // "Format error"), the codec spread + the dumped manifest pinpoint whether
      // it's an unsupported codec or a malformed manifest rather than the pot.
      return { id: videoId, ...meta, dash, url, mime, extras };
    }
    if (url && !progressiveFallback) {
      progressiveFallback = { label: attempt.label, url, mime };
      // keep hunting other clients for DASH before settling
    }
  }

  // If no client yielded a live DASH manifest, try the signed-in TV client's
  // getBasicInfo (it sometimes carries a manifest the anon clients don't).
  if (sawLive && isSignedIn() && !liveManifest) {
    try {
      const tvInfo = await tubeAuth.getBasicInfo(videoId);
      const tsd = tvInfo.streaming_data;
      if (tsd?.dash_manifest_url) {
        liveManifest = { label: 'TV', manifestUrl: tsd.dash_manifest_url.replace(/\/+$/, '') + '/mpd_version/7', manifestType: 'application/dash+xml' };
      } else if (tsd?.hls_manifest_url && !liveHls) {
        liveHls = { label: 'TV', url: tsd.hls_manifest_url };
      }
    } catch (e) {
      logger.error('TV getBasicInfo for live manifest failed:', e.message);
    }
  }

  // Prefer DASH + /mpd_version/7 for live (the reference's path: Shaka aligns
  // its timeline and our pot filter authorises the segments). HLS is the
  // fallback when no DASH manifest is available (it 403s intermittently under
  // pot/SABR enforcement).
  if (liveManifest) {
    logger.info(`Live via ${liveManifest.label} (dash mpd_version/7)`);
    return { id: videoId, ...(meta || { title: '', author: '', lengthSeconds: 0 }), isLive: true, manifestUrl: liveManifest.manifestUrl, manifestType: liveManifest.manifestType, dash: null, url: null, mime: null, poToken, extras };
  }

  if (liveHls) {
    logger.info(`Live via ${liveHls.label} (hls fallback)`);
    return { id: videoId, ...(meta || { title: '', author: '', lengthSeconds: 0 }), isLive: true, manifestUrl: liveHls.url, manifestType: 'application/x-mpegurl', dash: null, url: null, mime: null, poToken, extras };
  }

  if (progressiveFallback) {
    logger.info(`No DASH from any client; progressive via ${progressiveFallback.label} (max ~720p)`);
    return {
      id: videoId,
      ...(meta || { title: '', author: '', lengthSeconds: 0 }),
      dash: null,
      url: progressiveFallback.url,
      mime: progressiveFallback.mime,
      extras
    };
  }

  // Everything failed -- invalidate THIS video's PoToken so the next attempt
  // regenerates it (tokens/challenges rotate server-side).
  potoken.invalidate(videoId);
  logger.error('All stream clients failed for', videoId, lastError || '');
  return { id: videoId, ...(meta || { title: '', author: '', lengthSeconds: 0 }), dash: null, url: null, mime: null, extras };
}

// --- SABR streaming (playback rework, path B) ---
// Server-ABR path for VOD. The WEB client returns a server_abr_streaming_url
// plus a ustreamer config; googlevideo's SabrStreamingAdapter (renderer side)
// uses those + the SABR-flavoured DASH manifest that youtubei.js builds
// (toDash({ is_sabr: true })) to fetch UMP/SABR segments. That is what fixes
// the VOD seek-403 the byte-range GET path hits.
//
// LIVE / POST-LIVE are deliberately NOT routed through SABR (this matches
// LuanRT/kira, the maintained reference): they keep loading the ready-made
// manifest URL. getSabr returns { ok:false, reason:'live' } for them and the
// renderer falls back to the classic getStreams path.
//
// googlevideo is imported LAZILY so a missing dependency (before the user runs
// `npm install googlevideo`) can't break boot or the classic playback path --
// getSabr just returns ok:false and the renderer falls back.
let gvUtils = null;
async function loadGvUtils() {
  if (!gvUtils) gvUtils = await import('googlevideo/utils');
  return gvUtils;
}

function clientInfoFor(tube) {
  const c = tube.session.context.client;
  const nameId = ytMod.Constants && ytMod.Constants.CLIENT_NAME_IDS && ytMod.Constants.CLIENT_NAME_IDS[c.clientName];
  return {
    osName: c.osName,
    osVersion: c.osVersion,
    clientName: nameId ? parseInt(nameId, 10) : undefined,
    clientVersion: c.clientVersion
  };
}

function ustreamerConfigOf(info) {
  return info && info.player_config && info.player_config.media_common_config
    && info.player_config.media_common_config.media_ustreamer_request_config
    && info.player_config.media_common_config.media_ustreamer_request_config.video_playback_ustreamer_config
    || null;
}

// Build the SABR payload for a VOD. Returns { ok:true, ... } on success, or
// { ok:false, reason } so the renderer can decide to fall back to getStreams.
async function getSabr(videoId, preferredLang, opts) {
  opts = opts || {};
  let poToken = null;
  try {
    poToken = (await potoken.getPoToken(tubeAnon, videoId)).poToken;
  } catch (e) {
    logger.error('SABR: PoToken mint failed:', e.message);
  }
  // decipher() only appends the GVS pot= to URLs when the player carries it.
  if (poToken && tubeAnon.session.player) tubeAnon.session.player.po_token = poToken;

  let info;
  try {
    info = await tubeAnon.getInfo(videoId, { client: 'WEB', po_token: poToken });
  } catch (e) {
    logger.error('SABR: WEB getInfo failed:', e.message);
    return { ok: false, reason: 'error', message: e.message };
  }

  // Gating check: an anonymous WEB getInfo still lists formats for age/
  // login/region-gated videos (racyCheckOk/contentCheckOk bypass the /player
  // gate), but the SABR segment server then refuses to stream to the anonymous
  // session -- empty UMP responses, which is the seek-fallback-to-IOS cause on
  // gated content. Surface the playability so a failing video can be checked.
  const ps = info.playability_status;
  if (ps && ps.status && ps.status !== 'OK') logger.debug(`SABR ${videoId}: WEB playability=${ps.status}${ps.reason ? ' (' + ps.reason + ')' : ''}`);

  // Live / post-live-DVR stay on the manifest path (SABR is VOD-only here).
  if (info.basic_info && (info.basic_info.is_live || info.basic_info.is_post_live_dvr)) {
    return { ok: false, reason: 'live' };
  }

  const sd = info.streaming_data;
  if (!sd || !sd.server_abr_streaming_url) {
    logger.error('SABR: no server_abr_streaming_url on WEB streaming_data (youtubei.js too old?)');
    return { ok: false, reason: 'no-sabr' };
  }

  // s67d + s107b: collapse same-itag audio VARIANTS to a single track. YouTube
  // ships several audio formats under ONE itag, split by xtags: "Stable Volume"
  // / "Voice Boost" (drc/vb) on some videos, and per-language DUBBED tracks on
  // multi-audio videos. When more than one such variant is present, the SABR
  // server ACCEPTS a request for one of them but streams ZERO bytes (empty UMP,
  // protStatus=1, err=none) -- that is the whole empty-UMP-then-fallback-to-IOS
  // class (s66/s67 was the drc case; the multi-audio/dubbed case, e.g. itag 140
  // with per-language variants, slipped past the drc-only filter). Fix: for any
  // audio itag with >1 format, keep exactly ONE, preferring what the real web
  // player uses -- drc > original > audio-default > first -- in BOTH the SABR
  // manifest (toDash reads sd.adaptive_formats) and the sabr format list.
  // No-op for normal single-audio videos (one format per itag). TRADEOFF: this
  // drops alternate dubbed languages from SABR playback, but these videos
  // otherwise don't SABR-play at all (they fall to IOS, which 403s mid-stream).
  // In-player language switching (approach A, s129): the collapse still keeps
  // ONE audio format per itag (SABR stays healthy), but we (a) surface the
  // distinct audio languages available BEFORE the collapse so the renderer can
  // list them, and (b) when the caller passes preferredLang, keep THAT
  // language's format instead of the web-player default. Switching languages is
  // a re-fetch at the current timestamp (renderer), so no SABR regression.
  let audioTracks = [];          // [{ code, variant, name, original, default }] per (language, processing-variant)
  let selectedAudioLang = '';    // primary language code we collapsed to / the default track's
  let selectedAudioVariant = ''; // '' (normal) | 'drc' (Stable Volume) | 'vb' (Voice Boost)
  const preferredVariant = opts.preferredVariant || ''; // 'drc' | 'vb' | 'plain' | '' (default)
  if (Array.isArray(sd.adaptive_formats)) {
    const isAudio = (f) => (f.mime_type || '').startsWith('audio');
    const primLang = (f) => String(f.language || '').split('-')[0];
    const variantOf = (f) => f.is_drc ? 'drc' : f.is_vb ? 'vb' : '';
    let langNames = null; try { langNames = new Intl.DisplayNames(['en'], { type: 'language' }); } catch (e) {}
    const nameOf = (c) => { if (!c) return ''; try { return (langNames && langNames.of(c)) || c; } catch (e) { return c; } };

    // Audio menu options: one row per (language, processing-variant). Plain
    // language rows switch NATIVELY (Shaka selectAudioLanguage); Stable Volume
    // (drc) / Voice Boost (vb) rows RELOAD to that exact format - their SABR
    // unique keys can collide with the normal track, so native can't target them.
    const seen = new Map();
    for (const f of sd.adaptive_formats) if (isAudio(f)) {
      const code = primLang(f); if (!code) continue;
      const variant = variantOf(f);
      const key = code + '|' + variant;
      const isDefault = !!(f.audio_track && f.audio_track.audio_is_default);
      const isOrig = !!f.is_original || isDefault;
      if (!seen.has(key)) {
        const base = nameOf(code) || code;
        const suffix = variant === 'drc' ? ' (Stable Volume)' : variant === 'vb' ? ' (Voice Boost)'
          : (f.is_dubbed || f.is_auto_dubbed) ? ' (dubbed)' : f.is_descriptive ? ' (described)' : '';
        seen.set(key, { code, variant, name: base + suffix, original: isOrig, default: isDefault });
      } else {
        const e = seen.get(key); if (isOrig) e.original = true; if (isDefault) e.default = true;
      }
    }
    const distinctLangs = new Set([...seen.values()].map((t) => t.code));
    if (distinctLangs.size > 1 || seen.size > 1) {
      const vord = { '': 0, drc: 1, vb: 2 };
      audioTracks = [...seen.values()].sort((a, b) =>
        (Number(b.original) - Number(a.original)) ||
        (nameOf(a.code) || a.code).localeCompare(nameOf(b.code) || b.code) ||
        ((vord[a.variant] || 0) - (vord[b.variant] || 0)));
    }

    // The SABR unique-format key (mirrors the vendor getUniqueFormatId, plus -vb
    // which the vendor omits): audio = itag-<audioTrackId>[-drc][-vb]. Logged below.
    const fmtKey = (f) => `${f.itag}${(f.audio_track && f.audio_track.id) ? '-' + f.audio_track.id : ''}${f.is_drc ? '-drc' : ''}${f.is_vb ? '-vb' : ''}`;

    if (opts.multiAudio) {
      // Approach C (default): DON'T collapse. Keep every language Representation
      // so Shaka exposes them as native audio tracks. (Processing variants still
      // go through a collapsed reload - see preferredVariant below.)
      const audioFmts = sd.adaptive_formats.filter(isAudio);
      const orig = audioFmts.find((f) => f.is_original || (f.audio_track && f.audio_track.audio_is_default)) || audioFmts[0];
      if (orig) { selectedAudioLang = primLang(orig); selectedAudioVariant = variantOf(orig); }
      logger.debug(`SABR ${videoId} multiAudio(C): NOT collapsing; audio keys = ${audioFmts.map((f) => fmtKey(f) + '(lang=' + (f.language || '-') + ')').join(' | ')}`);
    } else {
      const byItag = new Map();
      for (const f of sd.adaptive_formats) if (isAudio(f)) {
        if (!byItag.has(f.itag)) byItag.set(f.itag, []);
        byItag.get(f.itag).push(f);
      }
      const keep = new Set();
      const dropped = [];
      for (const [itag, group] of byItag) {
        if (group.length <= 1) { keep.add(group[0]); continue; }
        let pool = group;
        if (preferredLang) {
          const m = group.filter((f) => primLang(f) === preferredLang);
          if (m.length) pool = m;
        }
        const pick =
          (preferredVariant === 'drc' && pool.find((f) => f.is_drc)) ||
          (preferredVariant === 'vb' && pool.find((f) => f.is_vb)) ||
          (preferredVariant === 'plain' && pool.find((f) => !f.is_drc && !f.is_vb)) ||
          pool.find((f) => f.is_drc) ||
          pool.find((f) => f.is_original) ||
          pool.find((f) => f.audio_track && f.audio_track.audio_is_default) ||
          pool[0];
        keep.add(pick);
        if (!selectedAudioLang) { selectedAudioLang = primLang(pick); selectedAudioVariant = variantOf(pick); }
        const why = (preferredVariant && pool.includes(pick)) ? preferredVariant : (preferredLang && pool !== group) ? 'lang' : pick.is_drc ? 'drc' : pick.is_original ? 'orig' : (pick.audio_track && pick.audio_track.audio_is_default) ? 'default' : 'first';
        dropped.push(`${itag}[${group.length}->1 ${why} lang=${pick.language || '-'}]`);
      }
      if (dropped.length) {
        const before = sd.adaptive_formats.length;
        sd.adaptive_formats = sd.adaptive_formats.filter((f) => !isAudio(f) || keep.has(f));
        logger.debug(`SABR ${videoId}: collapsed audio variants ${dropped.join(', ')} (${before} -> ${sd.adaptive_formats.length} formats)`);
      }
      // No collapse happened (single format per itag) but languages still differ:
      // derive the current track from the first kept audio format for the menu.
      if (!selectedAudioLang && audioTracks.length) {
        const firstAudio = sd.adaptive_formats.find(isAudio);
        if (firstAudio) { selectedAudioLang = primLang(firstAudio); selectedAudioVariant = variantOf(firstAudio); }
      }
    }
  }

  let streamingUrl, dashManifest, sabrFormats;
  try {
    const { buildSabrFormat } = await loadGvUtils();
    streamingUrl = await tubeAnon.session.player.decipher(sd.server_abr_streaming_url);
    // buildSabrFormat (current googlevideo) copies is_drc but DROPS is_vb; add it
    // so the renderer's format key can encode Voice Boost (-vb) and resolve it to
    // Shaka's distinct vb audio track instead of colliding with the normal one.
    sabrFormats = (sd.adaptive_formats || []).map((f) => { const sf = buildSabrFormat(f); if (sf) sf.isVb = !!f.is_vb; return sf; });
    const xml = await info.toDash({ manifest_options: { is_sabr: true, captions_format: 'vtt', include_thumbnails: false } });
    dashManifest = Buffer.from(xml, 'utf8').toString('base64');
    if (opts.multiAudio) {
      // Diagnostic for approach C: list the DASH audio Representation ids so we
      // can confirm they match the SABR unique-format keys logged above (if they
      // collide on bare itag, Shaka can't expose per-language tracks -> empty UMP).
      try {
        const repIds = (xml.match(/<Representation\b[^>]*\bid="[^"]*"/g) || [])
          .map((s) => { const m = s.match(/id="([^"]*)"/); return m ? m[1] : ''; });
        const audioSets = (xml.match(/<AdaptationSet\b[^>]*(audio|mp4a|opus)[^>]*>/gi) || []).length;
        logger.debug(`SABR ${videoId} multiAudio(C): DASH Representation ids = [${repIds.join(', ')}] audioAdaptationSets~=${audioSets}`);
      } catch (e) { logger.info('SABR multiAudio(C): rep-id log failed: ' + e.message); }
    }
  } catch (e) {
    logger.error('SABR: building streaming payload failed:', e.message);
    return { ok: false, reason: 'error', message: e.message };
  }

  // Reuse the Phase 2 extra serializers so SABR playback keeps captions /
  // chapters / storyboards / up-next.
  const extras = { captions: [], storyboards: null, chapters: [], related: [] };
  try {
    extras.captions = serializeCaptions(info);
    extras.storyboards = serializeStoryboards(info);
    extras.chapters = serializeChapters(info);
    extras.related = serializeRelated(info);
    logger.debug(`SABR ${videoId} related: raw=${Array.isArray(info.watch_next_feed) ? info.watch_next_feed.length : 0} kept=${extras.related.length}`);
    // Retain the WEB info for continuation/on-demand refetch even when the first
    // page is empty (getRelatedFresh can then page it), matching getRelatedFresh.
    lastWatchNext = { id: videoId, info };
  } catch (e) { logger.error('SABR extras failed:', e.message); }

  const uConfig = ustreamerConfigOf(info);
  const sigTs = (tubeAnon.session.player && tubeAnon.session.player.signature_timestamp) || null;
  if (!uConfig) logger.error(`SABR: missing ustreamerConfig for ${videoId} -- SABR segments come back empty; the renderer then falls back to classic getStreams.`);
  logger.info(`SABR payload built for ${videoId} (${sabrFormats.length} formats; ustreamer=${!!uConfig} streamingUrl=${!!streamingUrl} poToken=${!!poToken} sigTs=${!!sigTs})`);
  return {
    ok: true,
    id: videoId,
    title: (info.basic_info && info.basic_info.title) || '',
    author: (info.basic_info && info.basic_info.author) || '',
    channelId: (info.basic_info && info.basic_info.channel_id) || null,
    lengthSeconds: (info.basic_info && info.basic_info.duration) || 0,
    isLive: false,
    dashManifest,                 // base64 SABR DASH; renderer loads via data: URI
    streamingUrl,                 // deciphered server_abr_streaming_url
    ustreamerConfig: uConfig,
    sabrFormats,                  // adaptive_formats.map(buildSabrFormat)
    clientInfo: clientInfoFor(tubeAnon),
    signatureTimestamp: sigTs,
    poToken,
    audioTracks,                  // per (language, processing-variant) options for the audio menu
    selectedAudioLang,            // primary language code currently selected/collapsed to
    selectedAudioVariant,         // '' | 'drc' (Stable Volume) | 'vb' (Voice Boost)
    extras
  };
}

// The SABR server can ask the client to reload the player response mid-stream
// (onReloadPlayerResponse). Re-run /player with the reload context and hand the
// adapter the fresh streaming URL + ustreamer config. Best-effort.
async function reloadSabrPlayer(videoId, reloadContext) {
  const player = await tubeAnon.actions.execute('/player', {
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: {
      contentPlaybackContext: { signatureTimestamp: tubeAnon.session.player && tubeAnon.session.player.signature_timestamp },
      reloadPlaybackContext: reloadContext
    }
  });
  const cpn = ytMod.Utils.generateRandomString(16);
  const info = new ytMod.YT.VideoInfo([player], tubeAnon.actions, cpn);
  const sd = info.streaming_data;
  const streamingUrl = sd && sd.server_abr_streaming_url
    ? await tubeAnon.session.player.decipher(sd.server_abr_streaming_url) : null;
  return { streamingUrl, ustreamerConfig: ustreamerConfigOf(info) };
}

// Content-bound PoToken for the renderer adapter's onMintPoToken callback.
async function mintPoToken(videoId) {
  try { return (await potoken.getPoToken(tubeAnon, videoId)).poToken; }
  catch (e) { logger.error('SABR: mintPoToken failed:', e.message); return ''; }
}

// PoToken + matching visitorData for a yt-dlp DOWNLOAD via the mweb client.
// IMPORTANT: for a logged-out mweb GVS request the PO token is bound to the
// VISITOR (visitor_data), NOT the video id - a content/videoId-bound token (what
// the web client + playback use) 403s on mweb's stream URLs. So mint a
// visitor-bound token (no videoId) and hand yt-dlp the matching visitor_data.
// Cached 6h (shared visitor-bound entry), so it's minted at most once per session.
// (videoId kept in the signature for the caller; intentionally unused here.)
async function getDownloadPoToken(videoId) { // eslint-disable-line no-unused-vars
  try {
    const r = await potoken.getPoToken(tubeAnon); // no videoId -> visitor-bound
    return { poToken: r.poToken || '', visitorData: r.visitorData || '' };
  } catch (e) { logger.error('getDownloadPoToken failed:', e.message); return null; }
}

// SABR payload for an in-app DOWNLOAD (not playback). Same WEB /player route as
// getSabr, but tuned for a headless googlevideo SabrStream in main: we do NOT
// collapse the per-language audio variants (a download wants to pick ONE exact
// dubbed track), and we skip the DASH manifest + captions/chapters/related
// extras (playback-only). Returns everything SabrStream needs plus a light
// audioFormats metadata list so the caller can choose a track + size progress.
// This is the fix for the dub-download 403: reuse the playback SABR path (which
// streams these tracks fine) instead of yt-dlp, whose separate mweb session
// carries a mismatched token identity.
async function getSabrForDownload(videoId) {
  let poToken = null;
  try { poToken = (await potoken.getPoToken(tubeAnon, videoId)).poToken; }
  catch (e) { logger.error('SABR-DL: PoToken mint failed:', e.message); }
  if (poToken && tubeAnon.session.player) tubeAnon.session.player.po_token = poToken;

  let info;
  try { info = await tubeAnon.getInfo(videoId, { client: 'WEB', po_token: poToken }); }
  catch (e) { logger.error('SABR-DL: WEB getInfo failed:', e.message); return { ok: false, reason: 'error', message: e.message }; }

  if (info.basic_info && (info.basic_info.is_live || info.basic_info.is_post_live_dvr)) return { ok: false, reason: 'live' };
  const sd = info.streaming_data;
  if (!sd || !sd.server_abr_streaming_url) { logger.error('SABR-DL: no server_abr_streaming_url on WEB streaming_data'); return { ok: false, reason: 'no-sabr' }; }

  let streamingUrl, sabrFormats;
  try {
    const { buildSabrFormat } = await loadGvUtils();
    streamingUrl = await tubeAnon.session.player.decipher(sd.server_abr_streaming_url);
    // Keep ALL formats (no collapse). Carry -vb like getSabr does so the audio
    // key can encode Voice Boost if ever needed.
    sabrFormats = (sd.adaptive_formats || []).map((f) => { const sf = buildSabrFormat(f); if (sf) sf.isVb = !!f.is_vb; return sf; });
  } catch (e) {
    logger.error('SABR-DL: building streaming payload failed:', e.message);
    return { ok: false, reason: 'error', message: e.message };
  }

  const primLang = (f) => String(f.language || '').split('-')[0];
  let langNames = null; try { langNames = new Intl.DisplayNames(['en'], { type: 'language' }); } catch (e) {}
  const nameOf = (c) => { if (!c) return ''; try { return (langNames && langNames.of(c)) || c; } catch (e) { return c; } };
  const audioFormats = (sd.adaptive_formats || []).filter((f) => (f.mime_type || '').startsWith('audio')).map((f) => ({
    itag: f.itag,
    audioTrackId: (f.audio_track && f.audio_track.id) || '',
    language: f.language || null,
    primLang: primLang(f),
    name: nameOf(primLang(f)) || (primLang(f) || 'default'),
    isDrc: !!f.is_drc,
    isVb: !!f.is_vb,
    isOriginal: !!f.is_original || !!(f.audio_track && f.audio_track.audio_is_default),
    isDubbed: !!f.is_dubbed || !!f.is_auto_dubbed,
    isDescriptive: !!f.is_descriptive,
    mimeType: f.mime_type || '',
    ext: dlExtName(f.mime_type),
    bitrate: f.bitrate || f.average_bitrate || 0,
    contentLength: Number(f.content_length) || 0
  }));

  // Extras for ffmpeg post-processing (metadata / cover art / chapters), matching
  // what the yt-dlp path embeds. Best-effort: any of these can be empty.
  let thumbnailUrl = '';
  try {
    const thumbs = (info.basic_info && info.basic_info.thumbnail) || [];
    if (Array.isArray(thumbs) && thumbs.length) {
      const best = thumbs.slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0];
      thumbnailUrl = (best && best.url) || '';
    }
  } catch (e) {}
  let chapters = [];
  try { chapters = serializeChapters(info) || []; } catch (e) {}

  const uConfig = ustreamerConfigOf(info);
  if (!uConfig) logger.error(`SABR-DL: missing ustreamerConfig for ${videoId} -- SabrStream will get empty segments.`);
  logger.debug(`SABR-DL payload for ${videoId} (${sabrFormats.length} formats, ${audioFormats.length} audio; ustreamer=${!!uConfig} pot=${!!poToken} chapters=${chapters.length} thumb=${!!thumbnailUrl}); audio langs = ${audioFormats.map((a) => a.primLang + (a.isDrc ? '/drc' : '') + (a.isVb ? '/vb' : '')).join(',')}`);
  return {
    ok: true,
    id: videoId,
    title: (info.basic_info && info.basic_info.title) || videoId,
    author: (info.basic_info && info.basic_info.author) || '',
    description: (info.basic_info && info.basic_info.short_description) || '',
    durationMs: Math.round(((info.basic_info && info.basic_info.duration) || 0) * 1000),
    streamingUrl,
    ustreamerConfig: uConfig,
    clientInfo: clientInfoFor(tubeAnon),
    poToken,
    sabrFormats,
    audioFormats,
    thumbnailUrl,
    chapters                      // [{ start (sec), title }]
  };
}

// Rebuild both sessions to pick up a new content language / country. The
// renderer persists contentLang/contentCountry to ui_settings.json FIRST
// (init() reads them via localePrefs), then calls this. Re-running init() with
// the callbacks stored on the first boot recreates both sessions with the new
// locale, re-wires the auth events and re-restores the selected account; we
// also drop the in-memory feed cache so localized feeds refetch. The renderer
// then reloads the current section. Locale changes are rare, so paying a full
// data-layer re-init here is fine.
async function setLocale() {
  clearFeedCache();
  return init(cbAuthPending, cbAuthSuccess, cbAuthRestored);
}

module.exports = { init, setLocale, signIn, signOut, isSignedIn, listAccounts, addAccount, selectAccount, removeAccount, setStartup, setDefaultAccount, getStartupInfo, setPushSender, getHomeFeed, getSubscriptionsFeed, getSubscriptionChannels, getChannelFeed, getChannelPage, getSection, getPlaylists, getPlaylistFeed, getMusic, addToPlaylist, removeFromPlaylist, removePlaylist, recordHistory, removeFromHistory, rateVideo, setSubscribed, getMoreFeed, loadMoreShelf, search, searchSuggest, getStreams, getSabr, reloadSabrPlayer, mintPoToken, getDownloadPoToken, getSabrForDownload, getMoreRelated, getRelatedFresh, getDownloadFormats, probeLiveChat, startLiveChat, stopLiveChat, getVideoComments, getMoreComments, getCommentReplies, setDebugDumps };
