//! The part of SCIM filters (RFC 7644, section 3.4.2.2) that directories use to find what they
//! provisioned before: `attribute eq "value"`, several joined with `and`. Entra ID sends
//! `userName eq "..."`, `externalId eq "..."` and `displayName eq "..."`; Okta the same. Anything
//! else is answered with `400 invalidFilter`, so a directory never acts on a list that ignored
//! part of its filter.

use serde_json::Value;

use super::{ScimError, ScimResult};

/// One comparison: the attribute in lowercase without a schema prefix, and the value.
#[derive(Debug, Clone, PartialEq)]
pub struct Eq {
    pub attr: String,
    pub value: Value,
}

impl Eq {
    /// The value as text: strings as they are, other values in their JSON form.
    pub fn text(&self) -> String {
        match &self.value {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        }
    }
}

fn invalid(detail: impl Into<String>) -> ScimError {
    ScimError::bad("invalidFilter", detail).because("scim.filter_unsupported")
}

/// Parses `raw` into its comparisons, all of which must hold.
pub fn parse(raw: &str) -> ScimResult<Vec<Eq>> {
    let mut lexer = Lexer { rest: raw.trim() };
    let mut out = Vec::new();
    loop {
        let attr = lexer.word().ok_or_else(|| invalid("a filter starts with an attribute"))?;
        let op = lexer.word().ok_or_else(|| invalid("the filter has no operator"))?;
        if !op.eq_ignore_ascii_case("eq") {
            return Err(invalid(format!("only the operator eq is supported, not {op}")));
        }
        let value = lexer.value()?;
        out.push(Eq { attr: attribute(attr)?, value });
        if lexer.rest.is_empty() {
            return Ok(out);
        }
        match lexer.word() {
            Some(and) if and.eq_ignore_ascii_case("and") => {}
            Some(other) => return Err(invalid(format!("only and joins comparisons, not {other}"))),
            None => return Err(invalid("the filter does not end after its value")),
        }
    }
}

/// An attribute path in lowercase, without the core schema prefix
/// (`urn:ietf:params:scim:schemas:core:2.0:User:userName` is `username`).
fn attribute(raw: &str) -> ScimResult<String> {
    let lower = raw.to_ascii_lowercase();
    let name = match lower.strip_prefix("urn:ietf:params:scim:schemas:core:2.0:") {
        Some(rest) => rest.split_once(':').map(|(_, attr)| attr.to_string()).unwrap_or_default(),
        None => lower,
    };
    let valid = !name.is_empty()
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' || c == '$');
    if valid { Ok(name) } else { Err(invalid(format!("{raw} is not an attribute"))) }
}

struct Lexer<'a> {
    rest: &'a str,
}

impl<'a> Lexer<'a> {
    /// The next run of non-space characters outside quotes.
    fn word(&mut self) -> Option<&'a str> {
        self.rest = self.rest.trim_start();
        if self.rest.is_empty() || self.rest.starts_with('"') || self.rest.starts_with('(') {
            return None;
        }
        let end = self.rest.find(char::is_whitespace).unwrap_or(self.rest.len());
        let (word, rest) = self.rest.split_at(end);
        self.rest = rest.trim_start();
        Some(word)
    }

    /// A JSON value: a quoted string with JSON escapes, `true`, `false`, `null` or a number.
    fn value(&mut self) -> ScimResult<Value> {
        self.rest = self.rest.trim_start();
        if self.rest.starts_with('"') {
            let bytes = self.rest.as_bytes();
            let mut i = 1;
            while i < bytes.len() && bytes[i] != b'"' {
                i += if bytes[i] == b'\\' { 2 } else { 1 };
            }
            if i >= bytes.len() {
                return Err(invalid("a quoted value does not end"));
            }
            let (quoted, rest) = self.rest.split_at(i + 1);
            self.rest = rest.trim_start();
            return serde_json::from_str(quoted).map_err(|_| invalid("a quoted value is not valid"));
        }
        let word = self.word().ok_or_else(|| invalid("the comparison has no value"))?;
        match word.to_ascii_lowercase().as_str() {
            "true" => Ok(Value::Bool(true)),
            "false" => Ok(Value::Bool(false)),
            "null" => Ok(Value::Null),
            _ => serde_json::from_str::<serde_json::Number>(word)
                .map(Value::Number)
                .map_err(|_| invalid(format!("{word} is not a value"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_filters_of_entra_and_okta_are_read() {
        assert_eq!(
            parse(r#"userName eq "anna.berg@mueller.example""#).unwrap(),
            vec![Eq { attr: "username".into(), value: json!("anna.berg@mueller.example") }]
        );
        assert_eq!(parse("externalId eq \"5c1f\"").unwrap()[0].attr, "externalid");
        assert_eq!(parse(r#"displayName EQ "Vertrieb \"Nord\"""#).unwrap()[0].value, json!("Vertrieb \"Nord\""));
        let both = parse(r#"userName eq "a" and active eq true"#).unwrap();
        assert_eq!(both.len(), 2);
        assert_eq!(both[1], Eq { attr: "active".into(), value: json!(true) });
        let urn = parse(r#"urn:ietf:params:scim:schemas:core:2.0:User:userName eq "x""#).unwrap();
        assert_eq!(urn[0].attr, "username");
        assert_eq!(parse("id eq 42").unwrap()[0].text(), "42");
    }

    #[test]
    fn other_filters_are_refused() {
        for bad in [
            "",
            r#"userName co "a""#,
            r#"userName eq "a" or userName eq "b""#,
            r#"userName eq "a"#,
            "userName eq",
            r#"(userName eq "a")"#,
            r#"emails[type eq "work"] eq "a""#,
            r#"userName eq "a" junk"#,
        ] {
            let e = parse(bad).unwrap_err();
            assert_eq!(e.scim_type, Some("invalidFilter"), "{bad}");
        }
    }
}
