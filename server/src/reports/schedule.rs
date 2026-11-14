//! When a report runs: daily, weekly or monthly at a time of day, or a cron expression with five
//! fields (minute, hour, day of month, month, day of week), always in the report's time zone.
//!
//! Times are local wall-clock times, so a report at 08:00 runs at 08:00 in summer and in winter.
//! When the clocks go forward, a time that does not exist that day (02:30 in Europe/Berlin on the
//! last Sunday of March) runs at the first moment after the gap (03:00); when they go back, a time
//! that happens twice runs once, at its first occurrence. Seconds are not part of a schedule.

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};

/// The shortest time between two runs a schedule may have.
pub const MIN_SPACING_MS: i64 = 15 * 60_000;
/// How far ahead the next run is looked for (a cron expression for the 29th of February runs once
/// in four years, one for the 31st of February never).
const SEARCH_DAYS: i64 = 8 * 366;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Weekday {
    Mon,
    Tue,
    Wed,
    Thu,
    Fri,
    Sat,
    Sun,
}

impl Weekday {
    /// 0 for Sunday to 6 for Saturday, as cron counts.
    fn cron(self) -> u32 {
        match self {
            Weekday::Sun => 0,
            Weekday::Mon => 1,
            Weekday::Tue => 2,
            Weekday::Wed => 3,
            Weekday::Thu => 4,
            Weekday::Fri => 5,
            Weekday::Sat => 6,
        }
    }
}

/// A report's schedule as the API takes it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Schedule {
    /// Every day at `time` (`HH:MM`).
    Daily { time: String },
    /// On the given days of the week at `time`.
    Weekly { time: String, weekdays: Vec<Weekday> },
    /// On `day` (1 to 31) of every month at `time`; in shorter months on their last day.
    Monthly { time: String, day: u32 },
    /// A cron expression with five fields.
    Cron { expression: String },
}

/// Why a schedule is refused: a stable reason and an English message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invalid {
    pub reason: &'static str,
    pub message: String,
}

fn invalid(reason: &'static str, message: impl Into<String>) -> Invalid {
    Invalid { reason, message: message.into() }
}

/// A set of small numbers (minutes, hours, days, months, weekdays) as bits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
struct Bits(u64);

impl Bits {
    fn has(self, n: u32) -> bool {
        n < 64 && self.0 & (1 << n) != 0
    }
    fn add(&mut self, n: u32) {
        self.0 |= 1 << n;
    }
    fn range(from: u32, to: u32) -> Self {
        let mut b = Bits::default();
        for n in from..=to {
            b.add(n);
        }
        b
    }
}

/// A schedule ready to compute runs from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Compiled {
    minutes: Bits,
    hours: Bits,
    days: Bits,
    months: Bits,
    weekdays: Bits,
    /// The day of month field was given (not `*`).
    days_restricted: bool,
    /// The day of week field was given (not `*`).
    weekdays_restricted: bool,
    /// Monthly on a day some months do not have: their last day instead.
    clamp_day: Option<u32>,
}

/// `HH:MM`, 00:00 to 23:59.
fn time_of_day(text: &str) -> Result<(u32, u32), Invalid> {
    let bad = || invalid("reports.time_invalid", format!("{text:?} is not a time of day like 08:00"));
    let (h, m) = text.split_once(':').ok_or_else(bad)?;
    if h.is_empty() || h.len() > 2 || m.len() != 2 || !h.chars().chain(m.chars()).all(|c| c.is_ascii_digit()) {
        return Err(bad());
    }
    let (h, m): (u32, u32) = (h.parse().map_err(|_| bad())?, m.parse().map_err(|_| bad())?);
    if h > 23 || m > 59 {
        return Err(bad());
    }
    Ok((h, m))
}

