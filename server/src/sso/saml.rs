//! SAML 2.0 sign-in (docs/api/sso.md, "SAML 2.0"): Kalzit is the service provider of the Web
//! Browser SSO profile. The AuthnRequest goes to the provider with the HTTP-Redirect binding, the
//! answer comes back to the ACS with HTTP-POST.
//!
//! XML signatures are checked by bergshamra (pure Rust XML-DSig, through gamlastan's hardened
//! parser), never by hand. What this module adds is the SAML side of the check, written so a
//! signature wrapping attack has nothing to hide behind:
//!
//! - the response is parsed once, with DTDs, entities, comments, processing instructions and
//!   CDATA refused (so a comment cannot split the text of a NameID);
//! - the document holds exactly one `Assertion` anywhere (none in `Advice`, none encrypted), as a
//!   child of the `Response`, and every ID in it is unique;
//! - every signature sits on the `Response` or that `Assertion`, signs exactly that element with
//!   enveloped C14N and SHA-2, and must verify with a pinned certificate of the provider;
//! - the signature check reports the nodes it verified in the same parsed document; the
//!   `Assertion` read afterwards must be one of them, or a child of the verified `Response`.
//!
//! The values of the consumed `Assertion` are then read from that very node: issuer, audience,
//! recipient, the request it answers and the validity window with a small clock skew.

use std::collections::{BTreeMap, BTreeSet};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use gamlastan::crypto::keys::loader;
use gamlastan::crypto::{KeyUsage, KeysManager};
use gamlastan::xml::uppsala::{Document, NodeId, NodeKind};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::oidc::{Person, matching_email};

const PROTOCOL: &str = "urn:oasis:names:tc:SAML:2.0:protocol";
const ASSERTION: &str = "urn:oasis:names:tc:SAML:2.0:assertion";
const DSIG: &str = "http://www.w3.org/2000/09/xmldsig#";
const METADATA: &str = "urn:oasis:names:tc:SAML:2.0:metadata";
const XMLENC: &str = "http://www.w3.org/2001/04/xmlenc#";

const STATUS_SUCCESS: &str = "urn:oasis:names:tc:SAML:2.0:status:Success";
const BEARER: &str = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const BINDING_REDIRECT: &str = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const BINDING_POST: &str = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
const NAME_ID_TRANSIENT: &str = "urn:oasis:names:tc:SAML:2.0:nameid-format:transient";
const NAME_ID_EMAIL: &str = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
const NAME_ID_PERSISTENT: &str = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";

/// How far the provider's clock may be off.
pub const CLOCK_SKEW_MS: i64 = 2 * 60 * 1000;
/// Largest SAML answer read (decoded XML).
pub const MAX_RESPONSE_BYTES: usize = 256 * 1024;
/// Largest metadata document read.
pub const MAX_METADATA_BYTES: usize = 1024 * 1024;
/// Certificates pinned at once: the current one and the next during a rollover.
pub const MAX_CERTIFICATES: usize = 2;

/// Canonicalization of the signed element: exclusive or inclusive C14N, never with comments.
const C14N: [&str; 2] = ["http://www.w3.org/2001/10/xml-exc-c14n#", "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"];
const ENVELOPED: &str = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
/// RSA and ECDSA with SHA-2. SHA-1 is refused.
const SIGNATURE_METHODS: [&str; 6] = [
    "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    "http://www.w3.org/2001/04/xmldsig-more#rsa-sha384",
    "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
    "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256",
    "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha384",
    "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha512",
];
const DIGEST_METHODS: [&str; 3] = [
    "http://www.w3.org/2001/04/xmlenc#sha256",
    "http://www.w3.org/2001/04/xmldsig-more#sha384",
    "http://www.w3.org/2001/04/xmlenc#sha512",
];

/// `AuthnContextClassRef` values that say the provider checked more than one factor. Only the
/// signed `AuthnContextClassRef` counts: an attribute such as Entra ID's `authnmethodsreferences`
/// is any value the provider's claim rules put there, so it never skips Kalzit's second factor.
const MFA_CONTEXTS: [&str; 6] = [
    "https://refeds.org/profile/mfa",
    "http://schemas.microsoft.com/claims/multipleauthn",
    "urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorContract",
    "urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorUnregistered",
    "urn:oasis:names:tc:SAML:2.0:ac:classes:TimeSyncToken",
    "urn:oasis:names:tc:SAML:2.0:ac:classes:SmartcardPKI",
];

/// The status codes of SAML core 3.2.2.2. Another value in an unverified answer is reported as
/// `other`, so nothing the sender made up reaches the audit log.
const STATUS_CODES: [&str; 23] = [
    "Success",
    "Requester",
    "Responder",
    "VersionMismatch",
    "AuthnFailed",
    "InvalidAttrNameOrValue",
    "InvalidNameIDPolicy",
    "NoAuthnContext",
    "NoAvailableIDP",
    "NoPassive",
    "NoSupportedIDP",
    "PartialLogout",
    "ProxyCountExceeded",
    "RequestDenied",
    "RequestUnsupported",
    "RequestVersionDeprecated",
    "RequestVersionTooHigh",
    "RequestVersionTooLow",
    "ResourceNotRecognized",
    "TooManyResponses",
    "UnknownAttrProfile",
    "UnknownPrincipal",
    "UnsupportedBinding",
];

/// A status code of an answer whose signature is not checked yet: one of `STATUS_CODES` as its
/// URI, else `other`.
fn known_status(raw: &str) -> String {
    match raw.strip_prefix("urn:oasis:names:tc:SAML:2.0:status:") {
        Some(name) if STATUS_CODES.contains(&name) => raw.to_string(),
        _ => "other".to_string(),
    }
}

