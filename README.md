# AI TV Pro — IPTV / Live TV Player

একটি সিঙ্গেল-ফাইল HTML প্লেয়ার যা HLS (`.m3u8`), DASH (`.mpd` + DRM ClearKey), MPEG-TS (`.ts`) এবং MP4 স্ট্রিম প্লে করতে পারে। Shaka Player ও mpegts.js ব্যবহার করে তৈরি, এবং Cloudflare Worker প্রক্সি দিয়ে HTTP-প্রোটোকল স্ট্রিমও চালানো যায়।

---

## ফাইল স্ট্রাকচার

```
Vt/
├── ai-tv-pro.html      # মূল প্লেয়ার (সিঙ্গেল HTML ফাইল)
├── worker/
│   └── index.js        # Cloudflare Worker প্রক্সি (M3U/MPD/TS/CORS রিভ্রাইট)
├── wrangler.toml       # Cloudflare Worker কনফিগ
└── README.md           # এই ফাইল
```

---

## ফিচার সমূহ

- ✅ HLS (`.m3u8` / `.m3u`) — Shaka Player দিয়ে সরাসরি প্লে
- ✅ DASH (`.mpd`) — Shaka Player দিয়ে প্লে
- ✅ DRM ClearKey — `kid` + `key` দিয়ে encrypted DASH প্লে
- ✅ MPEG-TS (`.ts`) — mpegts.js দিয়ে live প্লে
- ✅ MP4 / WebM / MKV — native `<video>` প্লেব্যাক
- ✅ HTTP-protocol স্ট্রিম — Cloudflare Worker প্রক্সি দিয়ে HTTPS-এ রূপান্তর
- ✅ JSON প্লেলিস্ট সাপোর্ট (এই ফরম্যাটে: `{ name, url, kid, key, type }`)
- ✅ M3U প্লেলিস্ট সাপোর্ট (সব content tag সাপোর্ট করে: `tvg-logo`, `group-title`, `kid`, `key`, `session`, `token`, `http-user-agent`, `http-referrer`, ইত্যাদি)
- ✅ অ্যাডমিন চ্যানেল (Supabase) সব ক্যাটাগরিতে সবার উপরে দেখাবে
- ✅ Desktop / TV / Tablet মোডে নেভিগেশন চ্যানেল গ্রিডে যায়
- ✅ যেকোনো URL থেকে M3U/JSON প্লেলিস্ট লোড করা যায় (শুধু raw GitHub নয়)

---

## কীভাবে Git দিয়ে প্রক্সি হোস্ট করবেন (ফুল গাইড)

এই গাইডে আপনি শিখবেন কীভাবে Cloudflare Workers প্ল্যাটফর্মে আপনার নিজস্ব স্ট্রিমিং প্রক্সি হোস্ট করবেন Git রিপোজিটরি থেকে।

### ধাপ ১: প্রয়োজনীয় জিনিস

1. **GitHub অ্যাকাউন্ট** — কোড হোস্ট করার জন্য
2. **Cloudflare অ্যাকাউন্ট** (ফ্রি) — Worker হোস্ট করার জন্য
3. **Node.js 18+** লোকাল মেশিনে ইনস্টল থাকতে হবে
4. **Wrangler CLI** — Cloudflare Worker ডিপ্লয় করার টুল

### ধাপ ২: রিপো ক্লোন করুন

```bash
git clone https://github.com/ai-multitool-v1/Vt.git
cd Vt
```

### ধাপ ৩: Wrangler ইনস্টল করুন

```bash
npm install -g wrangler
# অথবা
npm install --save-dev wrangler
```

### ধাপ ৪: Cloudflare তে লগইন করুন

```bash
wrangler login
```

ব্রাউজার খুলবে, Cloudflare অ্যাকাউন্টে লগইন করে "Allow" ক্লিক করুন।

### ধাপ ৫: wrangler.toml কনফিগার করুন

`wrangler.toml` ফাইলে আপনার Worker এর নাম দেখুন:

```toml
name = "ai-multitools"        # আপনার Worker এর নাম
main = "worker/index.js"      # Worker entry point
compatibility_date = "2024-11-01"
workers_dev = true            # workers.dev সাবডোমেইনে ডিপ্লয় হবে
```

**আপনার Worker URL হবে:** `https://ai-multitools.<your-subdomain>.workers.dev/`

