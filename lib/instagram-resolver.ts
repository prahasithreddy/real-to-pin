/**
 * Instagram resolver provider abstraction (§15 of the resolver plan).
 *
 * The app never talks to a resolver provider from the client — only through
 * the server-side extract route, so keys stay private and the provider can
 * be swapped without touching call sites.
 */

export interface ResolvedReel {
  /** Caption / title text returned by the provider (may be null). */
  caption: string | null;
  creatorName: string | null;
  thumbnailUrl: string | null;
  /** Temporary video file URL (pre-signed, ~1h expiry for SocialKit). */
  videoUrl: string | null;
  durationSeconds: number | null;
  fileSizeBytes: number | null;
  provider: string;
}

export interface InstagramResolver {
  name: string;
  resolve(url: string): Promise<ResolvedReel>;
}

export class ResolverError extends Error {
  /** Permanent (don't retry / ask user) vs temporary (retryable) vs config. */
  readonly kind: "permanent" | "temporary" | "config";
  readonly status?: number;

  constructor(message: string, kind: ResolverError["kind"], status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [2000, 4000];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * SocialKit Instagram Download API.
 * Docs: https://docs.socialkit.dev/api-reference/instagram-download-api
 * - POST https://api.socialkit.dev/instagram/download
 * - auth via `access_key` body field (also accepts query/header)
 * - only public URLs; photo-only posts → 422 (no charge); max 30MB.
 */
export class SocialKitResolver implements InstagramResolver {
  readonly name = "socialkit";
  private readonly apiKey: string;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.SOCIALKIT_API_KEY;
    if (!key) {
      throw new ResolverError(
        "SOCIALKIT_API_KEY is not set — add it to .env.local (see .env.example).",
        "config"
      );
    }
    this.apiKey = key;
  }

  async resolve(url: string): Promise<ResolvedReel> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.tryOnce(url);
      } catch (err) {
        lastError = err;
        // Only retry temporary failures (429 / 5xx / network). Permanent
        // content problems (private, deleted, photo post) fail fast.
        if (!(err instanceof ResolverError) || err.kind !== "temporary") break;
        if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_MS[attempt - 1] ?? 4000);
      }
    }
    throw lastError;
  }

  private async tryOnce(url: string): Promise<ResolvedReel> {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 25000);
    let res: Response;
    try {
      res = await fetch("https://api.socialkit.dev/instagram/download", {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json" },
        // 480p keeps cost at 1 credit/started-min (720p+ costs 4x) and
        // keeps the file small enough for inline multimodal analysis.
        body: JSON.stringify({ access_key: this.apiKey, url, format: "mp4", quality: "480p" }),
      });
    } catch (err) {
      throw new ResolverError(
        `Resolver network error: ${err instanceof Error ? err.message : String(err)}`,
        "temporary"
      );
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 429) {
      throw new ResolverError("Resolver rate-limited (429) — retrying.", "temporary", 429);
    }
    if (res.status >= 500) {
      throw new ResolverError(`Resolver unavailable (HTTP ${res.status}) — retrying.`, "temporary", res.status);
    }
    if (res.status === 422) {
      throw new ResolverError(
        "This post has no downloadable video (photo post or unsupported carousel).",
        "permanent",
        422
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new ResolverError("Resolver rejected the API key (check SOCIALKIT_API_KEY).", "config", res.status);
    }
    if (!res.ok) {
      throw new ResolverError(
        "We couldn't access this Reel. It may be private, deleted, or region/age-restricted.",
        "permanent",
        res.status
      );
    }

    const body = (await res.json().catch(() => null)) as {
      success?: boolean;
      message?: string;
      data?: {
        title?: string;
        thumbnail?: string;
        downloadUrl?: string;
        durationSeconds?: number;
        fileSize?: number;
      };
    } | null;

    if (!body?.success || !body.data?.downloadUrl) {
      throw new ResolverError(
        body?.message || "We couldn't access this Reel. It may be private, deleted, or unavailable to our video provider.",
        "permanent"
      );
    }

    const d = body.data;
    const title = d.title?.trim() || null;
    return {
      // SocialKit `title` is "Video by <creator>" when no caption is exposed;
      // treat handle-only titles as creator, not caption.
      caption: title && !/^video by @?[\w.]+$/i.test(title) ? title : null,
      creatorName: title?.match(/^video by @?([\w.]+)$/i)?.[1] ?? null,
      thumbnailUrl: d.thumbnail ?? null,
      videoUrl: d.downloadUrl ?? null,
      durationSeconds: d.durationSeconds ?? null,
      fileSizeBytes: d.fileSize ?? null,
      provider: this.name,
    };
  }
}
