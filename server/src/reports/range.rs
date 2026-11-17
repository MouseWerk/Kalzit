//! A report's time range, resolved at each run in the report's time zone: `now`, relative times
//! like `now-7d`, rounded ones like `now-1d/d` (the start of yesterday as `from`, its end as `to`),
//! and absolute ISO dates and times. Days, weeks, months and years count on the calendar of the
//! time zone, so `now-1d/d` to `now-1d/d` is yesterday from midnight to midnight, 23 or 25 hours
//! on the days the clocks change. Weeks start on Monday. Fiscal units (`fy`, `fQ`) are not taken.

use chrono::{Datelike, Duration, Months, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Timelike};
use chrono_tz::Tz;

use super::schedule::{Invalid, instant};
use crate::shapes::TimeRange;

fn invalid(reason: &'static str, message: impl Into<String>) -> Invalid {
    Invalid { reason, message: message.into() }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Unit {
    Second,
    Minute,
    Hour,
    Day,
    Week,
    Month,
    Year,
}

fn unit(text: &str) -> Result<(Unit, &str), Invalid> {
    if text.starts_with("fy") || text.starts_with("fQ") {
        return Err(invalid("reports.time_unit_unsupported", "reports do not take fiscal years or quarters"));
    }
    let mut chars = text.chars();
    let u = match chars.next() {
        Some('s') => Unit::Second,
        Some('m') => Unit::Minute,
        Some('h') => Unit::Hour,
        Some('d') => Unit::Day,
        Some('w') => Unit::Week,
        Some('M') => Unit::Month,
        Some('y') => Unit::Year,
        _ => return Err(bad_time(text)),
    };
    Ok((u, chars.as_str()))
}

fn bad_time(text: &str) -> Invalid {
    invalid("reports.time_invalid_range", format!("{text:?} is not a time like now, now-7d, now-1d/d or 2026-11-01"))
}

fn local(ms: i64, zone: Tz) -> Option<NaiveDateTime> {
    zone.timestamp_millis_opt(ms).single().map(|t| t.naive_local())
}

/// `ms` moved by `n` units (negative: back).
fn add(ms: i64, n: i64, u: Unit, zone: Tz) -> Option<i64> {
    match u {
        Unit::Second => ms.checked_add(n.checked_mul(1000)?),
        Unit::Minute => ms.checked_add(n.checked_mul(60_000)?),
        Unit::Hour => ms.checked_add(n.checked_mul(3_600_000)?),
        Unit::Day | Unit::Week => {
            let days = if u == Unit::Week { n.checked_mul(7)? } else { n };
            instant(local(ms, zone)?.checked_add_signed(Duration::days(days))?, zone)
        }
        Unit::Month | Unit::Year => {
            let months = if u == Unit::Year { n.checked_mul(12)? } else { n };
            let at = local(ms, zone)?;
            let shifted = if months >= 0 {
                at.checked_add_months(Months::new(u32::try_from(months).ok()?))?
            } else {
                at.checked_sub_months(Months::new(u32::try_from(-months).ok()?))?
            };
            instant(shifted, zone)
        }
    }
}

/// The start of the unit `ms` lies in, in `zone`.
fn floor(ms: i64, u: Unit, zone: Tz) -> Option<i64> {
    let at = local(ms, zone)?;
    let date = at.date();
    let midnight = |d: NaiveDate| NaiveDateTime::new(d, NaiveTime::MIN);
    let start = match u {
        Unit::Second => at.with_nanosecond(0)?,
        Unit::Minute => at.with_second(0)?.with_nanosecond(0)?,
        Unit::Hour => at.with_minute(0)?.with_second(0)?.with_nanosecond(0)?,
        Unit::Day => midnight(date),
        Unit::Week => midnight(date - Duration::days(i64::from(date.weekday().num_days_from_monday()))),
        Unit::Month => midnight(date.with_day(1)?),
        Unit::Year => midnight(NaiveDate::from_ymd_opt(date.year(), 1, 1)?),
    };
    instant(start, zone)
}

/// One end of a range at `now`: `end` rounds to the end of a unit (`to`), else to its start.
pub fn resolve(text: &str, now: i64, zone: Tz, end: bool) -> Result<i64, Invalid> {
    let text = text.trim();
    let Some(mut rest) = text.strip_prefix("now") else { return absolute(text, zone) };
    let out_of_range = || invalid("reports.time_invalid_range", format!("{text:?} lies outside the calendar"));
    let mut at = now;
    while let Some(sign) = rest.chars().next().filter(|c| *c == '+' || *c == '-') {
        let after_sign = &rest[1..];
        let digits = after_sign.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 || digits > 5 {
            return Err(bad_time(text));
        }
        let n: i64 = after_sign[..digits].parse().map_err(|_| bad_time(text))?;
        let (u, tail) = unit(&after_sign[digits..])?;
        at = add(at, if sign == '-' { -n } else { n }, u, zone).ok_or_else(out_of_range)?;
        rest = tail;
    }
    if let Some(rounding) = rest.strip_prefix('/') {
        let (u, tail) = unit(rounding)?;
        if !tail.is_empty() {
            return Err(bad_time(text));
        }
        let start = floor(at, u, zone).ok_or_else(out_of_range)?;
        at = if end { add(start, 1, u, zone).ok_or_else(out_of_range)? - 1 } else { start };
    } else if !rest.is_empty() {
        return Err(bad_time(text));
    }
    Ok(at)
}

/// `2026-11-01` (midnight in the zone), `2026-11-01T08:00` (in the zone) or a time with its
/// offset (`2026-11-01T08:00:00Z`, `...+01:00`).
fn absolute(text: &str, zone: Tz) -> Result<i64, Invalid> {
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(text) {
        return Ok(t.timestamp_millis());
    }
    if let Ok(d) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return instant(NaiveDateTime::new(d, NaiveTime::MIN), zone).ok_or_else(|| bad_time(text));
    }
    for format in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"] {
        if let Ok(t) = NaiveDateTime::parse_from_str(text, format) {
            return instant(t, zone).ok_or_else(|| bad_time(text));
        }
    }
    Err(bad_time(text))
}

