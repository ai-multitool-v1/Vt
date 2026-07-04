/** v
 * ============================================================
 *  AI TV Pro - Universal Streaming Proxy (Cloudflare Worker)
 *  v2 - Production grade
 *
 *  Handles: M3U / M3U8 (HLS), MPD (DASH), TS / M4S / MP4 / AAC /
 *           VTT / KEY segments. CORS, Range, redirects, retries,
 *           caching tiers, optional rate limiting, structured logs.
 * ============================================================
 *
 * USAGE:
 *   GET  https://your-worker.workers.dev/?url=<ENCODED_TARGET_URL>
 *   HEAD https://your-worker.workers.dev/?url=<ENCODED_TARGET_URL>
 *
 * OPTIONAL QUERY PARAMS:
 *   &ref=<encoded referer>      -> Referer header sent to origin
 *   &origin=<encoded origin>    -> Origin header sent to origin
 *   &ua=<encoded user-agent>    -> override User-Agent sent to origin
 *   &token=<value>              -> required if env.PROXY_TOKEN is set
 *
 * ENV VARS (wrangler.toml / dashboard):
 *   ALLOWED_HOSTS   -> comma separated hostnames allowed as targets
 *                      (recommended for any public deployment)
 *   PROXY_TOKEN     -> if set, all requests must supply &token=
 *   RATE_LIMIT_MAX  -> requests allowed per window per IP (default 120)
 *   RATE_LIMIT_WINDOW_SEC -> window size in seconds (default 60)
 *
 * OPTIONAL BINDING:
 *   RATE_LIMIT_KV   -> KV namespace binding, enables rate limiting.
 *                      If not bound, rate limiting is skipped silently.
 */

/* ============================== CONFIG ============================== */

const UPSTREAM_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;
const DEFAULT_RATE_LIMIT_MAX = 120;
const DEFAULT_RATE_LIMIT_WINDOW_SEC = 60;

// VLC-like User-Agent pool. When upstream returns 403/401, we retry with the
// next UA in this list. The first UA that works is cached for that host.
// Minimal UA pool. The first entry is the confirmed working UA for IPTV portals.
// On 403/401, we try the next one. Kept small to minimize subrequests + latency.
const USER_AGENT_POOL = [
  "VLC/3.0.21 LibVLC/3.0.21",
  "VLC/3.0.18 LibVLC/3.0.18",
  "Lavf/58.76.100",
];

// Per-host UA cache (so we don't have to try every UA on every request).
const _hostUaCache = new Map();

// Referer fallbacks — only used if the first request gets 403 and no channel
// Referer was supplied. Kept minimal to avoid excessive subrequests.
const REFERER_FALLBACKS = (host) => [
  "http://" + host + "/",
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers":
    "Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag, Last-Modified, Cache-Control, Content-Encoding, Expires, Date",
  "Access-Control-Max-Age": "86400",
  "Timing-Allow-Origin": "*",
};

// Headers we forward FROM the client TO the upstream origin.
// Kept minimal — only Range and conditional-request headers that are
// safe and necessary for media streaming.
const REQUEST_HEADERS_TO_FORWARD = [
  "range",
  "if-none-match",
  "if-modified-since",
];

// Headers we copy FROM the upstream response back TO the client.
const RESPONSE_HEADERS_TO_PRESERVE = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
  "content-encoding",
  "expires",
  "date",
];

const TEXT_MANIFEST_EXT = [".m3u8", ".m3u", ".mpd"];

// Force-correct content types by extension (many origins mislabel these).
const MIME_MAP = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".m3u": "application/vnd.apple.mpegurl",
  ".mpd": "application/dash+xml",
  ".ts": "video/mp2t",
  ".m4s": "video/iso.segment",
  ".mp4": "video/mp4",
  ".aac": "audio/aac",
  ".vtt": "text/vtt",
  ".key": "application/octet-stream",
};

/* ============================== ENTRY ============================== */

