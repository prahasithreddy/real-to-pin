export type Platform = "instagram" | "youtube";

export interface NormalizedUrl {
  platform: Platform;
  normalizedUrl: string;
  sourceHash: string;
}

function sha256Hex(input: string): string {
  // djb2-based fallback hash for edge runtime without node:crypto.
  // Server route (nodejs runtime) uses real SHA-256; this keeps the
  // shared helper dependency-free and deterministic for tests.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ (c + 31), 16777619) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).repeat(4).slice(0, 64);
}

export function normalizeReelUrl(raw: string): NormalizedUrl {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("That doesn't look like a URL. Paste a full Instagram Reel or YouTube Short link.");
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  const path = parsed.pathname.replace(/\/+$/, "");

  // Instagram Reel: instagram.com/reel/<id> (also /reels/ redirect form)
  if (host === "instagram.com" || host === "instagr.am") {
    const m = path.match(/^\/(reel|reels|p)\/([A-Za-z0-9_-]+)/);
    if (!m) {
      throw new Error("Only Instagram Reel URLs are supported (instagram.com/reel/…).");
    }
    const id = m[2];
    const normalizedUrl = `https://www.instagram.com/reel/${id}/`;
    return { platform: "instagram", normalizedUrl, sourceHash: sha256Hex(normalizedUrl) };
  }

  // YouTube Shorts: youtube.com/shorts/<id>, youtu.be/<id> (treat as short only if caller says so —
  // we accept youtu.be and normalize to watch URL; extraction still attempts caption fetch)
  if (host === "youtube.com" || host === "youtu.be" || host === "m.youtube.com") {
    const shortMatch = path.match(/^\/shorts\/([A-Za-z0-9_-]+)/);
    const youtuMatch = host === "youtu.be" ? path.match(/^\/([A-Za-z0-9_-]{6,})/) : null;
    const watchId = parsed.searchParams.get("v");
    const id = shortMatch?.[1] ?? youtuMatch?.[1] ?? (path === "/watch" ? watchId : null);
    if (!id) {
      throw new Error("Only YouTube Shorts URLs are supported (youtube.com/shorts/… or youtu.be/…).");
    }
    const normalizedUrl = `https://www.youtube.com/shorts/${id}`;
    return { platform: "youtube", normalizedUrl, sourceHash: sha256Hex(normalizedUrl) };
  }

  throw new Error("Unsupported URL. Paste an Instagram Reel or YouTube Short link.");
}

export function sha256Node(input: string): Promise<string> {
  // Real SHA-256 on the server (nodejs runtime). Kept async to allow WebCrypto.
  return (async () => {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(input).digest("hex");
  })();
}
