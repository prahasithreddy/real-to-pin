# Japan Reel-to-Map — Technical Architecture

This describes *how* the system is built, to accompany the phased build plan. It matches that plan's choice of Next.js on Vercel as the whole app (frontend + API) with no separate backend service, Supabase added in Phase 2, and everything else deferred until it's actually needed.

---

## 1. System overview

```
                              USER (browser)
                                    |
                                    v
                     ┌───────────────────────────┐
                     │   Next.js App (Vercel)     │
                     │                            │
                     │  UI: paste URL, review     │
                     │  candidates, confirm,      │
                     │  map view                  │
                     └─────────────┬──────────────┘
                                   │ calls its own
                                   │ API routes (server-side)
                                   v
                     ┌───────────────────────────┐
                     │   Next.js API Routes       │
                     │   (app/api/v1/...)         │
                     └──┬──────────┬───────────┬──┘
                        │          │           │
                        v          v           v
                  Supabase     Gemini API   Google Places /
                  (Postgres    (extraction) Maps API
                  + Auth,
                  Phase 2+)
```

One deployable unit. The browser never talks to Gemini, Supabase's service role, or Google's server-side APIs directly — every external call is proxied through a Next.js API route, so secrets stay server-side.

**When to split this** (not before): if video/audio processing routinely exceeds Vercel's function execution time/memory, or you need long-running/async jobs with retries — see §9.

---

## 2. Data flow — the core loop

```
1. User pastes Reel/Short URL
2. POST /api/v1/sources
     → validate URL (must be instagram.com/reel/... or youtube.com/shorts/...)
     → normalize URL (strip query params, trailing slash, lowercase host)
     → hash normalized URL → source_hash
     → if source_hash already exists → reuse it, skip to step 5
     → else create `sources` row, status = "pending"
3. Processing (see §5 for state machine)
     a. fetch accessible metadata (title/caption/description/creator)
        → status = "fetching_metadata"
     b. [Phase 1, step 9+] extract frames (FFmpeg) + audio→transcript
        → status = "extracting_evidence"
     c. send combined evidence to Gemini → status = "extracting_locations"
     d. for each extracted location, query Google Places → status = "matching_places"
     e. status = "awaiting_confirmation"
4. GET /api/v1/processing/{job_id} — frontend polls this for status
5. User reviews candidates, calls:
     POST /api/v1/source-places/{id}/confirm        (accept top candidate)
     POST /api/v1/source-places/{id}/select-candidate (pick a different one)
     POST /api/v1/source-places/{id}/reject          (none are correct → manual search)
6. On confirm: create/reuse `places` row (keyed by google_place_id),
   create `trip_places` row linking it to the current trip
7. Map re-renders from the database (not from a fresh Google Places call)
```

---

## 3. Data model

Even in Phase 1 (no DB), design around this shape so Phase 2 is a straight port. In Phase 2, create these tables in Supabase Postgres:

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

