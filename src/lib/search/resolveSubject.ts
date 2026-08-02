import { primaryPersonFromText } from "@/lib/search/personSubject";
import { primaryPlaceFromText } from "@/lib/search/placeSubject";

/** Resolve Google lock: person XOR place (places never become person locks). */
export function resolveGoogleSubject(
  ...parts: Array<string | null | undefined>
): { personName: string | null; placeName: string | null } {
  const placeName = primaryPlaceFromText(...parts);
  if (placeName) return { personName: null, placeName };
  const personName = primaryPersonFromText(...parts);
  return { personName, placeName: null };
}