/// Both ends at `now`; `from` must not be after `to`.
pub fn resolve_range(from: &str, to: &str, now: i64, zone: Tz) -> Result<TimeRange, Invalid> {
    let range = TimeRange { from: resolve(from, now, zone, false)?, to: resolve(to, now, zone, true)? };
    if range.from > range.to {
        return Err(invalid("reports.time_range_reversed", "the time range ends before it starts"));
    }
    Ok(range)
}

/// A panel's own time shift (`1d`, `2h`): the range moved back by it, on the zone's calendar.
pub fn shift(range: TimeRange, by: &str, zone: Tz) -> Result<TimeRange, Invalid> {
    let text = by.trim();
    let digits = text.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 || digits > 5 {
        return Err(bad_time(text));
    }
    let n: i64 = text[..digits].parse().map_err(|_| bad_time(text))?;
    let (u, tail) = unit(&text[digits..])?;
    if !tail.is_empty() {
        return Err(bad_time(text));
    }
    let back = |t: i64| add(t, -n, u, zone).ok_or_else(|| bad_time(text));
    Ok(TimeRange { from: back(range.from)?, to: back(range.to)? })
}

#[cfg(test)]
mod tests {
    use super::*;

    const BERLIN: Tz = chrono_tz::Europe::Berlin;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        BERLIN.with_ymd_and_hms(y, mo, d, h, mi, 0).earliest().unwrap().timestamp_millis()
    }

    #[test]
    fn relative_and_rounded_times() {
        let now = at(2026, 11, 14, 9, 30);
        assert_eq!(resolve("now", now, BERLIN, false).unwrap(), now);
        assert_eq!(resolve("now-6h", now, BERLIN, false).unwrap(), now - 6 * 3_600_000);
        assert_eq!(resolve("now/d", now, BERLIN, false).unwrap(), at(2026, 11, 14, 0, 0));
        assert_eq!(resolve("now/d", now, BERLIN, true).unwrap(), at(2026, 11, 15, 0, 0) - 1);
        // 2026-11-14 is a Saturday; weeks start on Monday.
        assert_eq!(resolve("now-1w/w", now, BERLIN, false).unwrap(), at(2026, 11, 2, 0, 0));
        assert_eq!(resolve("now-1M/M", now, BERLIN, false).unwrap(), at(2026, 10, 1, 0, 0));
        assert_eq!(resolve("now-1M/M", now, BERLIN, true).unwrap(), at(2026, 11, 1, 0, 0) - 1);
        assert_eq!(resolve("now/y", now, BERLIN, false).unwrap(), at(2026, 1, 1, 0, 0));
        assert_eq!(resolve("2026-11-01", now, BERLIN, false).unwrap(), at(2026, 11, 1, 0, 0));
        assert_eq!(resolve("2026-11-01T08:00", now, BERLIN, false).unwrap(), at(2026, 11, 1, 8, 0));
        assert_eq!(resolve("2026-11-01T07:00:00Z", now, BERLIN, false).unwrap(), at(2026, 11, 1, 8, 0));
    }

    #[test]
    fn yesterday_has_23_or_25_hours_when_the_clocks_change() {
        let range = |now| resolve_range("now-1d/d", "now-1d/d", now, BERLIN).unwrap();
        let spring = range(at(2026, 3, 30, 9, 0));
        assert_eq!(spring.from, at(2026, 3, 29, 0, 0));
        assert_eq!(spring.to - spring.from + 1, 23 * 3_600_000);
        let autumn = range(at(2026, 10, 26, 9, 0));
        assert_eq!(autumn.to - autumn.from + 1, 25 * 3_600_000);
        // A day back from 09:00 is 09:00 the day before, not 24 hours.
        assert_eq!(resolve("now-1d", at(2026, 3, 30, 9, 0), BERLIN, false).unwrap(), at(2026, 3, 29, 9, 0));
    }

    #[test]
    fn bad_times_are_refused() {
        let now = at(2026, 11, 14, 9, 30);
        for bad in ["yesterday", "now-", "now-6", "now-6x", "now/", "now/dd", "now-1d/d/d", "2026-13-01", "now-123456d"]
        {
            assert_eq!(resolve(bad, now, BERLIN, false).unwrap_err().reason, "reports.time_invalid_range", "{bad}");
        }
        assert_eq!(resolve("now-1fy/fy", now, BERLIN, false).unwrap_err().reason, "reports.time_unit_unsupported");
        assert_eq!(resolve_range("now", "now-1d", now, BERLIN).unwrap_err().reason, "reports.time_range_reversed");
    }

    #[test]
    fn shifts_move_both_ends_back() {
        let r = TimeRange { from: at(2026, 11, 13, 0, 0), to: at(2026, 11, 14, 0, 0) };
        assert_eq!(
            shift(r, "1d", BERLIN).unwrap(),
            TimeRange { from: at(2026, 11, 12, 0, 0), to: at(2026, 11, 13, 0, 0) }
        );
        assert!(shift(r, "d", BERLIN).is_err());
    }
}
