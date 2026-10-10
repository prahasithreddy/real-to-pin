"use client";

import { useEffect, useRef, useState } from "react";

interface Evidence {
  type: string;
  text: string;
}

interface Location {
  name: string;
  city: string | null;
  region: string | null;
  country: string;
  category: string | null;
  evidence: Evidence[];
}

interface Candidate {
  name: string;
  address: string | null;
  placeId: string | null;
  latitude: number | null;
  longitude: number | null;
  rating: number | null;
  query: string;
  mapsUrl: string;
  embedUrl: string | null;
}

interface EvidenceSource {
  source: string;
  status: "ok" | "empty" | "failed" | "not_implemented" | "skipped";
  detail: string;
  chars?: number;
}

interface CandidateGroup {
  places: Candidate[];
  error: string | null;
  recommended?: string | null;
  recommendReason?: string | null;
}

interface ExtractResponse {
  platform?: string;
  normalizedUrl?: string;
  sourceHash?: string;
  meta?: {
    title: string | null;
    creatorName: string | null;
    thumbnailUrl: string | null;
    warnings: string[];
  };
  locations?: Location[];
  candidates?: Record<string, CandidateGroup>;
  error?: string;
  message?: string;
  usedMockAi?: boolean;
  usedMockPlaces?: boolean;
  hasMapEmbed?: boolean;
  resolver?: {
    provider: string;
    durationSeconds: number | null;
    captioned: boolean;
    videoAnalyzed: boolean;
  } | null;
  debug?: {
    requestId: string;
    evidence: EvidenceSource[];
  };
}

type Stage = "idle" | "working" | "done" | "error";

