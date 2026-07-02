/**
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
    // HTTPS Only
if (request.headers.get("X-Forwarded-Proto") !== "https") {
  return jsonResponse(
    { ok: false, message: "HTTPS required" },
    403
  );
}

// Allowed Origin
const allowedOrigins = [
  "https://ai-multitool.pages.dev"
];

const origin = request.headers.get("Origin");


if (origin && !allowedOrigins.includes(origin)) {
  return jsonResponse(
    { ok: false, message: "Forbidden" },
    403
  );
}

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (!["GET", "HEAD"].includes(request.method)) {
      return jsonResponse({ ok: false, message: "Only GET/HEAD are supported" }, 405);
    }

    let targetUrl;
    let logCtx = { target: null, status: null, ms: null, error: null };

    try {
      const rawTarget = reqUrl.searchParams.get("url");
      if (!rawTarget) {
        return jsonResponse(
          { ok: false, message: "Missing 'url' param. Usage: /?url=<encoded target>" },
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
        return jsonResponse({ ok: false, message: "Only http/https targets allowed" }, 400);
      }

      // ---- Security: token auth ----
      if (env.PROXY_TOKEN) {
        const token = reqUrl.searchParams.get("token");
        if (token !== env.PROXY_TOKEN) {
          return jsonResponse({ ok: false, message: "Invalid or missing token" }, 401);
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
 */
async function fetchUpstream(request, targetUrl, extraParams, env) {
  let currentUrl = targetUrl;
  let redirects = 0;

  while (true) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    const upstreamHeaders = buildUpstreamHeaders(request, extraParams);

    let resp;
    try {
      resp = await fetch(currentUrl.toString(), {
        method: request.method === "HEAD" ? "HEAD" : "GET",
        headers: upstreamHeaders,
        redirect: "manual",
        cf: { cacheEverything: false },
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
      continue;
    }

    return resp;
  }
}

function buildUpstreamHeaders(request, extraParams) {
  const headers = new Headers();

  for (const name of REQUEST_HEADERS_TO_FORWARD) {
    const val = request.headers.get(name);
    if (val) headers.set(name, val);
  }

  // Deliberately request identity encoding from upstream: Workers'
  // fetch() auto-decodes gzip/br anyway, and re-forwarding the raw
  // Accept-Encoding can cause double-compression edge cases. Cloudflare's
  // edge will still auto-compress the final response to the client based
  // on the client's own Accept-Encoding header.
  headers.set("Accept-Encoding", "identity");

  headers.set(
    "User-Agent",
    extraParams.ua
      ? decodeURIComponent(extraParams.ua)
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
  );
  if (extraParams.ref) headers.set("Referer", decodeURIComponent(extraParams.ref));
  if (extraParams.origin) headers.set("Origin", decodeURIComponent(extraParams.origin));

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