export default {
  async fetch(request, env, ctx) {
    const startedAt = Date.now();
    const reqUrl = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (!["GET", "HEAD"].includes(request.method)) {
      return jsonResponse({ ok: false, message: "access denied" }, 405);
    }

    let targetUrl;
    let logCtx = { target: null, status: null, ms: null, error: null };

    try {
      const rawTarget = reqUrl.searchParams.get("url");
      if (!rawTarget) {
        return jsonResponse(
          { ok: false, message: "internal server error, server not connected!" },
          400
        );
      }

      try {
        targetUrl = new URL(decodeURIComponent(rawTarget));
      } catch (e) {
        return jsonResponse({ ok: false, message: "Invalid target URL" }, 400);
      }
      logCtx.target = targetUrl.toString();

      if (!["http:", "https:"].includes(targetUrl.protocol)) {
        return jsonResponse({ ok: false, message: "error" }, 400);
      }

      // ---- Security: token auth ----
      if (env.PROXY_TOKEN) {
        const token = reqUrl.searchParams.get("token");
        if (token !== env.PROXY_TOKEN) {
          return jsonResponse({ ok: false, message: " বাল পাকনামু চুদাও👽🤣" }, 401);
        }
      }

      // ---- Security: host allowlist ----
      if (env.ALLOWED_HOSTS) {
        if (!isHostAllowed(targetUrl.hostname, env.ALLOWED_HOSTS)) {
          return jsonResponse(
            { ok: false, message: `Host '${targetUrl.hostname}' not in allowlist` },
            403
          );
        }
      }

      // ---- Security: rate limiting (optional, needs KV binding) ----
      if (env.RATE_LIMIT_KV) {
        const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
        const limited = await isRateLimited(env, clientIp);
        if (limited) {
          return jsonResponse({ ok: false, message: "Rate limit exceeded" }, 429, {
            "Retry-After": String(env.RATE_LIMIT_WINDOW_SEC || DEFAULT_RATE_LIMIT_WINDOW_SEC),
          });
        }
      }

      const extraParams = {
        ref: reqUrl.searchParams.get("ref"),
        origin: reqUrl.searchParams.get("origin"),
        ua: reqUrl.searchParams.get("ua"),
        // VLC-like per-channel HTTP options forwarded to upstream origin
        cookie: reqUrl.searchParams.get("cookie"),
        // Custom HTTP headers, semicolon-separated "Name: value" pairs
        headers: reqUrl.searchParams.get("headers"),
      };

      const cache = caches.default;
      const isRangeReq = request.headers.has("range");
      const cacheKey = new Request(reqUrl.toString(), request);

      if (!isRangeReq && request.method === "GET") {
        const cached = await cache.match(cacheKey);
        if (cached) {
          logCtx.status = cached.status;
          logCtx.cacheHit = true;
          logRequest(logCtx, startedAt);
          return withCors(cached);
        }
      }

      // ---- Fetch upstream (with timeout + manual redirect handling) ----
      // fetchUpstream follows redirects internally and returns the final response.
      // We capture the final effective URL for classification.
      const fetchResult = await fetchUpstream(request, targetUrl, extraParams, env);
      const upstreamResp = fetchResult.resp;
      const effectiveUrl = fetchResult.effectiveUrl; // final URL after redirects
      logCtx.status = upstreamResp.status;

      if (!upstreamResp.ok && upstreamResp.status !== 206 && upstreamResp.status !== 304) {
        logRequest(logCtx, startedAt);
        return jsonResponse(
          { ok: false, message: `Upstream error: ${upstreamResp.status} ${upstreamResp.statusText}` },
          upstreamResp.status || 502
        );
      }

      // Classify using the FINAL effective URL (after redirects) + Content-Type.
      // This correctly handles PHP/API endpoints that redirect to /live/play/<token>/<id>
      const finalPathLower = effectiveUrl.pathname.toLowerCase();
      const finalUrlLower = effectiveUrl.toString().toLowerCase();
      const contentType = (upstreamResp.headers.get("content-type") || "").toLowerCase();
      const isManifest =
        TEXT_MANIFEST_EXT.some((ext) => finalPathLower.endsWith(ext)) ||
        TEXT_MANIFEST_EXT.some((ext) => finalPathLower.includes(ext)) ||
        contentType.includes("mpegurl") ||
        contentType.includes("dash+xml");

      // Detect live MPEG-TS by Content-Type or URL patterns.
      const isLiveTS =
        contentType.includes("video/mp2t") ||
        finalPathLower.endsWith(".ts") ||
        (targetUrl.search || "").includes("extension=ts") ||
        finalUrlLower.includes("/live/play/") ||
        finalUrlLower.includes("/live/stream");

      let response;

      if (request.method === "HEAD") {
        // No body needed; just relay headers.
        const headers = passthroughHeaders(upstreamResp.headers, finalPathLower);
        response = new Response(null, { status: upstreamResp.status, headers });
      } else if (isManifest) {
        const bodyText = await upstreamResp.text();
        const proxyBase = `${reqUrl.origin}${reqUrl.pathname}`;
        const isMpd = finalPathLower.endsWith(".mpd") || contentType.includes("dash+xml");
        // Use effectiveUrl (final URL) as base for relative URL resolution.
        const rewritten = isMpd
          ? rewriteMPD(bodyText, effectiveUrl, proxyBase, extraParams)
          : rewriteM3U8(bodyText, effectiveUrl, proxyBase, extraParams);

        const liveness = isMpd ? mpdLiveness(bodyText) : hlsLiveness(bodyText);
        const cacheControl =
          liveness === "live" ? "public, max-age=3" : "public, max-age=180";

        response = new Response(rewritten, {
          status: upstreamResp.status,
          headers: {
            "Content-Type": isMpd ? MIME_MAP[".mpd"] : MIME_MAP[".m3u8"],
            "Cache-Control": cacheControl,
          },
        });
      } else if (isLiveTS) {
        // Live MPEG-TS: stream body directly, NO caching, NO buffering.
        const headers = passthroughHeaders(upstreamResp.headers, finalPathLower);
        // Force correct content-type if origin sent something generic.
        if (!headers.get("content-type") || headers.get("content-type").includes("octet-stream") || headers.get("content-type") === "text/html") {
          headers.set("Content-Type", MIME_MAP[".ts"]);
        }
        headers.set("Cache-Control", "no-store");
        response = new Response(upstreamResp.body, {
          status: upstreamResp.status,
          headers,
        });
      } else {
        // Binary passthrough: stream body directly, no buffering.
        const headers = passthroughHeaders(upstreamResp.headers, finalPathLower);
        // Content-type detection for extension-less URLs.
        if (!headers.get("content-type") || headers.get("content-type").includes("octet-stream") || headers.get("content-type") === "text/html") {
          const extParamMatch = (targetUrl.search || "").match(/extension=([a-z0-9]+)/i);
          if (extParamMatch) {
            const ext = "." + extParamMatch[1].toLowerCase();
            if (MIME_MAP[ext]) headers.set("Content-Type", MIME_MAP[ext]);
          }
        }
        // Non-TS binary: bounded cache for VOD segments, no-store for live.
        if (!headers.has("Cache-Control")) {
          headers.set("Cache-Control", "public, max-age=3600");
        }
        response = new Response(upstreamResp.body, {
          status: upstreamResp.status,
          headers,
        });
      }

      response = withCors(response);

      // Cache ONLY non-streaming, non-range, 200 responses (VOD segments, manifests).
      // NEVER cache live TS (endless stream — would buffer forever in cache.put).
      // NEVER cache 206 partial content.
      // NEVER cache if the response is a live stream.
      if (!isRangeReq && request.method === "GET" && upstreamResp.status === 200 && !isLiveTS) {
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }

      logRequest(logCtx, startedAt);
      return response;
    } catch (err) {
      logCtx.error = err.message;
      logRequest(logCtx, startedAt);

      if (err.name === "AbortError") {
        return jsonResponse({ ok: false, message: "Upstream request timed out" }, 504);
      }
      if (err instanceof TypeError) {
        return jsonResponse(
          { ok: false, message: "Upstream unreachable / DNS failure: " + err.message },
          502
        );
      }
      return jsonResponse({ ok: false, message: "Proxy error: " + err.message }, 500);
    }
  },
};

