//! The tokens the way back (`cypher::parse`, `gsql::parse`) reads. Unlike the read-only checks,
//! which only need to know where values are, this one keeps the values: a string or number in a
//! condition becomes a literal of the pattern.

use serde_json::Value;

use super::{Detail, not_representable};

#[derive(Clone, Debug, PartialEq)]
pub enum Tok {
    /// A name; `quoted` when written in backticks (Cypher).
    Ident {
        text: String,
        quoted: bool,
    },
    /// `$name` (Cypher).
    Param(String),
    Str(String),
    Num(Value),
    /// One character, or one of `<>`, `<=`, `>=`, `!=`, `==`, `..`, `+=`, `@@`.
    Sym(&'static str),
}

impl Tok {
    /// Whether the token is the word `w` (any case, not quoted).
    pub fn is_word(&self, w: &str) -> bool {
        matches!(self, Tok::Ident { text, quoted: false } if text.eq_ignore_ascii_case(w))
    }

    pub fn is_sym(&self, s: &str) -> bool {
        matches!(self, Tok::Sym(t) if *t == s)
    }

    /// The token as the text it stands for, for messages.
    pub fn show(&self) -> String {
        match self {
            Tok::Ident { text, .. } => text.clone(),
            Tok::Param(p) => format!("${p}"),
            Tok::Str(_) => "a string".into(),
            Tok::Num(n) => n.to_string(),
            Tok::Sym(s) => (*s).to_string(),
        }
    }
}

const PAIRS: &[&str] = &["<>", "<=", ">=", "!=", "==", "..", "+=", "@@"];
const SINGLES: &[&str] = &[
    "(", ")", "[", "]", "{", "}", "<", ">", "-", "=", ":", ",", ".", ";", "*", "|", "$", "+", "!", "@", "%", "/", "^",
    "&", "~",
];

fn sym(c: char) -> Option<&'static str> {
    SINGLES.iter().copied().find(|s| s.starts_with(c))
}

pub fn lex(q: &str) -> Result<Vec<Tok>, Detail> {
    let chars: Vec<char> = q.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c.is_whitespace() {
            i += 1;
        } else if c == '/' && next == Some('/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && next == Some('*') {
            let mut j = i + 2;
            while j + 1 < chars.len() && !(chars[j] == '*' && chars[j + 1] == '/') {
                j += 1;
            }
            if j + 1 >= chars.len() {
                return Err(not_representable("a comment that is not closed"));
            }
            i = j + 2;
        } else if c == '\'' || c == '"' {
            let (s, end) = string(&chars, i)?;
            out.push(Tok::Str(s));
            i = end;
        } else if c == '`' {
            let mut text = String::new();
            let mut j = i + 1;
            loop {
                match chars.get(j) {
                    None => return Err(not_representable("a `name` that is not closed")),
                    Some('`') if chars.get(j + 1) == Some(&'`') => {
                        text.push('`');
                        j += 2;
                    }
                    Some('`') => break,
                    Some(&ch) => {
                        text.push(ch);
                        j += 1;
                    }
                }
            }
            out.push(Tok::Ident { text, quoted: true });
            i = j + 1;
        } else if c == '$' && next.is_some_and(|n| n.is_ascii_alphabetic() || n == '_') {
            let mut j = i + 1;
            while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
                j += 1;
            }
            out.push(Tok::Param(chars[i + 1..j].iter().collect()));
            i = j;
        } else if c.is_alphabetic() || c == '_' {
            let mut j = i;
            while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') {
                j += 1;
            }
            out.push(Tok::Ident { text: chars[i..j].iter().collect(), quoted: false });
            i = j;
        } else if c.is_ascii_digit() {
            let (n, end) = number(&chars, i)?;
            out.push(Tok::Num(n));
            i = end;
        } else if let Some(pair) = next.and_then(|n| PAIRS.iter().find(|p| p.starts_with(c) && p.ends_with(n))) {
            out.push(Tok::Sym(pair));
            i += 2;
        } else if let Some(s) = sym(c) {
            out.push(Tok::Sym(s));
            i += 1;
        } else {
            return Err(not_representable(format!("the character {c:?}")));
        }
    }
    Ok(out)
}

fn string(chars: &[char], start: usize) -> Result<(String, usize), Detail> {
    let quote = chars[start];
    let mut s = String::new();
    let mut j = start + 1;
    loop {
        match chars.get(j) {
            None => return Err(not_representable("a string that is not closed")),
            Some('\\') => {
                let escaped = match chars.get(j + 1) {
                    Some('n') => '\n',
                    Some('t') => '\t',
                    Some('r') => '\r',
                    Some('b') => '\u{8}',
                    Some('f') => '\u{c}',
                    Some('u') => {
                        let hex: String = chars.get(j + 2..j + 6).map(|h| h.iter().collect()).unwrap_or_default();
                        let ch = u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32);
                        let ch = ch.ok_or_else(|| not_representable("a \\u escape that is not valid"))?;
                        s.push(ch);
                        j += 6;
                        continue;
                    }
                    Some(&ch @ ('\\' | '\'' | '"')) => ch,
                    _ => return Err(not_representable("an escape in a string")),
                };
                s.push(escaped);
                j += 2;
            }
            Some(&ch) if ch == quote => return Ok((s, j + 1)),
            Some(&ch) => {
                s.push(ch);
                j += 1;
            }
        }
    }
}

