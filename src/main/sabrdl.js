// SPDX-License-Identifier: GPL-3.0-or-later
// In-app SABR audio downloader (main process).
//
// Downloads a single audio track (typically a dubbed / alternate-language one)
// straight through YouTube's SABR pipeline - the SAME path playback already uses
// successfully for these tracks - instead of shelling to yt-dlp. This sidesteps
// the dub-download 403: yt-dlp's mweb session carries a PO token bound to a
// different identity, whereas here we reuse the app's own content-bound web GVS
// token and streaming URL (from innertube.getSabrForDownload).
//
// The heavy lifting (segment fetching, UMP parsing, SABR redirects / context
// updates / reload directives) is done by googlevideo's SabrStream download
// client; we just drive it AUDIO_ONLY and pipe its audioStream to a temp file.
// downloads.js then ffmpeg-remuxes that temp file into the chosen container.
//
// googlevideo is ESM-only, so it is imported dynamically from this CJS module
// (mirrors innertube.js's `await import('googlevideo/utils')`).

const fs = require('fs');
const { once } = require('events');

function primLang(code) { return String(code || '').split('-')[0]; }

// Pick the audio SabrFormat that matches the requested selection. `select`:
//   { lang, itag, audioTrackId, drc, vb } - any subset. An exact itag+track id
// match wins; otherwise match by primary language (preferring the plain,
// non-DRC / non-Voice-Boost track). Audio formats have no `width`.
function pickAudioFormat(sabrFormats, select) {
  select = select || {};
  const audio = (sabrFormats || []).filter((f) => f && !f.width);
  if (!audio.length) return null;

  // Exact itag, disambiguated by audio track id or language when the same itag is
  // reused across languages (targets the precise bitrate the user picked).
  if (select.itag) {
    const byItag = audio.filter((f) => f.itag === select.itag);
    if (byItag.length) {
      if (select.audioTrackId) {
        const exact = byItag.find((f) => (f.audioTrackId || '') === select.audioTrackId);
        if (exact) return exact;
      }
      if (select.lang) {
        const byLang = byItag.filter((f) => primLang(f.language) === select.lang);
        if (byLang.length) return byLang.find((f) => !f.isDrc && !f.isVb) || byLang[0];
      }
      if (byItag.length === 1) return byItag[0];
    }
  }

  // By language, preferring a plain (non-processing-variant) track.
  if (select.lang) {
    const inLang = audio.filter((f) => primLang(f.language) === select.lang);
    const pool = inLang.length ? inLang : audio;
    const wantDrc = !!select.drc, wantVb = !!select.vb;
    return (
      (wantDrc && pool.find((f) => f.isDrc)) ||
      (wantVb && pool.find((f) => f.isVb)) ||
      pool.find((f) => !f.isDrc && !f.isVb) ||
      pool.find((f) => f.isOriginal) ||
      pool[0]
    );
  }

  // No selector: original / first audio.
  return audio.find((f) => f.isOriginal) || audio[0];
}

