// SPDX-License-Identifier: GPL-3.0-or-later
// PoToken (Proof-of-Origin token) generation - REAL-BROWSER approach.
//
// WHY THE OLD jsdom ROUTE FAILED: BotGuard's VM fingerprints its runtime.
// jsdom is a fake DOM, so attestation was refused - GenerateIT returned
// integrityToken=null and only a low-trust websafe fallback token.
//
// THE FIX (approach used by FreeTube): run the whole flow inside a hidden,
// offscreen, sandboxed Chromium page whose base URL is youtube.com. The
// BotGuard VM then sees a genuine browser (real DOM, real Chromium, real
// screen metrics) and Google issues the full integrity token.
//
// Implementation is our own. The small in-page BotGuard-VM/minter glue is
// adapted from bgutils-js (MIT License, Copyright (c) LuanRT) - see
// https://github.com/LuanRT/BgUtils - since npm modules can't be imported
// into the throwaway page without a bundling step.
//
// HEADER FIXUPS (session 12): the data: page has an OPAQUE origin, so every
// fetch is cross-origin. Three things are required for the fetches to pass:
//  1. /youtubei/ requests must LOOK same-origin: Referer/Origin AND the
//     Sec-Fetch-Site/Mode headers forced to youtube.com/same-origin
//     (Chromium sets Sec-Fetch-* itself; only webRequest can override).
//  2. Response CORS injection must REPLACE any existing
//     access-control-allow-* headers - appending next to an original one
//     yields duplicate ACAO values, which browsers hard-fail
//     ('Failed to fetch').
//  3. cspReport/ping requests blocked; the interpreter script request gets
//     script-y Sec-Fetch headers.
//
// Isolation: the page runs in its own in-memory session partition
// ('potoken', no persist prefix → nothing on disk), permissions denied,
// popups denied, audio muted, destroyed after each generation. It never
// sees user credentials - only the anonymous session's visitorData.

const { BrowserWindow, session } = require('electron');
const logger = require('./logger');

// Public request key used by YouTube's web client for WAA/BotGuard.
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
const TTL_MS = 6 * 60 * 60 * 1000; // regenerate after 6h
const GEN_TIMEOUT_MS = 45000;

let cached = null;   // { poToken, visitorData, ts }
let inFlight = null; // dedupe concurrent generations
let potSession = null;

function getPotSession() {
  if (potSession) return potSession;

  // In-memory partition: isolated from app data, gone on app exit.
  potSession = session.fromPartition('potoken');
  potSession.setPermissionRequestHandler((wc, permission, cb) => cb(false));
  potSession.setPermissionCheckHandler(() => false);

  potSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://www.youtube.com/*', 'https://*.google.com/*'] },
    ({ url, requestHeaders }, cb) => {
      if (url.startsWith('https://www.youtube.com/youtubei/')) {
        // InnerTube rejects requests whose Referer/Origin isn't YouTube.
        requestHeaders['Referer'] = 'https://www.youtube.com/';
        requestHeaders['Origin'] = 'https://www.youtube.com';
        requestHeaders['Sec-Fetch-Site'] = 'same-origin';
        requestHeaders['Sec-Fetch-Mode'] = 'same-origin';
        requestHeaders['X-Youtube-Bootstrap-Logged-In'] = 'false';
      } else {
        // BotGuard interpreter script on www.google.com/js/…
        requestHeaders['Sec-Fetch-Dest'] = 'script';
        requestHeaders['Sec-Fetch-Site'] = 'cross-site';
        requestHeaders['Accept-Language'] = '*';
      }
      cb({ requestHeaders });
    }
  );

  potSession.webRequest.onHeadersReceived({ urls: ['https://*/*'] }, ({ responseHeaders }, cb) => {
    // Strip ALL original access-control-allow-* headers (case-insensitive)
    // before injecting ours - duplicates hard-fail the CORS check.
    const headers = {};
    for (const key of Object.keys(responseHeaders || {})) {
      if (!/^access-control-allow-/i.test(key)) headers[key] = responseHeaders[key];
    }
    headers['Access-Control-Allow-Origin'] = ['*'];
    headers['Access-Control-Allow-Methods'] = ['GET, HEAD, POST, PUT, DELETE, CONNECT, OPTIONS, TRACE, PATCH'];
    headers['Access-Control-Allow-Headers'] = ['*'];
    cb({ responseHeaders: headers });
  });

  potSession.webRequest.onBeforeRequest(
    { urls: ['<all_urls>'], types: ['cspReport', 'ping'] },
    (details, cb) => cb({ cancel: true })
  );

  return potSession;
}

