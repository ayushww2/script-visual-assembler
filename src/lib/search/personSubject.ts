/**
 * Decide the single person a beat/scene is about (for Google 1-person picks).
 */

const PERSON_PRIORITY = [
  "mel gibson",
  "joe rogan",
  "randall wallace",
  "jesus christ",
  "pontius pilate",
  "jesus",
  "gibson",
  "rogan",
];

const PROPER_PERSON =
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-zA-Z'-]+)+)\b/g;

/** Return the one person this text is primarily about, or null. */
export function primaryPersonFromText(...parts: Array<string | null | undefined>): string | null {
  const blob = parts.filter(Boolean).join(" \n ");
  if (!blob.trim()) return null;
  const lower = blob.toLowerCase();

  for (const name of PERSON_PRIORITY) {
    if (lower.includes(name)) {
      if (name === "gibson") return "Mel Gibson";
      if (name === "rogan") return "Joe Rogan";
      if (name === "jesus") return "Jesus Christ";
      // title-case known names
      return name
        .split(" ")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
    }
  }

  const spans = [...blob.matchAll(new RegExp(PROPER_PERSON.source, "g"))].map(
    (m) => m[1],
  );
  if (!spans.length) return null;

  // Prefer 2-token human-looking names; skip film titles with "The ..."
  const people = spans.filter((s) => {
    const words = s.split(/\s+/);
    if (words.length < 2 || words.length > 3) return false;
    if (/^(The|A|An)\b/.test(s)) return false;
    if (/\b(Christ|Passion|Resurrection|Experience)\b/i.test(s) && !/\bJesus\b/i.test(s)) {
      return false;
    }
    return true;
  });

  if (!people.length) return null;

  // Most frequent proper span wins
  const counts = new Map<string, number>();
  for (const p of people) {
    const key = p.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return people.find((p) => p.toLowerCase() === best) || people[0];
}

export function isSinglePersonBeat(text: string): boolean {
  return Boolean(primaryPersonFromText(text));
}