/* ============================== UPSTREAM FETCH ============================== */

/**
 * Fetches the target URL with timeout + manual redirect following
 * (301/302/303/307/308), re-validating the host allowlist on every hop.
 *
 * VLC-like behavior: if upstream returns 401/403, retry with a different
 * User-Agent + Referer combination. STRICTLY CAPPED to fit Cloudflare's
 * free-plan 50-subrequest limit per Worker invocation.
 *
 * Subrequest budget breakdown (worst case):
 *   - 3 redirects × 3 UA retries = 9 fetches max
 *   - + 2 referer fallbacks = 11 fetches max
 *   Well under 50. If we hit the limit anyway, we abort with 502.
 */
const MAX_SUBREQUESTS = 15; // hard cap, well under Cloudflare's 50
const MAX_UA_RETRIES = 2;   // channel UA + 1 fallback (single retry)
const MAX_REF_RETRIES = 1;  // channel ref OR 1 fallback (no doubling)

async function fetchUpstream(request, targetUrl, extraParams, env) {
  let currentUrl = targetUrl;
  let redirects = 0;
  let uaRetryIdx = 0;
  let refRetryIdx = -1;
  let totalSubrequests = 0;

  // Build the initial UA list: explicit channel UA first, then the pool.
  const uaList = [];
  if (extraParams.ua) uaList.push(decodeURIComponent(extraParams.ua));
  const cachedUa = _hostUaCache.get(targetUrl.hostname);
  if (cachedUa && !uaList.includes(cachedUa)) uaList.push(cachedUa);
  for (const ua of USER_AGENT_POOL) {
    if (uaList.length >= MAX_UA_RETRIES) break;
    if (!uaList.includes(ua)) uaList.push(ua);
  }
  // Ensure VLC/3.0.21 is always in the list as a fallback.
  if (!uaList.includes("VLC/3.0.21 LibVLC/3.0.21")) uaList.push("VLC/3.0.21 LibVLC/3.0.21");

  // Build the Referer list: explicit channel ref first, then fallbacks.
  const refList = [];
  if (extraParams.ref) refList.push(decodeURIComponent(extraParams.ref));
  const cachedRef = _hostUaCache.get(targetUrl.hostname + ":ref");
  if (cachedRef && !refList.includes(cachedRef)) refList.push(cachedRef);

  // Diagnostic logging helper — redacts sensitive values.
  function diagLog(stage, resp, attemptNum, hopNum, url, ua, hasRef, hasOrigin, hasRange, elapsed) {
    const ct = (resp && resp.headers && resp.headers.get("content-type")) || "";
    const location = (resp && resp.headers && resp.headers.get("location")) || "";
    let nextHost = "";
    if (location) {
      try { nextHost = new URL(location, url).hostname; } catch (e) { nextHost = "(unparseable)"; }
    }
    // Redact pathname: keep only first path segment + extension
    let redactedPath = "";
    try {
      const u = new URL(url);
      const segs = u.pathname.split("/").filter(Boolean);
      if (segs.length > 0) {
        redactedPath = "/" + segs[0] + "/..." + (segs.length > 1 ? "/" + segs[segs.length - 1].substring(0, 8) + "..." : "");
      } else {
        redactedPath = "/";
      }
    } catch (e) { redactedPath = "(unparseable)"; }

    console.log(JSON.stringify({
      diag: true,
      stage: stage,
      attempt: attemptNum,
      hop: hopNum,
      host: new URL(url).hostname,
      path: redactedPath,
      method: request.method,
      ua: ua ? ua.substring(0, 40) : "(none)",
      hasReferer: !!hasRef,
      hasOrigin: !!hasOrigin,
      hasRange: !!hasRange,
      status: resp ? resp.status : null,
      contentType: ct.substring(0, 40),
      hasLocation: !!location,
      nextHost: nextHost || null,
      elapsedMs: elapsed,
    }));
  }

  while (true) {
    if (totalSubrequests >= MAX_SUBREQUESTS) {
      console.log(JSON.stringify({ diag: true, stage: "subrequest_limit_reached", attempts: totalSubrequests }));
      return {
        resp: jsonResponse(
          { ok: false, message: "Subrequest limit reached." },
          502
        ),
        effectiveUrl: currentUrl,
      };
    }
    totalSubrequests += 1;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    const currentUa = uaList[uaRetryIdx] || uaList[0];
    const currentRef = refRetryIdx >= 0 ? (refList[refRetryIdx] || null) : (refList[0] || null);
    const hasRange = request.headers.has("range");
    const hasOrigin = !!(extraParams.origin);

    const upstreamHeaders = buildUpstreamHeaders(request, extraParams, currentUa, currentRef, targetUrl.hostname);

    const fetchStart = Date.now();

    let resp;
    try {
      resp = await fetch(currentUrl.toString(), {
        method: request.method === "HEAD" ? "HEAD" : "GET",
        headers: upstreamHeaders,
        redirect: "manual",
        cf: { cacheEverything: false, scrapeShield: false },
        signal: controller.signal,
      });
    } catch (fetchErr) {
      const elapsed = Date.now() - fetchStart;
      console.log(JSON.stringify({
        diag: true,
        stage: "fetch_error",
        attempt: totalSubrequests,
        hop: redirects,
        host: currentUrl.hostname,
        error: fetchErr.name || "Unknown",
        message: fetchErr.message ? fetchErr.message.substring(0, 100) : null,
        elapsedMs: elapsed,
      }));
      clearTimeout(timeout);
      throw fetchErr;
    }
    clearTimeout(timeout);

    const elapsed = Date.now() - fetchStart;

    // Log every attempt with full diagnostic context.
    diagLog("upstream_response", resp, totalSubrequests, redirects, currentUrl.toString(), currentUa, currentRef, hasOrigin, hasRange, elapsed);

    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const location = resp.headers.get("location");
      if (!location || redirects >= MAX_REDIRECTS) {
        console.log(JSON.stringify({ diag: true, stage: "redirect_exhausted", hops: redirects, hasLocation: !!location }));
        return { resp, effectiveUrl: currentUrl };
      }
      const nextUrl = new URL(location, currentUrl);
      console.log(JSON.stringify({
        diag: true,
        stage: "redirect_following",
        fromHost: currentUrl.hostname,
        toHost: nextUrl.hostname,
        hop: redirects + 1,
      }));
      // Security: validate redirect target (SSRF protection)
      if (env.ALLOWED_HOSTS && !isHostAllowed(nextUrl.hostname, env.ALLOWED_HOSTS)) {
        console.log(JSON.stringify({ diag: true, stage: "redirect_blocked_by_allowlist", host: nextUrl.hostname }));
        return {
          resp: jsonResponse(
            { ok: false, message: `Redirect target host not in allowlist` },
            403
          ),
          effectiveUrl: nextUrl,
        };
      }
      currentUrl = nextUrl;
      redirects += 1;
      uaRetryIdx = 0;
      try { await resp.arrayBuffer(); } catch (e) {}
      continue;
    }

    // VLC-like retry on 401/403/429. Capped to fit subrequest budget.
    if ((resp.status === 401 || resp.status === 403 || resp.status === 429) && uaRetryIdx < uaList.length - 1) {
      console.log(JSON.stringify({
        diag: true,
        stage: "retry_ua",
        status: resp.status,
        attempt: totalSubrequests,
        oldUa: currentUa ? currentUa.substring(0, 40) : null,
        newUa: (uaList[uaRetryIdx + 1] || "").substring(0, 40),
      }));
      uaRetryIdx += 1;
      try { await resp.arrayBuffer(); } catch (e) {}
      continue;
    }
    if ((resp.status === 401 || resp.status === 403) && refRetryIdx === -1) {
      for (const r of REFERER_FALLBACKS(targetUrl.hostname)) {
        if (refList.length >= MAX_REF_RETRIES) break;
        if (!refList.includes(r)) refList.push(r);
      }
      console.log(JSON.stringify({
        diag: true,
        stage: "retry_referer",
        status: resp.status,
        attempt: totalSubrequests,
        fallbackRef: refList[refList.length - 1] ? refList[refList.length - 1].substring(0, 50) : null,
      }));
      refRetryIdx = 0;
      try { await resp.arrayBuffer(); } catch (e) {}
      continue;
    }
    if ((resp.status === 401 || resp.status === 403) && refRetryIdx < refList.length - 1) {
      console.log(JSON.stringify({
        diag: true,
        stage: "retry_referer_next",
        status: resp.status,
        attempt: totalSubrequests,
      }));
      refRetryIdx += 1;
      try { await resp.arrayBuffer(); } catch (e) {}
      continue;
    }

    // Log final outcome
    if (resp.ok || resp.status === 206 || resp.status === 304) {
      console.log(JSON.stringify({
        diag: true,
        stage: "success",
        status: resp.status,
        attempt: totalSubrequests,
        hops: redirects,
        host: currentUrl.hostname,
        winningUa: currentUa ? currentUa.substring(0, 40) : null,
        hasReferer: !!currentRef,
      }));
      // Cache the winning UA + Referer for this host.
      _hostUaCache.set(targetUrl.hostname, currentUa);
      if (currentRef) _hostUaCache.set(targetUrl.hostname + ":ref", currentRef);
    } else {
      console.log(JSON.stringify({
        diag: true,
        stage: "final_error",
        status: resp.status,
        attempt: totalSubrequests,
        hops: redirects,
        host: currentUrl.hostname,
        allUasTried: uaList.map(u => u.substring(0, 30)),
        allRefsTried: refList.length,
      }));
    }

    return { resp, effectiveUrl: currentUrl };
  }
}

