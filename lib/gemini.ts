import { GoogleGenerativeAI } from "@google/generative-ai";

export interface EvidenceItem {
  type: "caption" | "transcript" | "visual" | "title" | "creator";
  text: string;
}

export interface ExtractedLocation {
  name: string;
  city: string | null;
  region: string | null;
  country: string;
  category: string | null;
  evidence: EvidenceItem[];
}

export interface ExtractionResult {
  locations: ExtractedLocation[];
  rawModelText: string;
  usedMock: boolean;
  /** Model ID that produced the result (null when mock). Logged per request. */
  model: string | null;
}

export interface VideoAnalysis {
  transcript: string | null;
  visualClues: string[];
  spokenClues: string[];
  japaneseText: string[];
  searchQueries: string[];
  model: string;
}

export interface VerifyResult {
  /** Location name (must match one of the candidates) the AI recommends. */
  recommended: string;
  reason: string;
}

const EXTRACTION_PROMPT = `You extract real-world travel locations in Japan from social video evidence.

Rules:
- Base every location ONLY on the supplied evidence. Never invent a location.
- Preserve original names exactly (do not translate or rename). Keep Japanese script when given.
- Handle romanized and Japanese names.
- Return null/empty locations array when evidence is insufficient.
- For each location, cite which evidence supports it.
- Country must be "Japan". If the evidence points outside Japan, return an empty locations array.
- Respond with strict JSON only, matching this schema:
{"locations":[{"name":"...","city":"..."|null,"region":"..."|null,"country":"Japan","category":"..."|null,"evidence":[{"type":"caption|transcript|visual|title|creator","text":"..."}]}]}`;

function mockExtraction(evidenceText: string): ExtractionResult {
  // Deterministic keyword fallback so the UI is testable with no API key.
  const hay = evidenceText.toLowerCase();
  const known: Array<{ keys: string[]; loc: ExtractedLocation }> = [
    {
      keys: ["nishiki"],
      loc: {
        name: "Nishiki Market",
        city: "Kyoto",
        region: null,
        country: "Japan",
        category: "market",
        evidence: [{ type: "caption", text: "Matched keyword 'Nishiki' (mock extraction — add GEMINI_API_KEY for real AI)" }],
      },
    },
    {
      keys: ["fushimi", "inari"],
      loc: {
        name: "Fushimi Inari Shrine",
        city: "Kyoto",
        region: null,
        country: "Japan",
        category: "shrine",
        evidence: [{ type: "caption", text: "Matched keyword 'Fushimi Inari' (mock extraction)" }],
      },
    },
    {
      keys: ["senso", "sensō", "asakusa"],
      loc: {
        name: "Senso-ji",
        city: "Tokyo",
        region: null,
        country: "Japan",
        category: "temple",
        evidence: [{ type: "caption", text: "Matched keyword 'Senso-ji/Asakusa' (mock extraction)" }],
      },
    },
    {
      keys: ["shibuya"],
      loc: {
        name: "Shibuya Crossing",
        city: "Tokyo",
        region: null,
        country: "Japan",
        category: "attraction",
        evidence: [{ type: "caption", text: "Matched keyword 'Shibuya' (mock extraction)" }],
      },
    },
    {
      keys: ["dotonbori", "dotonbori", "dōtonbori"],
      loc: {
        name: "Dotonbori",
        city: "Osaka",
        region: null,
        country: "Japan",
        category: "attraction",
        evidence: [{ type: "caption", text: "Matched keyword 'Dotonbori' (mock extraction)" }],
      },
    },
  ];
  const locations = known.filter((k) => k.keys.some((key) => hay.includes(key))).map((k) => k.loc);
  return {
    locations,
    rawModelText: JSON.stringify({ locations, note: "mock extraction (no GEMINI_API_KEY)" }),
    usedMock: true,
    model: null,
  };
}

export async function extractLocations(input: {
  caption: string | null;
  title: string | null;
  creatorName: string | null;
  transcript?: string | null;
  visualClues?: string[];
}): Promise<ExtractionResult> {
  const evidenceText = [input.title, input.caption, input.creatorName, input.transcript, ...(input.visualClues ?? [])]
    .filter(Boolean)
    .join("\n\n");
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return mockExtraction(evidenceText);
  }

  const userMessage = [
    `TITLE: ${input.title ?? "(none)"}`,
    `CREATOR: ${input.creatorName ?? "(none)"}`,
    `CAPTION / DESCRIPTION:\n${input.caption ?? "(none)"}`,
    `AUDIO TRANSCRIPT:\n${input.transcript ?? "(none)"}`,
    `VISUAL CLUES:\n${input.visualClues?.length ? input.visualClues.map((c) => `- ${c}`).join("\n") : "(none)"}`,
  ].join("\n\n");

  const { text, model } = await generateJson(apiKey, `${EXTRACTION_PROMPT}\n\nEVIDENCE:\n${userMessage}`);
  const parsed = JSON.parse(text) as { locations?: ExtractedLocation[] };
  const locations = Array.isArray(parsed.locations) ? parsed.locations : [];
  // Defensive: force country Japan, drop empty names.
  const cleaned = locations
    .filter((l) => typeof l?.name === "string" && l.name.trim().length > 0)
    .map((l) => ({ ...l, name: l.name.trim(), country: "Japan" }));
  return { locations: cleaned, rawModelText: text, usedMock: false, model };
}