/// The settings of a SAML provider, as stored (`sso_providers.config`) and edited. The provider's
/// values (`idp_entity_id`, `sso_url`, `certificates`) are pinned: read from its metadata or
/// typed in once, checked, and only changed by an admin, never by the provider.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SamlConfig {
    /// Where the metadata was read from, for reading it again; empty when it was uploaded or the
    /// values were typed in.
    #[serde(default)]
    pub metadata_url: String,
    pub idp_entity_id: String,
    /// The provider's SingleSignOnService for HTTP-Redirect.
    pub sso_url: String,
    /// The pinned signing certificates, base64 DER: one, or two during a rollover.
    pub certificates: Vec<String>,
    #[serde(default = "default_email_attribute")]
    pub email_attribute: String,
    #[serde(default = "default_name_attribute")]
    pub name_attribute: String,
    #[serde(default = "default_groups_attribute")]
    pub groups_attribute: String,
    #[serde(default)]
    pub trust_email: bool,
}

pub fn default_email_attribute() -> String {
    "mail".into()
}
pub fn default_name_attribute() -> String {
    "displayName".into()
}
pub fn default_groups_attribute() -> String {
    "memberOf".into()
}

impl SamlConfig {
    /// The pinned certificates as DER.
    pub fn certificate_der(&self) -> Vec<Vec<u8>> {
        self.certificates.iter().filter_map(|c| STANDARD.decode(c).ok()).collect()
    }

    /// Whether `other` signs in through the same provider with the same keys (what a check
    /// covers).
    pub fn same_trust(&self, other: &SamlConfig) -> bool {
        self.idp_entity_id == other.idp_entity_id
            && self.sso_url == other.sso_url
            && self.certificates == other.certificates
    }
}

/// Kalzit's entity ID for the provider `slug`: `<public URL>/auth/saml/<slug>`.
pub fn sp_entity_id(base: &str, slug: &str) -> String {
    format!("{}/auth/saml/{slug}", base.trim_end_matches('/'))
}

/// The assertion consumer service (HTTP-POST).
pub fn acs_url(base: &str, slug: &str) -> String {
    format!("{}/acs", sp_entity_id(base, slug))
}

/// Kalzit's metadata for the provider, a stable URL to give to the provider.
pub fn sp_metadata_url(base: &str, slug: &str) -> String {
    format!("{}/metadata", sp_entity_id(base, slug))
}

/// Why a SAML step failed: the reason code (docs/api/sso.md, "Reasons") and what happened.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SamlError {
    #[error("the answer is not readable SAML: {0}")]
    XmlInvalid(String),
    #[error("the answer is not a SAML Response")]
    NotResponse,
    #[error("the provider answered with status {0}")]
    Status(String),
    #[error("the answer names no request (an IdP-initiated sign-in, which Kalzit does not accept)")]
    Unsolicited,
    #[error("the answer is for another request")]
    InResponseTo,
    #[error("the answer is addressed to {0}, not this ACS")]
    Destination(String),
    #[error("the answer comes from {0}, not the configured provider")]
    Issuer(String),
    #[error("the answer holds {0} assertions; exactly one is accepted")]
    AssertionCount(usize),
    #[error("the assertion is encrypted, which Kalzit does not accept")]
    EncryptedAssertion,
    #[error("neither the assertion nor the response is signed")]
    Unsigned,
    #[error("the signature does not verify with the pinned certificates: {0}")]
    SignatureInvalid(String),
    #[error("the signature uses a form Kalzit does not accept: {0}")]
    SignatureUnsupported(String),
    #[error("the signed element is not the assertion that would be used")]
    Wrapping,
    #[error("the assertion names no subject")]
    SubjectMissing,
    #[error("the provider sends a transient NameID; set a persistent NameID or the email address")]
    NameIdTransient,
    #[error("the assertion is for the recipient {0}, not this ACS")]
    Recipient(String),
    #[error("the assertion is not for Kalzit's entity ID")]
    Audience,
    #[error("the assertion expired")]
    Expired,
    #[error("the assertion is not valid yet; the provider's clock is {0} minutes ahead")]
    NotYetValid(i64),
    #[error("the assertion has no authentication statement")]
    AuthnMissing,
}