> `<your-subdomain>` হলো আপনার Cloudflare অ্যাকাউন্টের সাবডোমেইন। প্রথমবার ডিপ্লয় করার সময় Cloudflare অটোমেটিক একটি সাবডোমেইন তৈরি করবে (যেমন: `ai-multitools.workers.dev`)।

### ধাপ ৬: লোকাল টেস্ট (ঐচ্ছিক)

প্রথমে লোকালে টেস্ট করে দেখুন:

```bash
wrangler dev
```

এটি `http://localhost:8787` এ চালু হবে। ব্রাউজারে টেস্ট:

```
http://localhost:8787/?url=https%3A%2F%2Fexample.com%2Fstream.m3u8
```

### ধাপ ৭: প্রোডাকশনে ডিপ্লয় করুন

```bash
wrangler deploy
```

সফল হলে নিচের মতো আউটপুট আসবে:

```
Published ai-multitools (1.23 sec)
  https://ai-multitools.workers.dev
```

### ধাপ ৮: ai-tv-pro.html এ প্রক্সি URL আপডেট করুন

`ai-tv-pro.html` ফাইলের ভেতরে নিচের লাইনটি খুঁজুন (প্রায় লাইন 4906):

```javascript
var STREAM_PROXY_BASE = 'https://ai-multitools.workers.dev/';
```

আপনার নিজস্ব Worker URL এ পরিবর্তন করুন (যদি ভিন্ন নাম হয়):

```javascript
var STREAM_PROXY_BASE = 'https://your-worker-name.your-subdomain.workers.dev/';
```

### ধাপ ৯: প্রক্সি টেস্ট করুন

ব্রাউজারে সরাসরি টেস্ট:

```
https://ai-multitools.workers.dev/?url=https%3A%2F%2Fexample.com%2Fstream.m3u8
```

সফল হলে playlist কন্টেন্ট দেখাবে এবং সব URI গুলো প্রক্সি দিয়ে রিভ্রাইট হবে।

---

## প্রক্সি কীভাবে কাজ করে

| রিকোয়েস্ট টাইপ | কী হয় |
|----------------|--------|
| `.m3u8` / `.m3u` | HLS playlist পার্স করে সব segment/key/rendition URL প্রক্সি দিয়ে রিভ্রাইট |
| `.mpd` | DASH manifest পার্স করে BaseURL/SegmentTemplate/SegmentList URL রিভ্রাইট |
| `.ts` / `.m4s` / `.mp4` / `.aac` / `.vtt` / `.key` | Binary পাসথ্রু (CORS হেডার সহ) |
| Range রিকোয়েস্ট | সাপোর্টেড (`Range` হেডার ফরওয়ার্ড করা হয়) |
| Redirects | অটো ফলো করা হয় (সর্বোচ্চ ৫ হপ) |

### অপশনাল কোয়েরি প্যারামিটার

```
?ref=<encoded referer>     → Origin-এ Referer হেডার
&origin=<encoded origin>   → Origin-এ Origin হেডার
&ua=<encoded user-agent>   → Origin-এ User-Agent ওভাররাইড
&token=<value>             → যদি env.PROXY_TOKEN সেট করা থাকে
```

### অপশনাল এনভায়রনমেন্ট ভেরিয়েবল

`wrangler.toml` এ `[vars]` সেকশনে সেট করুন:

```toml
[vars]
ALLOWED_HOSTS = "example.com,example.net"   # শুধু এই হোস্ট অনুমোদিত
PROXY_TOKEN = "your-secret-token"           # টোকেন প্রয়োজন
RATE_LIMIT_MAX = "120"                      # প্রতি IP প্রতি উইন্ডোতে রিকোয়েস্ট
RATE_LIMIT_WINDOW_SEC = "60"                # উইন্ডো সাইজ (সেকেন্ড)
```

Rate limiting চালু করতে KV namespace দরকার:

```bash
wrangler kv namespace create RATE_LIMIT_KV
```

তারপর `wrangler.toml` এ যোগ করুন:

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "your-kv-namespace-id"
```

---

## আপডেট পুশ করার প্রক্রিয়া

যখন `worker/index.js` পরিবর্তন করবেন:

```bash
git add worker/index.js
git commit -m "Update proxy worker"
git push origin main

# Cloudflare Worker আপডেট করতে:
wrangler deploy
```

---

## GitHub Actions দিয়ে অটো-ডিপ্লয় (অপশনাল)

`.github/workflows/deploy-worker.yml` ফাইল তৈরি করুন:

```yaml
name: Deploy Worker
on:
  push:
    branches: [main]
    paths: ['worker/**']
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

