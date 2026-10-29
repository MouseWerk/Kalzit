//! One certificate order (RFC 8555): the account (stored, or registered on first use), the order
//! for the configured names, a challenge per name answered by this server (HTTP-01 on the HTTP
//! listener, TLS-ALPN-01 on the HTTPS listener), then the certificate request with a new key.

use std::path::Path;
use std::time::Duration;

use instant_acme::{
    Account, AccountCredentials, AuthorizationStatus, ChallengeType, Identifier, NewAccount, NewOrder, OrderStatus,
    RetryPolicy,
};

use super::settings::{AcmeSettings, Challenge};
use super::store::{self, StoredAccount, StoredCertificate};
use super::transport::Transport;
use super::{Acme, Failure};
use crate::secrets::Keyring;

/// How long the CA gets to validate every name, and to issue once the request is sent.
const VALIDATION_TIMEOUT: Duration = Duration::from_secs(120);
const ISSUE_TIMEOUT: Duration = Duration::from_secs(120);
const ACCOUNT_DOES_NOT_EXIST: &str = "urn:ietf:params:acme:error:accountDoesNotExist";
const RATE_LIMITED: &str = "urn:ietf:params:acme:error:rateLimited";

pub struct Context<'a> {
    pub data_dir: &'a Path,
    pub db_url: &'a str,
    pub keyring: &'a Keyring,
    pub now_ms: i64,
    /// Several servers on one database (`cluster`): the challenge answers go to the database
    /// too, so the server the certificate authority reaches answers.
    pub shared: Option<Shared<'a>>,
}

#[derive(Clone, Copy)]
pub struct Shared<'a> {
    pub db: &'a sqlx::AnyPool,
    pub cluster: &'a crate::cluster::Cluster,
}

/// How long the leader waits after sharing a TLS-ALPN-01 answer before it lets the CA validate:
/// the other servers load it when the change reaches them (at once by NOTIFY, else at their
/// next poll).
const ALPN_SPREAD: Duration = Duration::from_secs(6);

impl Shared<'_> {
    async fn answer(&self, kind: &str, name: &str, value: &str, now_ms: i64) -> Result<(), Failure> {
        sqlx::query(
            "INSERT INTO acme_challenges (kind, name, value, created_at) VALUES ($1, $2, $3, $4) \
             ON CONFLICT (kind, name) DO UPDATE SET value = excluded.value, created_at = excluded.created_at",
        )
        .bind(kind)
        .bind(name)
        .bind(value)
        .bind(now_ms)
        .execute(self.db)
        .await
        .map_err(|e| {
            Failure::new("acme.challenge_not_shared", format!("sharing the challenge answer: {e}")).with("detail", e)
        })?;
        self.cluster.publish(crate::cluster::Change::AcmeChallenges);
        Ok(())
    }

    /// Removes every shared answer: one order runs at a time, on the leader.
    async fn clear(&self) {
        if let Err(e) = sqlx::query("DELETE FROM acme_challenges").execute(self.db).await {
            tracing::warn!("removing the shared challenge answers: {e}");
        }
        self.cluster.publish(crate::cluster::Change::AcmeChallenges);
    }
}

/// Orders a certificate for `settings`. The challenge answers are removed again whatever
/// happens.
pub async fn obtain(acme: &Acme, settings: &AcmeSettings, cx: &Context<'_>) -> Result<StoredCertificate, Failure> {
    let mut answered = Answered { acme, http: Vec::new(), alpn: Vec::new() };
    let result = order(acme, settings, cx, &mut answered).await;
    drop(answered);
    if let Some(shared) = &cx.shared {
        shared.clear().await;
    }
    result
}

/// The challenge answers set up so far, removed when dropped.
struct Answered<'a> {
    acme: &'a Acme,
    http: Vec<String>,
    alpn: Vec<String>,
}

impl Drop for Answered<'_> {
    fn drop(&mut self) {
        for token in &self.http {
            self.acme.remove_http_challenge(token);
        }
        for domain in &self.alpn {
            self.acme.certificates.remove_challenge(domain);
        }
    }
}