function buildUpstreamHeaders(request, extraParams, currentUa, currentRef, targetHost) {
  const headers = new Headers();

  // Forward only safe, necessary headers from the client.
  for (const name of REQUEST_HEADERS_TO_FORWARD) {
    const val = request.headers.get(name);
    if (val) headers.set(name, val);
  }

  // User-Agent — explicit per-stream UA first, then default VLC.
  headers.set("User-Agent", currentUa || "VLC/3.0.21 LibVLC/3.0.21");

  // Accept everything — matches confirmed working direct request.
  headers.set("Accept", "*/*");

  // Referer — only if explicitly provided by channel or fallback.
  if (currentRef) headers.set("Referer", currentRef);

  // Origin — only if explicitly provided by channel.
  if (extraParams.origin) headers.set("Origin", decodeURIComponent(extraParams.origin));

  // Per-channel cookie (from #EXTVLCOPT:http-cookie=...).
  if (extraParams.cookie) {
    const decodedCookie = decodeURIComponent(extraParams.cookie);
    headers.set("Cookie", decodedCookie);
  }

  // Generic custom HTTP headers (semicolon-separated "Name: value" pairs).
  // Only set when explicitly provided by the channel — never inject defaults.
  if (extraParams.headers) {
    const decodedHeaders = decodeURIComponent(extraParams.headers);
    const headerEntries = decodedHeaders.split(/;;|;\s*(?=[A-Za-z][\w-]*:)/);
    for (const entry of headerEntries) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx <= 0) continue;
      const hdrName = trimmed.substring(0, colonIdx).trim();
      const hdrVal = trimmed.substring(colonIdx + 1).trim();
      if (hdrName) {
        const lower = hdrName.toLowerCase();
        if (lower === "host" || lower === "content-length" || lower === "connection") continue;
        headers.set(hdrName, hdrVal);
      }
    }
  }

  return headers;
}

