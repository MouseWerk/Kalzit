//! Passkeys (WebAuthn) as a second factor, through webauthn-rs.
//!
//! The relying party is the host people open Kalzit on: `server.public_url` when it is set,
//! otherwise the host of the request (`RequestInfo::host`) with its scheme. Its id is that host
//! name, so a passkey works on one address only; an IP address cannot carry passkeys (browsers
//! refuse them). Registrations ask for no attestation and prefer user verification (a PIN,
//! fingerprint or face, where the authenticator has one); sign counters are checked by
//! webauthn-rs, and a counter that goes backwards refuses the passkey (a cloned authenticator).
//!
//! webauthn-rs calls these credentials "security keys": a factor next to the password, with user
//! verification preferred rather than required. The hint it adds for hardware keys is removed
//! from the options, so browsers offer passkeys on the device and the phone as well.

use url::Url;
use webauthn_rs::prelude::{
    CreationChallengeResponse, CredentialID, PublicKeyCredential, RegisterPublicKeyCredential,
    RequestChallengeResponse, SecurityKey, SecurityKeyAuthentication, SecurityKeyRegistration, Uuid, Webauthn,
    WebauthnBuilder,
};

use crate::error::{ApiError, ApiResult};
use crate::net::RequestInfo;

/// How long the browser's dialog may stay open.
const CEREMONY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

fn host_unusable() -> ApiError {
    ApiError::validation("passkeys need Kalzit to be opened by a host name, not an IP address")
        .because("second_factor.passkey_host")
}

/// The relying party of this request.
pub fn relying_party(public_url: Option<&str>, info: &RequestInfo, name: &str) -> ApiResult<Webauthn> {
    let origin = match public_url {
        Some(url) => Url::parse(url).map_err(|_| host_unusable())?,
        None => {
            let host = info.host.as_deref().ok_or_else(host_unusable)?;
            let scheme = if info.https { "https" } else { "http" };
            Url::parse(&format!("{scheme}://{host}")).map_err(|_| host_unusable())?
        }
    };
    // `domain` is `None` for IP addresses.
    let rp_id = origin.domain().ok_or_else(host_unusable)?.to_string();
    WebauthnBuilder::new(&rp_id, &origin)
        .map_err(|_| host_unusable())?
        .rp_name(name)
        .timeout(CEREMONY_TIMEOUT)
        .build()
        .map_err(|_| host_unusable())
}

/// Options for `navigator.credentials.create` and the state to keep until the answer.
pub fn start_registration(
    rp: &Webauthn,
    user_id: &str,
    email: &str,
    name: &str,
    existing: &[SecurityKey],
) -> ApiResult<(CreationChallengeResponse, SecurityKeyRegistration)> {
    let user = Uuid::parse_str(user_id).map_err(|e| ApiError::internal("passkey registration", e))?;
    // The same authenticator twice is refused by the browser.
    let exclude: Vec<CredentialID> = existing.iter().map(|k| k.cred_id().clone()).collect();
    let (mut options, state) = rp
        .start_securitykey_registration(user, email, name, Some(exclude), None, None)
        .map_err(|e| ApiError::internal("passkey registration", e))?;
    options.public_key.hints = None;
    Ok((options, state))
}

/// The new passkey, or a `validation` error when the browser's answer does not hold.
pub fn finish_registration(
    rp: &Webauthn,
    answer: &RegisterPublicKeyCredential,
    state: &SecurityKeyRegistration,
) -> ApiResult<SecurityKey> {
    rp.finish_securitykey_registration(answer, state).map_err(|e| {
        tracing::info!("passkey registration refused: {e}");
        ApiError::validation("the passkey could not be registered").because("second_factor.passkey_refused")
    })
}

/// Options for `navigator.credentials.get` with the account's passkeys, and the state to keep.
pub fn start_authentication(
    rp: &Webauthn,
    keys: &[SecurityKey],
) -> ApiResult<(RequestChallengeResponse, SecurityKeyAuthentication)> {
    let (mut options, state) =
        rp.start_securitykey_authentication(keys).map_err(|e| ApiError::internal("passkey sign-in", e))?;
    options.public_key.hints = None;
    Ok((options, state))
}

/// The result of an assertion: which passkey signed, and its new counter to store. `None` when
/// the assertion does not hold (wrong challenge, origin, signature, or a counter that went back).
pub fn finish_authentication(
    rp: &Webauthn,
    answer: &PublicKeyCredential,
    state: &SecurityKeyAuthentication,
) -> Option<webauthn_rs::prelude::AuthenticationResult> {
    match rp.finish_securitykey_authentication(answer, state) {
        Ok(result) => Some(result),
        Err(e) => {
            tracing::info!("passkey sign-in refused: {e}");
            None
        }
    }
}

/// The id webauthn-rs gives a credential, as stored next to it (base64url).
pub fn credential_key(id: &CredentialID) -> String {
    data_encoding::BASE64URL_NOPAD.encode(id.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(host: Option<&str>, https: bool) -> RequestInfo {
        RequestInfo { client_ip: "127.0.0.1".parse().unwrap(), https, host: host.map(str::to_string) }
    }

    #[test]
    fn the_relying_party_is_the_host_people_open() {
        assert!(relying_party(Some("https://kalzit.example.com"), &info(Some("other"), false), "Kalzit").is_ok());
        assert!(relying_party(None, &info(Some("kalzit.test:8080"), false), "Kalzit").is_ok());
        assert!(relying_party(None, &info(Some("localhost:3999"), false), "Kalzit").is_ok());
        let ip = relying_party(None, &info(Some("10.0.0.5:3000"), false), "Kalzit").err().unwrap();
        assert_eq!(ip.reason.unwrap().code, "second_factor.passkey_host");
        assert!(relying_party(None, &info(None, false), "Kalzit").is_err());
    }
}
