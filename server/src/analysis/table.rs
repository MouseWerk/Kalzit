//! The table steps that arrange a frame without new arithmetic: organize, filter fields and
//! rows, limit, convert types, reduce series, stack tables and turn series into rows
//! (docs/api/settings-dashboards.md, "Analysis steps"). The UI runs the same steps in
//! `ui/src/analysis/steps.ts`; both pass the cases of `conformance.json`.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use regex::{Regex, RegexBuilder};
use serde_json::Value;

use super::calculations;
use super::expr::{self, number_text};
use super::steps::{
    Control, NamedFrame, agg_type, detail, field_index, first_time_field, frame_of, int_of, is_time, key_of, new_field,
    num_value, number_at, position, text_units, type_name, wrong_type,
};
use super::{Agg, Conversion, ConvertTo, KeepDrop, LimitFrom, MatchMode, ReduceMode, RowCondition, RowOp};
use crate::datasources::detail::Detail;
use crate::shapes::{Field, FieldType, Frame, FrameMeta};

/// Rows a step that puts tables together may make.
pub const MAX_RESULT_ROWS: usize = 500_000;
/// Memory a compiled regular expression may take.
const PATTERN_SIZE_LIMIT: usize = 1 << 20;

fn is_numeric(t: FieldType) -> bool {
    matches!(t, FieldType::Number | FieldType::Int64 | FieldType::Decimal)
}

/// A field with the same name, type, unit and labels and other values.
fn copy_with(f: &Field, values: Vec<Value>) -> Field {
    Field { name: f.name.clone(), field_type: f.field_type, unit: f.unit.clone(), values, labels: f.labels.clone() }
}

/// The rows `rows` of every field of `frame`, in that order.
fn take_rows(frame: &Frame, rows: &[usize]) -> Result<Frame, Detail> {
    let fields = frame.fields().iter().map(|f| copy_with(f, rows.iter().map(|&r| f.values[r].clone()).collect()));
    frame_of(fields.collect(), frame.meta())
}

/// Characters a pattern may escape with a backslash (inside a class `-` too).
const ESCAPABLE: &str = "^$\\.*+?()[]{}|/";
/// The largest count a `{n,m}` may name.
const MAX_REPEAT: u32 = 1000;
/// Characters of a cell or field name that `matches` and **filterFields** read; the rest is
/// passed over, so that a pattern takes bounded time in the browser.
pub const MAX_MATCH_CHARS: usize = 150;
/// Characters a pattern may have.
const MAX_PATTERN_CHARS: usize = 2000;
/// Repetitions (`*`, `+`, `?`, `{n,}`, `{n,m}` with m > 1) a pattern may hold besides a leading
/// or trailing `.*`; each one multiplies the work of backtracking by the length of the text.
const MAX_QUANTIFIERS: u32 = 2;
/// Ways through the alternatives of groups a pattern without repetitions may have, and what each
/// repetition divides that by.
const MAX_PATHS: u64 = 4096;
const QUANTIFIER_PATHS: u64 = 64;
/// Size a pattern may expand to (a character its UTF-8 bytes, a class or `.` 40, repeated by its
/// count), which keeps the compiled expression under half of `PATTERN_SIZE_LIMIT`.
const MAX_WEIGHT: u64 = 16_000;
const CLASS_WEIGHT: u64 = 40;
/// What `.` stands for: any character but a line end, as JavaScript reads it.
const DOT: &str = r"[^\r\n\x{2028}\x{2029}]";

/// `pattern` without a leading or trailing `.*` (or `.*?`), which change nothing for a pattern
/// found anywhere in the text.
fn trim_wildcards(mut pattern: &str) -> &str {
    while let Some(rest) = pattern.strip_prefix(".*?").or_else(|| pattern.strip_prefix(".*")) {
        pattern = rest;
    }
    while let Some(rest) = pattern.strip_suffix(".*?").or_else(|| pattern.strip_suffix(".*")) {
        // A `.` after an odd number of backslashes is escaped.
        if rest.bytes().rev().take_while(|b| *b == b'\\').count() % 2 == 1 {
            break;
        }
        pattern = rest;
    }
    pattern
}

/// An open group while a pattern is read; the whole pattern first.
struct OpenGroup {
    /// Whether its body holds a quantifier.
    quantified: bool,
    /// Whether a group inside it holds a `|`.
    alternation: bool,
    /// Its alternatives (`|` plus one).
    branches: u64,
    weight: u64,
}

impl OpenGroup {
    fn new() -> Self {
        Self { quantified: false, alternation: false, branches: 1, weight: 0 }
    }
}

/// What a quantifier would apply to.
#[derive(Clone, Copy)]
struct Item {
    weight: u64,
    quantified: bool,
    alternation: bool,
}

/// Whether `pattern` keeps to the subset of regular expressions both engines read the same and
/// run in bounded time: literals, `.`, `^`, `$`, `|`, `(...)`, classes `[...]` with ranges,
/// `*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}` (each optionally lazy) and backslash escapes of the
/// special characters. No lookaround, backreferences, inline flags or named groups (`(?`), no
/// letter escapes (`\d`, `\w`, `\b`, ...), no class set operations, and no quantified group that
/// holds a quantifier (`(a+)+`) or a `|` (`(a|aa)+`), which take exponential time in the browser.
/// Besides a leading or trailing `.*` at most `MAX_QUANTIFIERS` repetitions, fewer alternatives
/// the more repetitions there are, and at most `MAX_PATTERN_CHARS` characters
/// (docs/api/settings-dashboards.md, **filterFields**).
pub fn safe_pattern(pattern: &str) -> bool {
    pattern.chars().count() <= MAX_PATTERN_CHARS && safe_body(trim_wildcards(pattern))
}