impl SamlError {
    pub fn reason(&self) -> &'static str {
        match self {
            Self::XmlInvalid(_) => "saml.xml_invalid",
            Self::NotResponse => "saml.not_response",
            Self::Status(_) => "saml.status",
            Self::Unsolicited => "saml.unsolicited",
            Self::InResponseTo => "saml.in_response_to",
            Self::Destination(_) => "saml.destination",
            Self::Issuer(_) => "saml.issuer",
            Self::AssertionCount(_) => "saml.assertion_count",
            Self::EncryptedAssertion => "saml.encrypted_assertion",
            Self::Unsigned => "saml.unsigned",
            Self::SignatureInvalid(_) => "saml.signature_invalid",
            Self::SignatureUnsupported(_) => "saml.signature_unsupported",
            Self::Wrapping => "saml.wrapping",
            Self::SubjectMissing => "saml.subject_missing",
            Self::NameIdTransient => "saml.name_id_transient",
            Self::Recipient(_) => "saml.recipient",
            Self::Audience => "saml.audience",
            Self::Expired => "saml.expired",
            Self::NotYetValid(_) => "saml.not_yet_valid",
            Self::AuthnMissing => "saml.authn_missing",
        }
    }

    /// The params of the reason (`minutes` the provider's clock is ahead).
    pub fn params(&self) -> serde_json::Value {
        match self {
            Self::NotYetValid(minutes) => serde_json::json!({ "minutes": minutes }),
            _ => serde_json::json!({}),
        }
    }

    /// What the person is told: a refusal by the provider reads as "cancelled", anything else as
    /// a failed sign-in.
    pub fn outcome(&self) -> &'static str {
        match self {
            Self::Status(s) if s.ends_with(":AuthnFailed") || s.ends_with(":RequestDenied") => "cancelled",
            _ => "failed",
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Reading the DOM

fn element_is(doc: &Document<'_>, id: NodeId, ns: &str, local: &str) -> bool {
    doc.element(id).is_some_and(|e| e.matches_name_ns(ns, local))
}

/// An attribute without a namespace: `foo:Destination` is not `Destination`.
fn attr<'d>(doc: &'d Document<'_>, id: NodeId, name: &str) -> Option<&'d str> {
    doc.element(id)?
        .attributes
        .iter()
        .find(|a| a.name.namespace_uri.is_none() && a.name.local_name == name)
        .map(|a| &*a.value)
}

fn child(doc: &Document<'_>, id: NodeId, ns: &str, local: &str) -> Option<NodeId> {
    doc.first_child_element_by_name_ns(id, ns, local)
}

fn children(doc: &Document<'_>, id: NodeId, ns: &str, local: &str) -> Vec<NodeId> {
    doc.child_elements_by_name_ns(id, ns, local)
}

/// The text of an element that holds only text (no child elements), trimmed.
fn text(doc: &Document<'_>, id: NodeId) -> Option<String> {
    let mut out = String::new();
    for c in doc.children(id) {
        match doc.node_kind(c) {
            Some(NodeKind::Text(t)) => out.push_str(t),
            Some(NodeKind::Element(_)) => return None,
            _ => {}
        }
    }
    let out = out.trim();
    (!out.is_empty()).then(|| out.to_string())
}

fn instant(raw: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(raw.trim()).ok().map(|t| t.timestamp_millis())
}

fn time_attr(doc: &Document<'_>, id: NodeId, name: &str) -> Result<Option<i64>, SamlError> {
    match attr(doc, id, name) {
        None => Ok(None),
        Some(raw) => instant(raw).map(Some).ok_or_else(|| SamlError::XmlInvalid(format!("{name} is not a time"))),
    }
}

fn parse(xml: &str) -> Result<Document<'_>, SamlError> {
    gamlastan::xml::parse_secure(xml).map_err(|e| SamlError::XmlInvalid(e.to_string()))
}

/// The XML of the `SAMLResponse` form field (base64, line breaks allowed).
pub fn decode_post(value: &str) -> Result<String, SamlError> {
    let compact: String = value.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    if compact.len() > MAX_RESPONSE_BYTES * 4 / 3 + 4 {
        return Err(SamlError::XmlInvalid("the answer is too large".into()));
    }
    let bytes = STANDARD.decode(compact).map_err(|_| SamlError::XmlInvalid("not base64".into()))?;
    String::from_utf8(bytes).map_err(|_| SamlError::XmlInvalid("not UTF-8".into()))
}

/// The request a response answers (`InResponseTo` of the `Response`), read before anything else
/// to find the sign-in it belongs to. Nothing in it is trusted yet.
pub fn in_response_to(xml: &str) -> Result<String, SamlError> {
    let doc = parse(xml)?;
    let root = doc.document_element().ok_or(SamlError::NotResponse)?;
    if !element_is(&doc, root, PROTOCOL, "Response") {
        return Err(SamlError::NotResponse);
    }
    attr(&doc, root, "InResponseTo")
        .filter(|v| !v.is_empty() && v.len() <= 256)
        .map(str::to_string)
        .ok_or(SamlError::Unsolicited)
}

// ---------------------------------------------------------------------------------------------
// Checking a response

/// What the checked response must say.
pub struct Expected<'a> {
    pub idp_entity_id: &'a str,
    pub certificates: &'a [Vec<u8>],
    pub sp_entity_id: &'a str,
    pub acs_url: &'a str,
    /// The ID of the AuthnRequest this answer must answer.
    pub request_id: &'a str,
    pub now_ms: i64,
}

/// What a checked assertion says.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asserted {
    /// The ID of the consumed assertion, remembered until `expires_ms` against replay.
    pub assertion_id: String,
    /// After this the assertion is refused anyway (its earliest `NotOnOrAfter` plus the skew).
    pub expires_ms: i64,
    pub name_id: String,
    pub name_id_format: Option<String>,
    /// Attribute values by `Name`, and by `FriendlyName` where the provider sends one.
    pub attributes: BTreeMap<String, Vec<String>>,
    pub authn_contexts: Vec<String>,
}

