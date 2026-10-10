import { NextResponse } from "next/server";
import { z } from "zod";
import { normalizeReelUrl, sha256Node } from "@/lib/url-normalize";
import { fetchSourceMetadata } from "@/lib/metadata";
import { extractLocations, analyzeReelVideo, verifyCandidates } from "@/lib/gemini";
import { searchPlaces, googleMapsUrl, mapsEmbedUrl } from "@/lib/google-places";
import { SocialKitResolver, ResolverError, type ResolvedReel } from "@/lib/instagram-resolver";
import { newRequestId, logStep, startTimer } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 60;

const BodySchema = z.object({
  url: z.string().min(1, "URL is required").max(2048),
  caption: z.string().max(10000).optional().default(""),
});

export type EvidenceStatus = "ok" | "empty" | "failed" | "not_implemented" | "skipped";

export interface EvidenceSource {
  /** Where the data was supposed to come from. */
  source: "link_url" | "link_title" | "link_description" | "link_creator" | "pasted_caption" | "reel_resolver" | "audio_transcript" | "video_frames";
  status: EvidenceStatus;
  /** Human-readable one-liner, also shown in the UI extraction log. */
  detail: string;
  chars?: number;
}

// Caps keep video analysis inside Gemini inline limits (<20MB/request) and
// inside the serverless function timeout. Larger/longer reels fall back to
// caption + metadata evidence with a logged reason.
const MAX_VIDEO_BYTES = 19 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 150;

