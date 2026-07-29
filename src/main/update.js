// SPDX-License-Identifier: GPL-3.0-or-later
// In-app self-updater for the portable Windows build.
//
// Windows locks the running CouchTube.exe + its DLLs + resources/app.asar while
// the app is running, so the files CANNOT be overwritten in place. This module
// therefore: (1) downloads the release zip (progress to the renderer), (2)
// extracts + validates it into a staging folder beside the exe, then (3) hands
// the actual file-replacement to a tiny generated helper (cmd launched hidden
// via a wscript vbs shim) that runs AFTER CouchTube exits, robocopies the staged
// files over the install dir (no purge, so Data/ and the yt-dlp/ffmpeg/deno
// binaries survive), relaunches, and cleans up. Nothing is shown to the user
// about URLs, sizes, or checksums.
//
// Only works for a packaged build in a writable folder (the normal portable
// case). In dev, or under a read-only location like Program Files, canSelfUpdate
// is false and the renderer falls back to opening the release page.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const logger = require('./logger');

const REPO = 'vdb86/CouchTube';

// Session state.
let staged = null;        // { version, stagingDir } once a download is ready
let busy = false;         // a download/extract is in progress
let helperSpawned = false; // guard so we never spawn the applier twice
let justUpdated = null;   // version we just updated TO this boot (for a toast)

function cmpVer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// The folder the exe lives in (packaged only). null => self-update not possible.
function installDir() {
  try { return app.isPackaged ? path.dirname(app.getPath('exe')) : null; } catch { return null; }
}
function isWritable(dir) {
  try {
    const probe = path.join(dir, '.ct-update-write-test');
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch { return false; }
}
function canSelfUpdate() {
  const d = installDir();
  return !!(d && isWritable(d));
}

// Paths (all derived from the install dir). The temp lives in <install>/update so
// the copy is same-volume and fast; the helper scripts sit at the install root
// (outside the temp) so the temp can be wiped wholesale at the end.
function paths() {
  const inst = installDir();
  if (!inst) return null;
  const root = path.join(inst, 'update');
  return {
    inst,
    root,
    zip: path.join(root, 'download.zip'),
    staging: path.join(root, 'staging'),
    log: path.join(root, 'apply.log'),
    cmd: path.join(inst, 'ct-update.cmd'),
    vbs: path.join(inst, 'ct-update.vbs'),
    // Success marker lives in Data/ (userData) so it survives the helper wiping
    // the update folder; the NEW version reads it on boot to toast + then deletes.
    marker: path.join(app.getPath('userData'), 'last_update.json')
  };
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }
function safeUnlink(p) { try { fs.unlinkSync(p); } catch { /* ignore */ } }

async function fetchLatestRelease() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CouchTube' }
  });
  if (!res.ok) throw new Error('GitHub API ' + res.status);
  const j = await res.json();
  return { tag: String(j.tag_name || '').replace(/^v/i, ''), assets: j.assets || [] };
}

