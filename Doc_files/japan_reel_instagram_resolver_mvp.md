# Japan Reel → Location: Replace Instagram Metadata Fetch

## Goal

Change the MVP so the user only does this:

> Paste Instagram Reel URL → Click Analyze → Get the Japan location on Google Maps.

The user should **not** copy the caption, upload the video, or switch between Instagram and your app.

---

# 1. Why the current implementation fails

Your current application appears to fetch Instagram metadata directly from your backend.

It eventually reaches a message like:

```text
Instagram blocks unauthenticated metadata fetches
```

Do **not** spend time trying to bypass Instagram's protections with your own scraper.

Instead, use a third-party Instagram URL resolver/downloader API.

For the MVP, use **SocialKit** as the first provider. It currently exposes an Instagram download endpoint that accepts a public Reel URL and returns metadata plus a temporary video URL. Its documentation says the temporary URL is valid for about one hour. It also supports Reel URLs such as `/reel/`, `/reels/`, `/p/`, and `/tv/`.

Source:
https://www.socialkit.dev/instagram-apis/download

---

# 2. New architecture

Replace this:

```text
User
  ↓
Your Backend
  ↓
Instagram direct metadata fetch
  ↓
❌ Instagram blocks request
```

With:

```text
User
  ↓
Paste Reel URL
  ↓
Your Backend
  ↓
Instagram Resolver API
  ↓
Caption + thumbnail + temporary video URL
  ↓
AI analysis
  ├── Video
  ├── Audio
  └── Caption
  ↓
Location clues
  ↓
Google Places API
  ↓
Candidate locations
  ↓
AI verification/ranking
  ↓
Google Maps result
```

---

# 3. Keep the provider behind your own service

Do NOT call SocialKit directly from the frontend.

Use:

```text
Frontend
   ↓
POST /api/analyze-reel
   ↓
InstagramResolverService
   ↓
SocialKit
```

This keeps your API key private and makes it easy to replace SocialKit later.

---

# 4. Add environment variables

Create/update `.env`:

```env
SOCIALKIT_API_KEY=your_socialkit_key
GEMINI_API_KEY=your_gemini_key
GEMINI_MODEL=your_current_supported_model
GOOGLE_MAPS_API_KEY=your_google_maps_key
```

Never expose these values in frontend JavaScript.

Do not commit `.env` to Git.

---

# 5. Create an Instagram resolver service

Create something similar to:

```text
backend/
  services/
    instagramResolver.ts
```

Example:

```ts
export async function resolveInstagramReel(url: string) {
  const response = await fetch(
    "https://api.socialkit.dev/instagram/download",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-access-key": process.env.SOCIALKIT_API_KEY!,
      },
      body: JSON.stringify({
        url,
        format: "mp4",
        quality: "720p",
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Instagram resolver failed: ${response.status}`
    );
  }

  const result = await response.json();

  if (!result.success) {
    throw new Error(
      result.message || "Could not resolve Instagram Reel"
    );
  }

  return result.data;
}
```

The API currently documents a response containing fields such as:

```text
downloadUrl
thumbnail
title
duration
durationSeconds
fileSize
quality
expiresIn
```

Source:
https://www.socialkit.dev/blog/how-to-download-instagram-videos-with-api

---

# 6. Validate the Reel URL first

Only accept Instagram URLs.

For example:

```ts
function isInstagramReelUrl(value: string) {
  try {
    const url = new URL(value);

    return (
      url.hostname === "instagram.com" ||
      url.hostname === "www.instagram.com"
    ) && (
      url.pathname.startsWith("/reel/") ||
      url.pathname.startsWith("/reels/") ||
      url.pathname.startsWith("/p/")
    );
  } catch {
    return false;
  }
}
```

If invalid:

```text
Please enter a valid Instagram Reel URL.
```

---

# 7. Download/process the video temporarily

Do NOT permanently store every Reel.

The resolver gives you a temporary video URL.

Your backend can:

```text
Temporary URL
     ↓
Download to temporary storage
     ↓
AI analysis
     ↓
Delete temporary file
```

Use a temporary directory such as:

```text
/tmp/reel-analysis/<job-id>.mp4
```

Delete it after processing.

If your AI provider can consume the remote video URL directly, you can skip the temporary download entirely.

---

# 8. Extract the three inputs

Your location analysis should use:

### A. Caption

Use the caption returned by the resolver.

### B. Audio

Transcribe the Reel audio.

Example:

```text
Video
 ↓
Audio
 ↓
Speech-to-text
 ↓
