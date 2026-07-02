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
const USER_AGENT_POOL = [
  "VLC/3.0.18 LibVLC/3.0.18",
  "VLC/3.0.17 LibVLC/3.0.17",
  "VLC/3.0.16 LibVLC/3.0.16",
  "Lavf/58.76.100",
  "Lavf/58.45.100",
  "Lavf/57.83.103",
  "mpv 0.33.1",
  "mpv 0.32.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
  "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "AppleCoreMedia/1.0.0.20A362 (iPhone; U; CPU OS 16_0 like Mac OS X; en_us)",
  "ExoPlayer",
  "TVirl/7.6.2 (Linux;Android 11) ExoPlayerLib/2.18.5",
  " Kodi/20.0 (Linux; Android 11) Krypton",
];

// Per-host UA cache (so we don't have to try every UA on every request).
const _hostUaCache = new Map();

// Realistic client IPs for X-Forwarded-For spoofing. Many IPTV portals check
// this header to "trust" the request. We rotate through residential-looking IPs.
const CLIENT_IP_POOL = [
  "192.168.1." + (Math.floor(Math.random() * 254) + 1),
  "10.0.0." + (Math.floor(Math.random() * 254) + 1),
  "172.16.0." + (Math.floor(Math.random() * 254) + 1),
  "100.64.0." + (Math.floor(Math.random() * 254) + 1),
];