async fn order(
    acme: &Acme,
    settings: &AcmeSettings,
    cx: &Context<'_>,
    answered: &mut Answered<'_>,
) -> Result<StoredCertificate, Failure> {
    let url = settings.directory_url().to_string();
    let transport = Transport::new(cx.data_dir, cx.db_url, settings.directory_ca())
        .map_err(|e| Failure::new("acme.directory_unreachable", e.to_string()))?;
    let identifiers: Vec<Identifier> = settings.domains.iter().map(|d| Identifier::Dns(d.clone())).collect();

    let mut account = account(&transport, settings, cx, false).await?;
    let mut order = match account.new_order(&NewOrder::new(&identifiers)).await {
        Err(instant_acme::Error::Api(problem)) if problem.r#type.as_deref() == Some(ACCOUNT_DOES_NOT_EXIST) => {
            // The CA forgot the account (a reset test CA, a deactivated account): register again.
            store::remove_account(cx.data_dir, &url);
            account = self::account(&transport, settings, cx, true).await?;
            account.new_order(&NewOrder::new(&identifiers)).await.map_err(|e| failure("acme.order_failed", e))?
        }
        other => other.map_err(|e| failure("acme.order_failed", e))?,
    };

    let wanted = match settings.challenge {
        Challenge::Http01 => ChallengeType::Http01,
        Challenge::TlsAlpn01 => ChallengeType::TlsAlpn01,
    };
    let mut authorizations = order.authorizations();
    while let Some(result) = authorizations.next().await {
        let mut authz = result.map_err(|e| failure("acme.order_failed", e))?;
        let domain = authz.identifier().to_string();
        match authz.status {
            AuthorizationStatus::Valid => continue,
            AuthorizationStatus::Pending => {}
            other => {
                return Err(Failure::new(
                    "acme.validation_failed",
                    format!("{domain}: the authorization is {other:?}"),
                )
                .with("domain", &domain));
            }
        }
        let mut challenge = authz.challenge(wanted.clone()).ok_or_else(|| {
            Failure::new(
                "acme.challenge_unsupported",
                format!("the CA does not offer {} for {domain}", settings.challenge.name()),
            )
            .with("challenge", settings.challenge.name())
        })?;
        let key_authorization = challenge.key_authorization();
        match settings.challenge {
            Challenge::Http01 => {
                acme.add_http_challenge(&challenge.token, key_authorization.as_str());
                answered.http.push(challenge.token.clone());
                if let Some(shared) = &cx.shared {
                    shared.answer("http", &challenge.token, key_authorization.as_str(), cx.now_ms).await?;
                }
            }
            Challenge::TlsAlpn01 => {
                let digest = key_authorization.digest();
                acme.certificates
                    .add_challenge(&domain, digest.as_ref())
                    .map_err(|e| Failure::new("acme.certificate_failed", format!("{e:#}")))?;
                answered.alpn.push(domain.clone());
                if let Some(shared) = &cx.shared {
                    shared.answer("alpn", &domain, &hex::encode(digest.as_ref()), cx.now_ms).await?;
                    tokio::time::sleep(ALPN_SPREAD).await;
                }
            }
        }
        challenge.set_ready().await.map_err(|e| failure("acme.validation_failed", e).with("domain", &domain))?;
    }

    let polling = RetryPolicy::new().initial_delay(Duration::from_secs(1)).backoff(1.5).timeout(VALIDATION_TIMEOUT);
    let status = order.poll_ready(&polling).await.map_err(|e| failure("acme.validation_failed", e))?;
    if status != OrderStatus::Ready {
        return Err(validation_problem(&mut order).await);
    }
    let key_pem = order.finalize().await.map_err(|e| failure("acme.certificate_failed", e))?;
    let issuing = RetryPolicy::new().initial_delay(Duration::from_secs(1)).backoff(1.5).timeout(ISSUE_TIMEOUT);
    let chain_pem = order.poll_certificate(&issuing).await.map_err(|e| failure("acme.certificate_failed", e))?;
    let (not_before_ms, not_after_ms, issuer) =
        validity(&chain_pem).map_err(|e| Failure::new("acme.certificate_failed", e))?;
    super::resolver::from_pem(&chain_pem, &key_pem)
        .map_err(|e| Failure::new("acme.certificate_failed", format!("{e:#}")))?;
    Ok(StoredCertificate {
        directory_url: url,
        domains: settings.domains.clone(),
        chain_pem,
        key_pem,
        not_before_ms,
        not_after_ms,
        issuer,
        issued_at_ms: cx.now_ms,
    })
}