const MONTH_NAMES: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/// One cron field: `*`, numbers, ranges `a-b`, steps `*/n` and `a-b/n`, lists of those, and for
/// months and weekdays their English three-letter names. Weekday 7 is Sunday, like 0.
fn field(text: &str, min: u32, max: u32, names: &[&str], what: &str) -> Result<(Bits, bool), Invalid> {
    let bad = |detail: &str| {
        invalid("reports.cron_invalid", format!("the {what} field {text:?} of the cron expression {detail}"))
    };
    let value = |s: &str| -> Result<u32, Invalid> {
        let lower = s.to_ascii_lowercase();
        if let Some(i) = names.iter().position(|n| *n == lower) {
            return Ok(u32::try_from(i).unwrap_or(0) + min);
        }
        if s.is_empty() || s.len() > 2 || !s.chars().all(|c| c.is_ascii_digit()) {
            return Err(bad("is not valid"));
        }
        let n: u32 = s.parse().map_err(|_| bad("is not valid"))?;
        // Sunday may be written 7.
        let top = if what == "weekday" { 7 } else { max };
        if n < min || n > top {
            return Err(bad(&format!("must lie within {min} to {top}")));
        }
        Ok(n)
    };
    let mut bits = Bits::default();
    let restricted = text != "*";
    for part in text.split(',') {
        let (span, step) = match part.split_once('/') {
            Some((span, step)) => {
                let step: u32 = step.parse().map_err(|_| bad("has a step that is not a number"))?;
                if step == 0 || step > max {
                    return Err(bad("has a step out of range"));
                }
                (span, step)
            }
            None => (part, 1),
        };
        let (from, to) = if span == "*" {
            (min, max)
        } else if let Some((a, b)) = span.split_once('-') {
            (value(a)?, value(b)?)
        } else {
            let a = value(span)?;
            // `5/15` means from 5 to the end in steps of 15.
            if part.contains('/') { (a, max) } else { (a, a) }
        };
        if from > to {
            return Err(bad("has a range that runs backwards"));
        }
        let mut n = from;
        while n <= to {
            bits.add(if what == "weekday" && n == 7 { 0 } else { n });
            n += step;
        }
    }
    Ok((bits, restricted))
}

impl Schedule {
    /// The schedule checked and ready to compute runs from.
    pub fn compile(&self) -> Result<Compiled, Invalid> {
        let at = |time: &str| -> Result<(Bits, Bits), Invalid> {
            let (h, m) = time_of_day(time)?;
            let (mut hours, mut minutes) = (Bits::default(), Bits::default());
            hours.add(h);
            minutes.add(m);
            Ok((hours, minutes))
        };
        let every = |from, to| Bits::range(from, to);
        Ok(match self {
            Schedule::Daily { time } => {
                let (hours, minutes) = at(time)?;
                Compiled {
                    minutes,
                    hours,
                    days: every(1, 31),
                    months: every(1, 12),
                    weekdays: every(0, 6),
                    days_restricted: false,
                    weekdays_restricted: false,
                    clamp_day: None,
                }
            }
            Schedule::Weekly { time, weekdays } => {
                let (hours, minutes) = at(time)?;
                if weekdays.is_empty() || weekdays.len() > 7 {
                    return Err(invalid("reports.weekdays_invalid", "pick at least one day of the week"));
                }
                let mut days = Bits::default();
                for d in weekdays {
                    days.add(d.cron());
                }
                Compiled {
                    minutes,
                    hours,
                    days: every(1, 31),
                    months: every(1, 12),
                    weekdays: days,
                    days_restricted: false,
                    weekdays_restricted: true,
                    clamp_day: None,
                }
            }
            Schedule::Monthly { time, day } => {
                let (hours, minutes) = at(time)?;
                if !(1..=31).contains(day) {
                    return Err(invalid("reports.day_invalid", "the day of the month must lie within 1 to 31"));
                }
                Compiled {
                    minutes,
                    hours,
                    days: Bits::default(),
                    months: every(1, 12),
                    weekdays: every(0, 6),
                    days_restricted: true,
                    weekdays_restricted: false,
                    clamp_day: Some(*day),
                }
            }
            Schedule::Cron { expression } => {
                let parts: Vec<&str> = expression.split_whitespace().collect();
                if parts.len() != 5 || expression.len() > 200 {
                    return Err(invalid(
                        "reports.cron_invalid",
                        "a cron expression has five fields: minute, hour, day of month, month, day of week",
                    ));
                }
                let (minutes, _) = field(parts[0], 0, 59, &[], "minute")?;
                let (hours, _) = field(parts[1], 0, 23, &[], "hour")?;
                let (days, days_restricted) = field(parts[2], 1, 31, &[], "day of month")?;
                let (months, _) = field(parts[3], 1, 12, &MONTH_NAMES, "month")?;
                let (weekdays, weekdays_restricted) = field(parts[4], 0, 6, &DAY_NAMES, "weekday")?;
                Compiled {
                    minutes,
                    hours,
                    days,
                    months,
                    weekdays,
                    days_restricted,
                    weekdays_restricted,
                    clamp_day: None,
                }
            }
        })
    }
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let next =
        if month == 12 { NaiveDate::from_ymd_opt(year + 1, 1, 1) } else { NaiveDate::from_ymd_opt(year, month + 1, 1) };
    next.and_then(|n| n.pred_opt()).map_or(28, |d| d.day())
}

