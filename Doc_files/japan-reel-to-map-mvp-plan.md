# Japan Reel-to-Map — MVP Build Plan

## Goal

Paste an Instagram Reel or YouTube Short URL → the app extracts the location mentioned/shown in it → finds it on Google Places → pins it on a map.

**Priorities, in order:**
1. Deploy as soon as possible.
2. Running cost as close to $0 as possible.
3. The core extraction loop (URL → location → map pin) works reliably.
4. Auth and "create a trip" are explicitly **not** priorities — stub them out until Phase 2.

Everything below is organized so you can get a working, deployed, testable core loop first, then layer on the rest.

---

## Why this architecture

Next.js on Vercel + Supabase (free tiers) + a free-tier multimodal LLM (Gemini) is the fastest path to a *deployed*, *free*, *working* version. A separate FastAPI backend, queues, workers, Docker, Redis, Ollama, or local Postgres are all things the other candidate plans considered — they're valid for a local-first dev loop, but they slow down "deploy ASAP" and aren't needed until real usage requires them. This plan defers all of that to "later" sections at the bottom.

```
                         USER
                           |
                           v
                    Next.js Web App
                       (Vercel)
                           |
                           v
                    Next.js API Route
                           |
             +-------------+--------------+
             |             |               |
             v             v               v
        Reel/Short      Gemini API     Google Places
        metadata        (extraction)   + Maps API
             |             |               |
             +-------------+---------------+
                           |
                           v
                  Candidate location(s)
                           |
                           v
                  You confirm / pick one
                           |
                           v
                    Pin on Google Map
```

**Do not build any of these until you actually need them:**
FastAPI, Redis, Celery/RQ, Kubernetes, Docker production infra, separate worker clusters, Ollama, multi-model AI abstraction, native iOS/Android, payments, social features, itinerary/route optimization, TikTok/WhatsApp ingestion, browser extension, permanent video storage, vector DB/RAG.

---

## Tech stack

| Layer | Choice |
|---|---|
| Frontend + API | Next.js (App Router), React, TypeScript, Tailwind |
| Hosting | Vercel (free tier) |
| Database | Supabase Postgres (free tier) — only added in Phase 2 |
| Auth | Supabase Auth + Google OAuth — only added in Phase 2 |
| AI | Google Gemini API (free tier), multimodal (text/image/video) |
| Video/audio processing | FFmpeg (only once you actually have a video file) |
| Maps | Google Maps JavaScript API, Google Places API, Google Maps URLs |

Cost target: **$0** for hosting, DB, auth, AI, video handling, and domain, all on free tiers. Google Maps Platform has free monthly usage thresholds — monitor usage rather than assuming it stays free forever, and double-check India-specific pricing eligibility if that applies to your billing account.

---

# Phase 1 — Core Loop Only (local test → fast deploy)

**Goal of this phase:** prove that "URL in → correct location pinned on map out" works. No login, no trip concept, no database if you can avoid it. This is the one uncertain, high-value part of the whole product — everything else is standard CRUD you can build with confidence later.

### 1. Before coding

Create free accounts: GitHub, Vercel, Google Cloud, Google AI Studio (Gemini API key), Google Maps Platform (Maps JS API + Places API keys).

### 2. Scaffold the app

```bash
npx create-next-app@latest japan-reel-to-map
cd japan-reel-to-map
```
Choose: TypeScript, ESLint, Tailwind, App Router, Turbopack.

```bash
npm run dev
```
Confirm `http://localhost:3000` loads before adding anything else.

### 3. Build a single-page workflow (no auth, no DB)

One page with:
- A text input for a Reel/Short URL.
- A "Process" button.
- A results area showing extracted evidence + candidate place(s).
- A "Confirm" button per candidate.
- An embedded Google Map that drops a pin when a candidate is confirmed.

State can live entirely in React state (`useState`) for this phase — no database table required yet.

### 4. URL intake

- Validate the URL is an Instagram Reel or YouTube Short.
- Normalize it (strip tracking params, trailing slashes).

### 5. Obtain accessible source info

Start with whatever is accessible without heavy scraping/downloading:
- Caption / title / description / creator name.

This alone is often enough to extract a location — build and test this path *first* before adding video/audio.

### 6. AI location extraction (Gemini)

Send the caption/description text to Gemini with a prompt like:

> Based only on the supplied evidence, identify possible real-world travel locations in Japan. Return structured JSON: name, city, region, country, category, and which evidence supports it. Return null / empty if there isn't enough evidence. Do not invent a location.