fn number(chars: &[char], start: usize) -> Result<(Value, usize), Detail> {
    let digits = |mut j: usize| {
        while j < chars.len() && chars[j].is_ascii_digit() {
            j += 1;
        }
        j
    };
    let mut j = digits(start);
    let mut float = false;
    if chars.get(j) == Some(&'.') && chars.get(j + 1).is_some_and(char::is_ascii_digit) {
        j = digits(j + 1);
        float = true;
    }
    if matches!(chars.get(j), Some('e' | 'E')) {
        let sign = usize::from(matches!(chars.get(j + 1), Some('+' | '-')));
        if chars.get(j + 1 + sign).is_some_and(char::is_ascii_digit) {
            j = digits(j + 1 + sign);
            float = true;
        }
    }
    if chars.get(j).is_some_and(|c| c.is_alphanumeric() || *c == '_') {
        return Err(not_representable("a number written with letters (hexadecimal, octal or glued to a word)"));
    }
    let text: String = chars[start..j].iter().collect();
    let value = if float {
        text.parse::<f64>().ok().and_then(serde_json::Number::from_f64).map(Value::Number)
    } else {
        text.parse::<i64>().ok().map(Value::from)
    };
    value.map(|v| (v, j)).ok_or_else(|| not_representable(format!("the number {text}")))
}

/// A cursor over tokens.
pub struct Cursor {
    toks: Vec<Tok>,
    pub i: usize,
}

impl Cursor {
    pub fn new(toks: Vec<Tok>) -> Self {
        Self { toks, i: 0 }
    }

    pub fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.i)
    }

    pub fn peek_at(&self, ahead: usize) -> Option<&Tok> {
        self.toks.get(self.i + ahead)
    }

    pub fn at_end(&self) -> bool {
        self.i >= self.toks.len()
    }

    pub fn next(&mut self) -> Option<Tok> {
        let t = self.toks.get(self.i).cloned();
        self.i += 1;
        t
    }

    pub fn word(&self, w: &str) -> bool {
        self.peek().is_some_and(|t| t.is_word(w))
    }

    pub fn sym(&self, s: &str) -> bool {
        self.peek().is_some_and(|t| t.is_sym(s))
    }

    pub fn eat_word(&mut self, w: &str) -> bool {
        let yes = self.word(w);
        if yes {
            self.i += 1;
        }
        yes
    }

    pub fn eat_sym(&mut self, s: &str) -> bool {
        let yes = self.sym(s);
        if yes {
            self.i += 1;
        }
        yes
    }

    /// What stands here, for a refusal.
    pub fn here(&self) -> String {
        self.peek().map_or_else(|| "the end of the query".to_string(), Tok::show)
    }

    pub fn expect_sym(&mut self, s: &str) -> Result<(), Detail> {
        if self.eat_sym(s) { Ok(()) } else { Err(not_representable(format!("{} where {s} belongs", self.here()))) }
    }

    pub fn expect_word(&mut self, w: &str) -> Result<(), Detail> {
        if self.eat_word(w) { Ok(()) } else { Err(not_representable(format!("{} where {w} belongs", self.here()))) }
    }

    /// A name: unquoted or in backticks.
    pub fn name(&mut self) -> Result<String, Detail> {
        match self.peek() {
            Some(Tok::Ident { text, .. }) => {
                let t = text.clone();
                self.i += 1;
                Ok(t)
            }
            _ => Err(not_representable(format!("{} where a name belongs", self.here()))),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn values_are_kept() {
        let t = lex(
            r#"MATCH (a:`Wer ``x`` ist`) WHERE a.n = 'it\'s' AND a.m <> -1.5e2 AND a.k IN [1, 2] AND x == "ä" // c"#,
        )
        .unwrap();
        assert!(t.contains(&Tok::Ident { text: "Wer `x` ist".into(), quoted: true }));
        assert!(t.contains(&Tok::Str("it's".into())));
        assert!(t.contains(&Tok::Sym("<>")));
        assert!(t.contains(&Tok::Num(json!(150.0))));
        assert!(t.contains(&Tok::Sym("==")));
        assert!(t.contains(&Tok::Str("ä".into())));
        assert_eq!(lex("*1..3").unwrap(), [Tok::Sym("*"), Tok::Num(json!(1)), Tok::Sym(".."), Tok::Num(json!(3))]);
        assert_eq!(lex("$firma").unwrap(), [Tok::Param("firma".into())]);
        assert_eq!(lex("0x1F").unwrap_err().reason, "pattern.not_representable");
        assert_eq!(lex("'offen").unwrap_err().reason, "pattern.not_representable");
        assert_eq!(lex("#").unwrap_err().reason, "pattern.not_representable");
    }
}
