//! What the data source routes tell people: a stable `reason` code the UI translates, its
//! `params`, and an English `message` for logs and API clients (and as the UI's fallback). Every
//! code is listed in docs/api/datasources.md.

use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct Detail {
    pub reason: &'static str,
    pub params: BTreeMap<String, String>,
    pub message: String,
}

impl Detail {
    pub fn new(reason: &'static str, message: impl Into<String>) -> Self {
        Self { reason, params: BTreeMap::new(), message: message.into() }
    }

    /// Adds a parameter the translated text can use (`{name}`).
    pub fn with(mut self, key: &str, value: impl ToString) -> Self {
        self.params.insert(key.to_string(), value.to_string());
        self
    }

    /// The same detail with `scrub` applied to the message and every parameter, so no secret
    /// leaves the server through either.
    pub fn scrubbed(&self, scrub: impl Fn(&str) -> String) -> Self {
        Self {
            reason: self.reason,
            params: self.params.iter().map(|(k, v)| (k.clone(), scrub(v))).collect(),
            message: scrub(&self.message),
        }
    }
}