impl Compiled {
    fn date_matches(&self, date: NaiveDate) -> bool {
        if !self.months.has(date.month()) {
            return false;
        }
        if let Some(day) = self.clamp_day {
            return date.day() == day.min(days_in_month(date.year(), date.month()));
        }
        let dom = self.days.has(date.day());
        let dow = self.weekdays.has(date.weekday().num_days_from_sunday());
        // As cron has it: with both fields given, either one is enough.
        match (self.days_restricted, self.weekdays_restricted) {
            (true, true) => dom || dow,
            _ => dom && dow,
        }
    }

    /// The first run strictly after `after_ms`, in `zone`; `None` when there is none within eight
    /// years.
    pub fn next_after(&self, after_ms: i64, zone: Tz) -> Option<i64> {
        let after = zone.timestamp_millis_opt(after_ms).single()?;
        let first_day = after.date_naive();
        for offset in 0..SEARCH_DAYS {
            let date = first_day.checked_add_signed(Duration::days(offset))?;
            if !self.date_matches(date) {
                continue;
            }
            for hour in (0..24).filter(|h| self.hours.has(*h)) {
                for minute in (0..60).filter(|m| self.minutes.has(*m)) {
                    let local = NaiveDateTime::new(date, NaiveTime::from_hms_opt(hour, minute, 0)?);
                    let at = instant(local, zone)?;
                    if at > after_ms {
                        return Some(at);
                    }
                }
            }
        }
        None
    }
}

/// The moment a local time stands for: the earlier one when the clocks go back, the end of the
/// gap when they go forward.
pub fn instant(local: NaiveDateTime, zone: Tz) -> Option<i64> {
    use chrono::LocalResult;
    match zone.from_local_datetime(&local) {
        LocalResult::Single(t) => Some(t.timestamp_millis()),
        LocalResult::Ambiguous(first, _) => Some(first.timestamp_millis()),
        LocalResult::None => {
            // In the gap: the first minute after it, the one the clocks jumped to. Gaps are at
            // most a few hours.
            (1..=24 * 60).find_map(|m| {
                let later = local.checked_add_signed(Duration::minutes(m))?;
                zone.from_local_datetime(&later).earliest().map(|t| t.timestamp_millis())
            })
        }
    }
}

/// A time zone name, checked.
pub fn zone(name: &str) -> Result<Tz, Invalid> {
    name.parse::<Tz>().map_err(|_| {
        invalid("reports.time_zone_invalid", format!("{name:?} is not a time zone name such as Europe/Berlin"))
    })
}

