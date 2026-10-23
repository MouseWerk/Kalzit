//! The pattern syntax both sides accept: what the Rust `regex` crate (here) and re2js (the UI,
//! `ui/src/panels/fieldConfig/patternSyntax.ts`) both compile and read alike. Each engine refuses
//! some forms the other takes, and a few forms both take with different meanings (class set
//! operations, nested classes, word-edge escapes); those are refused on both sides, so what the
//! editor accepts the server stores and the other way round. `pattern_fixture.json` holds the
//! cases both tests check; keep the two files in step.

/// Unicode names `\p{...}` may use: the ones both engines know, spelled exactly.
const PROPERTY_NAMES: &[&str] = &[
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
];
/// One-letter categories in the short form `\pL`.
const PROPERTY_LETTERS: &[u8] = b"LMNPSZC";
/// Largest repeat count, and largest product of nested counts; RE2 refuses more.
const MAX_REPEAT: u32 = 1000;
/// Unicode-wide atoms (`\d`, `\w`, `\s`, `\p{...}`, `.`, classes holding one of them) cost this
/// engine far more than a letter. At most this many of them, counting repeats, so the compiled
/// size never refuses a pattern the syntax allows.
const MAX_WIDE: u64 = 100;

/// Index after a `\p` property starting at `i` (just after p or P), or `None` when refused.
fn property(p: &str, i: usize) -> Option<usize> {
    let b = p.as_bytes();
    if b.get(i) == Some(&b'{') {
        let end = i + p[i..].find('}')?;
        return PROPERTY_NAMES.contains(&&p[i + 1..end]).then_some(end + 1);
    }
    b.get(i).filter(|c| PROPERTY_LETTERS.contains(c)).map(|_| i + 1)
}

/// A repeat `{n}`, `{n,}` or `{n,m}` at `i`: its length and counts, or `None` when the brace
/// starts no repeat (then it is a literal).
fn repeat_at(p: &str, i: usize) -> Option<(usize, Option<u32>, Option<u32>)> {
    let rest = &p[i + 1..];
    let close = rest.find('}')?;
    let inner = &rest[..close];
    let (low, high) = match inner.split_once(',') {
        Some((low, high)) => (low, Some(high)),
        None => (inner, None),
    };
    let digits = |s: &str| s.bytes().all(|c| c.is_ascii_digit());
    if !digits(low) || !high.is_none_or(digits) {
        return None;
    }
    // Counts too long for a number are over the limit anyway.
    let count = |s: &str| if s.is_empty() { None } else { Some(s.parse().unwrap_or(u32::MAX)) };
    Some((close + 2, count(low), high.and_then(count)))
}

/// One group level: wide atoms counted so far, the deepest count product, the last atom.
#[derive(Default)]
struct Level {
    wide: u64,
    product: u64,
    last: Option<(u64, u64)>,
}

impl Level {
    fn new() -> Self {
        Level { wide: 0, product: 1, last: None }
    }

    fn flush(&mut self) {
        if let Some((wide, product)) = self.last.take() {
            self.wide += wide;
            self.product = self.product.max(product);
        }
    }

    fn atom(&mut self, wide: u64, product: u64) {
        self.flush();
        self.last = Some((wide, product));
    }

    /// Applies a count to the last atom; false when the counts grow past the limits.
    fn counted(&mut self, count: u64) -> bool {
        match self.last.as_mut() {
            Some((wide, product)) => {
                *wide = wide.saturating_mul(count);
                *product = product.saturating_mul(count);
                *product <= u64::from(MAX_REPEAT)
            }
            None => true,
        }
    }
}

