//! PATCH requests (RFC 7644, section 3.5.2): their operations and the attribute paths in them, as
//! directories send them. Entra ID writes `op` capitalized (`"Replace"`) and booleans as strings
//! (`"False"`); Okta sends `replace` without a path and an object of attributes. Both are read here;
//! what an operation does to a user or group is decided in `users` and `groups`.

use serde_json::Value;

use super::{ScimError, ScimResult, field};

/// At most this many operations in one request.
const MAX_OPERATIONS: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpKind {
    Add,
    Replace,
    Remove,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Op {
    pub kind: OpKind,
    pub path: Option<AttrPath>,
    pub value: Option<Value>,
}

/// `attr`, `attr.sub`, `attr[filterAttr eq "value"]` or `attr[filterAttr eq "value"].sub`, with
/// names in lowercase and the core schema prefix left out. An extension's attribute keeps its
/// schema in `attr` (`urn:...:enterprise:2.0:user:department`).
#[derive(Debug, Clone, PartialEq)]
pub struct AttrPath {
    pub attr: String,
    pub filter: Option<(String, String)>,
    pub sub: Option<String>,
}

impl AttrPath {
    /// A path with only an attribute, for the keys of a path-less operation's object.
    pub fn of(attr: &str) -> ScimResult<Self> {
        parse_path(attr)
    }
}

fn invalid_path(detail: impl Into<String>) -> ScimError {
    ScimError::bad("invalidPath", detail).because("scim.path_invalid")
}

/// The operations of a PATCH body.
pub fn operations(body: &Value) -> ScimResult<Vec<Op>> {
    let ops = field(body, "Operations")
        .and_then(Value::as_array)
        .ok_or_else(|| ScimError::bad("invalidSyntax", "a PATCH needs Operations").because("scim.body_invalid"))?;
    if ops.len() > MAX_OPERATIONS {
        return Err(
            ScimError::bad("tooMany", format!("at most {MAX_OPERATIONS} operations")).because("scim.body_invalid")
        );
    }
    ops.iter()
        .map(|op| {
            let kind = match field(op, "op").and_then(Value::as_str).map(str::to_ascii_lowercase).as_deref() {
                Some("add") => OpKind::Add,
                Some("replace") => OpKind::Replace,
                Some("remove") => OpKind::Remove,
                _ => {
                    return Err(
                        ScimError::bad("invalidSyntax", "op is add, replace or remove").because("scim.body_invalid")
                    );
                }
            };
            let path = match field(op, "path") {
                None | Some(Value::Null) => None,
                Some(Value::String(p)) if p.trim().is_empty() => None,
                Some(Value::String(p)) => Some(parse_path(p)?),
                Some(_) => return Err(invalid_path("path is not a string")),
            };
            let value = field(op, "value").filter(|v| !v.is_null()).cloned();
            if kind != OpKind::Remove && value.is_none() {
                return Err(
                    ScimError::bad("invalidValue", "add and replace need a value").because("scim.value_invalid")
                );
            }
            if kind == OpKind::Remove && path.is_none() {
                return Err(ScimError::bad("noTarget", "remove needs a path").because("scim.path_invalid"));
            }
            Ok(Op { kind, path, value })
        })
        .collect()
}

fn parse_path(raw: &str) -> ScimResult<AttrPath> {
    const CORE: &str = "urn:ietf:params:scim:schemas:core:2.0:";
    let raw = raw.trim();
    // The core schemas' prefix; an extension keeps its schema as part of the attribute.
    let rest = match raw.get(..CORE.len()) {
        Some(head) if head.eq_ignore_ascii_case(CORE) => {
            raw[CORE.len()..].split_once(':').map(|(_, attr)| attr).ok_or_else(|| invalid_path(raw))?
        }
        _ if raw.get(..4).is_some_and(|h| h.eq_ignore_ascii_case("urn:")) => {
            return Ok(AttrPath { attr: raw.to_ascii_lowercase(), filter: None, sub: None });
        }
        _ => raw,
    };
    // The filter keeps the case of its value (`members[value eq "0190-AbC"]`).
    let (head, filter, tail) = match rest.find('[') {
        Some(open) => {
            let close = rest[open..].find(']').map(|c| open + c).ok_or_else(|| invalid_path(raw))?;
            let comparisons = super::filter::parse(&rest[open + 1..close]).map_err(|_| invalid_path(raw))?;
            let [only] = comparisons.as_slice() else { return Err(invalid_path(raw)) };
            (&rest[..open], Some((only.attr.clone(), only.text())), &rest[close + 1..])
        }
        None => match rest.find('.') {
            Some(dot) => (&rest[..dot], None, &rest[dot..]),
            None => (rest, None, ""),
        },
    };
    let head = head.to_ascii_lowercase();
    let sub = match tail.strip_prefix('.') {
        Some(sub) if !sub.is_empty() => Some(sub.to_ascii_lowercase()),
        Some(_) => return Err(invalid_path(raw)),
        None if tail.is_empty() => None,
        None => return Err(invalid_path(raw)),
    };
    let word = |w: &str| !w.is_empty() && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$');
    if !word(&head) || sub.as_deref().is_some_and(|s| !word(s)) {
        return Err(invalid_path(raw));
    }
    Ok(AttrPath { attr: head, filter, sub })
}

/// The values of an add or remove operation: an array, or a single value.
pub fn values(value: &Value) -> Vec<&Value> {
    match value {
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn path(raw: &str) -> AttrPath {
        parse_path(raw).unwrap()
    }

    #[test]
    fn paths_of_entra_and_okta_are_read() {
        assert_eq!(path("active"), AttrPath { attr: "active".into(), filter: None, sub: None });
        assert_eq!(
            path("name.givenName"),
            AttrPath { attr: "name".into(), filter: None, sub: Some("givenname".into()) }
        );
        assert_eq!(
            path(r#"emails[type eq "work"].value"#),
            AttrPath { attr: "emails".into(), filter: Some(("type".into(), "work".into())), sub: Some("value".into()) }
        );
        assert_eq!(
            path(r#"members[value eq "0190-AbC"]"#),
            AttrPath { attr: "members".into(), filter: Some(("value".into(), "0190-AbC".into())), sub: None },
            "filter values keep their case"
        );
        assert_eq!(path("urn:ietf:params:scim:schemas:core:2.0:User:userName").attr, "username");
        assert_eq!(
            path("urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department").attr,
            "urn:ietf:params:scim:schemas:extension:enterprise:2.0:user:department"
        );
        for bad in ["emails[type eq \"work\"", "name.", "a b", "members[value co \"x\"]", "x]y"] {
            assert!(parse_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn operations_accept_entra_capitals_and_okta_objects() {
        let ops = operations(&json!({
            "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
            "Operations": [
                { "op": "Replace", "path": "active", "value": "False" },
                { "op": "replace", "value": { "active": false } },
                { "op": "Remove", "path": "members[value eq \"u1\"]" }
            ]
        }))
        .unwrap();
        assert_eq!(ops.len(), 3);
        assert_eq!((ops[0].kind, ops[0].value.clone()), (OpKind::Replace, Some(json!("False"))));
        assert_eq!(ops[1].path, None);
        assert_eq!(ops[2].kind, OpKind::Remove);
        assert!(operations(&json!({ "Operations": [{ "op": "move", "path": "a", "value": 1 }] })).is_err());
        assert!(operations(&json!({ "Operations": [{ "op": "add", "path": "a" }] })).is_err());
        assert!(operations(&json!({ "Operations": [{ "op": "remove" }] })).is_err());
        assert!(operations(&json!({ "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"] })).is_err());
    }
}