/// The stored account of this directory, or a new one. A changed contact is sent to the CA.
async fn account(
    transport: &Transport,
    settings: &AcmeSettings,
    cx: &Context<'_>,
    fresh: bool,
) -> Result<Account, Failure> {
    let url = settings.directory_url().to_string();
    let contact = if settings.email.is_empty() { String::new() } else { format!("mailto:{}", settings.email) };
    let stored = if fresh {
        None
    } else {
        store::load_account(cx.data_dir, cx.keyring, &url).unwrap_or_else(|e| {
            tracing::warn!("the stored ACME account cannot be used, registering a new one: {e:#}");
            None
        })
    };
    if let Some(stored) = stored
        && let Ok(credentials) = serde_json::from_value::<AccountCredentials>(stored.credentials.clone())
    {
        let account = Account::builder_with_http(Box::new(transport.clone()))
            .from_credentials(credentials)
            .await
            .map_err(|e| failure("acme.directory_unreachable", e))?;
        if stored.contact != contact {
            let contacts: Vec<&str> = if contact.is_empty() { vec![] } else { vec![contact.as_str()] };
            account.update_contacts(&contacts).await.map_err(|e| failure("acme.account_failed", e))?;
            let updated = StoredAccount { contact: contact.clone(), ..stored };
            store::save_account(cx.data_dir, cx.keyring, &updated)
                .map_err(|e| Failure::new("acme.account_failed", format!("{e:#}")))?;
        }
        return Ok(account);
    }
    let contacts: Vec<&str> = if contact.is_empty() { vec![] } else { vec![contact.as_str()] };
    let (account, credentials) = Account::builder_with_http(Box::new(transport.clone()))
        .create(
            &NewAccount {
                contact: &contacts,
                terms_of_service_agreed: settings.accept_terms,
                only_return_existing: false,
            },
            url.clone(),
            None,
        )
        .await
        .map_err(|e| failure("acme.account_failed", e))?;
    let credentials =
        serde_json::to_value(&credentials).map_err(|e| Failure::new("acme.account_failed", e.to_string()))?;
    store::save_account(cx.data_dir, cx.keyring, &StoredAccount { directory_url: url, contact, credentials })
        .map_err(|e| Failure::new("acme.account_failed", format!("{e:#}")))?;
    Ok(account)
}

/// Why validation failed: the first challenge with an error the CA reported.
async fn validation_problem(order: &mut instant_acme::Order) -> Failure {
    let mut authorizations = order.authorizations();
    while let Some(Ok(mut authz)) = authorizations.next().await {
        let domain = authz.identifier().to_string();
        let Ok(state) = authz.refresh().await else { continue };
        if let Some(problem) = state.challenges.iter().find_map(|c| c.error.as_ref()) {
            return Failure::new("acme.validation_failed", problem.to_string()).with("domain", &domain);
        }
    }
    Failure::new("acme.validation_failed", "the CA could not validate the names")
}

/// The reason for a protocol error: rate limits get their own, everything else `reason`.
fn failure(reason: &'static str, error: instant_acme::Error) -> Failure {
    match &error {
        instant_acme::Error::Api(problem) if problem.r#type.as_deref() == Some(RATE_LIMITED) => {
            Failure::new("acme.rate_limited", problem.to_string())
        }
        instant_acme::Error::Other(_) if reason == "acme.order_failed" || reason == "acme.account_failed" => {
            // A transport error: the CA cannot be reached at all.
            Failure::new("acme.directory_unreachable", error.to_string())
        }
        _ => Failure::new(reason, error.to_string()),
    }
}

/// Validity and issuer of the leaf certificate.
pub fn validity(chain_pem: &str) -> Result<(i64, i64, String), String> {
    let (_, pem) =
        x509_parser::pem::parse_x509_pem(chain_pem.as_bytes()).map_err(|e| format!("reading the certificate: {e}"))?;
    let cert = pem.parse_x509().map_err(|e| format!("reading the certificate: {e}"))?;
    let validity = cert.validity();
    let issuer = cert
        .issuer()
        .iter_common_name()
        .next()
        .and_then(|cn| cn.as_str().ok())
        .map(str::to_string)
        .unwrap_or_else(|| cert.issuer().to_string());
    Ok((validity.not_before.timestamp() * 1000, validity.not_after.timestamp() * 1000, issuer))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validity_and_issuer_are_read() {
        let mut params = rcgen::CertificateParams::new(vec!["kalzit.example.com".into()]).unwrap();
        params.distinguished_name.push(rcgen::DnType::CommonName, "Test Issuer");
        params.not_before = rcgen::date_time_ymd(2026, 1, 1);
        params.not_after = rcgen::date_time_ymd(2026, 4, 1);
        let key = rcgen::KeyPair::generate().unwrap();
        let cert = params.self_signed(&key).unwrap();
        let (from, to, issuer) = validity(&cert.pem()).unwrap();
        assert_eq!(issuer, "Test Issuer");
        assert_eq!(from, 1_767_225_600_000);
        assert_eq!(to, 1_775_001_600_000);
        assert!(validity("no pem").is_err());
    }
}