/// Checks a SAML Response completely: structure, signatures with the pinned certificates, the
/// consumed assertion and its conditions. A replayed assertion ID is the caller's check
/// (`saml_assertions`), since it needs the database.
pub fn check_response(xml: &str, expected: &Expected<'_>) -> Result<Asserted, SamlError> {
    if xml.len() > MAX_RESPONSE_BYTES {
        return Err(SamlError::XmlInvalid("the answer is too large".into()));
    }
    let doc = parse(xml)?;
    let root = doc.document_element().ok_or(SamlError::NotResponse)?;
    if !element_is(&doc, root, PROTOCOL, "Response") || attr(&doc, root, "Version") != Some("2.0") {
        return Err(SamlError::NotResponse);
    }

    // Structure first: one assertion, as a child of the response, unique IDs.
    let all = doc.descendants(root);
    if all
        .iter()
        .any(|&n| element_is(&doc, n, ASSERTION, "EncryptedAssertion") || element_is(&doc, n, XMLENC, "EncryptedData"))
    {
        return Err(SamlError::EncryptedAssertion);
    }
    let assertions: Vec<NodeId> =
        all.iter().copied().filter(|&n| element_is(&doc, n, ASSERTION, "Assertion")).collect();
    let [assertion] = assertions[..] else { return Err(SamlError::AssertionCount(assertions.len())) };
    if doc.parent(assertion) != Some(root) {
        return Err(SamlError::Wrapping);
    }
    let mut ids = BTreeSet::new();
    for &n in std::iter::once(&root).chain(all.iter()) {
        if let Some(e) = doc.element(n) {
            for a in &e.attributes {
                if matches!(&*a.name.local_name, "ID" | "Id" | "id" | "AssertionID") && !ids.insert(a.value.to_string())
                {
                    return Err(SamlError::Wrapping);
                }
            }
        }
    }

    // The status, before signatures: a provider's refusal is often unsigned.
    let status = child(&doc, root, PROTOCOL, "Status")
        .and_then(|s| child(&doc, s, PROTOCOL, "StatusCode"))
        .and_then(|c| attr(&doc, c, "Value"))
        .unwrap_or_default();
    if status != STATUS_SUCCESS {
        let detail = child(&doc, root, PROTOCOL, "Status")
            .and_then(|s| child(&doc, s, PROTOCOL, "StatusCode"))
            .and_then(|c| child(&doc, c, PROTOCOL, "StatusCode"))
            .and_then(|c| attr(&doc, c, "Value"))
            .unwrap_or(status);
        return Err(SamlError::Status(known_status(detail)));
    }

    // Signatures: only on the response or the assertion, at most one each, each for its own
    // element. All of this is decided before any cryptography, so an answer stuffed with
    // signatures costs no more than two checks per pinned certificate.
    let signatures: Vec<NodeId> = all.iter().copied().filter(|&n| element_is(&doc, n, DSIG, "Signature")).collect();
    if signatures.is_empty() {
        return Err(SamlError::Unsigned);
    }
    let mut parents = Vec::with_capacity(2);
    for &sig in &signatures {
        let parent = doc.parent(sig).ok_or(SamlError::Wrapping)?;
        if parent != root && parent != assertion {
            return Err(SamlError::Wrapping);
        }
        if parents.contains(&parent) {
            return Err(SamlError::SignatureUnsupported("more than one signature on an element".into()));
        }
        parents.push(parent);
    }
    for &sig in &signatures {
        let parent = doc.parent(sig).ok_or(SamlError::Wrapping)?;
        check_signature_form(&doc, sig, attr(&doc, parent, "ID").unwrap_or_default())?;
    }
    let signed = verify_signatures(&doc, expected.certificates, signatures.len())?;
    if !signed.contains(&assertion.index()) && !signed.contains(&root.index()) {
        return Err(SamlError::Wrapping);
    }

    // The response's own fields.
    if attr(&doc, root, "InResponseTo") != Some(expected.request_id) {
        return Err(SamlError::InResponseTo);
    }
    match attr(&doc, root, "Destination") {
        Some(d) if d == expected.acs_url => {}
        Some(d) => return Err(SamlError::Destination(d.chars().take(200).collect())),
        None => return Err(SamlError::Destination(String::new())),
    }
    if let Some(issuer) = child(&doc, root, ASSERTION, "Issuer") {
        let value = text(&doc, issuer).unwrap_or_default();
        if value != expected.idp_entity_id {
            return Err(SamlError::Issuer(value.chars().take(200).collect()));
        }
    }

    check_assertion(&doc, assertion, expected)
}

/// The form of one signature: on the element `parent_id` names, exactly that element, enveloped,
/// C14N without comments, SHA-2. The cryptography is bergshamra's (`verify_signatures`).
fn check_signature_form(doc: &Document<'_>, sig: NodeId, parent_id: &str) -> Result<(), SamlError> {
    let bad = |what: &str| SamlError::SignatureUnsupported(what.to_string());
    if parent_id.is_empty() {
        return Err(bad("the signed element has no ID"));
    }
    if !children(doc, sig, DSIG, "Object").is_empty() {
        return Err(bad("the signature carries an Object"));
    }
    let info = child(doc, sig, DSIG, "SignedInfo").ok_or_else(|| bad("no SignedInfo"))?;
    let c14n = child(doc, info, DSIG, "CanonicalizationMethod").and_then(|m| attr(doc, m, "Algorithm"));
    if !c14n.is_some_and(|a| C14N.contains(&a)) {
        return Err(bad("canonicalization"));
    }
    let method = child(doc, info, DSIG, "SignatureMethod").and_then(|m| attr(doc, m, "Algorithm"));
    if !method.is_some_and(|a| SIGNATURE_METHODS.contains(&a)) {
        return Err(bad("signature method (RSA or ECDSA with SHA-256 or stronger)"));
    }
    let references = children(doc, info, DSIG, "Reference");
    let [reference] = references[..] else { return Err(bad("not exactly one reference")) };
    if attr(doc, reference, "URI") != Some(&format!("#{parent_id}")) {
        return Err(SamlError::Wrapping);
    }
    let digest = child(doc, reference, DSIG, "DigestMethod").and_then(|m| attr(doc, m, "Algorithm"));
    if !digest.is_some_and(|a| DIGEST_METHODS.contains(&a)) {
        return Err(bad("digest method (SHA-256 or stronger)"));
    }
    let transforms =
        child(doc, reference, DSIG, "Transforms").map(|t| children(doc, t, DSIG, "Transform")).unwrap_or_default();
    let algorithms: Vec<&str> = transforms.iter().filter_map(|&t| attr(doc, t, "Algorithm")).collect();
    if algorithms.len() != transforms.len()
        || !algorithms.contains(&ENVELOPED)
        || algorithms.iter().any(|a| *a != ENVELOPED && !C14N.contains(a))
    {
        return Err(bad("transforms (enveloped signature and C14N only)"));
    }
    Ok(())
}