const VIDEO_ANALYSIS_PROMPT = `Analyze this travel video reel for location identification in Japan.

Rules:
- Transcribe any speech (any language) briefly; note the language.
- List visual clues that could identify the place: restaurant/station/street signs, Japanese text (quote it exactly), buildings, landmarks, menus, store names, stations, scenery.
- Propose 2-4 Google Places search queries (e.g. "restaurant name + city").
- Only report what is actually visible/audible. Never invent.
- Respond with strict JSON only:
{"transcript":"..."|null,"visual_clues":["..."],"spoken_clues":["..."],"japanese_text":["..."],"search_queries":["..."]}`;

/**
 * Multimodal video analysis: Gemini watches the reel (vision + audio) and
 * returns transcript + visual clues. One call covers both the "audio" and
 * "video" evidence sources — no separate transcription infra needed.
 */
export async function analyzeReelVideo(input: {
  videoBytes: Buffer;
  mimeType: string;
  caption: string | null;
  title: string | null;
}): Promise<VideoAnalysis> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Video analysis needs GEMINI_API_KEY (no mock for video).");

  const context = [
    `TITLE: ${input.title ?? "(none)"}`,
    `CAPTION:\n${input.caption ?? "(none)"}`,
  ].join("\n\n");

  const { text, model } = await generateJson(
    apiKey,
    `${VIDEO_ANALYSIS_PROMPT}\n\nCONTEXT:\n${context}`,
    { inlineData: { data: input.videoBytes.toString("base64"), mimeType: input.mimeType } }
  );
  const parsed = JSON.parse(text) as {
    transcript?: string | null;
    visual_clues?: string[];
    spoken_clues?: string[];
    japanese_text?: string[];
    search_queries?: string[];
  };
  return {
    transcript: parsed.transcript ?? null,
    visualClues: Array.isArray(parsed.visual_clues) ? parsed.visual_clues : [],
    spokenClues: Array.isArray(parsed.spoken_clues) ? parsed.spoken_clues : [],
    japaneseText: Array.isArray(parsed.japanese_text) ? parsed.japanese_text : [],
    searchQueries: Array.isArray(parsed.search_queries) ? parsed.search_queries : [],
    model,
  };
}

const VERIFY_PROMPT = `You verify which Google Places candidate best matches extracted location clues for a Japan travel video.

Rules:
- Compare each candidate's name, address, and rating against the clues (names, Japanese text, visual/spoken clues).
- Pick exactly one candidate by its exact name, or return null if none match convincingly.
- Respond with strict JSON only: {"recommended":"<exact candidate name>"|null,"reason":"..."}`;

/**
 * AI verification/ranking over Places candidates (§10 of the resolver plan).
 * Best-effort: returns null when inconclusive or on any failure — the caller
 * falls back to showing all candidates for user confirmation (the user still
 * always confirms the final pin; the AI only recommends).
 */
export async function verifyCandidates(input: {
  clues: { name: string; city: string | null; evidence: EvidenceItem[] };
  candidates: Array<{ name: string; address: string | null; rating: number | null }>;
}): Promise<VerifyResult | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || input.candidates.length === 0) return null;
  try {
    const clueText = [
      `EXTRACTED: ${input.clues.name} (${input.clues.city ?? "unknown city"})`,
      ...input.clues.evidence.map((e) => `[${e.type}] ${e.text}`),
    ].join("\n");
    const candText = input.candidates
      .map((c, i) => `${i + 1}. ${c.name} — ${c.address ?? "no address"}${c.rating ? ` (rating ${c.rating})` : ""}`)
      .join("\n");
    const { text } = await generateJson(apiKey, `${VERIFY_PROMPT}\n\nCLUES:\n${clueText}\n\nCANDIDATES:\n${candText}`);
    const parsed = JSON.parse(text) as { recommended?: string | null; reason?: string };
    if (!parsed.recommended) return null;
    // Only accept an exact match to a real candidate — never a new invention.
    const match = input.candidates.find((c) => c.name === parsed.recommended);
    return match ? { recommended: match.name, reason: parsed.reason ?? "" } : null;
  } catch {
    return null;
  }
}

/** Single JSON-mode Gemini call with model-ID fallback across retirements. */
async function generateJson(
  apiKey: string,
  prompt: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...extraParts: any[]
): Promise<{ text: string; model: string }> {
  const genAI = new GoogleGenerativeAI(apiKey);

  // Model IDs retire regularly — ground truth is ListModels, but a pinned
  // fallback list plus 404-skip keeps requests working without code changes.
  // (Verified 2026-09-22: 2.5-flash/lite, 3.5/3.6/3.7/3.8-flash all listed.)
  const candidates = [
    process.env.GEMINI_MODEL,
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-3.8-flash",
  ].filter((m): m is string => !!m && m.length > 0);
  const modelsToTry = Array.from(new Set(candidates));

  let lastError: unknown = null;
  for (const modelId of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelId,
        generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
      });
      const content = extraParts.length ? [prompt, ...extraParts] : prompt;
      // One retry on transient overload/rate-limit (429/503) before moving on.
      try {
        const result = await model.generateContent(content);
        return { text: result.response.text(), model: modelId };
      } catch (err) {
        if (!isTransientError(err)) throw err;
        await new Promise((r) => setTimeout(r, 3000));
        const result = await model.generateContent(content);
        return { text: result.response.text(), model: modelId };
      }
    } catch (err) {
      lastError = err;
      // Move on for retired models AND overloaded ones; anything else
      // (bad key, quota, safety block) is terminal for this request.
      if (!isModelNotFoundError(err) && !isTransientError(err)) break;
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `AI call failed (tried: ${modelsToTry.join(", ")}): ${msg}. ` +
      `Set GEMINI_MODEL to a current model from https://ai.google.dev/gemini-api/docs/models`
  );
}

function isModelNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /404|not found|is not supported for generateContent/i.test(msg);
}

function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|503|overloaded|high demand|temporarily/i.test(msg);
}