export async function POST(req: Request) {
  const requestId = newRequestId();
  const totalDone = startTimer(requestId, "request");
  logStep(requestId, "request_received");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    logStep(requestId, "request_invalid", { reason: "bad_json" });
    totalDone({ outcome: "bad_json" });
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    logStep(requestId, "request_invalid", { reason: parsed.error.issues[0]?.message });
    totalDone({ outcome: "validation_error" });
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input." }, { status: 400 });
  }

  // 1. Validate + normalize URL
  let normalized: ReturnType<typeof normalizeReelUrl>;
  try {
    normalized = normalizeReelUrl(parsed.data.url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid URL.";
    logStep(requestId, "normalize_failed", { error: msg });
    totalDone({ outcome: "normalize_failed" });
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  const sourceHash = await sha256Node(normalized.normalizedUrl);
  logStep(requestId, "normalize_ok", {
    platform: normalized.platform,
    normalizedUrl: normalized.normalizedUrl,
    sourceHash,
  });

  // 2. Fetch accessible metadata (never throws — degrades to warnings)
  const metaDone = startTimer(requestId, "fetch_metadata");
  const meta = await fetchSourceMetadata(normalized.platform, normalized.normalizedUrl);
  metaDone({
    platform: meta.platform,
    oembed: meta.fetchDebug.oembed,
    opengraph: meta.fetchDebug.opengraph,
    titleChars: meta.title?.length ?? 0,
    descriptionChars: meta.description?.length ?? 0,
    creatorPresent: !!meta.creatorName,
    detail: meta.fetchDebug.detail ?? null,
  });

  // 3. Instagram resolver (SocialKit): caption + video for public reels.
  // Skipped for YouTube, skipped without SOCIALKIT_API_KEY, and never fatal —
  // on any resolver failure we fall back to link metadata + pasted caption.
  let resolved: ResolvedReel | null = null;
  let resolverNote: { status: EvidenceStatus; detail: string } | null = null;
  if (normalized.platform === "instagram") {
    if (!process.env.SOCIALKIT_API_KEY) {
      resolverNote = {
        status: "skipped",
        detail: "SOCIALKIT_API_KEY not set — using link metadata + pasted caption only",
      };
      logStep(requestId, "resolver_skipped", { reason: "no_api_key" });
    } else {
      const resolveDone = startTimer(requestId, "reel_resolve");
      try {
        resolved = await new SocialKitResolver().resolve(normalized.normalizedUrl);
        resolveDone({
          provider: resolved.provider,
          captionChars: resolved.caption?.length ?? 0,
          creatorPresent: !!resolved.creatorName,
          durationSeconds: resolved.durationSeconds,
          fileSizeBytes: resolved.fileSizeBytes,
        });
        resolverNote = {
          status: "ok",
          detail: `Resolved via SocialKit${resolved.caption ? ` — caption (${resolved.caption.length} chars)` : " (no caption exposed)"}${resolved.durationSeconds ? `, ${Math.round(resolved.durationSeconds)}s video` : ""}`,
        };
      } catch (e) {
        const kind = e instanceof ResolverError ? e.kind : "permanent";
        const msg = e instanceof Error ? e.message : "Resolver failed.";
        resolveDone({ outcome: "error", kind, error: msg });
        resolverNote = { status: "failed", detail: msg };
      }
    }
  }

  // 3b. Video → multimodal analysis (vision + audio in one Gemini call).
  // Buffer lives only in memory for this request — never written to disk.
  let transcript: string | null = null;
  let visualClues: string[] = [];
  let videoNote: { status: EvidenceStatus; detail: string } = {
    status: "not_implemented",
    detail: "No resolvable video for this request",
  };
  if (resolved?.videoUrl) {
    const tooBig = (resolved.fileSizeBytes ?? 0) > MAX_VIDEO_BYTES;
    const tooLong = (resolved.durationSeconds ?? 0) > MAX_VIDEO_SECONDS;
    if (tooBig || tooLong) {
      videoNote = {
        status: "skipped",
        detail: `Video skipped (${tooBig ? `>${MAX_VIDEO_BYTES / 1048576}MB` : ""}${tooBig && tooLong ? ", " : ""}${tooLong ? `>${MAX_VIDEO_SECONDS}s` : ""}) — continuing with caption evidence`,
      };
      logStep(requestId, "video_skipped", {
        fileSizeBytes: resolved.fileSizeBytes,
        durationSeconds: resolved.durationSeconds,
      });
    } else if (!process.env.GEMINI_API_KEY) {
      videoNote = { status: "skipped", detail: "Video resolved but GEMINI_API_KEY missing — continuing with caption" };
      logStep(requestId, "video_skipped", { reason: "no_gemini_key" });
    } else {
      const videoDone = startTimer(requestId, "video_analyze");
      try {
        const bytes = await downloadBytes(resolved.videoUrl, MAX_VIDEO_BYTES, requestId);
        const analysis = await analyzeReelVideo({
          videoBytes: bytes,
          mimeType: "video/mp4",
          caption: resolved.caption,
          title: meta.title,
        });
        transcript = [analysis.transcript, ...analysis.spokenClues].filter(Boolean).join("\n") || null;
        visualClues = [...analysis.visualClues, ...analysis.japaneseText.map((t) => `Visible Japanese text: ${t}`)];
        videoDone({
          model: analysis.model,
          bytes: bytes.length,
          transcriptChars: transcript?.length ?? 0,
          visualClueCount: visualClues.length,
          searchQueries: analysis.searchQueries,
        });
        videoNote = {
          status: "ok",
          detail: `Gemini watched ${(bytes.length / 1048576).toFixed(1)}MB of video (${analysis.model}): transcript ${transcript ? `${transcript.length} chars` : "none"} + ${visualClues.length} visual clues`,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Video analysis failed.";
        videoDone({ outcome: "error", error: msg });
        videoNote = { status: "failed", detail: `${msg} — continuing with caption evidence` };
      }
    }
  }

  // 4. Combine evidence: pasted caption + resolver caption + link description + video
  const pasted = parsed.data.caption?.trim() || null;
  const combinedCaption = [pasted, resolved?.caption, meta.description].filter(Boolean).join("\n\n") || null;
  const creator = resolved?.creatorName ?? meta.creatorName;
  if (resolved?.thumbnailUrl && !meta.thumbnailUrl) meta.thumbnailUrl = resolved.thumbnailUrl;
  logStep(requestId, "evidence_combined", {
    pastedCaptionChars: pasted?.length ?? 0,
    resolverCaptionChars: resolved?.caption?.length ?? 0,
    linkDescriptionChars: meta.description?.length ?? 0,
    linkTitleChars: meta.title?.length ?? 0,
    transcriptChars: transcript?.length ?? 0,
    visualClueCount: visualClues.length,
    combinedChars: combinedCaption?.length ?? 0,
  });

  const evidence: EvidenceSource[] = [
    {
      source: "link_url",
      status: "ok",
      detail: `Normalized ${normalized.platform} URL (hash ${sourceHash.slice(0, 8)}…)`,
    },
    {
      source: "link_title",
      status: meta.title ? "ok" : "empty",
      detail: meta.title
        ? `og/oEmbed title (${meta.title.length} chars): “${truncate(meta.title, 80)}”`
        : `No title fetchable from link (oEmbed: ${meta.fetchDebug.oembed}, OpenGraph: ${meta.fetchDebug.opengraph})`,
      chars: meta.title?.length ?? 0,
    },
    {
      source: "link_description",
      status: meta.description ? "ok" : meta.fetchDebug.opengraph === "failed" || meta.fetchDebug.oembed === "failed" ? "failed" : "empty",
      detail: meta.description
        ? `Link description (${meta.description.length} chars)`
        : platformNoDescriptionHint(normalized.platform, meta.fetchDebug),
      chars: meta.description?.length ?? 0,
    },
    {
      source: "link_creator",
      status: meta.creatorName ? "ok" : "empty",
      detail: meta.creatorName ? `Creator: ${meta.creatorName}` : "Creator not visible without login/API",
    },
    {
      source: "pasted_caption",
      status: pasted ? "ok" : "empty",
      detail: pasted ? `Pasted caption (${pasted.length} chars)` : "No caption pasted",
      chars: pasted?.length ?? 0,
    },
    ...(normalized.platform === "instagram"
      ? [
          {
            source: "reel_resolver" as const,
            status: resolverNote?.status ?? "skipped",
            detail: resolverNote?.detail ?? "Resolver not attempted",
          },
        ]
      : []),
    {
      source: "audio_transcript",
      status: transcript ? "ok" : videoNote.status === "ok" ? "empty" : videoNote.status,
      detail: transcript
        ? `Transcript from reel audio (${transcript.length} chars)`
        : videoNote.status === "ok"
          ? "Video analyzed but no speech detected"
          : videoNote.detail,
      chars: transcript?.length ?? 0,
    },
    {
      source: "video_frames",
      status: videoNote.status,
      detail: videoNote.detail,
    },
  ];

  // 5. AI extraction (Gemini, or deterministic mock when no key)
  const aiDone = startTimer(requestId, "ai_extract");
  let extraction;
  try {
    extraction = await extractLocations({
      caption: combinedCaption,
      title: meta.title,
      creatorName: creator,
      transcript,
      visualClues,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Extraction failed.";
    aiDone({ outcome: "error", error: msg });
    totalDone({ outcome: "ai_error" });
    return NextResponse.json(
      {
        platform: normalized.platform,
        normalizedUrl: normalized.normalizedUrl,
        sourceHash,
        meta: publicMeta(meta),
        debug: { requestId, evidence },
        error: msg,
      },
      { status: 502 }
    );
  }
  aiDone({
    model: extraction.model ?? "mock",
    usedMock: extraction.usedMock,
    locationCount: extraction.locations.length,
    names: extraction.locations.map((l) => l.name),
  });

  if (extraction.locations.length === 0) {
    logStep(requestId, "no_locations", { reason: "insufficient_evidence" });
    totalDone({ outcome: "insufficient_evidence" });
    return NextResponse.json({
      platform: normalized.platform,
      normalizedUrl: normalized.normalizedUrl,
      sourceHash,
      meta: publicMeta(meta),
      locations: [],
      candidates: {},
      usedMockAi: extraction.usedMock,
      debug: { requestId, evidence },
      message:
        "Not enough evidence to identify a Japan location. Paste the Reel caption (or a screenshot description) and try again, or use Manual search below.",
    });
  }

  // 6. Places matching — each location fails independently
  const placesDone = startTimer(requestId, "places_match");
  const candidates: Record<string, { places: Array<Record<string, unknown>>; error: string | null; recommended?: string | null; recommendReason?: string | null }> = {};
  const embedKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? process.env.GOOGLE_MAPS_EMBED_KEY ?? null;

  await Promise.all(
    extraction.locations.map(async (loc) => {
      try {
        const places = await searchPlaces(loc);
        logStep(requestId, "places_ok", {
          location: loc.name,
          query: places[0]?.query ?? `${loc.name} ${loc.city ?? ""} Japan`.trim(),
          resultCount: places.length,
        });
        const withLinks = places.map((p) => ({
          ...p,
          mapsUrl: googleMapsUrl(p),
          embedUrl: mapsEmbedUrl(p, embedKey),
        }));
        candidates[loc.name] = { places: withLinks, error: null };

        // 7. AI verification/ranking (best-effort recommendation only —
        // the user still confirms the final pin).
        if (withLinks.length > 1) {
          const verdict = await verifyCandidates({
            clues: { name: loc.name, city: loc.city, evidence: loc.evidence },
            candidates: withLinks.map((p) => ({
              name: String(p.name),
              address: (p.address as string | null) ?? null,
              rating: (p.rating as number | null) ?? null,
            })),
          });
          if (verdict) {
            candidates[loc.name].recommended = verdict.recommended;
            candidates[loc.name].recommendReason = verdict.reason;
            logStep(requestId, "verify_ok", { location: loc.name, recommended: verdict.recommended });
          } else {
            logStep(requestId, "verify_skipped", { location: loc.name, reason: "inconclusive_or_failed" });
          }
        } else if (withLinks.length === 1) {
          candidates[loc.name].recommended = String(withLinks[0].name);
          candidates[loc.name].recommendReason = "Only one candidate found.";
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Places lookup failed.";
        logStep(requestId, "places_failed", { location: loc.name, error: msg });
        candidates[loc.name] = { places: [], error: msg };
      }
    })
  );
  placesDone({ locationCount: extraction.locations.length });
  totalDone({ outcome: "ok", locationCount: extraction.locations.length });

  return NextResponse.json({
    platform: normalized.platform,
    normalizedUrl: normalized.normalizedUrl,
    sourceHash,
    meta: publicMeta(meta),
    locations: extraction.locations,
    candidates,
    usedMockAi: extraction.usedMock,
    usedMockPlaces: !process.env.GOOGLE_PLACES_API_KEY,
    hasMapEmbed: !!embedKey,
    resolver: resolved
      ? { provider: resolved.provider, durationSeconds: resolved.durationSeconds, captioned: !!resolved.caption, videoAnalyzed: visualClues.length > 0 || !!transcript }
      : null,
    debug: { requestId, evidence },
  });
}

/**
 * Downloads the temporary resolver video URL into memory (never disk).
 * Aborts + throws if it exceeds maxBytes — the caller falls back to
 * caption-only evidence.
 */
async function downloadBytes(url: string, maxBytes: number, requestId: string): Promise<Buffer> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`Video download failed (HTTP ${res.status}).`);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        reader.cancel().catch(() => {});
        throw new Error(`Video too large for inline analysis (>${Math.round(maxBytes / 1048576)}MB).`);
      }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    logStep(requestId, "video_downloaded", { bytes: buf.length });
    return buf;
  } finally {
    clearTimeout(timeout);
  }
}

function publicMeta(meta: Awaited<ReturnType<typeof fetchSourceMetadata>>) {
  return {
    title: meta.title,
    creatorName: meta.creatorName,
    thumbnailUrl: meta.thumbnailUrl,
    warnings: meta.warnings,
    fetchDebug: meta.fetchDebug,
  };
}

function platformNoDescriptionHint(platform: string, fetchDebug: { oembed: string; opengraph: string; detail?: string }): string {
  if (platform === "instagram") {
    return process.env.SOCIALKIT_API_KEY
      ? "Instagram blocks direct fetches — the reel resolver will supply the caption/video instead"
      : "Instagram blocks unauthenticated fetches and no SOCIALKIT_API_KEY is set — paste the caption, or add a resolver key";
  }
  if (fetchDebug.opengraph === "failed") {
    return `YouTube oEmbed has no description field and the page scrape failed (${fetchDebug.detail ?? "blocked"}) — paste the caption`;
  }
  return "No description found on the link — paste the caption";
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