/// Verifies every signature of `doc` with the pinned certificates and answers the elements they
/// sign, as nodes (indexes) of this same document.
fn verify_signatures(doc: &Document<'_>, certificates: &[Vec<u8>], count: usize) -> Result<BTreeSet<usize>, SamlError> {
    if certificates.is_empty() {
        return Err(SamlError::SignatureInvalid("no certificate is pinned".into()));
    }
    // Each pinned certificate on its own (two during a rollover): a signature holds when one of
    // them verifies it.
    let mut verified: Vec<Option<BTreeSet<usize>>> = vec![None; count];
    let mut last_error = String::new();
    for der in certificates {
        match verify_with(doc, der, count) {
            Ok(results) => {
                for (slot, result) in verified.iter_mut().zip(results) {
                    match result {
                        Ok(nodes) if slot.is_none() => *slot = Some(nodes),
                        Ok(_) => {}
                        Err(reason) => last_error = reason,
                    }
                }
            }
            Err(e) => last_error = e,
        }
    }
    let mut signed = BTreeSet::new();
    for slot in verified {
        signed.extend(slot.ok_or_else(|| SamlError::SignatureInvalid(last_error.clone()))?);
    }
    Ok(signed)
}

/// Verifies every signature of `doc` with one pinned certificate: per signature in document
/// order, the nodes (indexes) it signs, or why it does not verify.
fn verify_with(doc: &Document<'_>, der: &[u8], count: usize) -> Result<Vec<Result<BTreeSet<usize>, String>>, String> {
    let mut key = loader::load_x509_cert_der(der).map_err(|e| format!("a pinned certificate cannot be used: {e}"))?;
    key.usage = KeyUsage::Verify;
    let mut keys = KeysManager::new();
    keys.add_key(key);
    keys.add_trusted_cert(der.to_vec());
    // Only the pinned key, never one from the message's KeyInfo; signed elements only where the
    // signature sits (on them). A pinned certificate is trusted for its key, so its dates are not
    // checked: a provider rotates by publishing the next one, which an admin pins.
    let ctx = bergshamra_dsig::DsigContext::new(keys).with_skip_time_checks(true);
    let results = bergshamra_dsig::verify::verify_all_document(&ctx, doc).map_err(|e| e.to_string())?;
    if results.len() != count {
        return Err("not every signature was checked".into());
    }
    Ok(results
        .into_iter()
        .map(|result| match result {
            bergshamra_dsig::VerifyResult::Valid { references, .. } => {
                let mut nodes = BTreeSet::new();
                for r in references {
                    if !r.digest_verified {
                        return Err("a reference was not digested".to_string());
                    }
                    if let Some(node) = r.resolved_node {
                        nodes.insert(node.index());
                    }
                }
                Ok(nodes)
            }
            bergshamra_dsig::VerifyResult::Invalid { reason } => Err(reason),
        })
        .collect())
}

