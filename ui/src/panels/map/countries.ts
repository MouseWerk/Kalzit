import { fetchOwnFile } from "../../api/client";
import { OUTLINE_UNITS, OutlineError } from "./outlines";
import { project, type World } from "./projection";

/**
 * The country areas the map fills by country code (`outlines/countries.kzc`), from Natural Earth
 * (public domain), simplified; `scripts/map-countries.mjs` builds the file and describes its
 * format. It ships with Kalzit and loads with the first map that looks codes up; no request
 * leaves the server.
 */

export interface Country {
  /** ISO 3166-1 alpha-2, upper case. */
  alpha2: string;
  /** ISO 3166-1 alpha-3, upper case. */
  alpha3: string;
  /** The middle of its largest part, where a point of the country stands. */
  lat: number;
  lon: number;
  world: World;
  /** Its outer rings as one SVG path, in `OUTLINE_UNITS`. */
  path: string;
}

export interface CountryIndex {
  countries: readonly Country[];
  /** By alpha-2 and alpha-3 code, upper case. */
  byCode: ReadonlyMap<string, Country>;
}

const MAGIC = [0x4b, 0x5a, 0x43, 0x31];

/** Turns a country file into areas with their codes. */
export function decodeCountries(bytes: Uint8Array): CountryIndex {
  if (bytes.length < 12 || MAGIC.some((byte, i) => bytes[i] !== byte)) {
    throw new OutlineError("not a country file");
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const scale = header.getUint32(4, true);
  const count = header.getUint32(8, true);
  let at = 12;
  const byte = (): number => {
    const value = bytes[at++];
    if (value === undefined) {
      throw new OutlineError("the country file ends early");
    }
    return value;
  };
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const next = byte();
      value += (next & 0x7f) * 2 ** shift;
      if (next < 0x80) {
        return value;
      }
      shift += 7;
    }
  };
  const signed = (): number => {
    const value = varint();
    return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
  };
  const ascii = (length: number): string => {
    let text = "";
    for (let i = 0; i < length; i++) text += String.fromCharCode(byte());
    return text;
  };
  const countries: Country[] = [];
  for (let n = 0; n < count; n++) {
    const alpha2 = ascii(2);
    const alpha3 = ascii(3);
    const lon = signed() / scale;
    const lat = signed() / scale;
    const rings = varint();
    let d = "";
    for (let r = 0; r < rings; r++) {
      const points = varint();
      let [stepLon, stepLat] = [0, 0];
      let [lastX, lastY] = [0, 0];
      for (let i = 0; i < points; i++) {
        stepLon += signed();
        stepLat += signed();
        const world = project(stepLat / scale, stepLon / scale);
        const x = Math.round(world.x * OUTLINE_UNITS);
        const y = Math.round(world.y * OUTLINE_UNITS);
        if (i === 0) {
          d += `M${x} ${y}`;
        } else if (x !== lastX || y !== lastY) {
          d += `l${x - lastX} ${y - lastY}`;
        }
        [lastX, lastY] = [x, y];
      }
      d += "Z";
    }
    countries.push({ alpha2, alpha3, lat, lon, world: project(lat, lon), path: d });
  }
  const byCode = new Map<string, Country>();
  for (const country of countries) {
    byCode.set(country.alpha2, country);
    byCode.set(country.alpha3, country);
  }
  return { countries, byCode };
}

let loaded: Promise<CountryIndex> | null = null;

/** The country areas, fetched and decoded once per page. */
export function loadCountries(): Promise<CountryIndex> {
  if (loaded === null) {
    const next = import("./outlines/countries.kzc?url")
      .then((module) => fetchOwnFile(module.default))
      .then((blob) => {
        if (blob === null) {
          throw new OutlineError("the country areas could not be read");
        }
        return blob.arrayBuffer();
      })
      .then((buffer) => decodeCountries(new Uint8Array(buffer)));
    // A failed load is tried again by the next map.
    next.catch(() => {
      loaded = null;
    });
    loaded = next;
  }
  return loaded;
}

/**
 * Codes people use that are not the ISO code of the country they mean. Offered as a suggestion,
 * never applied silently: a click adds the pair to the layer's own list.
 */
const KNOWN_ALIASES: Readonly<Record<string, string>> = {
  UK: "GB",
  EL: "GR",
  ENG: "GB",
  SCO: "GB",
  WAL: "GB",
  GER: "DE",
  SUI: "CH",
  NED: "NL",
  POR: "PT",
  DEN: "DK",
};

/** Ordinary text of a key for comparing: no case, no accents, no surrounding space. */
function plain(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toUpperCase();
}

/**
 * The country a key that is not a code probably means: a known alias (`UK`) or the country's
 * name in English or German ("Germany", "Deutschland"). Null when nothing fits.
 */
export function suggestCountry(key: string, index: CountryIndex): Country | null {
  const wanted = plain(key);
  const alias = KNOWN_ALIASES[wanted];
  if (alias !== undefined) {
    return index.byCode.get(alias) ?? null;
  }
  if (wanted.length < 4) {
    return null;
  }
  for (const language of ["en", "de"]) {
    const names = regionNames(language);
    if (names === null) continue;
    for (const country of index.countries) {
      const name = names.of(country.alpha2);
      if (name !== undefined && plain(name) === wanted) {
        return country;
      }
    }
  }
  return null;
}

const displayNames = new Map<string, Intl.DisplayNames | null>();

function regionNames(language: string): Intl.DisplayNames | null {
  let names = displayNames.get(language);
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([language], { type: "region", fallback: "none" });
    } catch {
      names = null;
    }
    displayNames.set(language, names);
  }
  return names;
}

/** The country's name in the UI language, else its code. */
export function countryName(alpha2: string, language: string): string {
  return regionNames(language)?.of(alpha2) ?? alpha2;
}

/** Whether a text has the form of a country code: two or three letters. */
export function looksLikeCode(value: unknown): value is string {
  return typeof value === "string" && /^\s*[A-Za-z]{2,3}\s*$/.test(value);
}
