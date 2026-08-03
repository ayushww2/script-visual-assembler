/**
 * Build a photographable Google query for celebrity documentary beats.
 * Avoids memoir/report/book wording that pulls product covers.
 */

const MARILYN_ANGLES = [
  "marilyn monroe portrait",
  "marilyn monroe 1962",
  "marilyn monroe blonde",
  "marilyn monroe studio",
  "marilyn monroe red dress",
  "marilyn monroe candid",
  "marilyn monroe hollywood",
  "marilyn monroe press photo",
];

const FRANK_ANGLES = [
  "frank sinatra portrait",
  "frank sinatra 1960s",
  "frank sinatra singing",
  "frank sinatra tuxedo",
  "frank sinatra candid",
];

const TINA_ANGLES = [
  "tina sinatra portrait",
  "tina sinatra photo",
  "tina sinatra interview",
];

function angle(list: string[], salt: number): string {
  return list[Math.abs(salt) % list.length];
}

/** Short entity-first photo query for one celebrity scene. */
export function buildCelebrityPhotoQuery(
  words: string,
  sceneIndex = 1,
): { query: string; personName: string | null; placeName: string | null } {
  const text = (words || "").trim();
  const lower = text.toLowerCase();
  const salt = sceneIndex + text.length;

  // Places first
  if (/cal[\s-]?neva/i.test(text)) {
    return {
      query: "cal neva lodge lake tahoe",
      personName: null,
      placeName: "Cal Neva Lodge",
    };
  }
  if (/\blake tahoe\b/i.test(text)) {
    return {
      query: "lake tahoe aerial",
      personName: null,
      placeName: "Lake Tahoe",
    };
  }
  if (/\bbrentwood\b/i.test(text)) {
    return {
      query: "marilyn monroe brentwood house",
      personName: null,
      placeName: "Brentwood",
    };
  }

  // People — entity lock by spoken line
  if (
    /\btina sinatra\b/i.test(text) ||
    /sinatra.?s daughter/i.test(text) ||
    /\bfrank sinatra.?s daughter\b/i.test(text)
  ) {
    return {
      query: angle(TINA_ANGLES, salt),
      personName: "Tina Sinatra",
      placeName: null,
    };
  }

  if (/\btony oppedisano\b/i.test(text)) {
    return {
      query: "tony oppedisano frank sinatra",
      personName: "Tony Oppedisano",
      placeName: null,
    };
  }

  if (/\bpeter lawford\b/i.test(text)) {
    return {
      query: "peter lawford 1960s",
      personName: "Peter Lawford",
      placeName: null,
    };
  }

  if (/\brobert kennedy\b|\brfk\b/i.test(text)) {
    return {
      query: "robert kennedy 1962",
      personName: "Robert Kennedy",
      placeName: null,
    };
  }

  if (/\bjohn f\.? kennedy\b|\bjohn kennedy\b|\bjfk\b/i.test(text)) {
    return {
      query: "john f kennedy portrait",
      personName: "John F Kennedy",
      placeName: null,
    };
  }

  if (/\belvis\b/i.test(text) && /\bmarilyn\b/i.test(text)) {
    return {
      query: "elvis presley marilyn monroe",
      personName: "Elvis Presley",
      placeName: null,
    };
  }

  if (/\belvis\b/i.test(text)) {
    return {
      query: "elvis presley 1960s",
      personName: "Elvis Presley",
      placeName: null,
    };
  }

  if (
    /\b(hyman engelberg|ralph greenson|cyril wecht)\b/i.test(text)
  ) {
    if (/engleberg|engelberg/i.test(text)) {
      return {
        query: "hyman engelberg",
        personName: "Hyman Engelberg",
        placeName: null,
      };
    }
    if (/greenson/i.test(text)) {
      return {
        query: "ralph greenson",
        personName: "Ralph Greenson",
        placeName: null,
      };
    }
    return {
      query: "cyril wecht",
      personName: "Cyril Wecht",
      placeName: null,
    };
  }

  // Frank / her father (before bare Marilyn, after Tina)
  if (
    /\bfrank sinatra\b/i.test(text) ||
    (/\bher father\b/i.test(text) && /\b(marilyn|sinatra|tina)\b/i.test(text)) ||
    (/\bfrank\b/i.test(text) && /\bsinatra\b/i.test(text))
  ) {
    if (/\bmarilyn\b/i.test(text)) {
      return {
        query: salt % 2 === 0 ? "frank sinatra marilyn monroe" : angle(FRANK_ANGLES, salt),
        personName: "Frank Sinatra",
        placeName: null,
      };
    }
    return {
      query: angle(FRANK_ANGLES, salt),
      personName: "Frank Sinatra",
      placeName: null,
    };
  }

  if (/\bold hollywood\b|\bclassic hollywood\b|\bhollywood\b/i.test(text) && !/\bmarilyn\b/i.test(text)) {
    return {
      query: "classic hollywood 1950s",
      personName: null,
      placeName: null,
    };
  }

  if (
    /\b(nembutal|barbiturate|chloral|pills|medicine bottles|sedatives)\b/i.test(
      text,
    )
  ) {
    return {
      query: "vintage medicine bottles 1960s",
      personName: null,
      placeName: null,
    };
  }

  if (
    /\b(autopsy|toxicology|coroner|death report|locked bedroom)\b/i.test(text) ||
    /\bmarilyn\b/i.test(text)
  ) {
    return {
      query: angle(MARILYN_ANGLES, salt),
      personName: "Marilyn Monroe",
      placeName: null,
    };
  }

  // Fallback: first proper name span or cleaned words
  const m = text.match(
    /\b([A-Z][a-z]+(?:\s+(?:of|the|and|de|da|van|von))?[\s-]+[A-Z][a-zA-Z'-]+)\b/,
  );
  if (m?.[1] && !/^(That|This|What|When|Where|After|Before)\b/.test(m[1])) {
    const name = m[1].replace(/\s+/g, " ").trim();
    return {
      query: `${name.toLowerCase()} photo`,
      personName: name,
      placeName: null,
    };
  }

  const cleaned = lower
    .replace(
      /\b(memoir|book|report|autopsy|toxicology|coroner|investigation|file|paperback|hardcover)\b/g,
      " ",
    )
    .replace(/[^\w\s'-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");

  return {
    query: cleaned || "classic hollywood photo",
    personName: null,
    placeName: null,
  };
}