/* ============================== HEADER HELPERS ============================== */

function passthroughHeaders(upstreamHeaders, pathLower) {
  const h = new Headers();
  for (const key of RESPONSE_HEADERS_TO_PRESERVE) {
    const val = upstreamHeaders.get(key);
    if (val) h.set(key, val);
  }
  h.set("Accept-Ranges", h.get("Accept-Ranges") || "bytes");

  // Force correct content-type by extension when origin sends something
  // generic like application/octet-stream.
  const ext = Object.keys(MIME_MAP).find((e) => pathLower.endsWith(e));
  if (ext && (!h.get("content-type") || h.get("content-type").includes("octet-stream"))) {
    h.set("Content-Type", MIME_MAP[ext]);
  }
  return h;
}

function withCors(response) {
  const newResp = new Response(response.body, response);
  for (const [k, v] of Object.entries(CORS_HEADERS)) newResp.headers.set(k, v);
  return newResp;
}

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
  });
}

function isHostAllowed(hostname, allowedHostsCsv) {
  const allowed = allowedHostsCsv.split(",").map((h) => h.trim().toLowerCase());
  return allowed.includes(hostname.toLowerCase());
}

/* ============================== RATE LIMITING ============================== */

async function isRateLimited(env, clientIp) {
  const windowSec = Number(env.RATE_LIMIT_WINDOW_SEC) || DEFAULT_RATE_LIMIT_WINDOW_SEC;
  const maxReq = Number(env.RATE_LIMIT_MAX) || DEFAULT_RATE_LIMIT_MAX;
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const key = `rl:${clientIp}:${bucket}`;

  const current = await env.RATE_LIMIT_KV.get(key);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= maxReq) return true;

  await env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: windowSec + 5 });
  return false;
}