fn safe_body(pattern: &str) -> bool {
    let c: Vec<char> = pattern.chars().collect();
    let mut groups = vec![OpenGroup::new()];
    let mut last: Option<Item> = None;
    let mut quantifiers = 0u32;
    let mut paths = 1u64;
    let atom = |top: &mut OpenGroup, weight: u64| {
        top.weight = top.weight.saturating_add(weight);
        Some(Item { weight, quantified: false, alternation: false })
    };
    let mut i = 0;
    while i < c.len() {
        let Some(top) = groups.last_mut() else { return false };
        match c[i] {
            '\\' => {
                if !c.get(i + 1).is_some_and(|n| ESCAPABLE.contains(*n)) {
                    return false;
                }
                last = atom(top, 1);
                i += 2;
                continue;
            }
            '(' => {
                if c.get(i + 1) == Some(&'?') {
                    return false;
                }
                groups.push(OpenGroup::new());
                last = None;
            }
            ')' => {
                if groups.len() == 1 {
                    return false;
                }
                let Some(inner) = groups.pop() else { return false };
                if inner.branches > 1 {
                    paths = paths.saturating_mul(inner.branches);
                }
                let item = Item {
                    weight: inner.weight,
                    quantified: inner.quantified,
                    alternation: inner.alternation || inner.branches > 1,
                };
                if let Some(top) = groups.last_mut() {
                    top.weight = top.weight.saturating_add(item.weight);
                    top.quantified |= item.quantified;
                    top.alternation |= item.alternation;
                }
                last = Some(item);
            }
            '|' => {
                top.branches += 1;
                last = None;
            }
            '^' | '$' => last = None,
            '}' | ']' => return false,
            '[' => {
                i += 1;
                if c.get(i) == Some(&'^') {
                    i += 1;
                }
                if c.get(i) == Some(&']') {
                    return false;
                }
                loop {
                    match c.get(i) {
                        None | Some('[') => return false,
                        Some(']') => break,
                        Some('\\') => {
                            if !c.get(i + 1).is_some_and(|n| *n == '-' || ESCAPABLE.contains(*n)) {
                                return false;
                            }
                            i += 2;
                        }
                        Some(ch @ ('&' | '-' | '~')) if c.get(i + 1) == Some(ch) => return false,
                        Some(_) => i += 1,
                    }
                }
                last = atom(top, CLASS_WEIGHT);
            }
            '.' => last = atom(top, CLASS_WEIGHT),
            q @ ('*' | '+' | '?' | '{') => {
                // Whether it counts as a repetition, and how many copies of its item it makes.
                let (counted, copies) = if q == '{' {
                    let Some(end) = c[i..].iter().position(|x| *x == '}').map(|e| i + e) else { return false };
                    let body: String = c[i + 1..end].iter().collect();
                    let open = body.ends_with(',');
                    let (n, m) = body.split_once(',').unwrap_or((&body, &body));
                    let number = |t: &str| {
                        (!t.is_empty() && t.len() <= 4 && t.bytes().all(|b| b.is_ascii_digit()))
                            .then(|| t.parse::<u32>().ok())
                            .flatten()
                    };
                    let Some(n) = number(n) else { return false };
                    let m = if m.is_empty() { Some(n) } else { number(m) };
                    let Some(m) = m.filter(|m| *m >= n && *m <= MAX_REPEAT) else { return false };
                    i = end;
                    if open { (true, u64::from(n) + 1) } else { (m > 1, u64::from(m.max(1))) }
                } else {
                    (true, 1)
                };
                let Some(item) = last else { return false };
                if item.quantified || item.alternation {
                    return false;
                }
                top.weight = top.weight.saturating_add(item.weight.saturating_mul(copies - 1));
                top.quantified = true;
                if counted {
                    quantifiers += 1;
                }
                last = None;
                if c.get(i + 1) == Some(&'?') {
                    i += 1;
                }
            }
            ch => last = atom(top, ch.len_utf8() as u64),
        }
        i += 1;
    }
    groups.len() == 1
        && quantifiers <= MAX_QUANTIFIERS
        && paths.saturating_mul(QUANTIFIER_PATHS.saturating_pow(quantifiers)) <= MAX_PATHS
        && groups[0].weight <= MAX_WEIGHT
}

/// The text the engine compiles for a pattern `safe_pattern` took: without a leading or
/// trailing `.*`, and `.` as `DOT`.
fn engine_source(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len());
    let mut chars = trim_wildcards(pattern).chars();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => {
                out.push(ch);
                out.extend(chars.next());
            }
            '[' => {
                out.push(ch);
                while let Some(x) = chars.next() {
                    out.push(x);
                    if x == '\\' {
                        out.extend(chars.next());
                    } else if x == ']' {
                        break;
                    }
                }
            }
            '.' => out.push_str(DOT),
            _ => out.push(ch),
        }
    }
    out
}