Rules for the AI:
- Preserve original names (don't translate/rename).
- Handle Japanese names and romanized names.
- Distinguish evidence from assumptions; don't hallucinate.
- The AI never auto-saves anything — it only proposes candidates.

### 7. Google Places matching

Take the AI's extracted name/city/country and query Google Places (e.g. `"Nishiki Market Kyoto Japan"`). Return the top few candidates (name, address, place_id, lat/lng). Keep the matching logic simple — name + city + country string match is enough for now. Don't build a scoring system yet.

### 8. Confirmation + map pin

Show the candidates. Let you pick the right one (or none / search manually as a fallback). On confirm, drop a marker on the embedded Google Map using the place's lat/lng, and show an "Open in Google Maps" link built from the place_id or coordinates.

### 9. Add video + audio evidence (once caption-only extraction is proven)

Only once steps 5–8 work reliably on caption alone:

```
Video → FFmpeg → 5–10 representative frames → Gemini Vision → visual clues
Video → FFmpeg → extract audio → Gemini/Whisper → transcript
```

Combine caption + transcript + visual clues into one evidence object and send that combined evidence to the same extraction prompt from step 6, rather than asking three separate AI calls to each guess independently.

Every stage should be allowed to fail independently — if audio extraction fails, continue with caption + visuals, and so on. If everything is insufficient, fall back to asking for a manual search or a screenshot (see Phase 3).

Don't permanently store video — extract what you need, then delete the temporary file.

### 10. Deploy

Push to GitHub, import into Vercel, add your Gemini/Google Maps/Places API keys as environment variables (server-side only — never expose them to the client), deploy.

### 11. Test with a small real dataset

Try 15–20 real Reels/Shorts across: restaurants, markets, temples/shrines, attractions, street scenes, Japanese-signage videos, English-narration videos, Japanese-narration videos, and a couple with no identifiable location. Track: correct extraction, correct Google match, cases needing manual fallback.

**Phase 1 is done when:** you can paste a real Reel/Short URL into the deployed app and reliably get a correct, confirmed pin on the map, without login or trip management getting in the way.

---

# Phase 2 — Auth, Trips, and the rest of the real product

Only start this once Phase 1's core loop is proven to work reliably. This is standard, low-risk CRUD work.

### 1. Add a database

Supabase Postgres. Tables:

```sql
create table trips (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    name text not null,
    country text default 'Japan',
    start_date date,
    end_date date,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

create table places (
    id uuid primary key default gen_random_uuid(),
    google_place_id text unique,
    name text not null,
    category text,
    city text, region text, country text, address text,
    latitude double precision,
    longitude double precision,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

create table trip_places (
    id uuid primary key default gen_random_uuid(),
    trip_id uuid not null references trips(id) on delete cascade,
    place_id uuid not null references places(id) on delete cascade,
    status text not null default 'saved', -- saved | planned | visited | skipped
    notes text,
    priority integer,
    visited_at timestamptz,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    unique(trip_id, place_id)
);

create table sources (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    platform text not null,
    url text not null,
    normalized_url text not null,
    source_hash text not null,
    title text, description text, creator_name text,
    processing_status text not null default 'pending',
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

create table source_places (
    id uuid primary key default gen_random_uuid(),
    source_id uuid not null references sources(id) on delete cascade,
    extracted_name text, extracted_city text, extracted_region text,
    extracted_country text, extracted_category text,
    evidence jsonb,
    candidates jsonb,
    selected_place_id uuid,
    user_confirmed boolean default false,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);
```

`google_place_id` on `places` (unique) means the same real-world place found from multiple Reels only gets one row — `source_places` and `trip_places` link back to it.

### 2. Auth

- Supabase Auth + Google OAuth (don't build your own auth).
- In Google Cloud: create OAuth Client ID (Web Application), set authorized origins for `localhost:3000` and your Vercel domain, enable Google as a Supabase Auth provider.
- You only need `Sign in with Google → Supabase session → user ID` — no Drive/Gmail/YouTube scopes.

### 3. Trips CRUD

Create / list / open / edit / delete/archive a trip. Nothing fancy — name, country, dates.

### 4. Wire Phase 1's loop into the database

- Reel/Short submissions now create a `sources` row and, once processed, a `source_places` row with the AI's evidence + candidates.
- Confirming a candidate creates/reuses a `places` row and a `trip_places` row.
- Add manual place search (search Google Places directly, skip AI) as an alternative path — useful whenever AI extraction comes up empty.

### 5. Trip map view

Show all of a trip's saved places as markers; marker click shows a place card; "Open in Google Maps"; toggle visited status.

### 6. URL idempotency

Normalize URLs and hash them (`source_hash`) so pasting the same Reel twice doesn't reprocess it.

---

# Phase 3 — Non-essential polish (do last, only if needed)

- **Screenshot fallback**: if a URL yields insufficient evidence, let the user upload a screenshot → OCR/Vision → same extraction pipeline → delete the screenshot after processing.
- **Bigger evaluation dataset**: 20–50+ labeled test videos (restaurants, markets, temples, shrines, attractions, street scenes, Japanese vs. English narration, ambiguous/no-location cases). Track extraction accuracy, match accuracy, correction rate, processing time, AI/Google cost per source.
- **Better matching**: only if simple name/city/country matching starts producing enough wrong candidates to matter.
- **Move processing off Next.js**, e.g. to a small FastAPI service, **only if**: video processing becomes too heavy for the Vercel function runtime, jobs need to run long/async, or you specifically need a dedicated Python AI/video environment.
- **Add a queue (Redis/managed queue) + workers only if**: you have multiple simultaneous processing jobs, or jobs are regularly timing out.
- **Add persistent object storage only if**: you need retryable processing, large uploads, or persistent media — until then, temporary media in → process → delete is enough.
- Everything else from the "do not build" list above: payments, social features, collaboration, recommendations, itinerary/route optimization, TikTok/WhatsApp ingestion, browser extension, native mobile apps, PWA-specific features, advanced analytics.

---

## Definition of done (whole product)

- [ ] Paste an Instagram Reel URL or YouTube Short URL and get a correct, confirmed map pin (the core loop — Phase 1)
- [ ] Google login works
- [ ] Create / edit / delete a trip
- [ ] Manually search and save a place
- [ ] Saved places appear on the trip map, with "Open in Google Maps"
- [ ] Duplicate URLs are detected and not reprocessed
- [ ] AI never auto-saves a place — user always confirms
- [ ] Errors at any evidence stage (caption/video/audio unavailable) don't break the whole flow
- [ ] Temporary media is deleted after processing
- [ ] API keys are server-side only, never exposed to the client
- [ ] Tested against 20–50 real travel videos with tracked accuracy

## The one metric that matters

> Percentage of real travel videos that produce a correct location candidate the user confirms.

Not number of screens, not infrastructure sophistication. If the core loop doesn't work reliably, adding auth polish or backend infrastructure won't fix the actual product problem — go back and improve extraction/matching first.
