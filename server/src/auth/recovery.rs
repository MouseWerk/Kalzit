//! Recovery codes: ten per account, each standing in once for the second factor. A code is 16
//! characters from a 32-letter alphabet without look-alikes (80 bits), shown in groups of four
//! (`k7q2-m9xd-p4tz-8wna`) only when they are made. The database holds only a SHA-256 of each,
//! bound to the account; with 80 bits a stolen table cannot be searched for the codes.

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// Codes per set.
pub const COUNT: usize = 10;
const GROUPS: usize = 4;
const GROUP_LEN: usize = 4;
const LEN: usize = GROUPS * GROUP_LEN;
/// Letters and digits without `i`, `l`, `o` and `1`, which read alike; 32 of them, so each
/// character carries exactly 5 bits.
const ALPHABET: &[u8; 32] = b"abcdefghjkmnpqrstuvwxyz023456789";

/// A new set of codes, formatted for display.
pub fn generate() -> Vec<String> {
    (0..COUNT).map(|_| generate_one()).collect()
}

fn generate_one() -> String {
    let bytes: [u8; LEN] = rand::random();
    // 32 letters: the low five bits of a random byte pick one without bias.
    let chars: Vec<u8> = bytes.iter().map(|b| ALPHABET[usize::from(b & 31)]).collect();
    chars.chunks(GROUP_LEN).map(|g| String::from_utf8_lossy(g).into_owned()).collect::<Vec<_>>().join("-")
}

/// What the person typed, without dashes and spaces and in lower case, with `o` read as zero.
/// `None` when it cannot be a code.
pub fn normalize(input: &str) -> Option<String> {
    let text: String = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_lowercase())
        .map(|c| if c == 'o' { '0' } else { c })
        .collect();
    (text.len() == LEN && text.bytes().all(|b| ALPHABET.contains(&b))).then_some(text)
}

/// The stored hash of a normalized code of `user_id`.
pub fn hash(user_id: &str, normalized: &str) -> String {
    let digest = Sha256::new()
        .chain_update(b"kalzit-recovery-code\0")
        .chain_update(user_id.as_bytes())
        .chain_update(b"\0")
        .chain_update(normalized.as_bytes())
        .finalize();
    hex::encode(digest)
}

/// The hash in `stored` that `candidate` matches, compared with every one in constant time.
pub fn find<'a>(stored: &'a [String], candidate: &str) -> Option<&'a String> {
    let mut found = None;
    for hash in stored {
        let same: bool = hash.as_bytes().ct_eq(candidate.as_bytes()).into();
        if same {
            found = Some(hash);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_ten_distinct_and_normalize_back() {
        let codes = generate();
        assert_eq!(codes.len(), COUNT);
        let unique: std::collections::BTreeSet<_> = codes.iter().collect();
        assert_eq!(unique.len(), COUNT);
        for code in &codes {
            assert_eq!(code.len(), LEN + GROUPS - 1, "{code}");
            let plain = normalize(code).unwrap();
            assert_eq!(normalize(&code.to_uppercase().replace('-', " ")).as_deref(), Some(plain.as_str()));
        }
    }

    #[test]
    fn typos_are_forgiven_and_garbage_refused() {
        assert_eq!(normalize("KO7Q-2M9X-DP4T-Z8WA").as_deref(), Some("k07q2m9xdp4tz8wa"));
        for bad in ["", "k7q2-m9xd", "k7q2-m9xd-p4tz-8wn1", "k7q2-m9xd-p4tz-8wnaa", "k7q2-m9xd-p4tz-8wnä"] {
            assert_eq!(normalize(bad), None, "{bad}");
        }
    }

    #[test]
    fn hashes_are_bound_to_the_account() {
        assert_ne!(hash("u-1", "k07q2m9xdp4tz8wa"), hash("u-2", "k07q2m9xdp4tz8wa"));
        let stored = vec![hash("u-1", "aaaaaaaaaaaaaaaa"), hash("u-1", "bbbbbbbbbbbbbbbb")];
        assert_eq!(find(&stored, &hash("u-1", "bbbbbbbbbbbbbbbb")), Some(&stored[1]));
        assert_eq!(find(&stored, &hash("u-2", "bbbbbbbbbbbbbbbb")), None);
    }
}