/// The first `MAX_MATCH_CHARS` characters of `text`, which a pattern reads.
pub fn match_head(text: &str) -> &str {
    text.char_indices().nth(MAX_MATCH_CHARS).map_or(text, |(at, _)| &text[..at])
}

/// A regular expression over field names or cell text, found anywhere in their first
/// `MAX_MATCH_CHARS` characters, in the subset `safe_pattern` allows.
pub fn field_pattern(pattern: &str) -> Result<Regex, Detail> {
    let refused = || {
        detail("steps.pattern", format!("{pattern} is no regular expression this step can read"))
            .with("pattern", pattern)
    };
    if !safe_pattern(pattern) {
        return Err(refused());
    }
    RegexBuilder::new(&engine_source(pattern)).size_limit(PATTERN_SIZE_LIMIT).build().map_err(|_| refused())
}

// ---- organize and filter fields ----

pub fn organize(
    frame: &Frame,
    order: &[String],
    hide: &[String],
    rename: &BTreeMap<String, String>,
) -> Result<Frame, Detail> {
    let fields = frame.fields();
    let mut placed = vec![false; fields.len()];
    let mut picked: Vec<usize> = Vec::with_capacity(fields.len());
    for name in order {
        for (i, f) in fields.iter().enumerate() {
            if !placed[i] && &f.name == name {
                placed[i] = true;
                picked.push(i);
            }
        }
    }
    picked.extend((0..fields.len()).filter(|i| !placed[*i]));
    let hidden: BTreeSet<&str> = hide.iter().map(String::as_str).collect();
    // Each field with whether `rename` gave it its name.
    let out: Vec<(Field, bool)> = picked
        .into_iter()
        .filter(|&i| !hidden.contains(fields[i].name.as_str()))
        .map(|i| {
            let f = &fields[i];
            let mut field = copy_with(f, f.values.clone());
            let renamed = match rename.get(&f.name) {
                Some(to) if to != &f.name => {
                    field.name.clone_from(to);
                    true
                }
                _ => false,
            };
            (field, renamed)
        })
        .collect();
    // A new name may not be one another field keeps; fields that already shared a name may.
    for (i, (f, renamed)) in out.iter().enumerate() {
        if *renamed && out.iter().enumerate().any(|(j, (g, _))| j != i && g.name == f.name) {
            return Err(
                detail("steps.name_taken", format!("a field is already named {}", f.name)).with("name", &f.name)
            );
        }
    }
    frame_of(out.into_iter().map(|(f, _)| f).collect(), frame.meta())
}

pub fn filter_fields(frame: &Frame, mode: KeepDrop, names: &[String], pattern: Option<&str>) -> Result<Frame, Detail> {
    let regex = pattern.map(field_pattern).transpose()?;
    let fields = frame
        .fields()
        .iter()
        .filter(|f| {
            let hit = names.contains(&f.name) || regex.as_ref().is_some_and(|r| r.is_match(match_head(&f.name)));
            hit == (mode == KeepDrop::Keep)
        })
        .cloned()
        .collect();
    frame_of(fields, frame.meta())
}

// ---- filter rows ----

/// A cell as text for `contains` and `matches`: times and days in ISO 8601, the rest as groups
/// compare them.
fn cell_text(v: &Value, t: FieldType) -> Option<String> {
    match t {
        FieldType::Time => number_at(v).map(|ms| expr::iso_time(ms.floor() as i64)),
        FieldType::Date => number_at(v).map(|ms| expr::iso_time(ms.floor() as i64)[..10].to_string()),
        _ => key_of(v, t),
    }
}

fn is_empty_cell(v: &Value) -> bool {
    v.is_null() || v.as_str() == Some("")
}

/// A condition ready to test cells of its field.
enum Test {
    Empty,
    NotEmpty,
    Number(RowOp, f64, f64),
    /// An int64 field against whole numbers: compared exactly.
    Int(RowOp, i128, i128),
    Text(RowOp, String, String),
    Bool(RowOp, bool),
    Contains(String),
    Matches(Regex),
}

fn value_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.as_f64().map(number_text).unwrap_or_default(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

fn bad_value(field: &Field, v: &Value) -> Detail {
    let text = value_text(v);
    detail("steps.filter_value", format!("{text} cannot be compared with field {}", field.name))
        .with("field", &field.name)
        .with("value", text)
}

/// A condition's value as a number for a field of numbers or times: a number, number text, or
/// for times ISO 8601 text.
fn number_value(field: &Field, v: &Value) -> Result<f64, Detail> {
    let n = match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => expr::parse_number(s)
            .or_else(|| if is_time(field.field_type) { parse_time(s, None).map(|ms| ms as f64) } else { None }),
        _ => None,
    };
    n.ok_or_else(|| bad_value(field, v))
}