/* ============================== LOGGING ============================== */

function logRequest(logCtx, startedAt) {
  const ms = Date.now() - startedAt;
  console.log(
    JSON.stringify({
      target: logCtx.target,
      status: logCtx.status,
      ms,
      cacheHit: !!logCtx.cacheHit,
      error: logCtx.error || null,
      ts: new Date().toISOString(),
    })
  );
}

/* ============================== URL RESOLUTION ============================== */

function resolveUrl(possiblyRelative, baseUrl) {
  try {
    return new URL(possiblyRelative, baseUrl).toString();
  } catch (e) {
    return possiblyRelative;
  }
}

function buildProxyLink(absoluteUrl, proxyBase, extra) {
  const qs = new URLSearchParams();
  qs.set("url", absoluteUrl);
  if (extra.ref) qs.set("ref", extra.ref);
  if (extra.origin) qs.set("origin", extra.origin);
  if (extra.ua) qs.set("ua", extra.ua);
  return `${proxyBase}?${qs.toString()}`;
}

/* ============================== HLS (M3U/M3U8) REWRITE ============================== */

/**
 * Rewrites every URI reference in an HLS playlist so segments, keys,
 * maps, alt renditions, i-frame streams, session keys, preload hints
 * and rendition reports all route back through this proxy. Covers:
 * EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF,
 * EXT-X-SESSION-KEY, EXT-X-PRELOAD-HINT, EXT-X-RENDITION-REPORT
 * (all of these carry a URI="..." attribute, caught generically below),
 * plus plain segment/sub-playlist lines and EXT-X-STREAM-INF's URL line.
 */
