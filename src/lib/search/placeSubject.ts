/**
 * Places / objects / things — never treat as a "person" for Google locks.
 * Searches must return empty landscapes / gear, not weddings or tourists.
 */

const KNOWN_PLACES = [
  "lake tahoe",
  "tahoe",
  "yellowstone",
  "yellowstone national park",
  "jerusalem",
  "vatican",
  "golgotha",
  "calvary",
  "dead sea",
  "mount of olives",
  "garden tomb",
  "holy sepulchre",
];

const PLACE_WORDS =
  /\b(lake|ocean|sea|river|bay|gulf|mountain|mount|park|forest|desert|canyon|cave|tomb|ruins|island|glacier|volcano|valley|basin|crater|reef|shore|underwater|lakebed|seafloor)\b/i;

const OBJECT_GEAR =
  /\b(rov|drone|submersible|sonar|bathymetr|robot|probe|camera system|instrument)\b/i;

export function isPlaceOrObjectName(name: string | null | undefined): boolean {
  const n = (name || "").trim().toLowerCase();
  if (!n) return false;
  if (KNOWN_PLACES.some((p) => n === p || n.includes(p))) return true;
  if (PLACE_WORDS.test(n)) return true;
  if (OBJECT_GEAR.test(n)) return true;
  return false;
}

/** Detect the main place/object a beat is about (for no-people Google picks). */
export function primaryPlaceFromText(
  ...parts: Array<string | null | undefined>
): string | null {
  const blob = parts.filter(Boolean).join(" \n ");
  if (!blob.trim()) return null;
  const lower = blob.toLowerCase();

  if (lower.includes("lake tahoe") || /\btahoe\b/.test(lower)) return "Lake Tahoe";
  if (lower.includes("yellowstone")) return "Yellowstone";
  if (lower.includes("dead sea")) return "Dead Sea";
  if (lower.includes("jerusalem")) return "Jerusalem";
  if (lower.includes("vatican")) return "Vatican";
  if (/\bgolgotha\b/.test(lower)) return "Golgotha";
  if (/\bcalvary\b/.test(lower)) return "Calvary";

  if (/\b(rov|remotely operated vehicle|submersible)\b/.test(lower)) {
    if (/\btahoe\b/.test(lower)) return "Lake Tahoe ROV";
    return "underwater ROV";
  }
  if (/\b(lakebed|underwater|deep water|bathymetr)\b/.test(lower) && /\btahoe\b/.test(lower)) {
    return "Lake Tahoe underwater";
  }

  return null;
}

/** Negatives so place/object Google hits stay empty of people and wedding stock. */
export function placeSearchNegatives(placeName?: string | null): string {
  const base =
    "-people -person -couple -wedding -bride -groom -engagement -portrait " +
    "-tourist -tour -family -swimmer -hiker -selfie -model -dress -suit " +
    "-logo -watermark -text -meme -thumbnail -collage";
  const p = (placeName || "").toLowerCase();
  if (p.includes("tahoe")) {
    return `${base} -\"micro wedding\" -proposal -elopement -\"tulle skirt\"`;
  }
  return base;
}