/// The assertion's issuer, subject, conditions and statements.
fn check_assertion(doc: &Document<'_>, assertion: NodeId, expected: &Expected<'_>) -> Result<Asserted, SamlError> {
    let now = expected.now_ms;
    if attr(doc, assertion, "Version") != Some("2.0") {
        return Err(SamlError::XmlInvalid("the assertion is not SAML 2.0".into()));
    }
    let assertion_id =
        attr(doc, assertion, "ID").filter(|v| !v.is_empty() && v.len() <= 256).ok_or(SamlError::Wrapping)?;
    let issuer = child(doc, assertion, ASSERTION, "Issuer").and_then(|i| text(doc, i)).unwrap_or_default();
    if issuer != expected.idp_entity_id {
        return Err(SamlError::Issuer(issuer.chars().take(200).collect()));
    }

    // Subject: the NameID and a bearer confirmation for this ACS and request.
    let subject = child(doc, assertion, ASSERTION, "Subject").ok_or(SamlError::SubjectMissing)?;
    if child(doc, subject, ASSERTION, "EncryptedID").is_some() {
        return Err(SamlError::EncryptedAssertion);
    }
    let name_node = child(doc, subject, ASSERTION, "NameID").ok_or(SamlError::SubjectMissing)?;
    let name_id = text(doc, name_node).filter(|v| v.chars().count() <= 512).ok_or(SamlError::SubjectMissing)?;
    let name_id_format = attr(doc, name_node, "Format").map(str::to_string);
    if name_id_format.as_deref() == Some(NAME_ID_TRANSIENT) {
        return Err(SamlError::NameIdTransient);
    }
    let mut not_on_or_after = Vec::new();
    let mut confirmed: Option<Result<i64, SamlError>> = None;
    for c in children(doc, subject, ASSERTION, "SubjectConfirmation") {
        if attr(doc, c, "Method") != Some(BEARER) {
            continue;
        }
        let Some(data) = child(doc, c, ASSERTION, "SubjectConfirmationData") else { continue };
        let result = (|| {
            let recipient = attr(doc, data, "Recipient").unwrap_or_default();
            if recipient != expected.acs_url {
                return Err(SamlError::Recipient(recipient.chars().take(200).collect()));
            }
            if attr(doc, data, "InResponseTo") != Some(expected.request_id) {
                return Err(SamlError::InResponseTo);
            }
            // A bearer confirmation has no NotBefore (profiles 4.1.4.2).
            if attr(doc, data, "NotBefore").is_some() {
                return Err(SamlError::XmlInvalid("the bearer confirmation has a NotBefore".into()));
            }
            let until = time_attr(doc, data, "NotOnOrAfter")?.ok_or(SamlError::Expired)?;
            if now >= until + CLOCK_SKEW_MS {
                return Err(SamlError::Expired);
            }
            Ok(until)
        })();
        // The first confirmation that holds wins; otherwise the first refusal is reported.
        match (&confirmed, result) {
            (Some(Ok(_)), _) => {}
            (_, Ok(until)) => confirmed = Some(Ok(until)),
            (None, Err(e)) => confirmed = Some(Err(e)),
            (Some(Err(_)), Err(_)) => {}
        }
    }
    match confirmed {
        Some(Ok(until)) => not_on_or_after.push(until),
        Some(Err(e)) => return Err(e),
        None => return Err(SamlError::SubjectMissing),
    }

    // Conditions: the window and Kalzit as the audience of every restriction.
    let conditions = child(doc, assertion, ASSERTION, "Conditions").ok_or(SamlError::Audience)?;
    if let Some(from) = time_attr(doc, conditions, "NotBefore")?
        && now + CLOCK_SKEW_MS < from
    {
        return Err(SamlError::NotYetValid(((from - now) as f64 / 60_000.0).ceil() as i64));
    }
    if let Some(until) = time_attr(doc, conditions, "NotOnOrAfter")? {
        if now >= until + CLOCK_SKEW_MS {
            return Err(SamlError::Expired);
        }
        not_on_or_after.push(until);
    }
    let restrictions = children(doc, conditions, ASSERTION, "AudienceRestriction");
    if restrictions.is_empty() {
        return Err(SamlError::Audience);
    }
    for r in restrictions {
        let audiences: Vec<String> =
            children(doc, r, ASSERTION, "Audience").into_iter().filter_map(|a| text(doc, a)).collect();
        if !audiences.iter().any(|a| a == expected.sp_entity_id) {
            return Err(SamlError::Audience);
        }
    }

    // The authentication and the attributes.
    let statements = children(doc, assertion, ASSERTION, "AuthnStatement");
    if statements.is_empty() {
        return Err(SamlError::AuthnMissing);
    }
    let mut authn_contexts = Vec::new();
    for s in statements {
        if let Some(until) = time_attr(doc, s, "SessionNotOnOrAfter")?
            && now >= until + CLOCK_SKEW_MS
        {
            return Err(SamlError::Expired);
        }
        if let Some(class) = child(doc, s, ASSERTION, "AuthnContext")
            .and_then(|c| child(doc, c, ASSERTION, "AuthnContextClassRef"))
            .and_then(|c| text(doc, c))
        {
            authn_contexts.push(class);
        }
    }
    let mut attributes: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for statement in children(doc, assertion, ASSERTION, "AttributeStatement") {
        for a in children(doc, statement, ASSERTION, "Attribute") {
            let values: Vec<String> = children(doc, a, ASSERTION, "AttributeValue")
                .into_iter()
                .filter_map(|v| text(doc, v))
                .filter(|v| v.chars().count() <= 1024)
                .take(500)
                .collect();
            for key in [attr(doc, a, "Name"), attr(doc, a, "FriendlyName")].into_iter().flatten() {
                attributes.entry(key.to_string()).or_default().extend(values.iter().cloned());
            }
        }
    }
    let earliest = not_on_or_after.into_iter().min().unwrap_or(now);
    Ok(Asserted {
        assertion_id: assertion_id.to_string(),
        expires_ms: earliest + CLOCK_SKEW_MS,
        name_id,
        name_id_format,
        attributes,
        authn_contexts,
    })
}

/// The person of a checked assertion, as every provider kind hands it to `sso::signin`.
pub fn person(config: &SamlConfig, asserted: &Asserted) -> Person {
    let first = |name: &str| {
        asserted
            .attributes
            .get(name)
            .and_then(|v| v.iter().map(|s| s.trim()).find(|s| !s.is_empty()))
            .map(|s| s.chars().take(256).collect::<String>())
    };
    // The email attribute, else a NameID that is an email address.
    let raw_email = first(&config.email_attribute)
        .or_else(|| (asserted.name_id_format.as_deref() == Some(NAME_ID_EMAIL)).then(|| asserted.name_id.clone()));
    let email = raw_email.as_deref().and_then(matching_email);
    let email_as_typed = raw_email
        .as_deref()
        .filter(|e| matching_email(e).is_some())
        .and_then(|e| crate::routes::normalize_email(e).ok());
    // Group values are kept whole: an LDAP DN has commas.
    let mut groups: Vec<String> = asserted
        .attributes
        .get(&config.groups_attribute)
        .map(|v| v.iter().map(|g| g.trim().to_string()).collect())
        .unwrap_or_default();
    groups.retain(|g| !g.is_empty() && g.chars().count() <= 256 && !g.chars().any(char::is_control));
    groups.sort();
    groups.dedup();
    groups.truncate(500);
    let mfa_done = asserted.authn_contexts.iter().any(|c| MFA_CONTEXTS.contains(&c.as_str()));
    Person {
        subject: asserted.name_id.clone(),
        username: Some(asserted.name_id.chars().take(256).collect()),
        email,
        email_as_typed,
        // SAML has no "verified" flag: only the provider's switch says the address is checked.
        email_verified: config.trust_email,
        name: first(&config.name_attribute),
        groups,
        mfa_done,
    }
}

// ---------------------------------------------------------------------------------------------
// Requests and metadata

/// A fresh AuthnRequest ID: a letter first (xs:ID), then 160 random bits.
pub fn request_id() -> String {
    format!("_{}", hex::encode(rand::random::<[u8; 20]>()))
}

fn escape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for c in raw.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