fn prepare(field: &Field, c: &RowCondition) -> Result<Test, Detail> {
    let t = field.field_type;
    let value = c.value.as_ref().unwrap_or(&Value::Null);
    let to = c.to.as_ref().unwrap_or(&Value::Null);
    Ok(match c.op {
        RowOp::Empty => Test::Empty,
        RowOp::NotEmpty => Test::NotEmpty,
        _ if t == FieldType::Json => return Err(wrong_type(field)),
        RowOp::Contains => Test::Contains(value_text(value)),
        RowOp::Matches => Test::Matches(field_pattern(&value_text(value))?),
        op if t == FieldType::Int64 && int_of(value).is_some() && (op != RowOp::Between || int_of(to).is_some()) => {
            Test::Int(op, int_of(value).unwrap_or(0), int_of(to).unwrap_or(0))
        }
        op if is_numeric(t) || is_time(t) => {
            let b = if op == RowOp::Between { number_value(field, to)? } else { 0.0 };
            Test::Number(op, number_value(field, value)?, b)
        }
        op if t == FieldType::String => Test::Text(op, value_text(value), value_text(to)),
        op @ (RowOp::Eq | RowOp::Ne) => match value {
            Value::Bool(b) => Test::Bool(op, *b),
            Value::String(s) if s == "true" || s == "false" => Test::Bool(op, s == "true"),
            _ => return Err(bad_value(field, value)),
        },
        _ => return Err(wrong_type(field)),
    })
}

fn compare(op: RowOp, ord: Option<Ordering>, upper: Option<Ordering>) -> bool {
    match (op, ord) {
        (RowOp::Ne, None) => true,
        (_, None) => false,
        (RowOp::Eq, Some(o)) => o == Ordering::Equal,
        (RowOp::Ne, Some(o)) => o != Ordering::Equal,
        (RowOp::Gt, Some(o)) => o == Ordering::Greater,
        (RowOp::Gte, Some(o)) => o != Ordering::Less,
        (RowOp::Lt, Some(o)) => o == Ordering::Less,
        (RowOp::Lte, Some(o)) => o != Ordering::Greater,
        (RowOp::Between, Some(o)) => o != Ordering::Less && upper.is_some_and(|u| u != Ordering::Greater),
        _ => false,
    }
}

fn passes(test: &Test, v: &Value, t: FieldType) -> bool {
    match test {
        Test::Empty => is_empty_cell(v),
        Test::NotEmpty => !is_empty_cell(v),
        Test::Contains(s) => cell_text(v, t).is_some_and(|c| c.contains(s.as_str())),
        Test::Matches(r) => cell_text(v, t).is_some_and(|c| r.is_match(match_head(&c))),
        Test::Number(op, a, b) => {
            let x = number_at(v);
            compare(*op, x.and_then(|x| x.partial_cmp(a)), x.and_then(|x| x.partial_cmp(b)))
        }
        Test::Int(op, a, b) => {
            let x = int_of(v);
            compare(*op, x.map(|x| x.cmp(a)), x.map(|x| x.cmp(b)))
        }
        Test::Text(op, a, b) => {
            let x = v.as_str();
            compare(*op, x.map(|x| x.cmp(a.as_str())), x.map(|x| x.cmp(b.as_str())))
        }
        Test::Bool(op, b) => compare(*op, v.as_bool().map(|x| x.cmp(b)), None),
    }
}

pub fn filter_rows(
    frame: &Frame,
    mode: KeepDrop,
    match_: MatchMode,
    conditions: &[RowCondition],
    control: &Control,
) -> Result<Frame, Detail> {
    let tests: Vec<(&Field, Test)> = conditions
        .iter()
        .map(|c| {
            let f = &frame.fields()[field_index(frame, &c.field)?];
            Ok((f, prepare(f, c)?))
        })
        .collect::<Result<_, Detail>>()?;
    let mut rows = Vec::new();
    for row in 0..frame.rows() {
        control.every(row)?;
        let hit = |(f, test): &(&Field, Test)| passes(test, &f.values[row], f.field_type);
        let matched = match match_ {
            MatchMode::All => tests.iter().all(hit),
            MatchMode::Any => tests.iter().any(hit),
        };
        if matched == (mode == KeepDrop::Keep) {
            rows.push(row);
        }
    }
    take_rows(frame, &rows)
}

// ---- limit ----

pub fn limit(frame: &Frame, count: u32, from: LimitFrom) -> Result<Frame, Detail> {
    let n = frame.rows();
    let keep = (count as usize).min(n);
    let rows: Vec<usize> = match from {
        LimitFrom::First => (0..keep).collect(),
        LimitFrom::Last => (n - keep..n).collect(),
    };
    take_rows(frame, &rows)
}

// ---- convert ----

/// Characters of the longest text read as a time.
const MAX_TIME_CHARS: usize = 64;