// Self-contained script executed inside the hidden page. Returns
// { poToken, source: 'integrity' | 'fallback' }. Every stage updates `step`
// so failures come back labelled instead of a bare 'Failed to fetch'.
function buildPageScript(context, visitorData, contentBinding) {
  const ctxJson = JSON.stringify(context);
  const visitorJson = JSON.stringify(visitorData);
  const bindingJson = JSON.stringify(contentBinding);
  const reqKeyJson = JSON.stringify(REQUEST_KEY);

  return `(async () => {
  const context = ${ctxJson};
  const visitorData = ${visitorJson};
  const contentBinding = ${bindingJson};
  const requestKey = ${reqKeyJson};
  let step = 'init';

  try {
    // base64 helpers (adapted from bgutils-js, MIT)
    const b64ToU8 = (b64) => {
      const std = b64.replace(/-/g, '+').replace(/_/g, '/');
      const padded = std.padEnd(std.length + (4 - std.length % 4) % 4, '=');
      return new Uint8Array(atob(padded).split('').map((c) => c.charCodeAt(0)));
    };
    const u8ToWebsafeB64 = (u8) =>
      btoa(String.fromCharCode(...u8)).replace(/[+]/g, '-').replace(/[/]/g, '_');

    // 1) BotGuard challenge from InnerTube.
    step = 'att/get fetch';
    const attRes = await fetch('https://www.youtube.com/youtubei/v1/att/get?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Visitor-Id': visitorData
      },
      body: JSON.stringify({ engagementType: 'ENGAGEMENT_TYPE_UNBOUND', context })
    });
    if (!attRes.ok) throw new Error('HTTP ' + attRes.status);
    step = 'att/get parse';
    const att = await attRes.json();
    const bg = att.bgChallenge;
    if (!bg) throw new Error('No bgChallenge in attestation response');

    step = 'interpreter fetch';
    let interpreterUrl = bg.interpreterUrl && bg.interpreterUrl.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
    if (!interpreterUrl) throw new Error('No interpreter URL in challenge');
    if (interpreterUrl.startsWith('//')) interpreterUrl = 'https:' + interpreterUrl;
    const interpreterJs = await (await fetch(interpreterUrl)).text();
    if (!interpreterJs) throw new Error('Empty BotGuard interpreter script');

    step = 'interpreter eval';
    new Function(interpreterJs)();

    // 2) Load the VM and take a snapshot (adapted from bgutils-js, MIT).
    step = 'vm load';
    const vm = window[bg.globalName];
    if (!vm || !vm.a) throw new Error('BotGuard VM not initialized');

    let vmFunctionsResolve;
    const vmFunctionsPromise = new Promise((res) => { vmFunctionsResolve = res; });
    const vmSetupCallback = (asyncSnapshotFunction) => vmFunctionsResolve(asyncSnapshotFunction);
    const noop = () => {};
    await vm.a(bg.program, vmSetupCallback, true, undefined, noop, [[], []], undefined, false, [noop, noop, noop, noop, noop]);

    const asyncSnapshotFunction = await Promise.race([
      vmFunctionsPromise,
      new Promise((r, rej) => setTimeout(() => rej(new Error('VM setup timed out')), 10000))
    ]);
    if (typeof asyncSnapshotFunction !== 'function') throw new Error('snapshot function unavailable');

    step = 'snapshot';
    const webPoSignalOutput = [];
    const botguardResponse = await new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('snapshot timed out')), 10000);
      try {
        asyncSnapshotFunction((response) => resolve(response), [undefined, undefined, webPoSignalOutput, undefined]);
      } catch (e) { reject(e); }
    });

    // 3) Exchange the snapshot for an integrity token.
    // NOTE: the x-goog-api-key below is NOT a secret of ours. It is Google's OWN
    // public web-client key for the BotGuard / WAA (Web Application Attestation)
    // service, hardcoded verbatim into YouTube's web player and shared by every
    // InnerTube project (bgutils-js, youtubei.js, yt-dlp, ...). It is not tied to
    // any Google Cloud account, cannot be rotated or revoked by us, and grants no
    // access to accounts or data - it only identifies the WAA endpoint. GitHub
    // secret scanning flags it as a "Google API Key"; that alert is a false
    // positive and can be safely dismissed.
    step = 'GenerateIT fetch';
    const itRes = await fetch('https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT', {
      method: 'POST',
      headers: {
        'content-type': 'application/json+protobuf',
        'x-goog-api-key': 'AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw',
        'x-user-agent': 'grpc-web-javascript/0.1'
      },
      body: JSON.stringify([requestKey, botguardResponse])
    });
    const itBody = await itRes.text();
    let itData = null;
    try { itData = JSON.parse(itBody); } catch (e) {}

    // Shape: [integrityToken, ttlSecs, mintRefreshThreshold, websafeFallbackToken]
    if (itData && typeof itData[0] === 'string') {
      // 4) Mint a websafe PoToken bound to the visitor (adapted from bgutils-js, MIT).
      step = 'mint';
      const getMinter = webPoSignalOutput[0];
      if (!getMinter) throw new Error('No minter function in webPoSignalOutput');
      const mintCallback = await getMinter(b64ToU8(itData[0]));
      if (typeof mintCallback !== 'function') throw new Error('Failed to obtain mint callback');
      const minted = await mintCallback(new TextEncoder().encode(contentBinding));
      if (!(minted instanceof Uint8Array)) throw new Error('Invalid mint result');
      return { poToken: u8ToWebsafeB64(minted), source: 'integrity' };
    }
    if (itData && typeof itData[3] === 'string') {
      return { poToken: itData[3], source: 'fallback' };
    }
    throw new Error('No integrity token (HTTP ' + itRes.status + '): ' + itBody.slice(0, 200));
  } catch (e) {
    throw new Error('[' + step + '] ' + (e && e.message ? e.message : String(e)));
  }
})()`;
}