fn xml_time(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// The URL that sends the browser to the provider with an AuthnRequest (HTTP-Redirect binding,
/// unsigned: Kalzit has no signing key of its own; the answer is what is checked).
pub fn redirect_url(
    config: &SamlConfig,
    sp_entity_id: &str,
    acs_url: &str,
    id: &str,
    now_ms: i64,
) -> Result<String, String> {
    let xml = format!(
        "<samlp:AuthnRequest xmlns:samlp=\"{PROTOCOL}\" xmlns:saml=\"{ASSERTION}\" ID=\"{}\" Version=\"2.0\" \
         IssueInstant=\"{}\" Destination=\"{}\" AssertionConsumerServiceURL=\"{}\" ProtocolBinding=\"{BINDING_POST}\">\
         <saml:Issuer>{}</saml:Issuer><samlp:NameIDPolicy AllowCreate=\"true\"/></samlp:AuthnRequest>",
        escape(id),
        xml_time(now_ms),
        escape(&config.sso_url),
        escape(acs_url),
        escape(sp_entity_id),
    );
    let params = gamlastan::bindings::RedirectEncodeParams {
        saml_xml: xml.as_bytes(),
        is_request: true,
        destination: &config.sso_url,
        relay_state: None,
        signer: None,
    };
    gamlastan::bindings::redirect_encode(&params).map_err(|e| e.to_string())
}

/// Kalzit's metadata for one provider: the entity ID and the ACS, signed assertions wanted.
pub fn sp_metadata(sp_entity_id: &str, acs_url: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <md:EntityDescriptor xmlns:md=\"{METADATA}\" entityID=\"{}\">\n\
         \x20 <md:SPSSODescriptor AuthnRequestsSigned=\"false\" WantAssertionsSigned=\"true\" \
         protocolSupportEnumeration=\"{PROTOCOL}\">\n\
         \x20   <md:NameIDFormat>{NAME_ID_PERSISTENT}</md:NameIDFormat>\n\
         \x20   <md:NameIDFormat>{NAME_ID_EMAIL}</md:NameIDFormat>\n\
         \x20   <md:AssertionConsumerService Binding=\"{BINDING_POST}\" Location=\"{}\" index=\"0\" isDefault=\"true\"/>\n\
         \x20 </md:SPSSODescriptor>\n\
         </md:EntityDescriptor>\n",
        escape(sp_entity_id),
        escape(acs_url),
    )
}

/// What a provider's metadata says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdpMetadata {
    pub entity_id: String,
    pub sso_url: String,
    /// Base64 DER, the signing certificates.
    pub certificates: Vec<String>,
}

/// Reads an IdP's metadata: an `EntityDescriptor`, or an `EntitiesDescriptor` with exactly one
/// identity provider.
pub fn parse_metadata(xml: &str) -> Result<IdpMetadata, String> {
    if xml.len() > MAX_METADATA_BYTES {
        return Err("the metadata is larger than 1 MB".into());
    }
    let doc = gamlastan::xml::parse_secure_metadata(xml.trim_start_matches('\u{feff}')).map_err(|e| e.to_string())?;
    let root = doc.document_element().ok_or("no document element")?;
    let entities: Vec<NodeId> = if element_is(&doc, root, METADATA, "EntityDescriptor") {
        vec![root]
    } else if element_is(&doc, root, METADATA, "EntitiesDescriptor") {
        doc.descendants(root).into_iter().filter(|&n| element_is(&doc, n, METADATA, "EntityDescriptor")).collect()
    } else {
        return Err("not SAML metadata (no EntityDescriptor)".into());
    };
    let idps: Vec<(NodeId, NodeId)> =
        entities.into_iter().filter_map(|e| child(&doc, e, METADATA, "IDPSSODescriptor").map(|d| (e, d))).collect();
    let [(entity, descriptor)] = idps[..] else {
        return Err(if idps.is_empty() {
            "the metadata describes no identity provider".into()
        } else {
            "the metadata describes several identity providers".into()
        });
    };
    let entity_id = attr(&doc, entity, "entityID").unwrap_or_default().trim().to_string();
    let sso_url = children(&doc, descriptor, METADATA, "SingleSignOnService")
        .into_iter()
        .find(|s| attr(&doc, *s, "Binding") == Some(BINDING_REDIRECT))
        .and_then(|s| attr(&doc, s, "Location"))
        .map(|l| l.trim().to_string())
        .ok_or("the provider offers no HTTP-Redirect sign-in")?;
    let mut certificates = Vec::new();
    for key in children(&doc, descriptor, METADATA, "KeyDescriptor") {
        if attr(&doc, key, "use").is_some_and(|u| u != "signing") {
            continue;
        }
        let found = child(&doc, key, DSIG, "KeyInfo")
            .into_iter()
            .flat_map(|i| children(&doc, i, DSIG, "X509Data"))
            .flat_map(|d| children(&doc, d, DSIG, "X509Certificate"))
            .filter_map(|c| text(&doc, c));
        for raw in found {
            let der = certificate_der(&raw).map_err(|e| format!("a certificate in the metadata: {e}"))?;
            let b64 = STANDARD.encode(der);
            if !certificates.contains(&b64) {
                certificates.push(b64);
            }
        }
    }
    if certificates.is_empty() {
        return Err("the metadata has no signing certificate".into());
    }
    if certificates.len() > MAX_CERTIFICATES {
        return Err(format!("the metadata has {} signing certificates; at most two are pinned", certificates.len()));
    }
    Ok(IdpMetadata { entity_id, sso_url, certificates })
}