-- A canonical real-world place. One row per Google place, reused across sources/trips.
create table places (
    id uuid primary key default gen_random_uuid(),
    google_place_id text unique,
    name text not null,
    category text,
    city text,
    region text,
    country text,
    address text,
    latitude double precision,
    longitude double precision,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

-- A trip's saved places (many-to-many trips<->places, with per-trip state).
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

-- A submitted Reel/Short URL.
create table sources (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    platform text not null,           -- 'instagram' | 'youtube'
    url text not null,
    normalized_url text not null,
    source_hash text not null unique,
    title text,
    description text,
    creator_name text,
    processing_status text not null default 'pending',
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

-- What the AI found for a source, and what the user decided.
create table source_places (
    id uuid primary key default gen_random_uuid(),
    source_id uuid not null references sources(id) on delete cascade,
    extracted_name text,
    extracted_city text,
    extracted_region text,
    extracted_country text,
    extracted_category text,
    evidence jsonb,       -- {caption, transcript, visual_clues[]}
    candidates jsonb,     -- Google Places API results, raw
    selected_place_id uuid references places(id),
    user_confirmed boolean default false,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

create table processing_jobs (
    id uuid primary key default gen_random_uuid(),
    source_id uuid not null references sources(id) on delete cascade,
    status text not null default 'queued',
    current_step text,
    attempt_number integer not null default 1,
    error_code text,
    error_message text,
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz default now()
);
```

**Relationships:**
```
User → Trips → TripPlaces → Place
User → Sources → ProcessingJob
              → SourcePlace → Place
```
`google_place_id` being unique on `places` means the same real place found from 3 different Reels is still 1 row — you get 3 `source_places` rows pointing at it, not 3 duplicate places. Same place saved to 2 trips is 1 `places` row + 2 `trip_places` rows.

---

## 4. API design (Next.js Route Handlers, `app/api/v1/...`)

```
Trips
  POST   /api/v1/trips
  GET    /api/v1/trips
  GET    /api/v1/trips/{trip_id}
  PATCH  /api/v1/trips/{trip_id}
  DELETE /api/v1/trips/{trip_id}

Sources
  POST   /api/v1/sources                 -> { source_id, job_id, status }
  GET    /api/v1/sources/{source_id}
  DELETE /api/v1/sources/{source_id}

Processing
  GET    /api/v1/processing/{job_id}      -> { status, current_step }
  POST   /api/v1/processing/{job_id}/retry

Places
  GET    /api/v1/trips/{trip_id}/places
  POST   /api/v1/trips/{trip_id}/places/manual   (manual Google Places search+save)
  PATCH  /api/v1/trip-places/{trip_place_id}
  DELETE /api/v1/trip-places/{trip_place_id}

Source-place confirmation
  POST   /api/v1/source-places/{id}/confirm
  POST   /api/v1/source-places/{id}/reject
  POST   /api/v1/source-places/{id}/select-candidate
```

In Phase 1 (no DB, no trips), you only need a stripped-down version: a single `POST /api/v1/extract` route that takes a URL, runs steps 3a–3d synchronously (or with simple polling), and returns candidates directly to the page — no persistence.

---

## 5. Processing state machine

Deterministic states, no fake progress bars:

```
queued → fetching_metadata → extracting_evidence → extracting_locations
       → matching_places → awaiting_confirmation → completed
                                                   ↘ failed
```

Each stage can fail independently without failing the whole job:

```
Caption unavailable        → continue if video/audio available
Audio unavailable          → continue with caption + visuals
Video unavailable          → continue with caption + audio
Only caption available     → still attempt extraction
Insufficient evidence      → status = "needs_manual_input" (screenshot or manual search)
```

---

## 6. AI extraction contract

One prompt, one job: given evidence, propose candidate locations — never pick or save the final place.

**Input (combined evidence):**
```json
{
  "caption": "Best food spots in Kyoto. Visit Nishiki Market!",
  "transcript": "This is Nishiki Market in Kyoto.",
  "visual_clues": [
    "Japanese market street",
    "sign appears to contain 'Nishiki'",
    "traditional Kyoto shopping street"
  ]
}
```

**Output (structured JSON):**
```json
{
  "locations": [
    {
      "name": "Nishiki Market",
      "city": "Kyoto",
      "region": null,
      "country": "Japan",
      "category": "market",
      "evidence": [
        { "type": "caption", "text": "Visit Nishiki Market" },
        { "type": "transcript", "text": "This is Nishiki Market in Kyoto" }
      ]
    }
  ]
}
```

**Rules enforced in the prompt:**
- Preserve original names (don't translate or rename).
- Handle both Japanese and romanized names.
- Return `null`/empty when evidence is insufficient — never invent a location.
- Return evidence per claim; don't just assert.
- A model-reported "confidence" score is a hint, not ground truth — never branch logic on it as if it were.
- The model never selects or saves the final place — that's a separate step, and always requires user confirmation.

---

## 7. Google Places matching

```
AI output: "Nishiki Market", "Kyoto", "Japan"
     ↓
Google Places text search: "Nishiki Market Kyoto Japan"
     ↓
Candidates, ranked by simple signals:
  - name similarity
  - city match
  - country match
  - address/context plausibility
  - category match
     ↓
Clear single match  → show as the primary suggestion
Multiple plausible  → show all, let user pick
No good candidate   → prompt manual search
```

No weighted scoring model in the MVP — string/field matching is enough until real data shows it isn't.

The map view reads coordinates from your own `places` table, not from a fresh Google Places call on every render — only re-query Google when you need fresher place details.

---

## 8. Security

Required from Phase 1 onward:
- HTTPS (Vercel default).
- All third-party API keys (Gemini, Google Maps/Places server-side key) stored as Vercel environment variables, read only in API routes — never sent to the client. The Maps *JavaScript* key used client-side should be a separate, domain-restricted key with only the Maps JS API enabled.
- Request validation on every API route (e.g. with Zod).
- Upload size limits and file-type validation once screenshots/video are accepted.

Added in Phase 2:
- Supabase Auth session verification on every API route that touches user data.
- Resource ownership checks (a user can only read/modify their own trips/sources).
- Never expose the Supabase service-role key to the client — only the anon key, and only for client-side calls that RLS (Row Level Security) policies protect.
- Rate limiting on expensive operations: source submissions per user per day, manual search calls per minute, retry limits.

---

## 9. When to grow beyond this architecture

Stay on the single Next.js app until one of these is actually true — don't pre-build for them:

| Trigger | What to add |
|---|---|
| Video processing routinely exceeds Vercel function time/memory limits | A separate processing service (e.g. FastAPI) that Next.js calls |
| You need long-running async jobs with reliable retries | A queue (Redis + RQ/Arq or a managed queue) + worker process |
| Multiple simultaneous processing jobs cause contention | Same as above |
| You need retryable uploads, large media, or persistent processing artifacts | Object storage (e.g. Supabase Storage or S3) with `job_id`, `expires_at`, automatic cleanup for abandoned files |
| Google Places starts being an insufficient/ambiguous data source often enough to matter | A small `PlaceSearchProvider` interface so a second provider can be added without touching call sites |

Until then, temporary media follows: `receive → process → delete`. Every temporary object should still track `job_id`, `created_at`, `expires_at`, `media_type`, `size_bytes` even before you formalize storage, so cleanup is trivial to add later.

---

## 10. Project structure

Phase 1 (single app, no backend split):

```
japan-reel-to-map/
├── app/
│   ├── page.tsx                  # single-page core loop UI (Phase 1)
│   ├── api/v1/
│   │   ├── sources/route.ts
│   │   ├── processing/[jobId]/route.ts
│   │   ├── source-places/[id]/confirm/route.ts
│   │   ├── trips/route.ts         # Phase 2+
│   │   └── ...
│   └── trips/[tripId]/page.tsx    # Phase 2+
├── components/
│   ├── Map/
│   ├── SourceInput/
│   ├── ProcessingStatus/
│   ├── PlaceConfirmation/
│   └── ManualPlaceSearch/
├── lib/
│   ├── gemini.ts                  # Gemini client + extraction prompt
│   ├── google-places.ts           # PlaceSearchProvider (Google impl)
│   ├── ffmpeg.ts                  # frame/audio extraction helpers
│   └── url-normalize.ts
├── types/
├── supabase/migrations/           # Phase 2+
├── .env.local
└── package.json
```

No monorepo, no separate `backend/` or `frontend/` folders, no mobile package — all of that is premature until §9's triggers are hit.