async function generate(tubeAnon, videoId) {
  const context = tubeAnon.session.context;
  const visitorData = context && context.client && context.client.visitorData;
  if (!visitorData) throw new Error('No visitorData in anonymous session');
  // Content-bound (per-video) when a videoId is given -- YouTube now binds the
  // GVS PoToken to the video id (yt-dlp #15689), so a visitor-bound token 403s
  // on the stream URL (esp. on seek). Falls back to visitor binding when no
  // videoId is passed. visitorData still identifies the challenge session.
  const contentBinding = videoId || visitorData;

  const win = new BrowserWindow({
    show: false,
    width: 1920,
    height: 1080,
    webPreferences: {
      session: getPotSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      backgroundThrottling: false
    }
  });

  try {
    win.webContents.setAudioMuted(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // Blank page with a youtube.com base URL - YouTube origin without
    // actually loading YouTube.
    await win.loadURL(
      'data:text/html,<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>',
      { baseURLForDataURL: 'https://www.youtube.com/' }
    );

    const result = await Promise.race([
      win.webContents.executeJavaScript(buildPageScript(context, visitorData, contentBinding), true),
      new Promise((r, rej) => setTimeout(() => rej(new Error('PoToken generation window timed out')), GEN_TIMEOUT_MS))
    ]);

    if (!result || typeof result.poToken !== 'string') throw new Error('Page script returned no token');
    const bindLabel = videoId ? 'content-bound ' + videoId : 'visitor-bound';
    if (result.source === 'fallback') {
      logger.info('PoToken: attestation refused even in real browser; using websafe fallback token (' + bindLabel + ')');
    } else {
      logger.info('PoToken: full integrity-token mint succeeded (real-browser attestation, ' + bindLabel + ')');
    }
    return { poToken: result.poToken, visitorData, videoId: videoId || null };
  } finally {
    try { win.destroy(); } catch (e) {}
  }
}

// Per-video cache for CONTENT-BOUND tokens (videoId -> entry). The shared
// `cached`/`inFlight` above stay for the visitor-bound path (getPoToken with no
// videoId). Content-bound tokens can't be shared across videos, so each video
// mints its own (cached 6h, in-flight-deduped so a re-play is instant).
const videoCache = new Map();
const videoInFlight = new Map();

async function getPoToken(tubeAnon, videoId) {
  if (videoId) {
    const hit = videoCache.get(videoId);
    if (hit && Date.now() - hit.ts < TTL_MS) return hit;
    if (videoInFlight.has(videoId)) return videoInFlight.get(videoId);
    const p = (async () => {
      try {
        const result = await generate(tubeAnon, videoId);
        const entry = { ...result, ts: Date.now() };
        videoCache.set(videoId, entry);
        return entry;
      } finally {
        videoInFlight.delete(videoId);
      }
    })();
    videoInFlight.set(videoId, p);
    return p;
  }
  if (cached && Date.now() - cached.ts < TTL_MS) return cached;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const result = await generate(tubeAnon);
      cached = { ...result, ts: Date.now() };
      logger.info('PoToken generated (visitor-bound)');
      return cached;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function invalidate(videoId) {
  if (videoId) { videoCache.delete(videoId); return; }
  cached = null;
  videoCache.clear();
}

module.exports = { getPoToken, invalidate };