GitHub রিপো Settings → Secrets এ যোগ করুন:
- `CLOUDFLARE_API_TOKEN` — Cloudflare ড্যাশবোর্ড থেকে তৈরি করুন (Workers পারমিশন সহ)
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare ড্যাশবোর্ডের ডান পাশে দেখা যায়

এখন প্রতিবার `worker/` ফোল্ডারে push করলে অটোমেটিক Cloudflare Worker আপডেট হবে।

---

## JSON প্লেলিস্ট ফরম্যাট

Music ক্যাটাগরি `music.json` থেকে লোড হয়। ফাইল ফরম্যাট:

```javascript
{ name: "WC Tv", url: "https://example.com/stream.mpd", kid: "abc123...", key: "def456...", type: "stream" },
{ name: "Fox One", url: "https://example.com/fox.mpd", kid: "...", key: "...", type: "stream" }
```

> **টীকা:** এটি strict JSON নয় — JavaScript object-literal syntax ব্যবহার করা হয়েছে (unquoted property names, wrapping array নেই)। পার্সার দুই ফরম্যাটই সাপোর্ট করে।

### সাপোর্টেড ফিল্ড

| ফিল্ড | বর্ণনা |
|-------|--------|
| `name` | চ্যানেলের নাম (আবশ্যক) |
| `url` | স্ট্রিম URL (আবশ্যক) |
| `kid` | DRM ClearKey KID (hex, 32 অক্ষর) |
| `key` | DRM ClearKey key (hex, 32 অক্ষর) |
| `type` | `"stream"` (ডিফল্ট), `"iframe"`, `"upload"` |
| `logo` | চ্যানেল লোগো URL |
| `group` | ক্যাটাগরি নাম |

---

## M3U প্লেলিস্ট সাপোর্টেড ট্যাগ

পার্সার সব M3U ট্যাগ সাপোর্ট করে, যেমন:

```
#EXTINF:-1 tvg-logo="..." group-title="..." kid="..." key="..." session="..." token="..." http-user-agent="..." http-referrer="..." tvg-id="..." tvg-name="..." Channel Name
https://stream.url/playlist.m3u8
```

বিশেষ ট্যাগ:
- `#EXTGRP:Group Name` — গ্রুপ সেট করতে
- `#EXTVLCOPT:http-user-agent=...` — User-Agent সেট করতে
- `#EXTVLCOPT:http-referrer=...` — Referer সেট করতে
- যেকোনো কাস্টম `key="value"` এট্রিবিউট সাপোর্টেড

---

## ট্রাবলশুটিং

### সমস্যা: `EME use is not allowed on unique origins`
**সমাধান:** `file://` প্রোটোকলে DRM কাজ করে না। HTML ফাইল HTTP সার্ভার থেকে খুলুন (যেমন `python3 -m http.server`)।

### সমস্যা: `.mpd` ফাইল ডাউনলোড হয়ে যাচ্ছে
**সমাধান:** Shaka Player লোড হচ্ছে না বা browser unsupported। Browser console এ লগ চেক করুন।

### সমস্যা: HTTP স্ট্রিম প্লে হচ্ছে না
**সমাধান:** Cloudflare Worker প্রক্সি চালু আছে কিনা চেক করুন। `STREAM_PROXY_BASE` সঠিক URL পয়েন্ট করছে কিনা দেখুন।

### সমস্যা: DRM স্ট্রিম চলছে না
**সমাধান:** 
- Browser console এ `[Shaka-DRM]` লগ দেখুন
- `kid` ও `key` সঠিক hex (32 অক্ষর) কিনা চেক করুন
- Browser ClearKey সাপোর্ট করে কিনা চেক করুন (Chrome/Firefox সাপোর্ট করে)

### সমস্যা: Worker ডিপ্লয় ফেইল করছে
**সমাধান:**
- `wrangler login` সঠিকভাবে হয়েছে কিনা চেক করুন
- `wrangler.toml` এ `name` ইউনিক কিনা দেখুন
- Cloudflare অ্যাকাউন্টে Workers প্ল্যান অ্যাক্টিভ কিনা চেক করুন

---

## লাইসেন্স

MIT License — ফ্রি ব্যবহার, মডিফিকেশন, ডিস্ট্রিবিউশন।

## কন্টাক্ট

কোনো সমস্যা হলে GitHub Issues এ রিপোর্ট করুন।