// Realistic Origin/Referer pairs to try when channel doesn't supply one.
const REFERER_FALLBACKS = (host) => [
  "http://" + host + "/",
  "https://" + host + "/",
  "http://" + host + "/c/c/",
  "http://" + host + "/portal.php",
  "https://" + host + "/stalker_portal/",
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
const REQUEST_HEADERS_TO_FORWARD = [
  "authorization",
  "cookie",
  "accept",
  "accept-language",
  "if-none-match",
  "if-modified-since",
  "range",
];
// NOTE: accept-encoding is deliberately NOT forwarded from the client;
// see compression notes near fetchUpstream().

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
      const upstreamResp = await fetchUpstream(request, targetUrl, extraParams, env);
      logCtx.status = upstreamResp.status;

      if (!upstreamResp.ok && upstreamResp.status !== 206 && upstreamResp.status !== 304) {
        logRequest(logCtx, startedAt);
        return jsonResponse(
          { ok: false, message: `Upstream error: ${upstreamResp.status} ${upstreamResp.statusText}` },
          upstreamResp.status || 502
        );
      }

      const pathLower = targetUrl.pathname.toLowerCase();
      const contentType = (upstreamResp.headers.get("content-type") || "").toLowerCase();
      const isManifest =
        TEXT_MANIFEST_EXT.some((ext) => pathLower.endsWith(ext)) ||
        contentType.includes("mpegurl") ||
        contentType.includes("dash+xml");

      let response;

      if (request.method === "HEAD") {
        // No body needed; just relay headers.
        const headers = passthroughHeaders(upstreamResp.headers, pathLower);
        response = new Response(null, { status: upstreamResp.status, headers });
      } else if (isManifest) {
        const bodyText = await upstreamResp.text();
        const proxyBase = `${reqUrl.origin}${reqUrl.pathname}`;
        const isMpd = pathLower.endsWith(".mpd") || contentType.includes("dash+xml");
        const rewritten = isMpd
          ? rewriteMPD(bodyText, targetUrl, proxyBase, extraParams)
          : rewriteM3U8(bodyText, targetUrl, proxyBase, extraParams);

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
      } else {
        // Binary passthrough: stream body directly, no buffering.
        const headers = passthroughHeaders(upstreamResp.headers, pathLower);
        // VLC-like content-type detection by URL query string for stream URLs
        // that don't have a file extension (e.g. /play/live.php?...&extension=ts).
        if (!headers.get("content-type") || headers.get("content-type").includes("octet-stream") || headers.get("content-type") === "text/html") {
          const extParamMatch = (targetUrl.search || "").match(/extension=([a-z0-9]+)/i);
          const urlLow = targetUrl.toString().toLowerCase();
          if (extParamMatch) {
            const ext = "." + extParamMatch[1].toLowerCase();
            if (MIME_MAP[ext]) headers.set("Content-Type", MIME_MAP[ext]);
          } else if (urlLow.includes('/live/play/') || urlLow.includes('/live/stream')) {
            // Many IPTV portals serve raw MPEG-TS at /live/play/<token>/<id>
            headers.set("Content-Type", MIME_MAP[".ts"]);
          }
        }
        if (!headers.has("Cache-Control")) {
          headers.set("Cache-Control", "public, max-age=86400, immutable");
        }
        response = new Response(upstreamResp.body, {
          status: upstreamResp.status,
          headers,
        });
      }

      response = withCors(response);

      if (!isRangeReq && request.method === "GET" && upstreamResp.status === 200) {
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
const MAX_SUBREQUESTS = 40; // hard cap, leaves headroom under Cloudflare's 50
const MAX_UA_RETRIES = 3;   // channel UA + 2 fallbacks
const MAX_REF_RETRIES = 2;  // channel ref + 1 fallback (or 2 fallbacks if no channel ref)

async function fetchUpstream(request, targetUrl, extraParams, env) {
  let currentUrl = targetUrl;
  let redirects = 0;
  let uaRetryIdx = 0;
  let refRetryIdx = -1;
  let totalSubrequests = 0;

  // Build the initial UA list: explicit channel UA first, then the pool.
  // Capped at MAX_UA_RETRIES to keep subrequest count under Cloudflare's limit.
  const uaList = [];
  if (extraParams.ua) uaList.push(decodeURIComponent(extraParams.ua));
  const cachedUa = _hostUaCache.get(targetUrl.hostname);
  if (cachedUa && !uaList.includes(cachedUa)) uaList.push(cachedUa);
  for (const ua of USER_AGENT_POOL) {
    if (uaList.length >= MAX_UA_RETRIES) break;
    if (!uaList.includes(ua)) uaList.push(ua);
  }

  // Build the Referer list: explicit channel ref first, then fallbacks.
  // Capped at MAX_REF_RETRIES.
  const refList = [];
  if (extraParams.ref) refList.push(decodeURIComponent(extraParams.ref));
  const cachedRef = _hostUaCache.get(targetUrl.hostname + ":ref");
  if (cachedRef && !refList.includes(cachedRef)) refList.push(cachedRef);
  // We'll lazily add fallback referers only if we hit a 403.

  while (true) {
    // Hard cap on total subrequests to avoid Cloudflare's "Too many subrequests" error.
    if (totalSubrequests >= MAX_SUBREQUESTS) {
      return jsonResponse(
        { ok: false, message: "Subrequest limit reached. Stream may be blocked or require VLC." },
        502
      );
    }
    totalSubrequests += 1;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    const currentUa = uaList[uaRetryIdx] || uaList[0];
    const currentRef = refRetryIdx >= 0 ? (refList[refRetryIdx] || null) : (refList[0] || null);

    const upstreamHeaders = buildUpstreamHeaders(request, extraParams, currentUa, currentRef, targetUrl.hostname);

    let resp;
    try {
      resp = await fetch(currentUrl.toString(), {
        method: request.method === "HEAD" ? "HEAD" : "GET",
        headers: upstreamHeaders,
        redirect: "manual",
        cf: { cacheEverything: false, scrapeShield: false },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const location = resp.headers.get("location");
      if (!location || redirects >= MAX_REDIRECTS) {
        return resp; // give up, return the redirect response as-is
      }
      const nextUrl = new URL(location, currentUrl);
      if (env.ALLOWED_HOSTS && !isHostAllowed(nextUrl.hostname, env.ALLOWED_HOSTS)) {
        return jsonResponse(
          { ok: false, message: `Redirect target host '${nextUrl.hostname}' not in allowlist` },
          403
        );
      }
      currentUrl = nextUrl;
      redirects += 1;
      // Reset UA retry counter on redirect — the new host may accept the channel UA.
      uaRetryIdx = 0;
      continue;
    }

    // VLC-like retry on 401/403/429. Capped to fit subrequest budget.
    if ((resp.status === 401 || resp.status === 403 || resp.status === 429) && uaRetryIdx < uaList.length - 1) {
      uaRetryIdx += 1;
      try { await resp.arrayBuffer(); } catch (e) {}
      continue;
    }
    // Only try referer fallbacks if UA retries exhausted AND we haven't tried referer fallbacks yet.
    if ((resp.status === 401 || resp.status === 403) && refRetryIdx === -1) {
      // Add at most MAX_REF_RETRIES fallback referers.
      for (const r of REFERER_FALLBACKS(targetUrl.hostname)) {
        if (refList.length >= MAX_REF_RETRIES) break;
        if (!refList.includes(r)) refList.push(r);
      }
      refRetryIdx = 0;
      try { await resp.arrayBuffer(); } catch (e) {}
      continue;
    }
    if ((resp.status === 401 || resp.status === 403) && refRetryIdx < refList.length - 1) {
      refRetryIdx += 1;
      // Don't reset uaRetryIdx — keep subrequest count low, just try the next referer
      // with the last working UA.
      try { await resp.arrayBuffer(); } catch (e) {}
      continue;
    }

    // Success! Cache the winning UA + Referer for this host.
    if (resp.ok || resp.status === 206 || resp.status === 304) {
      _hostUaCache.set(targetUrl.hostname, currentUa);
      if (currentRef) _hostUaCache.set(targetUrl.hostname + ":ref", currentRef);
    }

    return resp;
  }
}

function buildUpstreamHeaders(request, extraParams, currentUa, currentRef, targetHost) {
  const headers = new Headers();

  for (const name of REQUEST_HEADERS_TO_FORWARD) {
    const val = request.headers.get(name);
    if (val) headers.set(name, val);
  }

  // Identity encoding — see compression notes above.
  headers.set("Accept-Encoding", "identity");

  // User-Agent (VLC-like, override-able per-channel via &ua=)
  headers.set("User-Agent", currentUa || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");

  // Referer
  if (currentRef) headers.set("Referer", currentRef);

  // Origin (separate from Referer)
  if (extraParams.origin) headers.set("Origin", decodeURIComponent(extraParams.origin));
  else if (currentRef) {
    // Auto-derive Origin from Referer so the two headers match
    try {
      const refUrl = new URL(currentRef);
      headers.set("Origin", refUrl.origin);
    } catch (e) {}
  }

  // VLC-like per-channel cookie (from #EXTVLCOPT:http-cookie=...).
  if (extraParams.cookie) {
    const decodedCookie = decodeURIComponent(extraParams.cookie);
    const existingCookie = headers.get("Cookie") || "";
    headers.set("Cookie", existingCookie ? existingCookie + "; " + decodedCookie : decodedCookie);
  }

  // Generic custom HTTP headers (semicolon-separated "Name: value" pairs)
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

  // VLC-style headers that help bypass naive portal restrictions
  if (!headers.has("Accept")) headers.set("Accept", "*/*");
  if (!headers.has("Accept-Language")) headers.set("Accept-Language", "en-US,en;q=0.9");
  if (!headers.has("X-Forwarded-For")) {
    headers.set("X-Forwarded-For", CLIENT_IP_POOL[Math.floor(Math.random() * CLIENT_IP_POOL.length)]);
  }
  // Some portals (Stalker/ministra) check these to recognize set-top-box clients.
  if (!headers.has("X-Real-IP")) headers.set("X-Real-IP", CLIENT_IP_POOL[Math.floor(Math.random() * CLIENT_IP_POOL.length)]);
  if (!headers.has("X-Requested-With")) headers.set("X-Requested-With", "XMLHttpRequest");

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
