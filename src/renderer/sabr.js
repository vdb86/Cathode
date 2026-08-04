// SPDX-License-Identifier: GPL-3.0-or-later
// SABR streaming glue (renderer). Ports LuanRT's ShakaPlayerAdapter (from the
// googlevideo sabr-shaka-example, MIT) to plain JS and wires googlevideo's
// SabrStreamingAdapter to our single global Shaka player.
//
// Runtime deps come from two globals already loaded by index.html:
//   - `shaka`         (shaka-player.compiled.js)
//   - `window.GoogleVideo` = { SabrStreamingAdapter, SabrUmpProcessor,
//       buildSabrFormat, FormatKeyUtils, isGoogleVideoURL }  (vendor bundle,
//       built by scripts/build-sabr.mjs)
//
// The InnerTube side (decipher, player reload, PoToken mint) lives in the main
// process; this file reaches it via window.tv.sabr / sabrReload / sabrPoToken.
//
// Differences from the reference: the ytc-bridge browser-extension proxy path
// is removed (Electron handles googlevideo CORS in the main process), so every
// request just uses window.fetch.
(function () {
  'use strict';

  function GV() {
    if (!window.GoogleVideo) throw new Error('GoogleVideo vendor bundle not loaded (run: npm run build:sabr)');
    return window.GoogleVideo;
  }

  // Diagnostics -> main log (renderer has window.tv.logError). Used to pin down
  // why a SABR segment comes back empty: a format-key mismatch (Shaka's track
  // ids don't map to the sabr formats -> no format requested) vs the server
  // genuinely returning nothing.
  function sabrDiag(msg) { try { if (window.tv && window.tv.logError) window.tv.logError('[sabr] ' + msg); } catch (e) {} }
  function streamInfoFlags(rm) {
    const si = (rm && rm.streamInfo) || {};
    let errStr = 'none';
    try { if (rm && rm.error) errStr = JSON.stringify(rm.error).slice(0, 200); } catch (e) { errStr = String(rm && rm.error); }
    return 'redirect=' + !!si.redirect + ' ctxUpdate=' + !!si.sabrContextUpdate + ' protStatus=' + (si.streamProtectionStatus && si.streamProtectionStatus.status) + ' isSABR=' + !!(rm && rm.isSABR) + ' isInit=' + !!(rm && rm.isInit) + ' err=' + errStr;
  }

  // ---- helpers (ported from the reference helpers.ts) ----
  function asMap(object) {
    const map = new Map();
    for (const key of Object.keys(object || {})) map.set(key, object[key]);
    return map;
  }

  // Mirrors the vendor FormatKeyUtils.getUniqueFormatId, but ALSO encodes Voice
  // Boost (-vb). The bundled googlevideo omits vb from the key, so a vb audio
  // format shares the normal track's key ("140-en.4") and can't be resolved -->
  // its segments come back empty. youtubei.js already puts -vb in the DASH
  // Representation id (originalAudioId), so encoding it here makes the two line
  // up and lets Shaka's vb audio track play over SABR. (sabrFormats carry isVb,
  // added in main after buildSabrFormat.)
  function uniqueFormatId(format) {
    if (format.width) return String(format.itag);
    const parts = [String(format.itag)];
    if (format.audioTrackId) parts.push(format.audioTrackId);
    if (format.isDrc) parts.push('drc');
    if (format.isVb) parts.push('vb');
    return parts.join('-');
  }

  function createRecoverableError(message, info) {
    return new shaka.util.Error(
      shaka.util.Error.Severity.RECOVERABLE,
      shaka.util.Error.Category.NETWORK,
      shaka.util.Error.Code.HTTP_ERROR,
      message,
      { info }
    );
  }

  function headersToGenericObject(headers) {
    const out = {};
    headers.forEach((value, key) => { out[key.trim()] = value; });
    return out;
  }

  function makeResponse(headers, data, status, uri, responseURL, request, requestType) {
    if (status >= 200 && status <= 299 && status !== 202) {
      return {
        uri: responseURL || uri,
        originalUri: uri,
        data,
        status,
        headers,
        originalRequest: request,
        fromCache: !!headers['x-shaka-from-cache']
      };
    }
    let responseText = null;
    try { responseText = shaka.util.StringUtils.fromBytesAutoDetect(data); } catch (e) { /* no-op */ }
    const severity = (status === 401 || status === 403)
      ? shaka.util.Error.Severity.CRITICAL
      : shaka.util.Error.Severity.RECOVERABLE;
    throw new shaka.util.Error(
      severity,
      shaka.util.Error.Category.NETWORK,
      shaka.util.Error.Code.BAD_HTTP_STATUS,
      uri, status, responseText, headers, requestType, responseURL || uri
    );
  }

  // ---- ShakaPlayerAdapter (implements googlevideo's SabrPlayerAdapter) ----
  class ShakaPlayerAdapter {
    constructor() {
      this.player = null;
      this.requestMetadataManager = undefined;
      this.cacheManager = undefined;
      this.abortController = undefined;
      this.requestFilter = undefined;
      this.responseFilter = undefined;
    }

    initialize(player, requestMetadataManager, cacheManager) {
      this.player = player;
      this.requestMetadataManager = requestMetadataManager;
      this.cacheManager = cacheManager;

      const networkingEngine = shaka.net.NetworkingEngine;
      const schemes = ['http', 'https'];

      if (!shaka.net.HttpFetchPlugin.isSupported())
        throw new Error('The Fetch API is not supported in this browser.');

      schemes.forEach((scheme) => {
        networkingEngine.registerScheme(
          scheme, this.parseRequest.bind(this),
          networkingEngine.PluginPriority.PREFERRED
        );
      });
    }

    parseRequest(uri, request, requestType, progressUpdated, headersReceived, config) {
      const headers = new Headers();
      asMap(request.headers).forEach((value, key) => { headers.append(key, value); });

      const controller = new AbortController();
      this.abortController = controller;

      const init = {
        body: request.body || undefined,
        headers,
        method: request.method,
        signal: this.abortController.signal,
        credentials: request.allowCrossSiteCredentials ? 'include' : undefined
      };

      const abortStatus = { canceled: false, timedOut: false };
      const minBytes = config.minBytesForProgressEvents || 0;

      const pendingRequest = this.request(uri, request, requestType, init, controller, abortStatus, progressUpdated, headersReceived, minBytes);

      const operation = new shaka.util.AbortableOperation(
        pendingRequest,
        () => { abortStatus.canceled = true; controller.abort(); return Promise.resolve(); }
      );

      const timeoutMs = request.retryParameters.timeout;
      if (timeoutMs) {
        const timer = new shaka.util.Timer(() => {
          abortStatus.timedOut = true;
          controller.abort();
          console.warn('[ShakaPlayerAdapter]', 'Request aborted due to timeout:', uri, requestType);
        });
        timer.tickAfter(timeoutMs / 1000);
        operation.finally(() => timer.stop());
      }

      return operation;
    }

    async handleCachedRequest(requestMetadata, uri, request, progressUpdated, headersReceived, requestType) {
      if (!requestMetadata.byteRange || !this.cacheManager) return null;

      const FormatKeyUtils = GV().FormatKeyUtils;
      const segmentKey = FormatKeyUtils.createSegmentCacheKeyFromMetadata(requestMetadata);

      const cached = requestMetadata.isInit
        ? this.cacheManager.getInitSegment(segmentKey)
        : this.cacheManager.getSegment(segmentKey);
      let arrayBuffer = cached ? cached.buffer : null;
      if (!arrayBuffer) return null;

      if (requestMetadata.isInit) {
        arrayBuffer = arrayBuffer.slice(requestMetadata.byteRange.start, requestMetadata.byteRange.end + 1);
      }

      const headers = {
        'content-type': (requestMetadata.format && requestMetadata.format.mimeType && requestMetadata.format.mimeType.split(';')[0]) || '',
        'content-length': arrayBuffer.byteLength.toString(),
        'x-shaka-from-cache': 'true'
      };

      headersReceived(headers);
      progressUpdated(0, arrayBuffer.byteLength, 0);

      return makeResponse(headers, arrayBuffer, 200, uri, uri, request, requestType);
    }

    async handleUmpResponse(response, requestMetadata, uri, request, requestType, progressUpdated, abortController, minBytes) {
      let lastTime = Date.now();
      const SabrUmpProcessor = GV().SabrUmpProcessor;
      const sabrUmpReader = new SabrUmpProcessor(requestMetadata, this.cacheManager);

      const checkResultIntegrity = (result) => {
        if (!result.data && ((!!requestMetadata.error || (requestMetadata.streamInfo && requestMetadata.streamInfo.streamProtectionStatus && requestMetadata.streamInfo.streamProtectionStatus.status === 3)) && !(requestMetadata.streamInfo && requestMetadata.streamInfo.sabrContextUpdate))) {
          throw createRecoverableError('Server streaming error', requestMetadata);
        }
      };

      const shouldReturnEmptyResponse = () => {
        return requestMetadata.isSABR && (requestMetadata.streamInfo && (requestMetadata.streamInfo.redirect || requestMetadata.streamInfo.sabrContextUpdate));
      };

      if (!response.body) {
        const arrayBuffer = await response.arrayBuffer();
        const currentTime = Date.now();
        progressUpdated(currentTime - lastTime, arrayBuffer.byteLength, 0);
        const result = await sabrUmpReader.processChunk(new Uint8Array(arrayBuffer));
        if (result) {
          checkResultIntegrity(result);
          return this.createShakaResponse({ uri, request, requestType, response, arrayBuffer: result.data });
        }
        if (shouldReturnEmptyResponse()) {
          return this.createShakaResponse({ uri, request, requestType, response, arrayBuffer: undefined });
        }
        sabrDiag('empty UMP (no-body) itag=' + (requestMetadata.format && requestMetadata.format.itag) + ' lang=' + (requestMetadata.format && (requestMetadata.format.language || (requestMetadata.format.audioTrack && requestMetadata.format.audioTrack.id))) + ' xtags=' + (requestMetadata.format && requestMetadata.format.xtags) + ' bytes=' + (arrayBuffer ? arrayBuffer.byteLength : 0) + ' ' + streamInfoFlags(requestMetadata));
        throw createRecoverableError('Empty response with no redirect information', requestMetadata);
      } else {
        const reader = response.body.getReader();
        let loaded = 0;
        let lastLoaded = 0;
        let contentLength;

        while (!abortController.signal.aborted) {
          let readObj;
          try { readObj = await reader.read(); } catch (e) { break; }
          const value = readObj.value;
          const done = readObj.done;

          if (done) {
            if (shouldReturnEmptyResponse()) {
              return this.createShakaResponse({ uri, request, requestType, response, arrayBuffer: undefined });
            }
            sabrDiag('empty UMP (stream) itag=' + (requestMetadata.format && requestMetadata.format.itag) + ' lang=' + (requestMetadata.format && (requestMetadata.format.language || (requestMetadata.format.audioTrack && requestMetadata.format.audioTrack.id))) + ' xtags=' + (requestMetadata.format && requestMetadata.format.xtags) + ' bytesRead=' + loaded + ' ' + streamInfoFlags(requestMetadata));
            throw createRecoverableError('Empty response with no redirect information', requestMetadata);
          }

          const result = await sabrUmpReader.processChunk(value);
          const segmentInfo = sabrUmpReader.getSegmentInfo();

          if (segmentInfo) {
            if (!contentLength) contentLength = segmentInfo.mediaHeader.contentLength;
            loaded += segmentInfo.lastChunkSize || 0;
            segmentInfo.lastChunkSize = 0;
          }

          const currentTime = Date.now();
          const chunkSize = loaded - lastLoaded;

          if ((currentTime - lastTime > 100 && chunkSize >= minBytes) || result) {
            if (result) checkResultIntegrity(result);
            if (contentLength) {
              const numBytesRemaining = result ? 0 : parseInt(contentLength) - loaded;
              try { progressUpdated(currentTime - lastTime, chunkSize, numBytesRemaining); }
              catch (e) { /* no-op */ }
              finally { lastLoaded = loaded; lastTime = currentTime; }
            }
          }

          if (result) {
            abortController.abort();
            return this.createShakaResponse({ uri, request, requestType, response, arrayBuffer: result.data });
          }
        }
        throw createRecoverableError('UMP stream processing was aborted but did not produce a result.', requestMetadata);
      }
    }

    async request(uri, request, requestType, init, abortController, abortStatus, progressUpdated, headersReceived, minBytes) {
      try {
        const requestMetadata = this.requestMetadataManager && this.requestMetadataManager.getRequestMetadata(uri);

        if (requestMetadata) {
          const cachedResponse = await this.handleCachedRequest(requestMetadata, uri, request, progressUpdated, headersReceived, requestType);
          if (cachedResponse) return cachedResponse;
        }

        const response = await fetch(uri, init);
        headersReceived(headersToGenericObject(response.headers));

        if (requestMetadata && init.method !== 'HEAD' && response.headers.get('content-type') === 'application/vnd.yt-ump') {
          return this.handleUmpResponse(response, requestMetadata, uri, request, requestType, progressUpdated, abortController, minBytes);
        }

        const lastTime = Date.now();
        const arrayBuffer = await response.arrayBuffer();
        const currentTime = Date.now();
        progressUpdated(currentTime - lastTime, arrayBuffer.byteLength, 0);

        return this.createShakaResponse({ uri, request, requestType, response, arrayBuffer });
      } catch (error) {
        if (abortStatus.canceled) {
          throw new shaka.util.Error(
            shaka.util.Error.Severity.RECOVERABLE, shaka.util.Error.Category.NETWORK,
            shaka.util.Error.Code.OPERATION_ABORTED, uri, requestType
          );
        } else if (abortStatus.timedOut) {
          throw new shaka.util.Error(
            shaka.util.Error.Severity.RECOVERABLE, shaka.util.Error.Category.NETWORK,
            shaka.util.Error.Code.TIMEOUT, uri, requestType
          );
        }
        throw new shaka.util.Error(
          shaka.util.Error.Severity.RECOVERABLE, shaka.util.Error.Category.NETWORK,
          shaka.util.Error.Code.HTTP_ERROR, uri, error, requestType
        );
      }
    }

    checkPlayerStatus() {
      if (!this.player) throw new Error('Player not initialized');
    }

    getPlayerTime() {
      this.checkPlayerStatus();
      const el = this.player.getMediaElement();
      return (el && el.currentTime) || 0;
    }

    getPlaybackRate() {
      this.checkPlayerStatus();
      return this.player.getPlaybackRate();
    }

    getBandwidthEstimate() {
      this.checkPlayerStatus();
      return this.player.getStats().estimatedBandwidth;
    }

    getActiveTrackFormats(activeFormat, sabrFormats) {
      this.checkPlayerStatus();
      const activeId = uniqueFormatId(activeFormat);

      const activeVariant = this.player.getVariantTracks().find((track) =>
        activeId === (activeFormat.width ? track.originalVideoId : track.originalAudioId)
      );

      if (!activeVariant) {
        sabrDiag('getActiveTrackFormats: NO Shaka variant matches sabr id=' + activeId + ' width=' + (activeFormat.width || 0));
        return { videoFormat: undefined, audioFormat: undefined };
      }

      const formatMap = new Map(sabrFormats.map((format) => [uniqueFormatId(format), format]));
      const videoFormat = activeVariant.originalVideoId ? formatMap.get(activeVariant.originalVideoId) : undefined;
      const audioFormat = activeVariant.originalAudioId ? formatMap.get(activeVariant.originalAudioId) : undefined;
      if ((activeVariant.originalVideoId && !videoFormat) || (activeVariant.originalAudioId && !audioFormat)) {
        sabrDiag('getActiveTrackFormats: id MISMATCH vid=' + activeVariant.originalVideoId + '->' + !!videoFormat + ' aud=' + activeVariant.originalAudioId + '->' + !!audioFormat + ' (sabr keys e.g. ' + Array.from(formatMap.keys()).slice(0, 4).join(',') + ')');
      }
      return { videoFormat, audioFormat };
    }

    registerRequestInterceptor(interceptor) {
      this.checkPlayerStatus();
      const networkingEngine = this.player.getNetworkingEngine();
      if (!networkingEngine) return;
      const isGoogleVideoURL = GV().isGoogleVideoURL;

      this.requestFilter = async (type, request, context) => {
        if (type !== shaka.net.NetworkingEngine.RequestType.SEGMENT || !isGoogleVideoURL(request.uris[0])) return;

        const modifiedRequest = await interceptor({
          headers: request.headers,
          url: request.uris[0],
          method: request.method,
          segment: {
            getStartTime: () => (context && context.segment && context.segment.getStartTime()) || null,
            isInit: () => !(context && context.segment)
          },
          body: request.body
        });

        if (modifiedRequest) {
          request.uris = modifiedRequest.url ? [modifiedRequest.url] : request.uris;
          request.method = modifiedRequest.method || request.method;
          request.headers = modifiedRequest.headers || request.headers;
          request.body = modifiedRequest.body || request.body;
        }
      };

      networkingEngine.registerRequestFilter(this.requestFilter);
    }

    registerResponseInterceptor(interceptor) {
      this.checkPlayerStatus();
      const networkingEngine = this.player.getNetworkingEngine();
      if (!networkingEngine) return;
      const isGoogleVideoURL = GV().isGoogleVideoURL;

      this.responseFilter = async (type, response, context) => {
        if (type !== shaka.net.NetworkingEngine.RequestType.SEGMENT || !isGoogleVideoURL(response.uri)) return;

        const modifiedResponse = await interceptor({
          url: response.originalRequest.uris[0],
          method: response.originalRequest.method,
          headers: response.headers,
          data: response.data,
          makeRequest: async (url, headers) => {
            const retryParameters = this.player.getConfiguration().streaming.retryParameters;
            const redirectRequest = shaka.net.NetworkingEngine.makeRequest([url], retryParameters);
            Object.assign(redirectRequest.headers, headers);
            const requestOperation = networkingEngine.request(type, redirectRequest, context);
            const redirectResponse = await requestOperation.promise;
            return {
              url: redirectResponse.uri,
              method: redirectResponse.originalRequest.method,
              headers: redirectResponse.headers,
              data: redirectResponse.data
            };
          }
        });

        if (modifiedResponse) {
          response.data = modifiedResponse.data || response.data;
          Object.assign(response.headers, modifiedResponse.headers);
        }
      };

      networkingEngine.registerResponseFilter(this.responseFilter);
    }

    createShakaResponse(args) {
      return makeResponse(
        headersToGenericObject(args.response.headers),
        args.arrayBuffer || new ArrayBuffer(0),
        args.response.status,
        args.uri,
        args.response.url,
        args.request,
        args.requestType
      );
    }

    dispose() {
      if (this.abortController) { this.abortController.abort(); this.abortController = undefined; }
      if (this.player) {
        const networkingEngine = this.player.getNetworkingEngine();
        if (networkingEngine && this.requestFilter && this.responseFilter) {
          networkingEngine.unregisterRequestFilter(this.requestFilter);
          networkingEngine.unregisterResponseFilter(this.responseFilter);
        }
        shaka.net.NetworkingEngine.unregisterScheme('http');
        shaka.net.NetworkingEngine.unregisterScheme('https');
        this.player = null;
      }
    }
  }

  // The adapter's dispose() unregisters the http/https schemes ENTIRELY, which
  // would leave classic (non-SABR) playback with no scheme handler. Re-register
  // Shaka's built-in fetch/xhr plugins so a later classic load still works.
  function restoreDefaultSchemes() {
    try {
      const NE = shaka.net.NetworkingEngine;
      const P = NE.PluginPriority;
      const fetchOk = !!(shaka.net.HttpFetchPlugin && shaka.net.HttpFetchPlugin.parse && shaka.net.HttpFetchPlugin.isSupported && shaka.net.HttpFetchPlugin.isSupported());
      const xhrOk = !!(shaka.net.HttpXHRPlugin && shaka.net.HttpXHRPlugin.parse);
      if (fetchOk) {
        NE.registerScheme('http', shaka.net.HttpFetchPlugin.parse, P.PREFERRED, true);
        NE.registerScheme('https', shaka.net.HttpFetchPlugin.parse, P.PREFERRED, true);
      }
      if (xhrOk) {
        NE.registerScheme('http', shaka.net.HttpXHRPlugin.parse, P.FALLBACK, true);
        NE.registerScheme('https', shaka.net.HttpXHRPlugin.parse, P.FALLBACK, true);
      }
      // The adapter's dispose() removed the http/https handlers GLOBALLY (static
      // registry -- survives a Player destroy/rebuild). The success case is now
      // silent (it was an s67 tripwire, confirmed working); only shout if
      // neither default plugin could be re-registered, since then every later
      // classic load dies instantly (UNSUPPORTED_SCHEME).
      if (!fetchOk && !xhrOk) sabrDiag('NO default scheme plugin available -- classic loads will fail (UNSUPPORTED_SCHEME)');
    } catch (e) {
      sabrDiag('restoreDefaultSchemes FAILED: ' + (e && e.message));
      console.warn('[sabr] restoreDefaultSchemes failed:', e);
    }
  }

  let currentAdapter = null;

  // Attach a SABR streaming session to the (already-created) Shaka player using
  // the payload from window.tv.sabr(). Returns the manifest data: URI to load.
  // Call BEFORE player.load(). start() also disposes any prior session.
  function start(shakaPlayer, payload) {
    stop();
    const { SabrStreamingAdapter } = GV();

    const adapter = new SabrStreamingAdapter({
      playerAdapter: new ShakaPlayerAdapter(),
      clientInfo: payload.clientInfo || {}
    });

    adapter.onMintPoToken(async () => {
      try { return (await window.tv.sabrPoToken(payload.id)) || ''; }
      catch (e) { console.warn('[sabr] mint pot failed:', e); return ''; }
    });

    adapter.onReloadPlayerResponse(async (reloadContext) => {
      try {
        const r = await window.tv.sabrReload(payload.id, reloadContext);
        if (r && r.streamingUrl) adapter.setStreamingURL(r.streamingUrl);
        if (r && r.ustreamerConfig) adapter.setUstreamerConfig(r.ustreamerConfig);
      } catch (e) { console.warn('[sabr] reload failed:', e); }
    });

    adapter.attach(shakaPlayer);
    adapter.setStreamingURL(payload.streamingUrl);
    adapter.setUstreamerConfig(payload.ustreamerConfig);
    adapter.setServerAbrFormats(payload.sabrFormats || []);

    currentAdapter = adapter;
    return 'data:application/dash+xml;base64,' + payload.dashManifest;
  }

  function stop() {
    if (currentAdapter) {
      try { currentAdapter.dispose(); } catch (e) { console.warn('[sabr] dispose failed:', e); }
      currentAdapter = null;
      restoreDefaultSchemes();
    }
  }

  window.CathodeSabr = { start, stop, active: function () { return !!currentAdapter; } };
})();