function escapeReg(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Choose the asset to download. Prefer the SMALL app-only delta zip
// (CouchTube-<ver>-app-e<electron>-x64.zip) when the delta's embedded Electron
// version matches our installed runtime - then only resources/app.asar changed,
// so a few MB replaces the ~150MB full download. Otherwise (Electron was bumped,
// or no delta was published) fall back to the full win-x64 zip, which is always
// present. Returns { url, size, name, appOnly }.
function pickZipAsset(assets, version) {
  const zips = (assets || []).filter((a) => /\.zip$/i.test(a.name || ''));
  if (!zips.length) return null;
  const myE = process.versions.electron;
  const delta = zips.find((z) => new RegExp('-app-e' + escapeReg(myE) + '-', 'i').test(z.name));
  if (delta) return { url: delta.browser_download_url, size: delta.size || 0, name: delta.name, appOnly: true };
  const full = zips.find((z) => /win.*x64/i.test(z.name)) ||
               zips.find((z) => version && z.name.includes(version)) || zips[0];
  return { url: full.browser_download_url, size: full.size || 0, name: full.name, appOnly: false };
}

// Stream the asset to disk with throttled progress callbacks (backpressure kept
// via a counting Transform inside the pipeline).
async function downloadTo(url, dest, expectedSize, onProgress) {
  const res = await fetch(url, { headers: { 'User-Agent': 'CouchTube' }, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error('download ' + res.status);
  const total = expectedSize || Number(res.headers.get('content-length')) || 0;
  let received = 0, lastPct = -1, lastAt = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      const now = Date.now();
      const pct = total ? Math.floor((received / total) * 100) : null;
      if ((pct != null && pct !== lastPct) || now - lastAt > 250) {
        lastPct = pct; lastAt = now;
        try { onProgress(pct); } catch { /* ignore */ }
      }
      cb(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(dest));
}

function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

function extractZip(zip, dest) {
  return new Promise((resolve, reject) => {
    const cmd = `Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(dest)} -Force`;
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err) => err ? reject(err) : resolve());
  });
}

// The app-only delta must end up as staging/resources/app.asar so the applier's
// robocopy lands it at installDir/resources/app.asar. Compress-Archive of the
// resources dir already produces that layout, but if a zip ever roots app.asar
// (and app.asar.unpacked) at the top instead, move it under resources/ so the
// apply is correct either way.
function normalizeAppOnly(staging) {
  const resDir = path.join(staging, 'resources');
  for (const name of ['app.asar', 'app.asar.unpacked']) {
    const nested = path.join(resDir, name);
    const flat = path.join(staging, name);
    if (!fs.existsSync(nested) && fs.existsSync(flat)) {
      try { fs.mkdirSync(resDir, { recursive: true }); fs.renameSync(flat, nested); }
      catch (e) { logger.error('update: normalizeAppOnly failed for', name, e && e.message); }
    }
  }
}

// A staged build is valid when app.asar is present (plus CouchTube.exe for the
// full zip; the app-only delta ships resources/app.asar only). Electron's patched
// fs can read package.json out of the asar, giving the true version; if that read
// fails we fall back to the release tag.
function validateStaging(staging, tagVersion, appOnly) {
  const asar = path.join(staging, 'resources', 'app.asar');
  if (!fs.existsSync(asar)) return null;
  if (!appOnly && !fs.existsSync(path.join(staging, 'CouchTube.exe'))) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(asar, 'package.json'), 'utf8'));
    if (pkg && pkg.version) return String(pkg.version);
  } catch (e) { logger.error('update: could not read staged version:', e && e.message); }
  return tagVersion || 'unknown';
}

// Download + extract + validate + stage. Emits progress via win. Returns
// { ok, version } or { ok:false, error }.
async function download(win) {
  if (!canSelfUpdate()) return { ok: false, error: 'not supported for this install' };
  if (busy) return { ok: false, error: 'already in progress' };
  if (staged) return { ok: true, version: staged.version };
  const P = paths();
  const send = (p) => { try { if (win && !win.isDestroyed()) win.webContents.send('update:progress', p); } catch { /* ignore */ } };
  busy = true;
  try {
    send({ phase: 'download', pct: 0 });
    const rel = await fetchLatestRelease();
    const asset = pickZipAsset(rel.assets, rel.tag);
    if (!asset) throw new Error('no download available');
    logger.info('update: downloading ' + (asset.appOnly ? 'app-only delta' : 'full') + ' zip ' + asset.name);
    rmrf(P.root);
    fs.mkdirSync(P.root, { recursive: true });
    await downloadTo(asset.url, P.zip, asset.size, (pct) => send({ phase: 'download', pct }));
    send({ phase: 'extract' });
    rmrf(P.staging);
    fs.mkdirSync(P.staging, { recursive: true });
    await extractZip(P.zip, P.staging);
    if (asset.appOnly) normalizeAppOnly(P.staging);
    const ver = validateStaging(P.staging, rel.tag, asset.appOnly);
    if (!ver) throw new Error('downloaded update failed validation');
    if (cmpVer(ver, app.getVersion()) <= 0) { rmrf(P.root); throw new Error('already up to date'); }
    // The zip is no longer needed once extracted; keep only the staging folder.
    safeUnlink(P.zip);
    staged = { version: ver, stagingDir: P.staging };
    send({ phase: 'ready', version: ver });
    logger.info('update: staged v' + ver + ' ready to apply');
    return { ok: true, version: ver };
  } catch (e) {
    logger.error('update: download failed:', e && e.message);
    try { rmrf(paths().root); } catch { /* ignore */ }
    return { ok: false, error: e && e.message };
  } finally {
    busy = false;
  }
}