/// Text read as a time, in ms (UTC unless the text names an offset): ISO 8601 without `format`
/// (`2026-01-31`, `2026-01-31T08:15`, `2026-01-31 08:15:00.250+01:00`), else by `format` with
/// the parts `YYYY`, `MM`, `DD`, `HH`, `mm`, `ss`, `SSS` (each with exactly that many digits)
/// and any other character as itself. `None` when the text does not fit or names no real time.
pub fn parse_time(text: &str, format: Option<&str>) -> Option<i64> {
    let s: Vec<char> = text.trim_matches(|c: char| c.is_ascii_whitespace()).chars().collect();
    // No time is written in more characters; longer text is not read at all.
    if s.len() > MAX_TIME_CHARS {
        return None;
    }
    let mut p = Parts { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, ms: 0, offset_min: 0 };
    let ok = match format {
        Some(f) => p.by_format(&s, &f.chars().collect::<Vec<_>>()),
        None => p.iso(&s),
    };
    if !ok
        || !(1..=12).contains(&p.month)
        || p.day < 1
        || p.day > expr::days_in_month(p.year, p.month)
        || p.hour > 23
        || p.minute > 59
        || p.second > 59
    {
        return None;
    }
    let ms = expr::days_from_civil(p.year, p.month, p.day) * 86_400_000
        + p.hour * 3_600_000
        + p.minute * 60_000
        + p.second * 1000
        + p.ms
        - p.offset_min * 60_000;
    ((expr::MIN_TIME_MS as i64)..=(expr::MAX_TIME_MS as i64)).contains(&ms).then_some(ms)
}

struct Parts {
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    ms: i64,
    offset_min: i64,
}

/// `n` digits at `at`, as a number.
fn digits(s: &[char], at: usize, n: usize) -> Option<i64> {
    let part = s.get(at..at + n)?;
    part.iter().all(char::is_ascii_digit).then(|| part.iter().fold(0, |acc, c| acc * 10 + (*c as i64 - '0' as i64)))
}

impl Parts {
    fn iso(&mut self, s: &[char]) -> bool {
        let (Some(y), Some(m), Some(d)) = (digits(s, 0, 4), digits(s, 5, 2), digits(s, 8, 2)) else { return false };
        if s.get(4) != Some(&'-') || s.get(7) != Some(&'-') {
            return false;
        }
        (self.year, self.month, self.day) = (y, m, d);
        if s.len() == 10 {
            return true;
        }
        if !matches!(s.get(10), Some('T' | 't' | ' ')) {
            return false;
        }
        let (Some(h), Some(mi)) = (digits(s, 11, 2), digits(s, 14, 2)) else { return false };
        if s.get(13) != Some(&':') {
            return false;
        }
        (self.hour, self.minute) = (h, mi);
        let mut at = 16;
        if s.get(at) == Some(&':') {
            let Some(sec) = digits(s, at + 1, 2) else { return false };
            self.second = sec;
            at += 3;
            if s.get(at) == Some(&'.') {
                let start = at + 1;
                let mut end = start;
                while end < s.len() && s[end].is_ascii_digit() && end - start < 9 {
                    end += 1;
                }
                if end == start {
                    return false;
                }
                let mut fraction: String = s[start..end.min(start + 3)].iter().collect();
                while fraction.len() < 3 {
                    fraction.push('0');
                }
                self.ms = fraction.parse().unwrap_or(0);
                at = end;
            }
        }
        match s.get(at) {
            None => true,
            Some('Z' | 'z') => at + 1 == s.len(),
            Some(sign @ ('+' | '-')) => {
                let Some(oh) = digits(s, at + 1, 2) else { return false };
                let rest = &s[at + 3..];
                let om = match rest {
                    [] => 0,
                    [':', a, b] | [a, b] => match digits(&[*a, *b], 0, 2) {
                        Some(m) => m,
                        None => return false,
                    },
                    _ => return false,
                };
                if oh > 23 || om > 59 {
                    return false;
                }
                self.offset_min = (oh * 60 + om) * if *sign == '-' { -1 } else { 1 };
                true
            }
            _ => false,
        }
    }

    fn by_format(&mut self, s: &[char], f: &[char]) -> bool {
        const TOKENS: [&str; 7] = ["YYYY", "SSS", "MM", "DD", "HH", "mm", "ss"];
        let (mut i, mut at) = (0, 0);
        while i < f.len() {
            let token = TOKENS.iter().find(|t| f[i..].iter().take(t.len()).copied().eq(t.chars()));
            match token {
                Some(t) => {
                    let Some(n) = digits(s, at, t.len()) else { return false };
                    match *t {
                        "YYYY" => self.year = n,
                        "SSS" => self.ms = n,
                        "MM" => self.month = n,
                        "DD" => self.day = n,
                        "HH" => self.hour = n,
                        "mm" => self.minute = n,
                        _ => self.second = n,
                    }
                    i += t.len();
                    at += t.len();
                }
                None => {
                    if s.get(at) != Some(&f[i]) {
                        return false;
                    }
                    i += 1;
                    at += 1;
                }
            }
        }
        at == s.len()
    }
}

/// A number as a time cell: whole ms within the years 1 to 9999, else empty.
fn time_cell(x: Option<f64>) -> Value {
    match x {
        Some(ms) if ms.is_finite() && (expr::MIN_TIME_MS..=expr::MAX_TIME_MS).contains(&ms.floor()) => {
            Value::from(ms.floor() as i64)
        }
        _ => Value::Null,
    }
}

/// Text read as true or false: `true`, `false`, `1`, `0` in any case, spaces around allowed.
fn bool_of_text(s: &str) -> Option<bool> {
    match s.trim_matches(|c: char| c.is_ascii_whitespace()).to_ascii_lowercase().as_str() {
        "true" | "1" => Some(true),
        "false" | "0" => Some(false),
        _ => None,
    }
}