Transcript
```

### C. Video

Send the video to your vision-capable AI model.

Look for:

```text
Restaurant signs
Station signs
Street signs
Japanese text
Buildings
Landmarks
Menus
Store names
Train stations
Neighborhood names
Distinctive scenery
```

---

# 9. Give the AI one structured extraction task

Do NOT ask the AI:

```text
Where is this?
```

Ask it to extract evidence.

Example:

```text
Analyze this Instagram Reel.

Inputs:
1. Caption
2. Audio transcript
3. Video frames

Extract every clue that could identify the location.

Return JSON:

{
  "country": "Japan",
  "city": null,
  "prefecture": null,
  "business_name": null,
  "landmark": null,
  "station": null,
  "street": null,
  "address": null,
  "japanese_text": [],
  "spoken_location_clues": [],
  "visual_clues": [],
  "search_queries": [],
  "confidence": 0
}

Do not invent information.
Only include information supported by the inputs.
```

---

# 10. Do NOT let the AI directly choose a Google Maps result

Instead:

```text
AI
 ↓
Location clues
 ↓
Google Places search
 ↓
5-10 candidates
 ↓
AI compares candidates
 ↓
Final candidate
```

This is much more reliable.

Example:

```text
AI says:

"Possible restaurant name:
Ichiran"

Search Google Places:

1. Ichiran Shibuya
2. Ichiran Kyoto
3. Ichiran Osaka
4. ...

Send candidates back to AI.

AI evaluates:

- Name
- City
- Visual clues
- Address
- Japanese text
- Nearby landmarks

Then returns:

{
  "selectedPlace": "...",
  "confidence": 0.91,
  "reason": "..."
}
```

---

# 11. Google Maps integration

Use Google Places API for candidate discovery.

Do not perform a huge Google Maps search.

Build targeted queries from the AI clues.

For example:

```text
"restaurant name + Kyoto"
```

or:

```text
"Japanese restaurant + Gion Kyoto"
```

or:

```text
"station name + Osaka"
```

Then retrieve the candidate's:

```text
place_id
name
formatted address
location
Google Maps URL
```

Your frontend can then display the result on a map.

---

# 12. Your main backend endpoint

Create:

```text
POST /api/analyze-reel
```

Request:

```json
{
  "url": "https://www.instagram.com/reel/ABC123/"
}
```

Backend flow:

```text
1. Validate URL

2. Resolve Reel
   ↓
3. Get caption + temporary video URL
   ↓
4. Extract/transcribe audio
   ↓
5. Analyze video
   ↓
6. Combine caption + transcript + visual clues
   ↓
7. Generate search queries
   ↓
8. Search Google Places
   ↓
9. Compare candidates
   ↓
