import type { Platform } from "./url-normalize";

export interface SourceMetadata {
  platform: Platform;
  normalizedUrl: string;
  title: string | null;
  description: string | null;
  creatorName: string | null;
  thumbnailUrl: string | null;
  warnings: string[];
  /** Which fetch strategies were attempted and what happened — surfaced in logs + API debug block. */
  fetchDebug: {
    oembed: "ok" | "failed" | "skipped";
    opengraph: "ok" | "empty" | "failed" | "skipped";
    detail?: string;
  };
}

interface OpenGraph {
  title: string | null;
  description: string | null;
  image: string | null;
}

/**
 * Phase 1 metadata strategy: use whatever is accessible without heavy
 * scraping or downloading.
 *  1. YouTube oEmbed (no key) → title/creator/thumbnail (never description).
 *  2. Best-effort OpenGraph scrape of the canonical URL → description/title.
 * Instagram blocks unauthenticated fetches, so both strategies usually fail
 * there — that outcome is logged and the caller falls back to pasted text.
 */
export async function fetchSourceMetadata(
  platform: Platform,
  normalizedUrl: string
): Promise<SourceMetadata> {
  const warnings: string[] = [];
  const fetchDebug: SourceMetadata["fetchDebug"] = {
    oembed: "skipped",
    opengraph: "skipped",
  };

  let title: string | null = null;
  let description: string | null = null;
  let creatorName: string | null = null;
  let thumbnailUrl: string | null = null;

  if (platform === "youtube") {
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
        normalizedUrl
      )}&format=json`;
      const res = await fetch(oembedUrl, { next: { revalidate: 3600 } });
      if (res.ok) {
        const data = (await res.json()) as {
          title?: string;
          author_name?: string;
          thumbnail_url?: string;
        };
        title = data.title ?? null;
        creatorName = data.author_name ?? null;
        thumbnailUrl = data.thumbnail_url ?? null;
        fetchDebug.oembed = "ok";
      } else {
        fetchDebug.oembed = "failed";
        fetchDebug.detail = `oEmbed HTTP ${res.status}`;
      }
    } catch (err) {
      fetchDebug.oembed = "failed";
      fetchDebug.detail = `oEmbed error: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    warnings.push(
      "Instagram blocks unauthenticated metadata fetches. Paste the Reel caption below for best results."
    );
  }

  // Best-effort OpenGraph: the only free shot at a link-derived description.
  const og = await fetchOpenGraph(normalizedUrl);
  if (og === null) {
    fetchDebug.opengraph = "failed";
    fetchDebug.detail = [fetchDebug.detail, "OpenGraph fetch failed (blocked/non-HTML/timeout)"]
      .filter(Boolean)
      .join("; ");
  } else if (og.description || og.title) {
    fetchDebug.opengraph = "ok";
    description = description ?? og.description;
    title = title ?? og.title;
    thumbnailUrl = thumbnailUrl ?? og.image;
  } else {
    fetchDebug.opengraph = "empty";
  }

  if (!title && !description && !creatorName) {
    warnings.push("No text could be extracted from the link itself — pasted caption is required.");
  }

  // Login-wall / generic titles ("Instagram", "YouTube") carry no signal —
  // don't count them as extracted evidence.
  if (title && isJunkTitle(title)) {
    title = null;
    if (!description && !creatorName) {
      fetchDebug.opengraph = "empty";
    }
  }

  return {
    platform,
    normalizedUrl,
    title,
    description,
    creatorName,
    thumbnailUrl,
    warnings,
    fetchDebug,
  };
}

async function fetchOpenGraph(url: string): Promise<OpenGraph | null> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html",
      },
    });
    if (!res.ok) return null;
    if (!(res.headers.get("content-type") ?? "").includes("text/html")) return null;
    const html = (await res.text()).slice(0, 300_000);
    const meta = (attr: string, name: string): string | null => {
      const m = html.match(
        new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]+content=["']([^"']{1,2000})["']`, "i")
      ) ?? html.match(
        new RegExp(`<meta[^>]+content=["']([^"']{1,2000})["'][^>]+${attr}=["']${name}["']`, "i")
      );
      return m ? decodeEntities(m[1]) : null;
    };
    return {
      title: meta("property", "og:title") ?? meta("name", "twitter:title") ?? htmlTitle(html),
      description:
        meta("property", "og:description") ?? meta("name", "description") ?? meta("name", "twitter:description"),
      image: meta("property", "og:image") ?? meta("name", "twitter:image"),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

const JUNK_TITLES = new Set(
  ["instagram", "login • instagram", "youtube", "youtu"].map((s) => s.toLowerCase())
);

function isJunkTitle(title: string): boolean {
  return JUNK_TITLES.has(title.trim().toLowerCase());
}

function htmlTitle(html: string): string | null {  const m = html.match(/<title[^>]*>([^<]{1,500})<\/title>/i);
  return m ? decodeEntities(m[1].trim()) : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}
