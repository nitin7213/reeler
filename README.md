# ReelScript AI — Reel Ingest module

Collects public Instagram Reels for a creator, extracts the audio, transcribes it locally (Hindi, English, Hinglish), and stores metrics and transcripts in PostgreSQL for analytics and script generation.

- **Stack:** Node.js 22 + TypeScript, PostgreSQL, [pg-boss](https://github.com/timgit/pg-boss) background jobs (no Redis), Fastify API.
- **Free path:** yt-dlp + FFmpeg + whisper.cpp, all running locally. Profile-wide discovery uses Meta's official Business Discovery API (free, but needs a token).
- **Swappable:** discovery, media and speech-to-text each sit behind a provider interface ([src/providers/types.ts](src/providers/types.ts)).

---

## 1. What works today (verified 2026-10-22)

| Capability | Status | How |
|---|---|---|
| Single Reel → metadata (caption, date, likes, comments) | ✅ works logged-out | yt-dlp |
| Single Reel → audio file | ✅ works logged-out; downloads the audio-only stream (~250 KB per 20 s), not the video | yt-dlp + FFmpeg |
| Transcription (de/en/hi + Hinglish code-switching) | ✅ ~7× real-time on an Apple M4 | whisper.cpp `large-v3-turbo-q5_0` + Silero VAD |
| **Views** for a Reel | ⚠️ only through Meta Business Discovery or Apify | Logged-out Instagram payloads contain no view or play count |
| **Profile-wide discovery** | ⚠️ needs a provider token | Logged-out Instagram endpoints now return `401 require_login` |

**The main limitation:** there is no longer a free, logged-out, compliant way to list all Reels on a profile. I tested all three:

- `GET /api/v1/users/web_profile_info` returned `401 {"require_login":true}`.
- `/<user>/reels/` and the profile embed are rendered client-side and contain no shortcodes.
- yt-dlp's `instagram:user` extractor is marked broken upstream and fails.

The module therefore supports three discovery modes:

1. **`meta_business_discovery`** (recommended): official, free, paginated, includes `view_count`. It needs your own Instagram Business or Creator account linked to a Facebook Page. The target must also be a Business or Creator account; most creators are.
2. **`apify_reel_scraper`**: paid and opt-in. A hosted scraper with profile-wide results and views. Review Apify's and Instagram's terms before enabling it.
3. **`reelUrls`**: you pass Reel URLs directly. Always works and is free.

With no discovery provider configured, a `profileUrl`-only import fails with an explanation of these options. It never returns a silent partial result.

---

## 2. Provider evaluation

All three proposed options were cloned or read and run against real public Reels (e.g. `instagram.com/reel/CsOS1ZhoQ55`).

| | **parth-dl** | **FluxNote instagram-reels-audio-download** | **Apify maximedupre/instagram-reels-audio-downloader** |
|---|---|---|---|
| Repo / licence | MIT, 52★, last push 2026-07-25, v1.2.0 | MIT, 1★, created 2026-09-14 (3 commits) | Closed-source actor, 6 total users, "beta", no rating |
| What it is | Pure-stdlib Python scraper (embed → logged-out GraphQL → private API) | ~100-line CLI wrapper around **yt-dlp** + FFmpeg | Hosted actor that returns a source `audioUrl` |
| Profile-wide discovery | ❌ "profile" support only fetches the profile picture | ❌ single Reel URLs only | ❌ single Reel URLs only (stated on its page) |
| Single Reel audio | ✅ worked 3/3, but downloads the **full video** (you extract audio yourself) | ✅ worked (tested via yt-dlp directly), audio-only stream | Not run: needs an Apify token. The page shows `audioUrl` (audio/mp4) |
| Metrics | Duration only. Likes, comments and date are dropped | Via yt-dlp: likes, comments, timestamp, caption. **No views** | None |
| Auth | None. Logged-out | None by default; offers `--cookies-from-browser` (not used here) | Apify API token |
| Free tier / cost | Free | Free | Listed at $0.01 per 1,000 audios, pay-per-event. Apify's free plan includes a $5 monthly credit |
| Setup | `pip install`, Python ≥3.9 | `pip install`, Python ≥3.10 + FFmpeg | Apify account + token |
| Risk | Hard-codes Instagram `doc_id`s that change often | Adds little beyond yt-dlp, and yt-dlp is the actively maintained part | Very new, tiny user base, no SLA |

**Decision:** use **yt-dlp** directly, the engine FluxNote wraps. It:

- returns the most metadata;
- fetches an audio-only DASH stream;
- is the most actively maintained of these options.

It is called with `--ignore-config` and never given cookies. The Apify audio actor is implemented as an optional fallback (`MEDIA_PROVIDER=apify_audio`). parth-dl is not integrated: it adds nothing yt-dlp lacks, and it drops the metrics.

### Expected cost per import

Assumptions: average Reel about 45 s; about 60 % of a creator's posts are Reels. Prices are as listed on 2026-10-22; check them before relying on them.

| Pipeline | 100 Reels | 500 Reels | 1,000 Reels | Notes |
|---|---|---|---|---|
| **Default: Meta discovery + yt-dlp + local whisper.cpp** | **$0** | **$0** | **$0** | About 4 / 17 / 34 Graph API calls. Time on an M4 is roughly 10 min / 50 min / 1.7 h, bounded by the 4 s pacing between Instagram requests |
| `reelUrls` + yt-dlp + whisper.cpp | $0 | $0 | $0 | Same throughput, but you supply the URLs |
| Apify Reel Scraper discovery | $0.26 | $1.30 | $2.60 | $2.60 per 1,000 on Apify's Free plan ($2.30 on Starter). Fits in the $5 monthly free credit up to about 1,900 results |
| + Apify audio downloader instead of yt-dlp | +$0.001 | +$0.005 | +$0.01 | Listed price. Unproven actor |
| Hosted STT instead of local (`openai_compatible`, e.g. `whisper-1` at $0.006/min) | $0.45 | $2.25 | $4.50 | Set `OPENAI_COMPAT_USD_PER_MINUTE` to your provider's price |

Transcripts are cached by audio SHA-256, provider and model, so re-importing a Reel never pays for transcription twice. Every operation writes a `cost_events` row, including cache hits with `cached=true`.

---

## 3. Setup (macOS, Apple Silicon)

```bash
brew install ffmpeg yt-dlp whisper-cpp postgresql@14
npm install

# Whisper model (574 MB, sha1 e050f7970618a659205450ad97eb95a18d69c9ee) + VAD model (0.9 MB)
mkdir -p models
curl -L -o models/ggml-large-v3-turbo-q5_0.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
curl -L -o models/ggml-large-v3-q5_0.bin       https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin   # 1.08 GB: English translation + Hindi
curl -L -o models/ggml-silero-v5.1.2.bin   https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin

# Database: point DATABASE_URL at your Postgres, or run a project-local one on :5433
/opt/homebrew/opt/postgresql@14/bin/initdb -D .pgdata -U reelscript --auth=trust -E UTF8
/opt/homebrew/opt/postgresql@14/bin/pg_ctl -D .pgdata -o "-p 5433 -k /tmp" -l .pgdata/server.log start
createdb -h localhost -p 5433 -U reelscript reelscript
createdb -h localhost -p 5433 -U reelscript reelscript_test

cp .env.example .env          # then fill in tokens if you use Meta/Apify
npm run migrate
npm run doctor                # checks postgres, ffmpeg, yt-dlp, whisper, models
npm run dev                   # API + workers in one process (ROLE=all)
```

Production: `npm run build`, then run `ROLE=api npm start` and `ROLE=worker npm start` as separate processes. Workers scale horizontally; pg-boss handles locking.

Linux: `apt install ffmpeg`, `pipx install yt-dlp`, and build whisper.cpp from source (CUDA optional). On a CPU-only server, `ggml-small` or the hosted provider may be more practical.

### Environment variables

See [.env.example](.env.example) for the full list. The important ones:

```dotenv
DATABASE_URL=postgres://reelscript@localhost:5433/reelscript
HOST=127.0.0.1                       # the API has no auth; keep it private or behind your gateway
DISCOVERY_PROVIDER=meta_business_discovery   # none | meta_business_discovery | apify_reel_scraper
META_ACCESS_TOKEN=                   # instagram_basic, pages_read_engagement, instagram_manage_insights
META_IG_USER_ID=                     # YOUR IG Business account id (17841...)
APIFY_TOKEN=                         # only for apify_* providers
MEDIA_PROVIDER=yt_dlp                # yt_dlp | apify_audio
MEDIA_MIN_INTERVAL_MS=4000           # polite pacing between Instagram requests
TRANSCRIPTION_PROVIDER=whisper_cpp   # whisper_cpp | openai_compatible
WHISPER_MODEL_PATH=./models/ggml-large-v3-turbo-q5_0.bin
RETRY_DELAY_SECONDS=30               # base for exponential backoff on 429 / transient errors
```

Secrets are read only from the environment. `.env` is git-ignored, and tokens are sent in `Authorization` headers, never in URLs or logs.

---

## 4. API

### `POST /v1/imports`: start an import (returns immediately)

```bash
# Profile-wide (requires a discovery provider)
curl -X POST localhost:3000/v1/imports -H 'content-type: application/json' \
  -d '{"profileUrl":"https://www.instagram.com/some_creator/","maxReels":500}'

# Explicit Reels (always free)
curl -X POST localhost:3000/v1/imports -H 'content-type: application/json' -d '{
  "reelUrls": ["https://www.instagram.com/reel/CrilSThplji/", "https://www.instagram.com/reel/CsOS1ZhoQ55/"],
  "transcribe": true
}'
```

```json
{"importId":"177091af-bf45-4bcb-a616-d5847d487534","status":"queued","deduplicated":false,
 "statusUrl":"/v1/imports/177091af-bf45-4bcb-a616-d5847d487534"}
```

Posting the same source while an import is still running returns the existing import with `"deduplicated": true` and HTTP 200.

### `GET /v1/imports/:id`: progress, coverage, failures, cost

This is a real response from importing five public Reels plus one invalid shortcode:

```json
{
  "importId": "177091af-bf45-4bcb-a616-d5847d487534",
  "status": "partial",
  "discoveryProvider": "reel_urls",
  "collection": {
    "reelsDiscovered": 6,
    "coverage": "user_supplied",
    "complete": null,
    "notes": ["6 Reel URL(s) supplied by the caller; no profile-wide discovery was performed."]
  },
  "progress": { "total": 6, "percent": 100, "done": 4, "skipped": 2 },
  "failures": [
    { "shortcode": "Csa90IvAZka", "outcome": "skipped", "kind": "unavailable", "attempts": 1,
      "error": "ERROR: [Instagram] Csa90IvAZka: Instagram sent an empty media response. ..." },
    { "shortcode": "ZZZZZZZZZZZ", "outcome": "skipped", "kind": "unavailable", "attempts": 1, "error": "..." }
  ],
  "costs": { "totalUsd": 0, "items": [
    { "provider": "whisper_cpp", "operation": "transcription", "units": 1.276,
      "unit": "audio_minutes", "cachedUnits": 0, "usd": 0 } ] },
  "error": null,
  "finishedAt": "2026-10-22T18:26:37.983Z"
}
```

- `status`: `queued → discovering → processing → completed | partial | failed`. The status is **`partial`** whenever any Reel was skipped or failed, or the provider could not return every Reel. It is never reported as `completed` in those cases.
- `collection.complete`: `true` only when the provider scanned every post it reports for the account; `false` when it is known to be incomplete; `null` when it cannot be verified.
- `failures[].kind`: one of `private`, `not_found`, `unavailable` (deleted, private or restricted; Instagram doesn't say which when logged out), `throttled`, `login_required`, `no_audio`, `config`, `transient`.

### `POST /v1/imports/:id/retry`

Re-queues failed Reels, and Reels that were `unavailable` (a login wall can be temporary), or re-runs a failed discovery step. Records are upserted, so retrying never creates duplicates.

```json
{"requeued":2,"rediscover":false}
```

### `GET /v1/profiles/:username/reels`: the input for script generation

```json
{
  "username": "svglehn",
  "count": 1,
  "reels": [{
    "shortcode": "CrilSThplji",
    "url": "https://www.instagram.com/reel/CrilSThplji/",
    "caption": "GTV und SVG machen gemeinsame Sache bei der Vereinsaktion = ...",
    "publishedAt": "2023-04-27T12:55:37.000Z",
    "durationSeconds": 37.74,
    "availability": "available",
    "metrics": {
      "views": null, "likes": 63, "comments": 0,
      "collectedAt": { "views": null, "likes": "2026-10-22T18:27:18.384Z", "comments": "2026-10-22T18:27:18.384Z" },
      "hidden": null, "missing": ["views"], "stale": []
    },
    "transcript": {
      "status": "completed", "language": "de",
      "english":  { "text": "\"Scheine für Vereine\" is back! Are you ready to give everything for our common success again? ...",
                    "segments": [{ "start": 0.19, "end": 2.11, "text": "\"Scheine für Vereine\" is back!" }, "..."] },
      "original": { "text": "Scheine für Vereine ist zurück. Bist du bereit, wieder alles für unseren gemeinsamen Erfolg zu geben? ...",
                    "segments": [{ "start": 0.19, "end": 1.83, "text": "Scheine für Vereine ist zurück." }, "..."] },
      "provider": "whisper_cpp", "model": "ggml-large-v3-turbo-q5_0"
    }
  }]
}
```

Metrics are stored as time-stamped snapshots per source. Each field shows its latest non-null value and when it was collected. A missing value stays `null`; it is never filled in as 0. `missing` and `stale` (older than `METRICS_STALE_AFTER_HOURS`) are listed per Reel.

### `GET /v1/profiles/:username/analytics`

The response has three parts:

- **`measured`**: rankings by views, likes, comments, engagement and engagement rate, plus the creator's medians. A Reel is an **outlier** when it reaches at least 2× the creator's median **and** at least 2× the median of Reels published within ±45 days. That period check applies when there are 3 or more peers in the window, so account growth alone doesn't create outliers. When most Reels lack views, likes become the primary metric, and the response says so in `primaryMetricReason` and `caveats`. Outlier detection is disabled below 5 Reels.
- **`content`**: per-Reel script features:
  - hook text (first 3 s) and hook type: question, number or list, direct address, bold claim, or story opener;
  - time to the first word, words per second, and speech coverage;
  - numbered steps and storytelling markers;
  - whether it ends with a call to action;
  - language: `hindi`, `english`, `hinglish` (by Devanagari/Latin ratio) or `other`.

  Keyword lists cover English, romanized Hindi and Devanagari.
- **`hypotheses`**: feature differences between outliers and other Reels, each with its evidence and a confidence of `low` or `medium`. These are explicitly correlational, and the response carries a `disclaimer`.

---

### Web UI

Open **http://127.0.0.1:3000**. From the page you can:
- start imports and watch progress (time remaining, elapsed time, the stage of each Reel);
- see past imports and delete them, optionally with their Reels, transcripts and audio;
- browse a creator's Reels in a table you can sort by any metric, with English transcripts (the original is one click away), and delete single Reels;
- switch transcription between **Sequential** and **Parallel (2 at a time)**. Parallel is about 20% faster on an M4; 4 at a time was slower in testing. The choice is saved.

**Getting every Reel from a profile, free.** Logged-out tools (instaloader 4.15.3, yt-dlp, parth-dl) all get `401 require_login` from Instagram now. Instead, the page offers a **📥 Collect Reels** bookmark:
1. Open the creator's Reels tab in your own browser.
2. Click the bookmark, then **Auto-scroll**.
3. Click **Import**. ReelScript opens with every Reel link filled in.

The bookmark only reads links shown on the page you're viewing. It never touches cookies or passwords.

Other endpoints: `GET /v1/imports`, `DELETE /v1/imports/:id?withReels=true`, `DELETE /v1/reels/:shortcode`, `GET|PUT /v1/settings`.

### English transcripts

Each transcript is stored twice: in the **original language**, which analytics and script generation use, and in **English**.
- English is Whisper's own translation, using the full `large-v3` model; `large-v3-turbo` was not trained to translate and produced wrong text.
- Hindi and Urdu originals also use `large-v3`. Turbo skipped about the first 30 seconds of a fast 2-minute Hindi Reel.
- **Time cost:** on an M4, Hindi Reels take about 2× their length to process. German and English take about 0.3–0.5×.
- Disable translation with `TRANSLATE_TO_ENGLISH=false`.
- Captions are shown as posted, not translated.

## 5. Architecture

```
POST /v1/imports ─► import_jobs ─► [reel-discover] ─► reels + metric_snapshots + reel_tasks
                                          │  (provider: meta | apify | reelUrls)
                                          ▼
                                   [reel-fetch]  (concurrency MEDIA_CONCURRENCY, paced)
                                   yt-dlp metadata + audio-only stream ─► ffmpeg 16 kHz mono WAV
                                          │  sha256 ─► audio_assets
                                          ▼
                                   [reel-transcribe] (concurrency TRANSCRIPTION_CONCURRENCY)
                                   cache lookup (sha256, provider, model) ─► whisper.cpp ─► transcripts
                                          ▼
                                   finalize: completed | partial
```

- **Retries.** pg-boss retries up to 4 times with exponential backoff on `throttled`, `transient` and `unknown` errors. Private, deleted and unavailable Reels are marked `skipped` straight away, with no hammering.
- **Deduplication.** Reels are unique by shortcode. Each (import, reel) pair is one `reel_tasks` row, and job `singletonKey`s prevent duplicate queue entries. Concurrent identical imports join the import already running.
- **Throttling.** Requests to Instagram are serialized per worker with a minimum interval. On a 429 the job backs off. There's no proxy rotation, identity switching or cookie use.
- **Logs.** Logging is structured JSON (pino), with `importId`, `reelId`, `shortcode`, `stage` and `attempt` on every line. Secrets are redacted.
- **Hinglish.** whisper.cpp first detects the language (about 2 s). If it detects Hindi or Urdu, it decodes as Hindi with a short romanized-Hinglish prompt, so English words stay in Latin script. In testing:
  - without the prompt: `इंस्टाग्राइम पर वाइरल रियल्स`
  - with the prompt: `Instagram पर viral reels`

  Never force `-l en` on Hindi audio: Whisper translates instead of transcribing.
- **Music-only Reels** are stored as `no_speech`, not as a fake "Music." transcript.

### Using it as a library

```ts
import { createReelIngest, loadConfig } from '@reelscript/reel-ingest';

const ingest = createReelIngest(loadConfig());
await ingest.start({ workers: true });
const { importId } = await ingest.importProfile({ reelUrls: ['https://www.instagram.com/reel/CrilSThplji/'] });
// later…
const reels = await ingest.getReels('svglehn');      // metrics + transcripts for script generation
const report = await ingest.getReport('svglehn');    // measured vs hypotheses
```

To add a provider, implement `DiscoveryProvider`, `ReelMediaProvider` or `TranscriptionProvider` ([src/providers/types.ts](src/providers/types.ts)) and register it in [src/providers/index.ts](src/providers/index.ts).

---

## 6. Tests

```bash
npm test                    # unit tests; the integration suite is skipped without a DB
npm run test:integration    # + real Postgres/pg-boss pipeline with fake providers
```

The integration suite covers:

- deduplicated concurrent imports;
- a Reel that is throttled once and then retried;
- a deleted Reel reported as `skipped` with status `partial`, not `completed`;
- two Reels with identical audio transcribed only once (cache hit recorded in costs);
- retry not duplicating rows;
- a profile import with no provider failing with an actionable error;
- analytics separating measured data from hypotheses.

A manual end-to-end run against real public Reels is shown in §4.

---

## 7. Compliance and known limitations

- **Data accessed.** Only logged-out, publicly accessible data, or data from official APIs you are authorized to use. There are no passwords, session cookies, CAPTCHA bypasses or proxy rotation. Private profiles and Reels are reported as such and skipped.
- **Views.** These are unavailable without Meta Business Discovery or Apify. Analytics then rank by likes and say so.
- **Meta Business Discovery** sees only Business and Creator accounts, and not age-gated ones. It does not return Reel duration; FFmpeg measures that from the downloaded audio.
- **Logged-out access is fragile.** Instagram can tighten logged-out access at any time. When yt-dlp starts returning `unavailable` for Reels you can see in a browser, run `brew upgrade yt-dlp`. If that doesn't help, switch `MEDIA_PROVIDER=apify_audio`.
- **Media files.** Downloaded media is used for transcription and analysis. Reposting or redistributing creators' audio needs the rights holder's permission.
