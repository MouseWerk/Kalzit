//! ID tokens (JSON Web Tokens, RFC 7519) of identity providers: the signature with a key of the
//! provider's key set (JWKS, RFC 7517), then the claims OpenID Connect requires (issuer, audience,
//! times, nonce). Only signed tokens in the compact form; `none` and HMAC algorithms are refused,
//! since a client secret must never be what proves a provider's answer.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::signature;
use serde::Deserialize;
use serde_json::{Map, Value};

/// Clock skew allowed between Kalzit and the provider, for `exp`, `iat` and `nbf`.
pub const LEEWAY_SECS: i64 = 120;
/// Larger tokens are refused before they are parsed.
pub const MAX_TOKEN_BYTES: usize = 64 * 1024;

/// Why a token was refused. The texts go to the audit log for admins, never to the person.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TokenError {
    #[error("the ID token is not a signed JWT: {0}")]
    Malformed(&'static str),
    #[error("the ID token uses the algorithm {0}, which Kalzit does not accept")]
    Algorithm(String),
    #[error("no key of the provider matches the ID token (kid {0:?})")]
    UnknownKey(Option<String>),
    #[error("the signature of the ID token is not valid")]
    Signature,
    #[error("the ID token was issued by {0:?}, not by the provider's issuer")]
    Issuer(Option<String>),
    #[error("the ID token is not meant for this client")]
    Audience,
    #[error("the ID token has expired")]
    Expired,
    #[error("the ID token is not valid yet (its time is ahead of this server)")]
    NotYetValid,
    #[error("the ID token does not carry the nonce of this sign-in")]
    Nonce,
    #[error("the ID token has no subject")]
    Subject,
}

