/**
 * The pattern syntax both sides accept: what re2js (here) and the Rust `regex` crate (the
 * server, `dashboards/pattern_syntax.rs`) both compile and read alike. Each engine refuses some
 * forms the other takes, and a few forms both take with different meanings (class set
 * operations, nested classes, word-edge escapes); those are refused here, on both sides, so a
 * pattern the editor accepts is one the server stores and the other way round. The shared
 * fixture `server/src/dashboards/pattern_fixture.json` holds the cases both tests check.
 */

/** Unicode names `\p{...}` may use: the ones both engines know, spelled exactly. */
const PROPERTY_NAMES = new Set([
  "ASCII_Hex_Digit",
  "Adlam",
  "Ahom",
  "Alphabetic",
  "Anatolian_Hieroglyphs",
  "Any",
  "Arabic",
  "Armenian",
  "Avestan",
  "Balinese",
  "Bamum",
  "Bassa_Vah",
  "Batak",
  "Bengali",
  "Bhaiksuki",
  "Bopomofo",
  "Brahmi",
  "Braille",
  "Buginese",
  "Buhid",
  "C",
  "Canadian_Aboriginal",
  "Carian",
  "Caucasian_Albanian",
  "Cc",
  "Cf",
  "Chakma",
  "Cham",
  "Cherokee",
  "Chorasmian",
  "Cn",
  "Co",
  "Common",
  "Coptic",
  "Cuneiform",
  "Cypriot",
  "Cypro_Minoan",
  "Cyrillic",
  "Dash",
  "Deseret",
  "Devanagari",
  "Dives_Akuru",
  "Dogra",
  "Duployan",
  "Egyptian_Hieroglyphs",
  "Elbasan",
  "Elymaic",
  "Emoji",
  "Emoji_Component",
  "Emoji_Modifier",
  "Emoji_Modifier_Base",
  "Emoji_Presentation",
  "Ethiopic",
  "Extended_Pictographic",
  "Garay",
  "Georgian",
  "Glagolitic",
  "Gothic",
  "Grantha",
  "Greek",
  "Gujarati",
  "Gunjala_Gondi",
  "Gurmukhi",
  "Gurung_Khema",
  "Han",
  "Hangul",
  "Hanifi_Rohingya",
  "Hanunoo",
  "Hatran",
  "Hebrew",
  "Hex_Digit",
  "Hiragana",
  "Imperial_Aramaic",
  "Inherited",
  "Inscriptional_Pahlavi",
  "Inscriptional_Parthian",
  "Javanese",
  "Kaithi",
  "Kannada",
  "Katakana",
  "Kawi",
  "Kayah_Li",
  "Kharoshthi",
  "Khitan_Small_Script",
  "Khmer",
  "Khojki",
  "Khudawadi",
  "Kirat_Rai",
  "L",
  "LC",
  "Lao",
  "Latin",
  "Lepcha",
  "Limbu",
  "Linear_A",
  "Linear_B",
  "Lisu",
  "Ll",
  "Lm",
  "Lo",
  "Lowercase",
  "Lt",
  "Lu",
  "Lycian",
  "Lydian",
  "M",
  "Mahajani",
  "Makasar",
  "Malayalam",
  "Mandaic",
  "Manichaean",
  "Marchen",
  "Masaram_Gondi",
  "Math",
  "Mc",
  "Me",
  "Medefaidrin",
  "Meetei_Mayek",
  "Mende_Kikakui",
  "Meroitic_Cursive",
  "Meroitic_Hieroglyphs",
  "Miao",
  "Mn",
  "Modi",
  "Mongolian",
  "Mro",
  "Multani",
  "Myanmar",
  "N",
  "Nabataean",
  "Nag_Mundari",
  "Nandinagari",
  "Nd",
  "New_Tai_Lue",
  "Newa",
  "Nko",
  "Nl",
  "No",
  "Nushu",
  "Nyiakeng_Puachue_Hmong",
  "Ogham",
  "Ol_Chiki",
  "Ol_Onal",
  "Old_Hungarian",
  "Old_Italic",
  "Old_North_Arabian",
  "Old_Permic",
  "Old_Persian",
  "Old_Sogdian",
  "Old_South_Arabian",
  "Old_Turkic",
  "Old_Uyghur",
  "Oriya",
  "Osage",
  "Osmanya",
  "P",
  "Pahawh_Hmong",
  "Palmyrene",
  "Pau_Cin_Hau",
  "Pc",
  "Pd",
  "Pe",
  "Pf",
  "Phags_Pa",
  "Phoenician",
  "Pi",
  "Po",
  "Ps",
  "Psalter_Pahlavi",
  "Quotation_Mark",
  "Rejang",
  "Runic",
  "S",
  "Samaritan",
  "Saurashtra",
  "Sc",
  "Sharada",
  "Shavian",
  "Siddham",
  "SignWriting",
  "Sinhala",
  "Sk",
  "Sm",
  "So",
  "Sogdian",
  "Sora_Sompeng",
  "Soyombo",
  "Sundanese",
  "Sunuwar",
  "Syloti_Nagri",
  "Syriac",
  "Tagalog",
  "Tagbanwa",
  "Tai_Le",
  "Tai_Tham",
  "Tai_Viet",
  "Takri",
  "Tamil",
  "Tangsa",
  "Tangut",
  "Telugu",
  "Terminal_Punctuation",
  "Thaana",
  "Thai",
  "Tibetan",
  "Tifinagh",
  "Tirhuta",
  "Todhri",
  "Toto",
  "Tulu_Tigalari",
  "Ugaritic",
  "Uppercase",
  "Vai",
  "Vithkuqi",
  "Wancho",
  "Warang_Citi",
  "White_Space",
  "Yezidi",
  "Yi",
  "Z",
  "Zanabazar_Square",
  "Zl",
  "Zp",
  "Zs",
]);
/** One-letter categories in the short form `\pL`. */
const PROPERTY_LETTERS = "LMNPSZC";
/** Largest repeat count; RE2 refuses more. */
const MAX_REPEAT = 1000;

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}

