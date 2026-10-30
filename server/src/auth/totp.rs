//! Time-based one-time passwords (RFC 6238) for authenticator apps: HMAC-SHA-1 over 30-second
//! steps, 6 digits. A code is accepted for the current step and one step on either side (clocks of
//! phones drift), and each step only once per account (`second_factor`, `last_step`).

use hmac::{Hmac, KeyInit, Mac};
use sha1::Sha1;
use subtle::ConstantTimeEq;

/// Seconds per step.
pub const STEP_SECS: i64 = 30;
/// Digits of a code.
pub const DIGITS: u32 = 6;
/// Length of a key: 160 bits, the size of an HMAC-SHA-1 output (RFC 4226, section 4).
pub const SECRET_BYTES: usize = 20;
/// Steps accepted on either side of the current one.
pub const WINDOW: i64 = 1;

/// A new random key.
pub fn generate_secret() -> [u8; SECRET_BYTES] {
    rand::random()
}

/// The key as authenticator apps take it: Base32 (RFC 4648) without padding.
pub fn encode_secret(secret: &[u8]) -> String {
    data_encoding::BASE32_NOPAD.encode(secret)
}

pub fn decode_secret(text: &str) -> Option<Vec<u8>> {
    data_encoding::BASE32_NOPAD.decode(text.as_bytes()).ok()
}

/// The key in groups of four, as the setup dialog shows it for typing by hand.
pub fn grouped(encoded: &str) -> String {
    encoded.as_bytes().chunks(4).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join(" ")
}

/// The step `now_ms` falls in.
pub fn step_at(now_ms: i64) -> i64 {
    now_ms.div_euclid(1000).div_euclid(STEP_SECS)
}

/// HOTP (RFC 4226) with `digits` digits.
fn hotp(secret: &[u8], counter: u64, digits: u32) -> u32 {
    // HMAC takes keys of any length.
    let mut mac = <Hmac<Sha1> as KeyInit>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(&counter.to_be_bytes());
    let hash = mac.finalize().into_bytes();
    let offset = usize::from(hash[hash.len() - 1] & 0x0f);
    let binary = u32::from_be_bytes([hash[offset] & 0x7f, hash[offset + 1], hash[offset + 2], hash[offset + 3]]);
    binary % 10u32.pow(digits)
}

/// The code of `step`, zero-padded.
pub fn code_at(secret: &[u8], step: i64) -> String {
    format!("{:0width$}", hotp(secret, step as u64, DIGITS), width = DIGITS as usize)
}

/// What the person typed, as six digits: spaces and dashes are left out. `None` for anything else.
pub fn normalize(input: &str) -> Option<String> {
    let digits: String = input.chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    (digits.len() == DIGITS as usize && digits.bytes().all(|b| b.is_ascii_digit())).then_some(digits)
}

/// The latest step within the window around `now_ms` whose code is `code` and that comes after
/// `after` (the last step this account used), or `None`. Every step of the window is compared, in
/// constant time, so the answer time does not tell which one matched.
pub fn matching_step(secret: &[u8], code: &str, now_ms: i64, after: i64) -> Option<i64> {
    let now = step_at(now_ms);
    let mut found = None;
    for step in now - WINDOW..=now + WINDOW {
        let same: bool = code_at(secret, step).as_bytes().ct_eq(code.as_bytes()).into();
        if same && step > after {
            found = Some(step);
        }
    }
    found
}

/// Characters a URI may hold as they are (RFC 3986, unreserved); everything else is encoded.
fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The `otpauth://` URI authenticator apps read from the QR code.
pub fn otpauth_uri(issuer: &str, account: &str, encoded_secret: &str) -> String {
    let issuer_enc = percent_encode(issuer);
    format!(
        "otpauth://totp/{issuer_enc}:{}?secret={encoded_secret}&issuer={issuer_enc}&algorithm=SHA1&digits={DIGITS}&period={STEP_SECS}",
        percent_encode(account)
    )
}