10. Return final location
```

Response:

```json
{
  "success": true,
  "location": {
    "name": "Example Restaurant",
    "city": "Kyoto",
    "address": "Example address",
    "latitude": 35.0,
    "longitude": 135.0,
    "googleMapsUrl": "...",
    "confidence": 0.91
  }
}
```

---

# 13. Frontend becomes extremely simple

Your UI should have only:

```text
┌─────────────────────────────────────┐
│ Paste Instagram Reel URL            │
│                                     │
│ [ https://instagram.com/reel/... ]  │
│                                     │
│           [ Analyze Reel ]          │
└─────────────────────────────────────┘
```

Then:

```text
Analyzing Reel...

✓ Retrieved Reel
✓ Analyzed caption
✓ Analyzed audio
✓ Analyzed video
✓ Searching locations
✓ Verified location

📍 Restaurant Name
Kyoto, Japan

[ Open in Google Maps ]
```

The user never leaves your application.

---

# 14. Handle resolver failures

Not every Instagram URL will work.

For example:

```text
Private account
Deleted Reel
Region restricted
Age restricted
Instagram login required
Invalid URL
Third-party resolver unavailable
```

Return a useful message:

```text
We couldn't access this Reel.

The Reel may be private, deleted, or unavailable
to our video provider.
```

Do NOT tell the user:

```text
Instagram blocked your metadata.
```

That is an implementation detail.

---

# 15. Add a provider abstraction

This is important.

Don't make your application depend permanently on SocialKit.

Create:

```ts
interface InstagramResolver {
  resolve(url: string): Promise<{
    videoUrl: string;
    caption?: string;
    thumbnail?: string;
    duration?: number;
  }>;
}
```

Then:

```text
InstagramResolver
       │
       ├── SocialKitResolver
       │
       ├── Provider2Resolver
       │
       └── Provider3Resolver
```

Initially:

```text
SocialKit only
```

Later you can add another provider if SocialKit becomes unreliable or expensive.

---

# 16. Add fallback provider later

Do NOT build multiple providers on day one.

First make:

```text
SocialKit
   ↓
AI
   ↓
Google Places
```

work end-to-end.

Once the MVP works, you can add:

```text
SocialKit
   ↓ fails
Provider B
   ↓ fails
Return error
```

This prevents unnecessary complexity.

---

# 17. Add retry handling

Third-party APIs can return:

```text
429 = rate limit
500 = provider error
503 = temporary service problem
```

Retry temporary errors:

```text
Attempt 1
  ↓
wait 2 sec
  ↓
Attempt 2
  ↓
wait 4 sec
  ↓
Attempt 3
```

Do not retry invalid URLs or private/deleted content indefinitely.

---

# 18. Do not build an AI Agent yet

For this MVP, use a deterministic pipeline:

```text
Resolve
  ↓
Extract
  ↓
Search
  ↓
Verify
  ↓
Return
```

You do NOT need LangGraph, CrewAI, or an autonomous agent.

Add agentic behavior later only if you discover that the system needs to dynamically decide:

```text
Try restaurant search
       ↓ failed
Search Japanese text
       ↓ failed
Search landmark
       ↓ failed
Search creator information
       ↓
Try another strategy
```

---

# 19. Important legal/operational consideration

A third-party resolver is still accessing Instagram content on your application's behalf.

Before launching publicly, review:

- Instagram/Meta terms
- The resolver provider's terms
- Copyright/content-use requirements
- Google Maps Platform terms
- Your own privacy policy

For the MVP, process only the minimum data required and delete temporary Reel files after analysis.

---

# 20. Recommended MVP stack

Keep it simple:

```text
Frontend
Next.js

Backend
Next.js API routes OR FastAPI

Instagram
SocialKit Instagram Download API

AI
Gemini / another vision-capable model

Speech
Your chosen transcription API/model

Maps
Google Places API

Database
Supabase/Postgres

Storage
Temporary only
```

Do not add:

```text
LangGraph
CrewAI
Redis
Kafka
Kubernetes
S3
Complex queues
Vector database
Multi-agent architecture
```

until you actually need them.

---

# 21. Implementation order

Build in exactly this order.

### Step 1

Create SocialKit account and obtain an API key.

### Step 2

Test the API manually with one public Reel URL.

Expected:

```text
Reel URL
   ↓
SocialKit
   ↓
downloadUrl
```

### Step 3

Create:

```text
instagramResolver.ts
```

### Step 4

Connect:

```text
POST /api/analyze-reel
```

to the resolver.

### Step 5

Confirm your backend can obtain:

```text
caption
video URL
thumbnail
duration
```

### Step 6

Send the video + caption to your AI extraction layer.

### Step 7

Add audio transcription.

### Step 8

Generate structured location clues.

### Step 9

Search Google Places.

### Step 10

Have AI verify the candidate locations.

### Step 11

Return:

```text
Place
Address
Coordinates
Google Maps URL
Confidence
Evidence
```

### Step 12

Delete temporary video data.

### Step 13

Add retry/error handling.

### Step 14

Test with at least:

```text
5 obvious Japan Reels
5 restaurant Reels
5 landmark Reels
5 difficult/ambiguous Reels
5 Reels with little/no caption
```

---

# 22. Final architecture

Your finished MVP should look like:

```text
                    USER
                     │
                     │ Reel URL
                     ▼
              ┌──────────────┐
              │   FRONTEND   │
              └──────┬───────┘
                     │
                     ▼
              ┌──────────────┐
              │   BACKEND    │
              └──────┬───────┘
                     │
                     ▼
          ┌──────────────────────┐
          │ Instagram Resolver   │
          │      (SocialKit)     │
          └──────────┬───────────┘
                     │
             video + caption
                     │
                     ▼
          ┌──────────────────────┐
          │     AI ANALYSIS      │
          │                      │
          │ Video + Audio + Text │
          └──────────┬───────────┘
                     │
                location clues
                     │
                     ▼
          ┌──────────────────────┐
          │   Google Places      │
          └──────────┬───────────┘
                     │
                 candidates
                     │
                     ▼
          ┌──────────────────────┐
          │   AI VERIFICATION    │
          └──────────┬───────────┘
                     │
                     ▼
                📍 LOCATION
                     │
                     ▼
               Google Maps
```

## The key change

**Remove your current direct Instagram metadata-fetching code.**

Replace it with:

```text
Instagram Reel URL
        ↓
SocialKit
        ↓
Temporary video + metadata
        ↓
Your existing AI extraction
        ↓
Google Places
```

That preserves the UX you want:

> **One URL → one click → automatic analysis → location.**

---

## Sources

- SocialKit Instagram Download API: https://www.socialkit.dev/instagram-apis/download
- SocialKit Instagram Download API guide: https://www.socialkit.dev/blog/how-to-download-instagram-videos-with-api
- SocialKit API documentation: https://docs.socialkit.dev/
- Meta Instagram API documentation: https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api
