# Japan Reel-to-Map — MVP (Phase 1)

Paste an Instagram Reel or YouTube Short URL → extract the Japan location → confirm a candidate → pin it on a map.

## Quick start

```bash
npm install
cp .env.example .env.local   # fill in keys (app runs in demo/mock mode without them)
npm run dev                  # http://localhost:3000
```

## Env vars

| Var | Where | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | server | Real AI extraction (Google AI Studio, free tier). Without it: deterministic keyword mock. |
| `GEMINI_MODEL` | server | Default `gemini-1.5-flash`. |
| `GOOGLE_PLACES_API_KEY` | server | Places API (New) Text Search. Without it: mock candidates. |
| `NEXT_PUBLIC_GOOGLE_MAPS_KEY` | client | Maps Embed API key, domain-restricted. Without it: "Open in Google Maps" links only. |

Get keys: Google AI Studio (Gemini) + Google Cloud Console (Places API (New) + Maps Embed API, each restricted to its API).

## Instagram reel resolver (SocialKit)

Instagram blocks unauthenticated fetches, so for Instagram URLs the route uses
a third-party resolver **only when `SOCIALKIT_API_KEY` is set**:

```
Instagram URL → SocialKit download API (caption + 480p mp4, temp URL, 1h expiry)
  → video analyzed in-memory by Gemini (transcript + visual clues, one multimodal call)
  → combined with caption → extraction → Places → AI verification (recommendation only)
```

- Provider abstraction: `lib/instagram-resolver.ts` (`InstagramResolver` interface +
  `SocialKitResolver`). Swap providers without touching the route.
- Retry with backoff on 429/5xx (max 3 attempts). No retry on permanent failures
  (private/deleted/photo posts → user-friendly message, never "Instagram blocked").
- Video caps: ≤19MB and ≤150s go to Gemini inline; larger reels fall back to
  caption evidence. The buffer lives only in memory — nothing is stored.
- Without the key (or on resolver failure), the flow degrades to link metadata +
  pasted caption. Auth is via `access_key` body field per the official docs.

Setup: sign up at https://www.socialkit.dev (20 free credits; ~1 credit per reel
at 480p), paste the key as `SOCIALKIT_API_KEY`, then test with a real public Reel.

## How the core loop works

```
POST /api/v1/extract { url, caption? }
 → validate + normalize URL (lib/url-normalize.ts)
 → fetch accessible metadata, YouTube oEmbed / Instagram graceful fallback (lib/metadata.ts)
 → Gemini extraction, strict JSON, never auto-saves (lib/gemini.ts)
 → Places Text Search per location, failures isolated (lib/google-places.ts)
 → client renders candidates → user confirms → pin + Maps link (app/page.tsx)
```

## Test it (no keys needed — mock mode)

1. `npm run dev`, open http://localhost:3000
2. URL: `https://www.youtube.com/shorts/dQw4w9WgXcQ` + caption: `Best food spots in Kyoto. Visit Nishiki Market!`
3. Expect candidate "Nishiki Market" → Confirm pin → Maps link works.
4. Try `https://www.instagram.com/reel/ABC123/` + caption mentioning `Fushimi Inari` → shrine candidate.

## Deploy (Vercel, $0)

```bash
git init && git add -A && git commit -m "Phase 1 MVP" && git push
# Vercel dashboard → Import repo → add env vars → Deploy
```

Server keys stay in Vercel env (API routes only). The `NEXT_PUBLIC_` key must be domain-restricted with only the Maps Embed API enabled.

## What's stubbed for Phase 2

Auth, trips, Supabase tables (`trips`, `places`, `trip_places`, `sources`, `source_places`), idempotency hash reuse, video/frame/audio evidence (FFmpeg), screenshot fallback. See `Doc_files/` plans.