// Generate the hidden helper (cmd run via a wscript vbs shim so no console window
// ever appears) and launch it detached. It waits for THIS process to exit, then
// robocopies the staged files over the install dir, relaunches, and cleans up.
function spawnHelper() {
  if (!staged || helperSpawned) return false;
  const P = paths();
  if (!P) return false;
  try {
    // Record what we are updating TO so the new version can confirm + toast.
    fs.writeFileSync(P.marker, JSON.stringify({ version: staged.version, ts: Date.now() }));
    const pid = process.pid;
    const cmd = [
      '@echo off',
      'setlocal enableextensions',
      'set "PID=' + pid + '"',
      ':waitloop',
      'tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul',
      'if not errorlevel 1 (',
      '  ping -n 2 127.0.0.1 >nul',
      '  goto waitloop',
      ')',
      'robocopy "' + P.staging + '" "' + P.inst + '" /E /R:20 /W:1 /NP /NFL /NDL >"' + P.log + '" 2>&1',
      'start "" "' + path.join(P.inst, 'CouchTube.exe') + '"',
      'rmdir /S /Q "' + P.root + '"',
      'del /F /Q "' + P.vbs + '" >nul 2>&1',
      '(goto) 2>nul & del /F /Q "%~f0"',
      ''
    ].join('\r\n');
    fs.writeFileSync(P.cmd, cmd);
    // vbs style-0 = hidden window, False = do not wait.
    const vbs = 'CreateObject("WScript.Shell").Run "cmd /c ""' + P.cmd + '""", 0, False\r\n';
    fs.writeFileSync(P.vbs, vbs);
    const child = spawn('wscript.exe', [P.vbs], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    helperSpawned = true;
    logger.info('update: applier launched for v' + staged.version);
    return true;
  } catch (e) {
    logger.error('update: could not launch applier:', e && e.message);
    return false;
  }
}

// Called by the "Restart now" button: spawn the applier; the caller then quits.
function applyNow() { return spawnHelper(); }

// Called from before-quit: if an update is staged and the applier has not already
// been launched (the "restart later" path), launch it now so the update installs
// as the app closes.
function applyOnQuit() { if (staged && !helperSpawned) spawnHelper(); }

function hasPending() { return !!staged; }

// Boot: consume the success marker (toast if it matches our version) and wipe any
// stale update folder / helper scripts left by a previous session.
function finalizeBoot() {
  const P = paths();
  if (!P) return;
  try {
    if (fs.existsSync(P.marker)) {
      const m = JSON.parse(fs.readFileSync(P.marker, 'utf8'));
      if (m && m.version && m.version === app.getVersion()) justUpdated = m.version;
      safeUnlink(P.marker);
    }
  } catch (e) { logger.error('update: marker read failed:', e && e.message); }
  // Any update/ present at boot is leftover (a successful apply deletes it; an
  // abandoned one is stale) - remove it so we never keep a ~150MB orphan.
  rmrf(P.root);
  safeUnlink(P.cmd);
  safeUnlink(P.vbs);
}

function status() {
  return {
    canSelfUpdate: canSelfUpdate(),
    staged: staged ? { version: staged.version } : null,
    busy,
    justUpdated
  };
}

module.exports = { download, applyNow, applyOnQuit, hasPending, finalizeBoot, status, canSelfUpdate };