/// A QR code of `text` as the modules of its square: `size` modules per side, and an SVG path
/// (`M x y h1 v1 h-1 z` per run of dark modules) that the UI draws in its own colors, so no image
/// or markup from the server ends up in the page.
#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct QrCode {
    pub size: usize,
    pub path: String,
}

pub fn qr_code(text: &str) -> Option<QrCode> {
    let code = qrcode::QrCode::with_error_correction_level(text.as_bytes(), qrcode::EcLevel::M).ok()?;
    let size = code.width();
    let colors = code.to_colors();
    let mut path = String::new();
    for y in 0..size {
        let mut x = 0;
        while x < size {
            if colors[y * size + x] == qrcode::Color::Dark {
                let start = x;
                while x < size && colors[y * size + x] == qrcode::Color::Dark {
                    x += 1;
                }
                path.push_str(&format!("M{start} {y}h{}v1h-{}z", x - start, x - start));
            } else {
                x += 1;
            }
        }
    }
    Some(QrCode { size, path })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The SHA-1 test vectors of RFC 6238, appendix B (8 digits; the key is "12345678901234567890").
    #[test]
    fn rfc_6238_vectors() {
        let secret = b"12345678901234567890";
        for (time, expected) in [
            (59_i64, 94_287_082_u32),
            (1_111_111_109, 7_081_804),
            (1_111_111_111, 14_050_471),
            (1_234_567_890, 89_005_924),
            (2_000_000_000, 69_279_037),
            (20_000_000_000, 65_353_130),
        ] {
            let step = step_at(time * 1000);
            assert_eq!(hotp(secret, step as u64, 8), expected, "T = {time}");
            // Six digits are the last six of the same value.
            assert_eq!(code_at(secret, step), format!("{:06}", expected % 1_000_000), "T = {time}");
        }
    }

    #[test]
    fn the_window_is_one_step_on_either_side() {
        let secret = generate_secret();
        let now = 1_800_000_015_000;
        let step = step_at(now);
        for (offset, accepted) in [(-2, false), (-1, true), (0, true), (1, true), (2, false)] {
            let code = code_at(&secret, step + offset);
            assert_eq!(matching_step(&secret, &code, now, 0) == Some(step + offset), accepted, "offset {offset}");
        }
    }

    #[test]
    fn a_used_step_is_not_accepted_again() {
        let secret = generate_secret();
        let now = 1_800_000_015_000;
        let step = step_at(now);
        let code = code_at(&secret, step);
        assert_eq!(matching_step(&secret, &code, now, step - 1), Some(step));
        assert_eq!(matching_step(&secret, &code, now, step), None, "replayed in the same step");
        // Nor an older code once a newer one was used.
        let older = code_at(&secret, step - 1);
        assert_eq!(matching_step(&secret, &older, now, step), None);
    }

    #[test]
    fn input_is_six_digits_with_or_without_spaces() {
        assert_eq!(normalize("123 456").as_deref(), Some("123456"));
        assert_eq!(normalize(" 123-456 ").as_deref(), Some("123456"));
        for bad in ["", "12345", "1234567", "12345a", "١٢٣٤٥٦"] {
            assert_eq!(normalize(bad), None, "{bad}");
        }
    }

    #[test]
    fn keys_round_trip_and_uris_are_encoded() {
        let secret = generate_secret();
        let encoded = encode_secret(&secret);
        assert_eq!(encoded.len(), 32);
        assert_eq!(decode_secret(&encoded).unwrap(), secret);
        assert_eq!(grouped("JBSWY3DPEHPK3PXP"), "JBSW Y3DP EHPK 3PXP");
        let uri = otpauth_uri("Kalzit (kalzit.example)", "jörg@example.de", "JBSWY3DPEHPK3PXP");
        assert_eq!(
            uri,
            "otpauth://totp/Kalzit%20%28kalzit.example%29:j%C3%B6rg%40example.de?secret=JBSWY3DPEHPK3PXP\
             &issuer=Kalzit%20%28kalzit.example%29&algorithm=SHA1&digits=6&period=30"
        );
        let qr = qr_code(&uri).unwrap();
        assert!(qr.size >= 21 && qr.path.starts_with('M'));
    }
}