fn converted(f: &Field, c: &Conversion, control: &Control) -> Result<Field, Detail> {
    use FieldType::*;
    let from = f.field_type;
    let (to, values): (FieldType, Vec<Value>) = match (c.to, from) {
        (ConvertTo::Number, Json) | (ConvertTo::String, Json) | (ConvertTo::Time, Bool | Json) => {
            return Err(wrong_type(f));
        }
        (ConvertTo::Bool, Time | Date | Json) => return Err(wrong_type(f)),
        (ConvertTo::Number, Number)
        | (ConvertTo::String, String)
        | (ConvertTo::Time, Time)
        | (ConvertTo::Bool, Bool) => {
            return Ok(f.clone());
        }
        (ConvertTo::Number, Bool) => (Number, f.values.iter().map(|v| num_value(v.as_bool().map(f64::from))).collect()),
        (ConvertTo::Number, _) => (Number, f.values.iter().map(|v| num_value(number_at(v))).collect()),
        (ConvertTo::String, t) => {
            let mut out = Vec::with_capacity(f.values.len());
            for v in &f.values {
                let text = match t {
                    Number => number_at(v).map(number_text),
                    Bool => v.as_bool().map(|b| b.to_string()),
                    _ => cell_text(v, t),
                };
                let cell = text.map_or(Value::Null, Value::String);
                control.spend_text(text_units(&cell))?;
                out.push(cell);
            }
            (String, out)
        }
        (ConvertTo::Time, String) => {
            let format = c.format.as_deref();
            (
                Time,
                f.values
                    .iter()
                    .map(|v| v.as_str().and_then(|s| parse_time(s, format)).map_or(Value::Null, Value::from))
                    .collect(),
            )
        }
        (ConvertTo::Time, _) => (Time, f.values.iter().map(|v| time_cell(number_at(v))).collect()),
        (ConvertTo::Bool, String) => (
            Bool,
            f.values.iter().map(|v| v.as_str().and_then(bool_of_text).map_or(Value::Null, Value::Bool)).collect(),
        ),
        (ConvertTo::Bool, _) => {
            (Bool, f.values.iter().map(|v| number_at(v).map_or(Value::Null, |x| Value::Bool(x != 0.0))).collect())
        }
    };
    Ok(Field {
        name: f.name.clone(),
        field_type: to,
        unit: if to == Number { f.unit.clone() } else { None },
        values,
        labels: f.labels.clone(),
    })
}

pub fn convert(frame: &Frame, conversions: &[Conversion], control: &Control) -> Result<Frame, Detail> {
    let mut fields = frame.fields().to_vec();
    for c in conversions {
        control.check()?;
        let i = field_index(frame, &c.field)?;
        fields[i] = converted(&frame.fields()[i], c, control)?;
    }
    frame_of(fields, frame.meta())
}

// ---- reduce ----

/// The unit all `fields` share, if they share one.
fn shared_unit<'a>(mut fields: impl Iterator<Item = &'a Field>) -> Option<String> {
    let first = fields.next()?.unit.clone()?;
    fields.all(|f| f.unit.as_deref() == Some(first.as_str())).then_some(first)
}

pub fn reduce_series(
    frame: &Frame,
    mode: ReduceMode,
    ops: &[Agg],
    names: &[String],
    control: &Control,
) -> Result<Frame, Detail> {
    let fields: Vec<&Field> = if names.is_empty() {
        frame.fields().iter().filter(|f| is_numeric(f.field_type)).collect()
    } else {
        names.iter().map(|n| field_index(frame, n).map(|i| &frame.fields()[i])).collect::<Result<_, _>>()?
    };
    let all: Vec<usize> = (0..frame.rows()).collect();
    match mode {
        ReduceMode::Rows => {
            for f in &fields {
                if !is_numeric(f.field_type) {
                    return Err(wrong_type(f));
                }
            }
            control.cells(fields.len(), ops.len() + 1)?;
            let mut out = vec![new_field(
                "field",
                FieldType::String,
                fields.iter().map(|f| Value::from(f.name.as_str())).collect(),
            )];
            let unit = shared_unit(fields.iter().copied());
            for op in ops {
                control.check()?;
                let mut values = Vec::with_capacity(fields.len());
                for f in &fields {
                    control.check()?;
                    values.push(num_value(number_at(&calculations::aggregate(f, *op, &all))));
                }
                let mut field = new_field(&op.name(), FieldType::Number, values);
                if *op != Agg::Count {
                    field.unit.clone_from(&unit);
                }
                out.push(field);
            }
            frame_of(out, frame.meta())
        }
        ReduceMode::Columns => {
            control.cells(1, fields.len() * ops.len())?;
            let mut out = Vec::with_capacity(fields.len() * ops.len());
            for f in &fields {
                control.check()?;
                for op in ops {
                    control.check()?;
                    let t = agg_type(f, *op)?;
                    let name = if ops.len() == 1 { f.name.clone() } else { format!("{}({})", op.name(), f.name) };
                    out.push(Field {
                        name,
                        field_type: t,
                        unit: if *op == Agg::Count { None } else { f.unit.clone() },
                        values: vec![calculations::aggregate(f, *op, &all)],
                        labels: f.labels.clone(),
                    });
                }
            }
            frame_of(out, frame.meta())
        }
    }
}

// ---- stack and series to rows ----