/// One key of a JWKS, as far as Kalzit uses it.
#[derive(Debug, Clone, Deserialize)]
pub struct Jwk {
    pub kty: String,
    #[serde(default)]
    pub kid: Option<String>,
    #[serde(default, rename = "use")]
    pub use_: Option<String>,
    #[serde(default)]
    pub alg: Option<String>,
    #[serde(default)]
    pub n: Option<String>,
    #[serde(default)]
    pub e: Option<String>,
    #[serde(default)]
    pub crv: Option<String>,
    #[serde(default)]
    pub x: Option<String>,
    #[serde(default)]
    pub y: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct JwkSet {
    #[serde(default)]
    pub keys: Vec<Jwk>,
}

impl JwkSet {
    /// The keys that can check signatures: not marked for encryption, of a kind Kalzit knows.
    pub fn usable(&self) -> usize {
        self.keys.iter().filter(|k| k.use_.as_deref() != Some("enc") && key_bytes(k).is_some()).count()
    }
}

/// The algorithms Kalzit accepts, with the key type each needs.
fn algorithm(alg: &str) -> Option<(&'static dyn signature::VerificationAlgorithm, &'static str)> {
    Some(match alg {
        "RS256" => (&signature::RSA_PKCS1_2048_8192_SHA256, "RSA"),
        "RS384" => (&signature::RSA_PKCS1_2048_8192_SHA384, "RSA"),
        "RS512" => (&signature::RSA_PKCS1_2048_8192_SHA512, "RSA"),
        "PS256" => (&signature::RSA_PSS_2048_8192_SHA256, "RSA"),
        "PS384" => (&signature::RSA_PSS_2048_8192_SHA384, "RSA"),
        "PS512" => (&signature::RSA_PSS_2048_8192_SHA512, "RSA"),
        "ES256" => (&signature::ECDSA_P256_SHA256_FIXED, "EC:P-256"),
        "ES384" => (&signature::ECDSA_P384_SHA384_FIXED, "EC:P-384"),
        "EdDSA" => (&signature::ED25519, "OKP:Ed25519"),
        _ => return None,
    })
}

/// The public key in the form ring reads, with its type (`RSA`, `EC:<curve>`, `OKP:<curve>`).
enum KeyBytes {
    Rsa { n: Vec<u8>, e: Vec<u8> },
    Raw(Vec<u8>),
}

fn key_bytes(jwk: &Jwk) -> Option<(String, KeyBytes)> {
    let b64 = |s: &Option<String>| s.as_deref().and_then(|v| URL_SAFE_NO_PAD.decode(v).ok());
    match jwk.kty.as_str() {
        "RSA" => Some(("RSA".into(), KeyBytes::Rsa { n: b64(&jwk.n)?, e: b64(&jwk.e)? })),
        "EC" => {
            let crv = jwk.crv.as_deref()?;
            let (x, y) = (b64(&jwk.x)?, b64(&jwk.y)?);
            let len = match crv {
                "P-256" => 32,
                "P-384" => 48,
                _ => return None,
            };
            if x.len() != len || y.len() != len {
                return None;
            }
            // The uncompressed point: 0x04, x, y.
            let mut point = Vec::with_capacity(1 + 2 * len);
            point.push(4);
            point.extend_from_slice(&x);
            point.extend_from_slice(&y);
            Some((format!("EC:{crv}"), KeyBytes::Raw(point)))
        }
        "OKP" => {
            let crv = jwk.crv.as_deref()?;
            (crv == "Ed25519").then_some(())?;
            Some(("OKP:Ed25519".into(), KeyBytes::Raw(b64(&jwk.x)?)))
        }
        _ => None,
    }
}

/// The parts of a token before its signature is checked.
pub struct Parsed {
    pub alg: String,
    pub kid: Option<String>,
    signed: Vec<u8>,
    signature: Vec<u8>,
    claims: Map<String, Value>,
}

pub fn parse(token: &str) -> Result<Parsed, TokenError> {
    if token.len() > MAX_TOKEN_BYTES {
        return Err(TokenError::Malformed("too large"));
    }
    let mut parts = token.split('.');
    let (Some(header), Some(payload), Some(sig), None) = (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(TokenError::Malformed("not three parts"));
    };
    let decode = |s: &str| URL_SAFE_NO_PAD.decode(s).map_err(|_| TokenError::Malformed("not base64url"));
    let header: Map<String, Value> =
        serde_json::from_slice(&decode(header)?).map_err(|_| TokenError::Malformed("header is not JSON"))?;
    let claims: Map<String, Value> =
        serde_json::from_slice(&decode(payload)?).map_err(|_| TokenError::Malformed("claims are not JSON"))?;
    // Nested or encrypted tokens are not ID tokens Kalzit reads.
    if header.contains_key("crit") || header.get("enc").is_some() {
        return Err(TokenError::Malformed("unsupported header"));
    }
    let alg = header.get("alg").and_then(Value::as_str).ok_or(TokenError::Malformed("no alg"))?.to_string();
    let kid = header.get("kid").and_then(Value::as_str).map(str::to_string);
    let signed = token.as_bytes()[..token.len() - sig.len() - 1].to_vec();
    Ok(Parsed { alg, kid, signed, signature: decode(sig)?, claims })
}

impl Parsed {
    /// Checks the signature with a key of `keys`: the one named by `kid`, or without `kid` every
    /// key of the algorithm's type. `Err(UnknownKey)` means no key fits, so a reload of the key
    /// set may help.
    pub fn verify(&self, keys: &JwkSet) -> Result<(), TokenError> {
        let (alg, kty) = algorithm(&self.alg).ok_or_else(|| TokenError::Algorithm(self.alg.clone()))?;
        let candidates = keys.keys.iter().filter(|k| {
            k.use_.as_deref() != Some("enc")
                && k.alg.as_deref().is_none_or(|a| a == self.alg)
                && match (&self.kid, &k.kid) {
                    (Some(want), Some(have)) => want == have,
                    (Some(_), None) => true,
                    (None, _) => true,
                }
        });
        let mut tried = false;
        for jwk in candidates {
            let Some((ty, bytes)) = key_bytes(jwk) else { continue };
            if ty != kty {
                continue;
            }
            tried = true;
            let ok = match bytes {
                KeyBytes::Rsa { n, e } => {
                    let params = match self.alg.as_str() {
                        "RS256" => &signature::RSA_PKCS1_2048_8192_SHA256,
                        "RS384" => &signature::RSA_PKCS1_2048_8192_SHA384,
                        "RS512" => &signature::RSA_PKCS1_2048_8192_SHA512,
                        "PS256" => &signature::RSA_PSS_2048_8192_SHA256,
                        "PS384" => &signature::RSA_PSS_2048_8192_SHA384,
                        _ => &signature::RSA_PSS_2048_8192_SHA512,
                    };
                    signature::RsaPublicKeyComponents { n: &n, e: &e }
                        .verify(params, &self.signed, &self.signature)
                        .is_ok()
                }
                KeyBytes::Raw(raw) => {
                    signature::UnparsedPublicKey::new(alg, raw).verify(&self.signed, &self.signature).is_ok()
                }
            };
            if ok {
                return Ok(());
            }
        }
        if tried { Err(TokenError::Signature) } else { Err(TokenError::UnknownKey(self.kid.clone())) }
    }

