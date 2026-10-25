//! The vetted customization of the UI's look: accent colors, density, base font size and the
//! sign-in texts. Customization goes through these options only, never custom CSS (owner
//! decision). The UI mirrors the contrast rules in `ui/src/appearance/contrast.ts`; both run the
//! cases of `CASES` in their tests.

/// Accent colors the UI defines for every scheme in its design tokens; `copper` is Kalzit's own.
pub const ACCENTS: &[&str] = &["copper", "blue", "teal", "green", "violet", "rose", "amber", "graphite"];

pub const DENSITIES: &[&str] = &["compact", "balanced", "comfortable"];

/// Pages a member can land on when they enter Kalzit and have no start dashboard of their own.
pub const START_PAGES: &[&str] = &["home", "dashboards", "explore"];

/// Body text sizes in pixels the UI offers (14 is the design's default).
pub const FONT_SIZES: &[i64] = &[13, 14, 15, 16];

/// The darkest and lightest surfaces of the light and dark themes (`--bg-surface` dark,
/// `--bg-raised` light), as WCAG relative luminance. A custom accent sits on all of them, so it is
/// checked against the extremes. The UI test pins these to the design tokens.
pub const LIGHT_SURFACE_LUMINANCE: f64 = 1.0;
pub const DARK_SURFACE_LUMINANCE: f64 = 0.00481;
/// The two label colors a custom accent can carry: white and the near-black of the dark scheme's
/// primary button label (`--on-accent` dark).
pub const LIGHT_LABEL_LUMINANCE: f64 = 1.0;
pub const DARK_LABEL_LUMINANCE: f64 = 0.00579;

/// Meaningful non-text UI (the primary button fill against the page): WCAG 1.4.11.
pub const MIN_UI_CONTRAST: f64 = 3.0;
/// Text on the accent (the primary button's label): WCAG 1.4.3.
pub const MIN_TEXT_CONTRAST: f64 = 4.5;

/// `#rrggbb` (lower or upper case) as linear-light channels.
pub fn parse_hex(value: &str) -> Option<[f64; 3]> {
    let hex = value.strip_prefix('#')?;
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |i: usize| -> Option<f64> {
        let byte = u8::from_str_radix(&hex[i..i + 2], 16).ok()?;
        let c = f64::from(byte) / 255.0;
        Some(if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) })
    };
    Some([channel(0)?, channel(2)?, channel(4)?])
}

/// WCAG 2 relative luminance.
pub fn luminance(rgb: [f64; 3]) -> f64 {
    0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

pub fn contrast(one: f64, two: f64) -> f64 {
    let (light, dark) = if one > two { (one, two) } else { (two, one) };
    (light + 0.05) / (dark + 0.05)
}

/// What a custom accent color reaches; the UI shows the same numbers next to the color picker.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AccentCheck {
    /// Against the lightest surface of the light theme.
    pub on_light: f64,
    /// Against the darkest surface of the dark theme.
    pub on_dark: f64,
    /// The better of the two label colors on the accent.
    pub label: f64,
    /// Whether that better label is the dark one.
    pub dark_label: bool,
}

impl AccentCheck {
    pub fn passes(&self) -> bool {
        self.on_light >= MIN_UI_CONTRAST && self.on_dark >= MIN_UI_CONTRAST && self.label >= MIN_TEXT_CONTRAST
    }
}

pub fn check_accent(hex: &str) -> Option<AccentCheck> {
    let l = luminance(parse_hex(hex)?);
    let light_label = contrast(l, LIGHT_LABEL_LUMINANCE);
    let dark_label = contrast(l, DARK_LABEL_LUMINANCE);
    Some(AccentCheck {
        on_light: contrast(l, LIGHT_SURFACE_LUMINANCE),
        on_dark: contrast(l, DARK_SURFACE_LUMINANCE),
        label: light_label.max(dark_label),
        dark_label: dark_label > light_label,
    })
}

/// An accent setting: a vetted name, or `#rrggbb` that keeps 3:1 against the surfaces of both
/// themes and 4.5:1 for its label.
pub fn validate_accent(value: &str) -> Result<(), String> {
    if ACCENTS.contains(&value) {
        return Ok(());
    }
    let Some(check) = check_accent(value) else {
        return Err(format!("the accent must be one of {} or a color as #rrggbb", ACCENTS.join(", ")));
    };
    if check.passes() {
        return Ok(());
    }
    Err(format!(
        "the color {value} has too little contrast: {:.2}:1 on light and {:.2}:1 on dark surfaces (at least \
         {MIN_UI_CONTRAST}:1), {:.2}:1 for the label on it (at least {MIN_TEXT_CONTRAST}:1)",
        check.on_light, check.on_dark, check.label
    ))
}