/// The metas of several frames as one: truncated when one is, all notices in order.
fn joined_meta<'a>(metas: impl Iterator<Item = Option<&'a FrameMeta>>) -> Option<FrameMeta> {
    let mut out: Option<FrameMeta> = None;
    for m in metas.flatten() {
        let o = out.get_or_insert_with(FrameMeta::default);
        o.rows_truncated |= m.rows_truncated;
        o.notices.extend(m.notices.iter().cloned());
    }
    out
}

/// The places of `names` among `frames`, each checked.
fn places(frames: &[NamedFrame], names: &[String]) -> Result<Vec<usize>, Detail> {
    names.iter().map(|n| position(frames, n)).collect()
}

/// Puts `frame` at the place of the first of `at` and takes out the others.
fn replace(frames: &mut Vec<NamedFrame>, at: &[usize], frame: Frame) {
    frames[at[0]].frame = frame;
    let mut gone: Vec<usize> = at[1..].to_vec();
    gone.sort_unstable_by(|a, b| b.cmp(a));
    for i in gone {
        frames.remove(i);
    }
}

fn too_many_rows() -> Detail {
    detail("steps.result_rows", format!("the step would make more than {MAX_RESULT_ROWS} rows"))
        .with("max", MAX_RESULT_ROWS)
}

pub fn stack(frames: &mut Vec<NamedFrame>, names: &[String], control: &Control) -> Result<(), Detail> {
    let at = places(frames, names)?;
    // The fields of all tables by name, in the order they first appear.
    let mut fields: Vec<Field> = Vec::new();
    for &i in &at {
        let frame = &frames[i].frame;
        for f in frame.fields() {
            field_index(frame, &f.name)?;
            match fields.iter_mut().find(|g| g.name == f.name) {
                Some(g) if g.field_type != f.field_type => {
                    return Err(detail(
                        "steps.stack_types",
                        format!(
                            "field {} is {} in one table and {} in another",
                            f.name,
                            type_name(g.field_type),
                            type_name(f.field_type)
                        ),
                    )
                    .with("field", &f.name)
                    .with("first", type_name(g.field_type))
                    .with("other", type_name(f.field_type)));
                }
                Some(g) => {
                    if g.unit != f.unit {
                        g.unit = None;
                    }
                    if g.labels != f.labels {
                        g.labels = None;
                    }
                }
                None => fields.push(copy_with(f, Vec::new())),
            }
        }
    }
    let rows: usize = at.iter().map(|&i| frames[i].frame.rows()).sum();
    if rows > MAX_RESULT_ROWS {
        return Err(too_many_rows());
    }
    control.cells(rows, fields.len())?;
    let mut text = 0;
    for &i in &at {
        control.check()?;
        let frame = &frames[i].frame;
        for g in &mut fields {
            match frame.fields().iter().find(|f| f.name == g.name) {
                Some(f) => {
                    text += f.values.iter().map(text_units).sum::<usize>();
                    g.values.extend(f.values.iter().cloned());
                }
                None => g.values.extend(std::iter::repeat_n(Value::Null, frame.rows())),
            }
        }
    }
    control.spend_text(text)?;
    let meta = joined_meta(at.iter().map(|&i| frames[i].frame.meta()));
    let stacked = frame_of(fields, meta.as_ref())?;
    replace(frames, &at, stacked);
    Ok(())
}

/// A series' name: the field's name and its labels, as `cpu{host="a", zone="b"}`.
fn metric_name(f: &Field) -> String {
    match &f.labels {
        Some(labels) if !labels.is_empty() => {
            let inner: Vec<String> = labels.iter().map(|(k, v)| format!("{k}=\"{v}\"")).collect();
            format!("{}{{{}}}", f.name, inner.join(", "))
        }
        _ => f.name.clone(),
    }
}