/// A certificate as PEM or bare base64, as DER, checked to be an X.509 certificate.
pub fn certificate_der(raw: &str) -> Result<Vec<u8>, String> {
    let body: String = raw
        .lines()
        .map(str::trim)
        .filter(|l| !l.starts_with("-----"))
        .collect::<String>()
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    if body.is_empty() || body.len() > 64 * 1024 {
        return Err("not a certificate".into());
    }
    let der = STANDARD.decode(&body).map_err(|_| "not base64".to_string())?;
    x509_parser::parse_x509_certificate(&der).map_err(|e| format!("not an X.509 certificate: {e}"))?;
    Ok(der)
}

/// A certificate for the admin: its SHA-256 fingerprint, subject and end of validity.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateInfo {
    pub fingerprint: String,
    pub subject: String,
    pub not_after: i64,
    pub expired: bool,
}

pub fn certificate_info(b64: &str, now_ms: i64) -> Option<CertificateInfo> {
    let der = STANDARD.decode(b64).ok()?;
    let (_, cert) = x509_parser::parse_x509_certificate(&der).ok()?;
    let not_after = cert.validity().not_after.timestamp() * 1000;
    let fingerprint = Sha256::digest(&der).iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":");
    Some(CertificateInfo { fingerprint, subject: cert.subject().to_string(), not_after, expired: not_after <= now_ms })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_follow_the_public_url() {
        assert_eq!(sp_entity_id("https://k.example/sub/", "p"), "https://k.example/sub/auth/saml/p");
        assert_eq!(acs_url("https://k.example", "p"), "https://k.example/auth/saml/p/acs");
        assert_eq!(sp_metadata_url("https://k.example", "p"), "https://k.example/auth/saml/p/metadata");
    }

    #[test]
    fn metadata_is_escaped_and_parses() {
        let xml = sp_metadata("https://k.example/auth/saml/a&b", "https://k.example/acs?x=\"1\"");
        assert!(xml.contains("entityID=\"https://k.example/auth/saml/a&amp;b\""));
        assert!(gamlastan::xml::parse_secure_metadata(&xml).is_ok());
    }

    #[test]
    fn unsolicited_and_foreign_documents_are_named() {
        let unsolicited = format!("<samlp:Response xmlns:samlp=\"{PROTOCOL}\" ID=\"_r\" Version=\"2.0\"/>");
        assert_eq!(in_response_to(&unsolicited), Err(SamlError::Unsolicited));
        assert_eq!(in_response_to("<x/>"), Err(SamlError::NotResponse));
        let dtd = format!("<!DOCTYPE r [<!ENTITY e \"x\">]><samlp:Response xmlns:samlp=\"{PROTOCOL}\"/>");
        assert!(matches!(in_response_to(&dtd), Err(SamlError::XmlInvalid(_))));
        assert!(matches!(decode_post("%%%"), Err(SamlError::XmlInvalid(_))));
    }

    #[test]
    fn metadata_without_a_redirect_endpoint_or_certificate_is_refused() {
        let md = |inner: &str| {
            format!(
                "<md:EntityDescriptor xmlns:md=\"{METADATA}\" xmlns:ds=\"{DSIG}\" entityID=\"https://idp\">\
                 <md:IDPSSODescriptor protocolSupportEnumeration=\"{PROTOCOL}\">{inner}</md:IDPSSODescriptor>\
                 </md:EntityDescriptor>"
            )
        };
        let post_only = format!("<md:SingleSignOnService Binding=\"{BINDING_POST}\" Location=\"https://idp/sso\"/>");
        assert!(parse_metadata(&md(&post_only)).unwrap_err().contains("HTTP-Redirect"));
        let no_cert = format!("<md:SingleSignOnService Binding=\"{BINDING_REDIRECT}\" Location=\"https://idp/sso\"/>");
        assert!(parse_metadata(&md(&no_cert)).unwrap_err().contains("certificate"));
    }

    #[test]
    fn several_factors_come_from_the_authn_context_only() {
        let config = SamlConfig {
            metadata_url: String::new(),
            idp_entity_id: "https://idp".into(),
            sso_url: "https://idp/sso".into(),
            certificates: vec![],
            email_attribute: "mail".into(),
            name_attribute: "displayName".into(),
            groups_attribute: "memberOf".into(),
            trust_email: false,
        };
        let mut asserted = Asserted {
            assertion_id: "_a".into(),
            expires_ms: 0,
            name_id: "lea@example.de".into(),
            name_id_format: Some(NAME_ID_EMAIL.into()),
            attributes: BTreeMap::from([(
                "memberOf".to_string(),
                vec!["CN=Vertrieb,OU=Gruppen,DC=example".to_string(), " ".to_string()],
            )]),
            authn_contexts: vec!["urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport".into()],
        };
        let p = person(&config, &asserted);
        assert_eq!(p.email.as_deref(), Some("lea@example.de"));
        assert!(!p.email_verified && !p.mfa_done);
        assert_eq!(p.groups, vec!["CN=Vertrieb,OU=Gruppen,DC=example"]);
        // Entra ID's attribute is not the signed context: it never counts.
        asserted.attributes.insert(
            "http://schemas.microsoft.com/claims/authnmethodsreferences".into(),
            vec!["http://schemas.microsoft.com/claims/multipleauthn".into()],
        );
        assert!(!person(&config, &asserted).mfa_done);
        asserted.authn_contexts.push("http://schemas.microsoft.com/claims/multipleauthn".into());
        assert!(person(&config, &asserted).mfa_done);
    }

    #[test]
    fn only_known_status_codes_are_reported() {
        let refused = "urn:oasis:names:tc:SAML:2.0:status:AuthnFailed";
        assert_eq!(known_status(refused), refused);
        assert_eq!(known_status("urn:oasis:names:tc:SAML:2.0:status:Made\nUp"), "other");
        assert_eq!(known_status("evil\u{1b}[31m"), "other");
    }
}