/// Whether the pattern uses a form outside the syntax both engines share.
pub fn refused_syntax(p: &str) -> bool {
    let b = p.as_bytes();
    let mut levels = vec![Level::new()];
    let mut i = 0;
    let mut in_class = false;
    let mut class_start = 0;
    let mut class_wide = false;
    // 0: no repeat just before; 1: after a repeat; 2: after a lazy repeat (`*?`).
    let mut repeat = 0;
    macro_rules! top {
        () => {
            levels.last_mut().expect("the outer level stays")
        };
    }
    while i < b.len() {
        let c = b[i];
        if c == b'\\' {
            let Some(&e) = b.get(i + 1) else { return true };
            if matches!(e, b'Q' | b'u' | b'<' | b'>') || e.is_ascii_digit() {
                return true;
            }
            if matches!(e, b'b' | b'B') && b.get(i + 2) == Some(&b'{') {
                return true;
            }
            if matches!(e, b'p' | b'P') {
                let Some(next) = property(p, i + 2) else { return true };
                i = next;
            } else if e == b'x' && b.get(i + 2) == Some(&b'{') {
                let Some(end) = p[i..].find('}') else { return true };
                i += end + 1;
            } else {
                // The escaped character may take several bytes; step over all of them.
                i += 1 + p[i + 1..].chars().next().map_or(1, char::len_utf8);
            }
            let wide = b"dDwWsSpP".contains(&e);
            // A class escape cannot start a range: [\d-z] is an error in one engine only.
            if in_class && wide && b.get(i) == Some(&b'-') && b.get(i + 1) != Some(&b']') {
                return true;
            }
            if in_class {
                class_wide |= wide;
            } else {
                repeat = 0;
                top!().atom(u64::from(wide), 1);
            }
            continue;
        }
        if in_class {
            if c == b']' && i > class_start {
                in_class = false;
                repeat = 0;
                top!().atom(u64::from(class_wide), 1);
                i += 1;
                continue;
            }
            if c == b'[' {
                if b.get(i + 1) != Some(&b':') {
                    return true;
                }
                let Some(end) = p[i + 2..].find(":]") else { return true };
                i += 2 + end + 2;
                continue;
            }
            if matches!(c, b'&' | b'~' | b'-') && b.get(i + 1) == Some(&c) {
                return true;
            }
            i += 1;
            continue;
        }
        match c {
            b'[' => {
                in_class = true;
                class_wide = false;
                i += 1;
                if b.get(i) == Some(&b'^') {
                    i += 1;
                }
                class_start = i;
            }
            b'(' => {
                if b.get(i + 1) == Some(&b'?') && !group_start_ok(&p[i + 2..]) {
                    return true;
                }
                top!().flush();
                levels.push(Level::new());
                repeat = 0;
                i += 1;
            }
            b')' if levels.len() > 1 => {
                let mut inner = levels.pop().expect("more than one level");
                inner.flush();
                top!().atom(inner.wide, inner.product);
                repeat = 0;
                i += 1;
            }
            b'*' | b'+' => {
                if repeat != 0 {
                    return true;
                }
                repeat = 1;
                i += 1;
            }
            b'?' => {
                if repeat == 2 {
                    return true;
                }
                repeat = if repeat == 1 { 2 } else { 1 };
                i += 1;
            }
            b'{' if repeat_at(p, i).is_some() => {
                let Some((len, low, high)) = repeat_at(p, i) else { return true };
                let Some(low) = low else { return true };
                let most = high.unwrap_or(low).max(low);
                if low > MAX_REPEAT || most > MAX_REPEAT || repeat != 0 || !top!().counted(u64::from(most)) {
                    return true;
                }
                repeat = 1;
                i += len;
            }
            _ => {
                repeat = 0;
                top!().atom(u64::from(c == b'.'), 1);
                i += 1;
            }
        }
    }
    while levels.len() > 1 {
        let mut inner = levels.pop().expect("more than one level");
        inner.flush();
        top!().atom(inner.wide, inner.product);
    }
    let outer = top!();
    outer.flush();
    outer.wide > MAX_WIDE
}

/// `(?:`, `(?P<name>`, `(?<name>` and flag groups of i, m, s and U; nothing else.
fn group_start_ok(rest: &str) -> bool {
    if rest.starts_with(':') || rest.starts_with("P<") {
        return true;
    }
    if let Some(name) = rest.strip_prefix('<') {
        return name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_');
    }
    let flags = rest.bytes().take_while(|c| matches!(c, b'i' | b'm' | b's' | b'U' | b'-')).count();
    flags > 0 && matches!(rest.as_bytes().get(flags), Some(b':' | b')'))
}