export default function Home() {
  const [url, setUrl] = useState("");
  const [caption, setCaption] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [result, setResult] = useState<ExtractResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<Candidate | null>(null);
  const confirmedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (confirmed) {
      confirmedRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [confirmed]);

  function handleConfirm(candidate: Candidate) {
    setConfirmed(candidate);
  }

  async function handleProcess(e: React.FormEvent) {
    e.preventDefault();
    setStage("working");
    setError(null);
    setResult(null);
    setConfirmed(null);
    try {
      const res = await fetch("/api/v1/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, caption }),
      });
      const data = (await res.json()) as ExtractResponse;
      if (!res.ok) {
        setStage("error");
        setError(data.error ?? "Something went wrong.");
        return;
      }
      setStage("done");
      setResult(data);
    } catch (err) {
      setStage("error");
      setError(err instanceof Error ? err.message : "Network error.");
    }
  }

  const locations = result?.locations ?? [];
  const candidateEntries = result?.candidates ?? {};

  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <header className="mb-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-red-400">Japan Reel-to-Map · MVP Phase 1</p>
        <h1 className="mt-2 text-3xl font-bold leading-tight">
          Paste a Reel → pin it on the map
        </h1>
        <p className="mt-2 text-sm text-neutral-400">
          Instagram Reels and YouTube Shorts. No login. AI proposes candidates — you confirm the pin.
        </p>
      </header>

      <form onSubmit={handleProcess} className="space-y-3 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
        <label className="block text-sm font-medium">
          Reel / Short URL
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.instagram.com/reel/… or https://www.youtube.com/shorts/…"
            className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-red-500"
            inputMode="url"
          />
        </label>
        <label className="block text-sm font-medium">
          Caption / description <span className="font-normal text-neutral-400">(optional for Instagram when the reel resolver is configured — otherwise recommended)</span>
          <textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            rows={4}
            placeholder="Paste the Reel caption, on-screen text, or what the narrator says. e.g. Best food spots in Kyoto — visit Nishiki Market!"
            className="mt-1 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-red-500"
          />
        </label>
        <button
          type="submit"
          disabled={stage === "working" || !url.trim()}
          className="w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {stage === "working" ? "Processing…" : "Process"}
        </button>
      </form>

      {stage === "working" && (
        <div className="mt-6 rounded-xl border border-neutral-800 bg-neutral-900 p-4 text-sm text-neutral-300">
          <ol className="list-decimal space-y-1 pl-5">
            <li>Validating + normalizing URL…</li>
            <li>Fetching accessible metadata…</li>
            <li>Resolving Instagram reel (caption + video)…</li>
            <li>Analyzing video + extracting locations (Gemini)…</li>
            <li>Matching Google Places + verifying…</li>
          </ol>
          <p className="mt-2 text-xs text-neutral-500">Video reels can take 20–50s. Per-stage timings land in the extraction log.</p>
        </div>
      )}

      {error && (
        <div className="mt-6 rounded-xl border border-red-900 bg-red-950/40 p-4 text-sm text-red-200">{error}</div>
      )}

      {stage === "done" && result && (
        <section className="mt-6 space-y-4">
          {(result.usedMockAi || result.usedMockPlaces) && (
            <div className="rounded-xl border border-amber-900 bg-amber-950/40 p-3 text-xs text-amber-200">
              Demo mode: {result.usedMockAi ? "AI mock (add GEMINI_API_KEY). " : ""}
              {result.usedMockPlaces ? "Places mock (add GOOGLE_PLACES_API_KEY)." : ""}
              Pins/addresses become real once keys are set.
            </div>
          )}

          {result.resolver && (
            <div className="rounded-xl border border-sky-900 bg-sky-950/40 p-3 text-xs text-sky-200">
              Reel resolved via {result.resolver.provider}
              {result.resolver.durationSeconds ? ` · ${Math.round(result.resolver.durationSeconds)}s video` : ""}
              {result.resolver.captioned ? " · caption captured" : " · no caption exposed"}
              {result.resolver.videoAnalyzed ? " · video analyzed" : ""}
              {result.meta?.thumbnailUrl && (
                <img src={result.meta.thumbnailUrl} alt="Reel thumbnail" className="mt-2 h-24 rounded-lg object-cover" />
              )}
            </div>
          )}

          {result.meta?.warnings?.map((w) => (
            <div key={w} className="rounded-xl border border-neutral-800 bg-neutral-900 p-3 text-xs text-neutral-400">
              {w}
            </div>
          ))}

          {result.debug && <ExtractionLog debug={result.debug} />}

          {result.meta && (result.meta.title || result.meta.creatorName) && (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4 text-sm">
              <p className="font-semibold">Source info</p>
              {result.meta.title && <p className="mt-1 text-neutral-300">{result.meta.title}</p>}
              {result.meta.creatorName && <p className="text-xs text-neutral-500">by {result.meta.creatorName}</p>}
              {result.normalizedUrl && (
                <a href={result.normalizedUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-red-400 underline">
                  Open original
                </a>
              )}
            </div>
          )}

          {result.message && locations.length === 0 && (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4 text-sm text-neutral-300">
              {result.message}
            </div>
          )}

          {locations.map((loc) => (
            <div key={loc.name} className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">{loc.name}</p>
                  <p className="text-xs text-neutral-400">
                    {[loc.city, loc.region, loc.country].filter(Boolean).join(", ")}
                    {loc.category ? ` · ${loc.category}` : ""}
                  </p>
                </div>
              </div>
              <ul className="mt-2 space-y-1 text-xs text-neutral-400">
                {loc.evidence.map((ev, i) => (
                  <li key={i} className="rounded bg-neutral-950 px-2 py-1">
                    <span className="font-semibold text-neutral-500">[{ev.type}]</span> {ev.text}
                  </li>
                ))}
              </ul>

              <div className="mt-3 space-y-2">
                {candidateEntries[loc.name]?.error && (
                  <p className="text-xs text-red-300">{candidateEntries[loc.name].error}</p>
                )}
                {(candidateEntries[loc.name]?.places ?? []).map((c, i) => (
                  <div key={`${c.placeId ?? c.name}-${i}`} className="rounded-lg border border-neutral-700 p-3">
                    <p className="text-sm font-medium">
                      {c.name}{" "}
                      {candidateEntries[loc.name]?.recommended === c.name && (
                        <span className="ml-1 rounded border border-emerald-800 bg-emerald-950 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-300">
                          AI recommended
                        </span>
                      )}
                    </p>
                    {c.address && <p className="text-xs text-neutral-400">{c.address}</p>}
                    {candidateEntries[loc.name]?.recommended === c.name && candidateEntries[loc.name]?.recommendReason && (
                      <p className="mt-1 text-xs text-emerald-200/70">{candidateEntries[loc.name]?.recommendReason}</p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => handleConfirm(c)}
                        className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold hover:bg-emerald-500"
                      >
                        Confirm pin
                      </button>
                      <a
                        href={c.mapsUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-md border border-neutral-600 px-3 py-1.5 text-xs hover:border-neutral-400"
                      >
                        Open in Google Maps
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Manual fallback: search Google Maps directly when AI comes up empty */}
          <ManualSearch onConfirm={handleConfirm} />
        </section>
      )}

      {confirmed && (
        <section ref={confirmedRef} className="mt-6 scroll-mt-6 rounded-xl border border-emerald-900 bg-emerald-950/30 p-4">
          <p className="text-sm font-semibold text-emerald-200">Pinned: {confirmed.name}</p>
          {confirmed.address && <p className="text-xs text-emerald-200/70">{confirmed.address}</p>}
          {confirmed.embedUrl ? (
            <iframe
              title={`Map of ${confirmed.name}`}
              src={confirmed.embedUrl}
              className="mt-3 h-80 w-full rounded-lg border border-emerald-900"
              loading="lazy"
            />
          ) : (
            <div className="mt-3 rounded-lg border border-emerald-900 bg-neutral-950 p-4 text-xs text-neutral-300">
              {confirmed.latitude != null && confirmed.longitude != null ? (
                <p>
                  Coordinates: {confirmed.latitude}, {confirmed.longitude}
                </p>
              ) : (
                <p>No embed key configured — use the Google Maps link for the live pin.</p>
              )}
              <a href={confirmed.mapsUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-emerald-300 underline">
                Open in Google Maps
              </a>
            </div>
          )}
        </section>
      )}

      <footer className="mt-10 border-t border-neutral-800 pt-4 text-xs text-neutral-500">
        Phase 1 core loop: URL → metadata → Gemini extraction → Places candidates → you confirm the pin.
        Auth, trips, and DB land in Phase 2.
      </footer>
    </main>
  );
}

const STATUS_STYLE: Record<EvidenceSource["status"], { label: string; className: string }> = {
  ok: { label: "ok", className: "bg-emerald-950 text-emerald-300 border-emerald-800" },
  empty: { label: "empty", className: "bg-neutral-800 text-neutral-400 border-neutral-700" },
  failed: { label: "failed", className: "bg-red-950 text-red-300 border-red-800" },
  not_implemented: { label: "not built yet", className: "bg-amber-950 text-amber-300 border-amber-800" },
  skipped: { label: "skipped", className: "bg-neutral-800 text-neutral-500 border-neutral-700" },
};

const SOURCE_LABEL: Record<string, string> = {
  link_url: "Link URL",
  link_title: "Link → title",
  link_description: "Link → description",
  link_creator: "Link → creator",
  pasted_caption: "Pasted caption",
  reel_resolver: "Reel resolver",
  audio_transcript: "Audio → transcript",
  video_frames: "Video → frames",
};

function ExtractionLog({ debug }: { debug: { requestId: string; evidence: EvidenceSource[] } }) {
  const okCount = debug.evidence.filter((e) => e.status === "ok").length;
  return (
    <details className="rounded-xl border border-neutral-800 bg-neutral-900 p-4" open={okCount === 0}>
      <summary className="cursor-pointer text-sm font-medium">
        Extraction log{" "}
        <span className="font-normal text-neutral-400">
          — {okCount}/{debug.evidence.length} sources yielded data
        </span>
      </summary>
      <ul className="mt-3 space-y-1.5">
        {debug.evidence.map((e) => {
          const style = STATUS_STYLE[e.status];
          return (
            <li key={e.source} className="flex items-start gap-2 text-xs">
              <span className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 font-mono ${style.className}`}>
                {style.label}
              </span>
              <span>
                <span className="font-semibold text-neutral-300">{SOURCE_LABEL[e.source] ?? e.source}</span>
                <span className="text-neutral-400"> — {e.detail}</span>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 font-mono text-[11px] text-neutral-500">
        request {debug.requestId} · full stage timings in the server terminal (`npm run dev` output, lines tagged
        [reel-to-map])
      </p>
    </details>
  );
}

function ManualSearch({ onConfirm }: { onConfirm: (c: Candidate) => void }) {  const [q, setQ] = useState("");
  return (
    <div className="rounded-xl border border-dashed border-neutral-700 p-4">
      <p className="text-sm font-medium">No good candidate? Search manually</p>
      <div className="mt-2 flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. Nishiki Market Kyoto Japan"
          className="flex-1 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-red-500"
        />
        <a
          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q || "Japan")}`}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg border border-neutral-600 px-3 py-2 text-xs hover:border-neutral-400"
        >
          Search Maps
        </a>
        <button
          onClick={() =>
            q.trim() &&
            onConfirm({
              name: q.trim(),
              address: null,
              placeId: null,
              latitude: null,
              longitude: null,
              rating: null,
              query: q.trim(),
              mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q.trim())}`,
              embedUrl: null,
            })
          }
          className="rounded-lg bg-neutral-700 px-3 py-2 text-xs font-semibold hover:bg-neutral-600"
        >
          Pin this
        </button>
      </div>
    </div>
  );
}