// Stream the selected audio track to `tmpPath`.
//   payload    - the object returned by innertube.getSabrForDownload(videoId)
//   select     - { lang, itag, audioTrackId, drc, vb }
//   tmpPath    - absolute path for the raw audio bytes
//   onProgress - ({ bytes, total, pct }) => void   (best-effort)
//   signal     - optional AbortSignal to cancel
//   log/logErr - optional loggers
// Resolves { ok:true, bytes, format } or throws.
async function streamAudioToFile({ payload, select, tmpPath, onProgress, signal, log, logErr, stallMs }) {
  log = log || (() => {}); logErr = logErr || (() => {});
  const STALL_MS = Number(stallMs) > 0 ? Number(stallMs) : 10000;
  if (!payload || !payload.ok) throw new Error('SABR-DL: no payload');
  if (!payload.streamingUrl || !payload.ustreamerConfig) throw new Error('SABR-DL: payload missing streamingUrl / ustreamerConfig');

  const { SabrStream } = await import('googlevideo/sabr-stream');
  const { EnabledTrackTypes } = await import('googlevideo/utils');

  const format = pickAudioFormat(payload.sabrFormats, select);
  if (!format) throw new Error('SABR-DL: no matching audio format for ' + JSON.stringify(select || {}));
  log('SABR-DL selected audio itag=' + format.itag + ' track=' + (format.audioTrackId || '-') + ' lang=' + (format.language || '-') + ' drc=' + !!format.isDrc + ' vb=' + !!format.isVb);

  const stream = new SabrStream({
    serverAbrStreamingUrl: payload.streamingUrl,
    videoPlaybackUstreamerConfig: payload.ustreamerConfig,
    clientInfo: payload.clientInfo,
    poToken: payload.poToken || undefined,
    durationMs: payload.durationMs || undefined,
    formats: payload.sabrFormats
  });

  let aborted = false;
  const doAbort = () => { aborted = true; try { stream.abort(); } catch (e) {} };
  if (signal) {
    if (signal.aborted) doAbort();
    else signal.addEventListener('abort', doAbort, { once: true });
  }
  // The server can invalidate the session mid-download (reload directive). v1
  // just lets SabrStream error out so the caller can fall back; a refresh /
  // resume via getState() is a later refinement.
  stream.on('reloadPlayerResponse', () => logErr('SABR-DL: server asked for player reload - aborting this attempt'));

  let started;
  try {
    started = await stream.start({ audioFormat: format, enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY });
  } catch (e) {
    if (signal) signal.removeEventListener('abort', doAbort);
    throw new Error('SABR-DL start failed: ' + (e && e.message));
  }

  const audioStream = started && started.audioStream;
  if (!audioStream) { if (signal) signal.removeEventListener('abort', doAbort); throw new Error('SABR-DL: no audio stream'); }

  const total = format.contentLength || 0;
  const ws = fs.createWriteStream(tmpPath);
  const reader = audioStream.getReader();
  let bytes = 0, lastPct = -1;
  try {
    for (;;) {
      // Watchdog: SabrStream can silently stall (a segment request hangs with no
      // error and no `done`), freezing the download at, e.g., 26%. Race each read
      // against an inactivity timeout so a stall becomes an error the caller can
      // retry / fall back on, instead of hanging forever.
      const rp = reader.read();
      let timer;
      const tp = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('SABR-DL: stalled - no data for ' + Math.round(STALL_MS / 1000) + 's')), STALL_MS); });
      let res;
      try { res = await Promise.race([rp, tp]); }
      catch (e) { rp.catch(() => {}); throw e; } // swallow the losing read's later rejection
      finally { clearTimeout(timer); }
      const { value, done } = res;
      if (done) break;
      if (aborted) throw new Error('aborted');
      if (value && value.byteLength) {
        if (!ws.write(Buffer.from(value.buffer, value.byteOffset, value.byteLength))) await once(ws, 'drain');
        bytes += value.byteLength;
        if (onProgress) {
          const pct = total ? Math.min(99, (bytes / total) * 100) : 0;
          if (pct - lastPct >= 0.5 || !total) { lastPct = pct; onProgress({ bytes, total, pct }); }
        }
      }
    }
    await new Promise((res, rej) => ws.end((err) => (err ? rej(err) : res())));
  } catch (e) {
    doAbort(); // stop the SabrStream so a stalled/failed attempt doesn't linger
    try { ws.destroy(); } catch (_) {}
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw e;
  } finally {
    try { reader.releaseLock(); } catch (_) {}
    if (signal) signal.removeEventListener('abort', doAbort);
  }
  if (onProgress) onProgress({ bytes, total: total || bytes, pct: 100 });
  log('SABR-DL wrote ' + bytes + ' bytes -> ' + tmpPath);
  return { ok: true, bytes, format };
}

module.exports = { streamAudioToFile, pickAudioFormat };
