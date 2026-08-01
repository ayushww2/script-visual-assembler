/**
 * Decide the single person a beat/scene is about (for Google 1-person picks).
 * Always return a full searchable name — never bare "Gibson".
 */

const PROPER_PERSON =
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-zA-Z'-]+)+)\b/g;

/**
 * Return the ONE person this beat is primarily about.
 * Mel Gibson documentary rules: "Gibson" alone → Mel Gibson.
 * Passion + Jesus → Jim Caviezel (the actor in that film).
 */
export function primaryPersonFromText(
  ...parts: Array<string | null | undefined>
): string | null {
  const blob = parts.filter(Boolean).join(" \n ");
  if (!blob.trim()) return null;
  const lower = blob.toLowerCase();

  const mentionsMelExplicit =
    lower.includes("mel gibson") || /\bgibson\b/.test(lower);
  const mentionsRogan =
    lower.includes("joe rogan") || /\brogan\b/.test(lower);
  const mentionsJesus =
    lower.includes("jesus christ") || /\bjesus\b/.test(lower);
  const mentionsPassion =
    lower.includes("passion of the christ") ||
    lower.includes("passion of christ") ||
    lower.includes("resurrection of the christ");
  const mentionsWallace = lower.includes("randall wallace");
  const mentionsPilate = lower.includes("pontius pilate") || /\bpilate\b/.test(lower);

  const jesusInFilm =
    mentionsPassion ||
    /religious films?\b/.test(lower) ||
    /\b(passion|crucifixion|golgotha|calvary)\b/.test(lower);

  // Film Jesus → Jim Caviezel (real Passion stills), never watermarked AI Jesus
  if (mentionsJesus && jesusInFilm && !mentionsMelExplicit) {
    return "Jim Caviezel";
  }
  if (mentionsJesus && jesusInFilm && mentionsMelExplicit) {
    if (
      /\bgibson\b/.test(lower) &&
      /\b(said|says|revealed|returned|believed|warned|focused|words)\b/.test(
        lower,
      )
    ) {
      return "Mel Gibson";
    }
    return "Jim Caviezel";
  }

  // Both Rogan + Gibson: pick the person the sentence is about (usually Mel in this film)
  if (mentionsMelExplicit && mentionsRogan) {
    if (
      /\brogan (asked|asks|interviewed|hosts)\b/.test(lower) &&
      !/\bgibson (said|says|returned|revealed|believed|warned)\b/.test(lower)
    ) {
      // "Rogan asked Gibson…" → show Mel Gibson (the guest / topic)
      return "Mel Gibson";
    }
    if (/\bgibson (returned|said|says|revealed|appeared|joined)\b/.test(lower)) {
      return "Mel Gibson";
    }
    if (/\bon (the )?joe rogan\b/.test(lower) || /\brogan experience\b/.test(lower)) {
      return "Mel Gibson";
    }
    return "Mel Gibson";
  }

  if (lower.includes("mel gibson") || (/\bgibson\b/.test(lower) && !mentionsRogan)) {
    return "Mel Gibson";
  }
  if (mentionsMelExplicit) return "Mel Gibson";

  if (lower.includes("joe rogan") || /\brogan\b/.test(lower)) return "Joe Rogan";
  if (mentionsWallace) return "Randall Wallace";
  if (mentionsPilate) return "Pontius Pilate";
  if (mentionsJesus) return "Jesus Christ";

  const spans = [...blob.matchAll(new RegExp(PROPER_PERSON.source, "g"))].map(
    (m) => m[1],
  );
  if (!spans.length) return null;

  const people = spans.filter((s) => {
    const words = s.split(/\s+/);
    if (words.length < 2 || words.length > 3) return false;
    if (/^(The|A|An)\b/.test(s)) return false;
    if (
      /\b(Christ|Passion|Resurrection|Experience)\b/i.test(s) &&
      !/\bJesus\b/i.test(s)
    ) {
      return false;
    }
    return true;
  });

  if (!people.length) return null;

  // Never return a bare last name — expand known ones
  const counts = new Map<string, number>();
  for (const p of people) {
    const key = p.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const raw = people.find((p) => p.toLowerCase() === best) || people[0];
  if (/^gibson$/i.test(raw)) return "Mel Gibson";
  if (/^rogan$/i.test(raw)) return "Joe Rogan";
  return raw;
}

export function isSinglePersonBeat(text: string): boolean {
  return Boolean(primaryPersonFromText(text));
}

/** Extra negative keywords when searching for a specific person. */
export function personSearchNegatives(personName: string | null | undefined): string {
  const p = (personName || "").toLowerCase();
  if (p.includes("mel gibson")) {
    return (
      "-\"david gibson\" -\"dean gibson\" -\"hutton gibson\" " +
      "-\"andrew garfield\" -garfield -\"hacksaw ridge\" " +
      "-collage -split -\"side by side\" -thumbnail -logo -people.com"
    );
  }
  if (p.includes("joe rogan")) {
    return "-collage -split -thumbnail -logo -meme -\"mel gibson\"";
  }
  if (p.includes("jim caviezel")) {
    return "-ai -generated -creativemarket -watermark -logo";
  }
  return "-collage -split -thumbnail -logo -watermark";
}
