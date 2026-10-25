//! What `build.rs` needs to turn a build's inputs into the commit and date shown in Settings,
//! About. Shared with the library only for its tests (build scripts have none of their own).

/// The civil date (`YYYY-MM-DD`) of a Unix time in seconds.
pub fn date_of(secs: u64) -> String {
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// A commit id: 7 to 40 hexadecimal digits.
pub fn valid_commit(value: &str) -> bool {
    (7..=40).contains(&value.len()) && value.chars().all(|c| c.is_ascii_hexdigit())
}

/// A date as `YYYY-MM-DD` with a real month and a day that month can have.
pub fn valid_date(value: &str) -> bool {
    let b = value.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let digits = |r: std::ops::Range<usize>| value.get(r).filter(|s| s.chars().all(|c| c.is_ascii_digit()));
    let (Some(y), Some(m), Some(d)) = (digits(0..4), digits(5..7), digits(8..10)) else { return false };
    let (y, m, d): (u32, u32, u32) = (y.parse().unwrap_or(0), m.parse().unwrap_or(0), d.parse().unwrap_or(0));
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    y >= 1970 && (1..=days).contains(&d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_follow_the_calendar() {
        assert_eq!(date_of(0), "1970-01-01");
        // 2024-02-29 00:00:00 UTC, a leap day.
        assert_eq!(date_of(1_709_164_800), "2024-02-29");
        // 2026-10-25 12:00:00 UTC.
        assert_eq!(date_of(1_792_929_600), "2026-10-25");
        assert_eq!(date_of(86_399), "1970-01-01");
        assert_eq!(date_of(86_400), "1970-01-02");
    }

    #[test]
    fn commits_and_dates_are_checked() {
        assert!(valid_commit("c3c564de9"));
        assert!(!valid_commit("abc"));
        assert!(!valid_commit("c3c564dez"));
        assert!(!valid_commit(&"a".repeat(41)));
        assert!(valid_date("2026-10-25"));
        assert!(valid_date("2024-02-29"));
        assert!(!valid_date("2026-02-29"));
        assert!(!valid_date("2026-13-01"));
        assert!(!valid_date("2026-1-01"));
        assert!(!valid_date("26-10-25"));
        assert!(!valid_date("2026-10-25 "));
        assert!(!valid_date("1969-12-31"));
    }
}