    /// The claims, once `verify` passed and they were checked with `check_claims`.
    pub fn claims(&self) -> &Map<String, Value> {
        &self.claims
    }
}

/// What an ID token must say (OpenID Connect Core 1.0, 3.1.3.7).
pub struct Expected<'a> {
    pub issuer: &'a str,
    pub client_id: &'a str,
    pub nonce: &'a str,
    pub now_secs: i64,
}

pub fn check_claims(claims: &Map<String, Value>, want: &Expected<'_>) -> Result<(), TokenError> {
    let iss = claims.get("iss").and_then(Value::as_str);
    if iss != Some(want.issuer) {
        return Err(TokenError::Issuer(iss.map(str::to_string)));
    }
    let audiences: Vec<&str> = match claims.get("aud") {
        Some(Value::String(a)) => vec![a.as_str()],
        Some(Value::Array(list)) => list.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    if !audiences.contains(&want.client_id) {
        return Err(TokenError::Audience);
    }
    // With several audiences the authorized party must be this client.
    let azp = claims.get("azp").and_then(Value::as_str);
    if (audiences.len() > 1 || azp.is_some()) && azp.is_some_and(|a| a != want.client_id) {
        return Err(TokenError::Audience);
    }
    if audiences.len() > 1 && azp.is_none() {
        return Err(TokenError::Audience);
    }
    let time = |name: &str| claims.get(name).and_then(Value::as_f64).map(|t| t as i64);
    match time("exp") {
        Some(exp) if exp + LEEWAY_SECS > want.now_secs => {}
        _ => return Err(TokenError::Expired),
    }
    for name in ["iat", "nbf"] {
        if time(name).is_some_and(|t| t - LEEWAY_SECS > want.now_secs) {
            return Err(TokenError::NotYetValid);
        }
    }
    if claims.get("nonce").and_then(Value::as_str) != Some(want.nonce) {
        return Err(TokenError::Nonce);
    }
    match claims.get("sub").and_then(Value::as_str) {
        Some(sub) if !sub.is_empty() && sub.len() <= 255 => Ok(()),
        _ => Err(TokenError::Subject),
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{EcdsaKeyPair, Ed25519KeyPair, KeyPair};
    use serde_json::json;

    /// An ES256 key pair for tests, with its JWK.
    pub struct TestKey {
        pair: EcdsaKeyPair,
        pub kid: String,
    }

    impl TestKey {
        pub fn new(kid: &str) -> Self {
            let rng = SystemRandom::new();
            let pkcs8 = EcdsaKeyPair::generate_pkcs8(&signature::ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
            let pair =
                EcdsaKeyPair::from_pkcs8(&signature::ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng).unwrap();
            Self { pair, kid: kid.into() }
        }

        pub fn jwk(&self) -> Value {
            let point = self.pair.public_key().as_ref();
            json!({ "kty": "EC", "crv": "P-256", "kid": self.kid, "use": "sig", "alg": "ES256",
                    "x": URL_SAFE_NO_PAD.encode(&point[1..33]), "y": URL_SAFE_NO_PAD.encode(&point[33..65]) })
        }

        pub fn sign(&self, claims: &Value) -> String {
            let header = json!({ "alg": "ES256", "typ": "JWT", "kid": self.kid });
            let signed = format!(
                "{}.{}",
                URL_SAFE_NO_PAD.encode(header.to_string()),
                URL_SAFE_NO_PAD.encode(claims.to_string())
            );
            let sig = self.pair.sign(&SystemRandom::new(), signed.as_bytes()).unwrap();
            format!("{signed}.{}", URL_SAFE_NO_PAD.encode(sig.as_ref()))
        }
    }

    fn set(keys: &[Value]) -> JwkSet {
        serde_json::from_value(json!({ "keys": keys })).unwrap()
    }

    fn claims(now: i64) -> Value {
        json!({ "iss": "https://idp.example", "aud": "kalzit", "sub": "u-1", "nonce": "n-1",
                "iat": now, "exp": now + 300 })
    }

    fn expected(now: i64) -> Expected<'static> {
        Expected { issuer: "https://idp.example", client_id: "kalzit", nonce: "n-1", now_secs: now }
    }

    #[test]
    fn a_signed_token_passes_with_its_key() {
        let key = TestKey::new("k1");
        let token = key.sign(&claims(1000));
        let parsed = parse(&token).unwrap();
        assert_eq!(parsed.alg, "ES256");
        parsed.verify(&set(&[key.jwk()])).unwrap();
        check_claims(parsed.claims(), &expected(1000)).unwrap();
    }

    #[test]
    fn another_key_or_a_changed_payload_fails() {
        let key = TestKey::new("k1");
        let other = TestKey::new("k1");
        let token = key.sign(&claims(1000));
        assert_eq!(parse(&token).unwrap().verify(&set(&[other.jwk()])), Err(TokenError::Signature));
        // A rotated key set without the token's key: a reload may help.
        let rotated = TestKey::new("k2");
        assert_eq!(
            parse(&token).unwrap().verify(&set(&[rotated.jwk()])),
            Err(TokenError::UnknownKey(Some("k1".into())))
        );
        // Both keys while the provider rotates: the right one is found by kid.
        parse(&token).unwrap().verify(&set(&[rotated.jwk(), key.jwk()])).unwrap();
        let mut parts: Vec<String> = token.split('.').map(str::to_string).collect();
        let mut forged = claims(1000);
        forged["sub"] = json!("admin");
        parts[1] = URL_SAFE_NO_PAD.encode(forged.to_string());
        assert_eq!(parse(&parts.join(".")).unwrap().verify(&set(&[key.jwk()])), Err(TokenError::Signature));
    }

    #[test]
    fn none_and_hmac_are_refused() {
        let key = TestKey::new("k1");
        for alg in ["none", "HS256"] {
            let header = URL_SAFE_NO_PAD.encode(json!({ "alg": alg }).to_string());
            let payload = URL_SAFE_NO_PAD.encode(claims(1000).to_string());
            let token = format!("{header}.{payload}.");
            assert_eq!(parse(&token).unwrap().verify(&set(&[key.jwk()])), Err(TokenError::Algorithm(alg.into())));
        }
        assert!(matches!(parse("a.b"), Err(TokenError::Malformed(_))));
    }

    #[test]
    fn eddsa_tokens_are_checked() {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let header = URL_SAFE_NO_PAD.encode(json!({ "alg": "EdDSA", "kid": "ed" }).to_string());
        let signed = format!("{header}.{}", URL_SAFE_NO_PAD.encode(claims(1).to_string()));
        let token = format!("{signed}.{}", URL_SAFE_NO_PAD.encode(pair.sign(signed.as_bytes()).as_ref()));
        let jwk = json!({ "kty": "OKP", "crv": "Ed25519", "kid": "ed",
                          "x": URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()) });
        parse(&token).unwrap().verify(&set(&[jwk])).unwrap();
    }

    /// RS256 against a fixed RSA key (RFC 7515, appendix A.2), so the RSA path is covered too.
    #[test]
    fn rs256_from_rfc_7515_verifies() {
        let token = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.cC4hiUPoj9Eetdgtv3hF80EGrhuB__dzERat0XF9g2VtQgr9PJbu3XOiZj5RZmh7AAuHIm4Bh-0Qc_lF5YKt_O8W2Fp5jujGbds9uJdbF9CUAr7t1dnZcAcQjbKBYNX4BAynRFdiuB--f_nZLgrnbyTyWzO75vRK5h6xBArLIARNPvkSjtQBMHlb1L07Qe7K0GarZRmB_eSN9383LcOLn6_dO--xi12jzDwusC-eOkHWEsqtFZESc6BfI7noOPqvhJ1phCnvWh6IeYI2w9QOYEUipUTI8np6LbgGY9Fs98rqVt5AXLIhWkWywlVmtVrBp0igcN_IoypGlUPQGe77Rw";
        let jwk = json!({ "kty": "RSA",
            "n": "ofgWCuLjybRlzo0tZWJjNiuSfb4p4fAkd_wWJcyQoTbji9k0l8W26mPddxHmfHQp-Vaw-4qPCJrcS2mJPMEzP1Pt0Bm4d4QlL-yRT-SFd2lZS-pCgNMsD1W_YpRPEwOWvG6b32690r2jZ47soMZo9wGzjb_7OMg0LOL-bSf63kpaSHSXndS5z5rexMdbBYUsLA9e-KXBdQOS-UTo7WTBEMa2R2CapHg665xsmtdVMTBQY4uDZlxvb3qCo5ZwKh9kG4LT6_I5IhlJH7aGhyxXFvUK-DWNmoudF8NAco9_h9iaGNj8q2ethFkMLs91kzk2PAcDTW9gb54h4FRWyuXpoQ",
            "e": "AQAB" });
        parse(token).unwrap().verify(&set(&[jwk])).unwrap();
    }

    #[test]
    fn claims_are_checked() {
        let base = claims(1000);
        let check = |c: &Value, now: i64| check_claims(c.as_object().unwrap(), &expected(now));
        check(&base, 1000).unwrap();
        let mut c = base.clone();
        c["iss"] = json!("https://evil.example");
        assert!(matches!(check(&c, 1000), Err(TokenError::Issuer(_))));
        let mut c = base.clone();
        c["aud"] = json!("other");
        assert_eq!(check(&c, 1000), Err(TokenError::Audience));
        let mut c = base.clone();
        c["aud"] = json!(["kalzit", "other"]);
        assert_eq!(check(&c, 1000), Err(TokenError::Audience), "several audiences need azp");
        c["azp"] = json!("kalzit");
        check(&c, 1000).unwrap();
        c["azp"] = json!("other");
        assert_eq!(check(&c, 1000), Err(TokenError::Audience));
        // Expiry with the allowed skew.
        check(&base, 1000 + 300 + LEEWAY_SECS - 1).unwrap();
        assert_eq!(check(&base, 1000 + 300 + LEEWAY_SECS), Err(TokenError::Expired));
        let mut c = base.clone();
        c.as_object_mut().unwrap().remove("exp");
        assert_eq!(check(&c, 1000), Err(TokenError::Expired));
        assert_eq!(check(&base, 1000 - LEEWAY_SECS - 1), Err(TokenError::NotYetValid));
        let mut c = base.clone();
        c["nonce"] = json!("n-2");
        assert_eq!(check(&c, 1000), Err(TokenError::Nonce));
        let mut c = base;
        c["sub"] = json!("");
        assert_eq!(check(&c, 1000), Err(TokenError::Subject));
    }
}