function rewriteM3U8(text, targetUrl, proxyBase, extra) {
  const lines = text.split(/\r?\n/);

  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith("#")) {
      // Any directive carrying one or more URI="..." attributes
      // (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF,
      // EXT-X-SESSION-KEY, EXT-X-PRELOAD-HINT, EXT-X-RENDITION-REPORT).
      if (/URI="([^"]+)"/.test(trimmed)) {
        return line.replace(/URI="([^"]+)"/g, (match, uri) => {
          const abs = resolveUrl(uri, targetUrl);
          const proxied = buildProxyLink(abs, proxyBase, extra);
          return `URI="${proxied}"`;
        });
      }
      return line;
    }

    // Plain URL line -> media segment or nested/variant playlist,
    // used after EXT-X-STREAM-INF, EXTINF, etc.
    const abs = resolveUrl(trimmed, targetUrl);
    return buildProxyLink(abs, proxyBase, extra);
  });

  return out.join("\n");
}

function hlsLiveness(text) {
  if (/#EXT-X-ENDLIST/.test(text)) return "vod";
  if (/#EXT-X-PLAYLIST-TYPE:\s*VOD/i.test(text)) return "vod";
  return "live";
}

/* ============================== MPD (DASH) REWRITE ============================== */

/**
 * Rewrites every URL-bearing element/attribute in a DASH manifest:
 *  - <BaseURL> (MPD/Period/AdaptationSet/Representation level, any depth)
 *  - SegmentTemplate: initialization="", media="" (template tokens like
 *    $Number$/$Time$/$RepresentationID$ are preserved as part of the string)
 *  - SegmentList: <SegmentURL media="" index=""/>
 *  - SegmentBase / Initialization: sourceURL=""
 *  - xlink:href (remote Period / AdaptationSet / EventStream inclusion)
 */
function rewriteMPD(xmlText, targetUrl, proxyBase, extra) {
  let result = xmlText;

  // <BaseURL>...</BaseURL> at any nesting level
  result = result.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (match, url) => {
    const abs = resolveUrl(url.trim(), targetUrl);
    return `<BaseURL>${buildProxyLink(abs, proxyBase, extra)}</BaseURL>`;
  });

  // initialization="" / media="" (SegmentTemplate) / sourceURL="" (SegmentBase,
  // Initialization) / index="" (SegmentURL sidx reference)
  result = result.replace(
    /(initialization|media|sourceURL|index)="([^"]+)"/g,
    (match, attr, url) => {
      const abs = resolveUrl(url, targetUrl);
      return `${attr}="${buildProxyLink(abs, proxyBase, extra)}"`;
    }
  );

  // xlink:href="" (remote element inclusion, e.g. remote Period/EventStream)
  result = result.replace(/xlink:href="([^"]+)"/g, (match, url) => {
    if (url === "urn:mpeg:dash:resolve-to-zero:2013") return match; // spec sentinel, not a URL
    const abs = resolveUrl(url, targetUrl);
    return `xlink:href="${buildProxyLink(abs, proxyBase, extra)}"`;
  });

  return result;
}

function mpdLiveness(xmlText) {
  const match = xmlText.match(/type="(static|dynamic)"/);
  if (match && match[1] === "dynamic") return "live";
  return "vod";
      }