/// Refuses a schedule that runs more often than every [`MIN_SPACING_MS`] (looked at over its next
/// runs from `now`) or never.
pub fn check_spacing(compiled: &Compiled, zone: Tz, now: i64) -> Result<(), Invalid> {
    let mut last =
        compiled.next_after(now, zone).ok_or_else(|| invalid("reports.schedule_never", "this schedule never runs"))?;
    for _ in 0..48 {
        let Some(next) = compiled.next_after(last, zone) else { break };
        if next - last < MIN_SPACING_MS {
            return Err(invalid(
                "reports.schedule_too_frequent",
                format!("a report runs at most every {} minutes", MIN_SPACING_MS / 60_000),
            ));
        }
        last = next;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const BERLIN: Tz = chrono_tz::Europe::Berlin;
    const NEW_YORK: Tz = chrono_tz::America::New_York;

    fn at(zone: Tz, y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        zone.with_ymd_and_hms(y, mo, d, h, mi, 0).earliest().unwrap().timestamp_millis()
    }

    fn local(zone: Tz, ms: i64) -> String {
        zone.timestamp_millis_opt(ms).unwrap().format("%Y-%m-%d %H:%M %Z").to_string()
    }

    fn runs(s: &Schedule, zone: Tz, from: i64, n: usize) -> Vec<String> {
        let c = s.compile().unwrap();
        let mut out = Vec::new();
        let mut t = from;
        for _ in 0..n {
            t = c.next_after(t, zone).unwrap();
            out.push(local(zone, t));
        }
        out
    }

    #[test]
    fn daily_runs_at_the_same_wall_clock_time_across_the_change_to_summer_time() {
        let s = Schedule::Daily { time: "08:00".into() };
        let from = at(BERLIN, 2026, 3, 27, 12, 0);
        assert_eq!(
            runs(&s, BERLIN, from, 3),
            ["2026-03-28 08:00 CET", "2026-03-29 08:00 CEST", "2026-03-30 08:00 CEST"]
        );
        // 24 hours apart before the change, 23 across it.
        let c = s.compile().unwrap();
        let a = c.next_after(from, BERLIN).unwrap();
        let b = c.next_after(a, BERLIN).unwrap();
        assert_eq!(b - a, 23 * 3_600_000);
    }

    #[test]
    fn a_time_in_the_spring_gap_runs_when_the_gap_ends() {
        let s = Schedule::Daily { time: "02:30".into() };
        let from = at(BERLIN, 2026, 3, 28, 12, 0);
        assert_eq!(runs(&s, BERLIN, from, 2), ["2026-03-29 03:00 CEST", "2026-03-30 02:30 CEST"]);
        // New York goes forward at 02:00 on the second Sunday of March.
        let from = at(NEW_YORK, 2026, 3, 7, 12, 0);
        assert_eq!(runs(&s, NEW_YORK, from, 2), ["2026-03-08 03:00 EDT", "2026-03-09 02:30 EDT"]);
    }

    #[test]
    fn a_time_that_happens_twice_in_autumn_runs_once() {
        let s = Schedule::Daily { time: "02:30".into() };
        let from = at(BERLIN, 2026, 10, 24, 12, 0);
        let got = runs(&s, BERLIN, from, 3);
        assert_eq!(got, ["2026-10-25 02:30 CEST", "2026-10-26 02:30 CET", "2026-10-27 02:30 CET"]);
        // Every quarter hour in the night of the change: the repeated hour is not run again.
        let s = Schedule::Cron { expression: "0,30 1-3 25 10 *".into() };
        let from = at(BERLIN, 2026, 10, 25, 0, 0);
        assert_eq!(
            runs(&s, BERLIN, from, 6)[..6],
            [
                "2026-10-25 01:00 CEST",
                "2026-10-25 01:30 CEST",
                "2026-10-25 02:00 CEST",
                "2026-10-25 02:30 CEST",
                "2026-10-25 03:00 CET",
                "2026-10-25 03:30 CET"
            ]
        );
    }

    #[test]
    fn weekly_and_monthly() {
        let s = Schedule::Weekly { time: "07:15".into(), weekdays: vec![Weekday::Mon, Weekday::Fri] };
        // 2026-11-14 is a Saturday.
        let from = at(BERLIN, 2026, 11, 14, 9, 0);
        assert_eq!(runs(&s, BERLIN, from, 3), ["2026-11-16 07:15 CET", "2026-11-20 07:15 CET", "2026-11-23 07:15 CET"]);
        let s = Schedule::Monthly { time: "06:00".into(), day: 31 };
        let from = at(BERLIN, 2027, 1, 31, 7, 0);
        assert_eq!(
            runs(&s, BERLIN, from, 3),
            ["2027-02-28 06:00 CET", "2027-03-31 06:00 CEST", "2027-04-30 06:00 CEST"],
            "the last day of shorter months"
        );
    }

    #[test]
    fn cron_fields() {
        let s = Schedule::Cron { expression: "*/30 9-10 * * MON-fri".into() };
        let from = at(BERLIN, 2026, 11, 13, 10, 31);
        assert_eq!(runs(&s, BERLIN, from, 3), ["2026-11-16 09:00 CET", "2026-11-16 09:30 CET", "2026-11-16 10:00 CET"]);
        // Day of month and weekday both given: either one.
        let s = Schedule::Cron { expression: "0 12 1 * 0".into() };
        let from = at(chrono_tz::UTC, 2026, 11, 14, 0, 0);
        assert_eq!(
            runs(&s, chrono_tz::UTC, from, 3),
            ["2026-11-15 12:00 UTC", "2026-11-22 12:00 UTC", "2026-11-29 12:00 UTC"]
        );
        // Sunday as 7, February 29.
        let s = Schedule::Cron { expression: "0 0 29 feb *".into() };
        assert_eq!(runs(&s, chrono_tz::UTC, from, 1), ["2028-02-29 00:00 UTC"]);
        let s = Schedule::Cron { expression: "0 0 * * 7".into() };
        assert_eq!(runs(&s, chrono_tz::UTC, from, 1), ["2026-11-15 00:00 UTC"]);
    }

    #[test]
    fn invalid_schedules_are_refused_with_a_reason() {
        let reason = |s: Schedule| s.compile().unwrap_err().reason;
        assert_eq!(reason(Schedule::Daily { time: "24:00".into() }), "reports.time_invalid");
        assert_eq!(reason(Schedule::Daily { time: "8".into() }), "reports.time_invalid");
        assert_eq!(reason(Schedule::Weekly { time: "08:00".into(), weekdays: vec![] }), "reports.weekdays_invalid");
        assert_eq!(reason(Schedule::Monthly { time: "08:00".into(), day: 0 }), "reports.day_invalid");
        for bad in [
            "* * * *",
            "60 * * * *",
            "* 24 * * *",
            "* * 0 * *",
            "* * * 13 *",
            "*/0 * * * *",
            "5-1 * * * *",
            "x * * * *",
        ] {
            assert_eq!(reason(Schedule::Cron { expression: bad.into() }), "reports.cron_invalid", "{bad}");
        }
        assert!(zone("Mars/Olympus").is_err());
        assert!(zone("Europe/Berlin").is_ok());
    }

    #[test]
    fn schedules_that_run_too_often_or_never_are_refused() {
        let now = at(BERLIN, 2026, 11, 14, 9, 0);
        let check = |e: &str| {
            let c = Schedule::Cron { expression: e.into() }.compile().unwrap();
            check_spacing(&c, BERLIN, now).map_err(|e| e.reason)
        };
        assert_eq!(check("* * * * *"), Err("reports.schedule_too_frequent"));
        assert_eq!(check("0,10 * * * *"), Err("reports.schedule_too_frequent"));
        assert_eq!(check("*/15 * * * *"), Ok(()));
        assert_eq!(check("0 0 31 2 *"), Err("reports.schedule_never"));
    }
}
