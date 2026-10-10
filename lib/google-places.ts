import type { ExtractedLocation } from "./gemini";

export interface PlaceCandidate {
  name: string;
  address: string | null;
  placeId: string | null;
  latitude: number | null;
  longitude: number | null;
  rating: number | null;
  query: string;
}

/**
 * Google Places matching (Phase 1: simple name+city+country text search).
 * Uses the Places API (New) Text Search endpoint server-side.
 * Without a key, returns a mock candidate derived from the AI output so
 * the map-pin loop stays testable end to end.
 */
export async function searchPlaces(loc: ExtractedLocation): Promise<PlaceCandidate[]> {
  const query = [loc.name, loc.city, "Japan"].filter(Boolean).join(" ");
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  if (!apiKey) {
    return [
      {
        name: loc.name,
        address: [loc.name, loc.city, "Japan"].filter(Boolean).join(", ") + " (mock — add GOOGLE_PLACES_API_KEY)",
        placeId: null,
        latitude: null,
        longitude: null,
        rating: null,
        query,
      },
    ];
  }

  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "places.displayName,places.formattedAddress,places.id,places.location,places.rating",
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 5 }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Places search failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    places?: Array<{
      id?: string;
      displayName?: { text?: string };
      formattedAddress?: string;
      location?: { latitude?: number; longitude?: number };
      rating?: number;
    }>;
  };

  return (data.places ?? []).map((p) => ({
    name: p.displayName?.text ?? loc.name,
    address: p.formattedAddress ?? null,
    placeId: p.id ?? null,
    latitude: p.location?.latitude ?? null,
    longitude: p.location?.longitude ?? null,
    rating: p.rating ?? null,
    query,
  }));
}

export function googleMapsUrl(c: PlaceCandidate): string {
  if (c.placeId) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.name)}&query_place_id=${encodeURIComponent(c.placeId)}`;
  if (c.latitude != null && c.longitude != null)
    return `https://www.google.com/maps/search/?api=1&query=${c.latitude},${c.longitude}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.query)}`;
}

/** Maps Embed URL (iframe). Requires a Maps Embed API key client-side. Null when unusable. */
export function mapsEmbedUrl(c: PlaceCandidate, embedKey: string | null): string | null {
  if (!embedKey) return null;
  const q = c.placeId
    ? `place_id:${c.placeId}`
    : c.latitude != null && c.longitude != null
      ? `${c.latitude},${c.longitude}`
      : c.query;
  return `https://www.google.com/maps/embed/v1/search?key=${encodeURIComponent(embedKey)}&q=${encodeURIComponent(q)}`;
}