/// Text an admin writes for the sign-in page or as the product name: no control characters except
/// line breaks where `multiline`, at most `max_chars`, not only white space when `required`.
/// The UI renders it as plain text with a few Markdown marks (emphasis, links), never as HTML.
pub fn validate_text(value: &str, max_chars: usize, multiline: bool, required: bool) -> Result<(), String> {
    if required && value.trim().is_empty() {
        return Err("the text must not be empty".into());
    }
    if value.chars().count() > max_chars {
        return Err(format!("the text takes at most {max_chars} characters"));
    }
    if value.chars().any(crate::text::is_invisible_format) {
        return Err("the text contains invisible direction or format characters".into());
    }
    if value.chars().any(|c| c.is_control() && !(multiline && (c == '\n' || c == '\r' || c == '\t'))) {
        return Err(if multiline {
            "the text contains control characters".into()
        } else {
            "the text must be a single line without control characters".into()
        });
    }
    Ok(())
}

/// The cases both sides run: color, whether it passes, and the label it gets.
#[cfg(test)]
const CASES: &[(&str, bool, bool)] = &[
    ("#2563eb", true, false),
    ("#0f766e", true, false),
    ("#1e3a8a", false, false),
    ("#7c3aed", true, false),
    ("#e5534b", true, true),
    ("#ffffff", false, true),
    ("#000000", false, false),
    ("#808080", true, true),
    ("#ffd400", false, true),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vetted_names_pass_and_free_colors_are_checked() {
        for name in ACCENTS {
            assert!(validate_accent(name).is_ok(), "{name}");
        }
        for bad in ["", "red", "#12345", "#1234567", "#gg0000", "rgb(0,0,0)", "copper "] {
            assert!(validate_accent(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn contrast_matches_known_ratios() {
        assert!((contrast(1.0, 0.0) - 21.0).abs() < 1e-9);
        assert!((contrast(0.5, 0.5) - 1.0).abs() < 1e-9);
        let white = luminance(parse_hex("#FFFFFF").unwrap());
        assert!((white - 1.0).abs() < 1e-9);
        // #767676 is the classic 4.54:1 grey on white.
        let grey = luminance(parse_hex("#767676").unwrap());
        assert!((contrast(grey, white) - 4.54).abs() < 0.01);
    }

    #[test]
    fn the_shared_cases_hold() {
        for (hex, passes, dark_label) in CASES {
            let check = check_accent(hex).unwrap();
            assert_eq!(check.passes(), *passes, "{hex}: {check:?}");
            assert_eq!(check.dark_label, *dark_label, "{hex}: {check:?}");
            assert_eq!(validate_accent(hex).is_ok(), *passes, "{hex}");
        }
        let message = validate_accent("#ffffff").unwrap_err();
        assert!(message.contains("1.00:1 on light"), "{message}");
    }

    #[test]
    fn texts_are_bounded_and_free_of_control_characters() {
        assert!(validate_text("Kalzit", 40, false, true).is_ok());
        assert!(validate_text("  ", 40, false, true).is_err());
        assert!(validate_text("", 280, true, false).is_ok());
        assert!(validate_text("Zeile 1\nZeile 2", 280, true, false).is_ok());
        assert!(validate_text("Zeile 1\nZeile 2", 40, false, true).is_err());
        assert!(validate_text("a\u{0007}b", 280, true, false).is_err());
        assert!(validate_text(&"ä".repeat(41), 40, false, true).is_err());
        assert!(validate_text(&"ä".repeat(40), 40, false, true).is_ok());
        for sneaky in crate::text::SNEAKY {
            assert!(validate_text(sneaky, 40, false, true).is_err(), "{sneaky:?}");
            assert!(validate_text(sneaky, 280, true, false).is_err(), "{sneaky:?}");
        }
        // Visible letters of any script stay allowed.
        assert!(validate_text("Datenwerk – شركة 数据", 40, false, true).is_ok());
        assert!(validate_text("می\u{200C}خواهم", 40, false, true).is_ok(), "Persian needs the non-joiner");
    }
}