/** Index after a `\\p` property starting at `i` (just after p or P), or -1 when refused. */
function property(p: string, i: number): number {
  if (p[i] === "{") {
    const end = p.indexOf("}", i);
    return end !== -1 && PROPERTY_NAMES.has(p.slice(i + 1, end)) ? end + 1 : -1;
  }
  const letter = p[i];
  return letter !== undefined && PROPERTY_LETTERS.includes(letter) ? i + 1 : -1;
}

/** Whether the pattern uses a form outside the syntax both engines share. */
export function refusedSyntax(p: string): boolean {
  let i = 0;
  let inClass = false;
  let classStart = 0;
  // 0: no repeat just before; 1: after a repeat; 2: after a lazy repeat (`*?`).
  let repeat = 0;
  while (i < p.length) {
    const c = p[i] as string;
    if (c === "\\") {
      const e = p[i + 1];
      if (e === undefined) return true;
      if (e === "Q" || e === "u" || e === "<" || e === ">" || isDigit(e)) return true;
      if ((e === "b" || e === "B") && p[i + 2] === "{") return true;
      if (e === "p" || e === "P") {
        const next = property(p, i + 2);
        if (next === -1) return true;
        i = next;
      } else if (e === "x" && p[i + 2] === "{") {
        const end = p.indexOf("}", i);
        if (end === -1) return true;
        i = end + 1;
      } else {
        i += 2;
      }
      // A class escape cannot start a range: [\d-z] is an error in one engine only.
      if (inClass && "dwsDWSpP".includes(e) && p[i] === "-" && p[i + 1] !== "]") return true;
      if (!inClass) repeat = 0;
      continue;
    }
    if (inClass) {
      if (c === "]" && i > classStart) {
        inClass = false;
        repeat = 0;
        i++;
        continue;
      }
      if (c === "[") {
        if (p[i + 1] !== ":") return true;
        const end = p.indexOf(":]", i + 2);
        if (end === -1) return true;
        i = end + 2;
        continue;
      }
      if ((c === "&" || c === "~" || c === "-") && p[i + 1] === c) return true;
      i++;
      continue;
    }
    if (c === "[") {
      inClass = true;
      i++;
      if (p[i] === "^") i++;
      classStart = i;
      continue;
    }
    if (c === "(") {
      if (p[i + 1] === "?") {
        const rest = p.slice(i + 2);
        if (!/^(:|P<|<[A-Za-z_]|[imsU-]+[:)])/.test(rest)) return true;
      }
      repeat = 0;
      i++;
      continue;
    }
    if (c === "*" || c === "+") {
      if (repeat !== 0) return true;
      repeat = 1;
      i++;
      continue;
    }
    if (c === "?") {
      if (repeat === 2) return true;
      repeat = repeat === 1 ? 2 : 1;
      i++;
      continue;
    }
    if (c === "{") {
      const m = /^\{(\d*)(?:,(\d*))?\}/.exec(p.slice(i));
      if (m !== null) {
        if (m[1] === "") return true;
        const counts = [m[1], m[2]].filter((n) => n !== undefined && n !== "").map(Number);
        if (counts.some((n) => n > MAX_REPEAT) || repeat !== 0) return true;
        repeat = 1;
        i += m[0].length;
        continue;
      }
    }
    repeat = 0;
    i++;
  }
  return false;
}
