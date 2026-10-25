//! Checks shared by every place that stores text people read: names, titles, descriptions.

/// Characters that change how the text around them is shown without being seen themselves: bidi
/// embeddings, overrides and isolates (which can make a name read backwards), direction marks,
/// the zero-width space, word joiners, invisible operators and the byte order mark. The zero-width
/// joiner and non-joiner stay allowed: Persian, Indic scripts and emoji need them.
pub fn is_invisible_format(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'
            | '\u{200E}'
            | '\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
    )
}

/// The line and paragraph separators: not control characters, but they break a line where
/// text is shown on one, and differently in each place that reads them.
pub fn is_line_separator(c: char) -> bool {
    matches!(c, '\u{2028}' | '\u{2029}')
}

/// The strings the tests of every text check use: each hides a character `is_invisible_format`
/// refuses.
#[cfg(test)]
pub const SNEAKY: &[&str] =
    &["Kal\u{202E}tiz", "Kal\u{2066}zit\u{2069}", "Kal\u{200B}zit", "\u{FEFF}Kalzit", "a\u{200F}b"];