pub fn series_to_rows(frames: &mut Vec<NamedFrame>, names: &[String], control: &Control) -> Result<(), Detail> {
    let at = places(frames, names)?;
    // (time, metric, value), in the order of the tables, their rows and their fields.
    let mut entries: Vec<(f64, usize, f64)> = Vec::new();
    let mut metrics: Vec<String> = Vec::new();
    let mut value_fields: Vec<&Field> = Vec::new();
    for &i in &at {
        let nf = &frames[i];
        let t = first_time_field(nf)?;
        let times = &nf.frame.fields()[t].values;
        let series: Vec<(usize, &Field)> = nf
            .frame
            .fields()
            .iter()
            .enumerate()
            .filter(|(j, f)| *j != t && is_numeric(f.field_type))
            .map(|(_, f)| {
                metrics.push(metric_name(f));
                value_fields.push(f);
                (metrics.len() - 1, f)
            })
            .collect();
        for (row, time) in times.iter().enumerate() {
            control.every(row)?;
            let Some(time) = number_at(time) else { continue };
            for (metric, f) in &series {
                if let Some(v) = number_at(&f.values[row]) {
                    entries.push((time, *metric, v));
                    if entries.len() > MAX_RESULT_ROWS {
                        return Err(too_many_rows());
                    }
                }
            }
        }
    }
    control.cells(entries.len(), 3)?;
    entries.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(Ordering::Equal));
    let text: usize = entries.iter().map(|e| expr::utf16_len(&metrics[e.1])).sum();
    control.spend_text(text)?;
    let mut value = new_field("value", FieldType::Number, entries.iter().map(|e| num_value(Some(e.2))).collect());
    value.unit = shared_unit(value_fields.into_iter());
    let fields = vec![
        new_field("time", FieldType::Time, entries.iter().map(|e| Value::from(e.0.floor() as i64)).collect()),
        new_field("metric", FieldType::String, entries.iter().map(|e| Value::from(metrics[e.1].as_str())).collect()),
        value,
    ];
    let meta = joined_meta(at.iter().map(|&i| frames[i].frame.meta()));
    let long = frame_of(fields, meta.as_ref())?;
    replace(frames, &at, long);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_read_iso_and_formats() {
        let t = |s: &str| parse_time(s, None);
        assert_eq!(t("2026-01-01"), Some(1_767_225_600_000));
        assert_eq!(t(" 2026-01-01T00:00Z "), Some(1_767_225_600_000));
        assert_eq!(t("2026-01-01 01:00:00.5+01:00"), Some(1_767_225_600_500));
        assert_eq!(t("2026-01-01T00:00:00.123456789-0030"), Some(1_767_227_400_123));
        for bad in ["2026-02-30", "2026-1-01", "2026-01-01T24:00", "2026-01-01Z", "2026-01-01T00:00+1", "x"] {
            assert_eq!(t(bad), None, "{bad}");
        }
        let f = |s: &str, f: &str| parse_time(s, Some(f));
        assert_eq!(f("31.01.2026 08:15", "DD.MM.YYYY HH:mm"), Some(1_769_847_300_000));
        assert_eq!(f("20260101", "YYYYMMDD"), Some(1_767_225_600_000));
        assert_eq!(f("31.01.2026", "DD.MM.YYYY HH:mm"), None);
        assert_eq!(f("2026/01/01", "YYYY-MM-DD"), None);
        assert_eq!(t(&format!("2026-01-01T00:00:00.{}", "0".repeat(60))), None);
    }

    #[test]
    fn patterns_are_checked() {
        assert!(field_pattern("^cpu_(user|system)$").is_ok());
        assert_eq!(field_pattern("(").unwrap_err().reason, "steps.pattern");
        for ok in [
            "^cpu_(user|system)$",
            "a{2,5}?",
            "[a-z\\-]+",
            "x\\.y",
            "(ab)*",
            "",
            "a|",
            "ä+",
            ".*cpu.*",
            ".*?a+b*.*?",
            "[a-z]+_[0-9]+",
            "(a|b)(c|d)x+",
            "a?aaaa",
            "[^a]{400}",
        ] {
            assert!(safe_pattern(ok), "{ok}");
        }
        for bad in [
            "(?=a)",
            "(?i)a",
            "(?:a)",
            "(a)\\1",
            "\\d+",
            "\\w",
            "\\bx",
            "(a+)+",
            "((a*)b)*",
            "a{2",
            "a{3,2}",
            "a{1001}",
            "}",
            "]",
            "[a&&b]",
            "[[:alpha:]]",
            "[]",
            "*a",
            "a**",
            "^*",
            "\\ ",
            "(ab|cd)*",
            "(a|a)*",
            "(a|aa)+",
            "((a|b)c){2}",
            "a*b*c*",
            ".*a.*b.*c.*d",
            "a+b+\\.*",
            "a?a?a?a?aaaa",
            "(a|b)x+y+",
            "(a|b)(a|b)(a|b)(a|b)(a|b)(a|b)(a|b)x+",
            "[^a]{401}",
            "(abcdefghijklmnopq){1000}",
        ] {
            assert!(!safe_pattern(bad), "{bad}");
        }
        assert!(safe_pattern(&"(a|b)".repeat(12)));
        assert!(!safe_pattern(&"(a|b)".repeat(13)));
        assert!(safe_pattern(&"x".repeat(2000)));
        assert!(!safe_pattern(&"x".repeat(2001)));
        // The heaviest patterns the subset takes stay under the compiled size limit.
        for heavy in [
            ".{400}".to_string(),
            "[^a]{200}[ -\u{10FFFF}]{199}".to_string(),
            format!("({}){{1000}}", "\u{1F600}".repeat(4)),
            "\u{4e2d}".repeat(2000),
            "[^a]".repeat(400),
        ] {
            assert!(field_pattern(&heavy).is_ok(), "{heavy}");
        }
        // `.` passes over line ends as in JavaScript; a pattern reads the first 150 characters.
        let dot = field_pattern("a.b").unwrap();
        assert!(dot.is_match("a b") && !dot.is_match("a\rb") && !dot.is_match("a\u{2028}b"));
        let end = field_pattern("x$").unwrap();
        let long = format!("{}x", "a".repeat(MAX_MATCH_CHARS));
        assert!(end.is_match(&long) && !end.is_match(match_head(&long)));
        assert_eq!(match_head(&"ä".repeat(300)).chars().count(), MAX_MATCH_CHARS);
        assert!(field_pattern("x\\.*").unwrap().is_match("x"));
        assert_eq!(bool_of_text(" TRUE "), Some(true));
        assert_eq!(bool_of_text("0"), Some(false));
        assert_eq!(bool_of_text("yes"), None);
    }
}
