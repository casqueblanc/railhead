//! Format, length and range rules shared by events and the agent wire.
//!
//! Each rule matches its counterpart in `@railhead/shared/events` or `@railhead/shared/agent-api`.
//! Lengths count UTF-16 code units and blank text is judged by JavaScript's `trim`, so a value is
//! refused here exactly when TypeScript refuses it.

use std::collections::HashSet;

use crate::error::{Error, Result};
use crate::integer::SafeInteger;

/// Maximum length of an issue title, in UTF-16 code units.
pub const MAX_TITLE_LENGTH: usize = 256;
/// Maximum length of an issue body.
pub const MAX_ISSUE_BODY_LENGTH: usize = 16 * 1024;
/// Maximum length of a question's text.
pub const MAX_QUESTION_LENGTH: usize = 2000;
/// Maximum length of one option label in a question.
pub const MAX_OPTION_LABEL_LENGTH: usize = 200;
/// Minimum number of options a question offers.
pub const MIN_OPTIONS: usize = 2;
/// Maximum number of options a question offers.
pub const MAX_OPTIONS: usize = 8;
/// Maximum length of an acknowledgement plan.
pub const MAX_PLAN_LENGTH: usize = 4000;
/// Maximum length of an agent's display name.
pub const MAX_AGENT_NAME_LENGTH: usize = 32;
/// Maximum length of a repository path or Git ref.
pub const MAX_PATH_LENGTH: usize = 1024;
/// Maximum number of entries in any list an event carries.
pub const MAX_LIST_LENGTH: usize = 64;
/// Maximum length of a check's name.
pub const MAX_CHECK_NAME_LENGTH: usize = 128;
/// Largest armored SSH signature the backend reads, in characters.
pub const MAX_SIGNATURE_LENGTH: usize = 4096;
/// Largest OpenSSH public key line the backend reads, in characters.
pub const MAX_PUBLIC_KEY_LENGTH: usize = 1024;

/// One kind of identifier. Each kind has its own prefix, so one cannot stand in for another.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum IdKind {
    /// `rep_`, a repository.
    Repo,
    /// `agt_`, an agent.
    Agent,
    /// `usr_`, a person.
    User,
    /// `sys_`, a system component such as `sys_train`.
    System,
    /// `inv_`, an invite.
    Invite,
    /// `iss_`, an issue.
    Issue,
    /// `clm_`, a claim.
    Claim,
    /// `qst_`, a question.
    Question,
    /// `dec_`, a decision. Its versions share one id.
    Decision,
    /// `chk_`, a check run.
    CheckRun,
    /// `int_`, a merge intent.
    Intent,
}

impl IdKind {
    /// The prefix identifiers of this kind carry.
    #[must_use]
    pub const fn prefix(self) -> &'static str {
        match self {
            Self::Repo => "rep_",
            Self::Agent => "agt_",
            Self::User => "usr_",
            Self::System => "sys_",
            Self::Invite => "inv_",
            Self::Issue => "iss_",
            Self::Claim => "clm_",
            Self::Question => "qst_",
            Self::Decision => "dec_",
            Self::CheckRun => "chk_",
            Self::Intent => "int_",
        }
    }
}

/// True when `value` is an identifier of the given kind, by the rules of `isId`.
///
/// ```
/// use railhead_protocol::{IdKind, is_id};
///
/// assert!(is_id(IdKind::Claim, "clm_42abcd"));
/// assert!(!is_id(IdKind::Decision, "clm_42abcd"));
/// assert!(is_id(IdKind::System, "sys_train"));
/// ```
#[must_use]
pub fn is_id(kind: IdKind, value: &str) -> bool {
    let Some(body) = value.strip_prefix(kind.prefix()) else {
        return false;
    };
    match kind {
        IdKind::System => is_system_id_body(body),
        IdKind::Repo
        | IdKind::Agent
        | IdKind::User
        | IdKind::Invite
        | IdKind::Issue
        | IdKind::Claim
        | IdKind::Question
        | IdKind::Decision
        | IdKind::CheckRun
        | IdKind::Intent => is_alphanumeric_between(body, 6, 64),
    }
}

/// True when `value` is a 40-character lowercase hexadecimal commit id.
#[must_use]
pub fn is_commit_sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `[A-Za-z0-9]{min,max}`.
fn is_alphanumeric_between(body: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&body.len()) && body.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// `[a-z][a-z0-9_]{1,63}`.
fn is_system_id_body(body: &str) -> bool {
    starts_lowercase_then(body, 2, 64, |b| {
        b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'
    })
}

/// A lowercase ASCII letter followed by bytes `rest` accepts, `min` to `max` bytes in all.
fn starts_lowercase_then(value: &str, min: usize, max: usize, rest: fn(u8) -> bool) -> bool {
    let mut bytes = value.bytes();
    (min..=max).contains(&value.len())
        && bytes.next().is_some_and(|b| b.is_ascii_lowercase())
        && bytes.all(rest)
}

/// `chl_[A-Za-z0-9]{16,64}`, a login challenge.
#[must_use]
pub fn is_challenge_id(value: &str) -> bool {
    value
        .strip_prefix("chl_")
        .is_some_and(|body| is_alphanumeric_between(body, 16, 64))
}

/// `req_[A-Za-z0-9]{16,64}`, an idempotency key.
pub(crate) fn is_request_id(value: &str) -> bool {
    value
        .strip_prefix("req_")
        .is_some_and(|body| is_alphanumeric_between(body, 16, 64))
}

/// `[A-Za-z0-9_-]{43}`, an invite secret.
pub(crate) fn is_invite_secret(value: &str) -> bool {
    value.len() == 43 && value.bytes().all(is_base64url_byte)
}

/// `ssh-ed25519 [A-Za-z0-9+/]{68}`, a public key with no comment.
pub(crate) fn is_ed25519_public_key(value: &str) -> bool {
    value.len() <= MAX_PUBLIC_KEY_LENGTH
        && value
            .strip_prefix("ssh-ed25519 ")
            .is_some_and(|blob| blob.len() == 68 && blob.bytes().all(is_base64_byte))
}

/// An armored SSH signature: the begin line, lines of 1 to 76 base64 characters, the end line and
/// an optional final newline.
pub(crate) fn is_armored_signature(value: &str) -> bool {
    const BEGIN: &str = "-----BEGIN SSH SIGNATURE-----\n";
    const END: &str = "-----END SSH SIGNATURE-----";
    if value.len() > MAX_SIGNATURE_LENGTH {
        return false;
    }
    let Some(rest) = value.strip_prefix(BEGIN) else {
        return false;
    };
    let rest = rest.strip_suffix('\n').unwrap_or(rest);
    let Some(body) = rest.strip_suffix(END) else {
        return false;
    };
    let Some(body) = body.strip_suffix('\n') else {
        return false;
    };
    !body.is_empty()
        && body.split('\n').all(|line| {
            (1..=76).contains(&line.len()) && line.bytes().all(|b| is_base64_byte(b) || b == b'=')
        })
}

fn is_base64_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'+' || b == b'/'
}

fn is_base64url_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

/// The number of UTF-16 code units in `value`, which is what JavaScript's `length` counts.
fn utf16_length(value: &str) -> usize {
    value.encode_utf16().count()
}

/// The characters JavaScript's `String.prototype.trim` removes: `WhiteSpace` and
/// `LineTerminator`. Rust's `char::is_whitespace` differs at U+0085 and U+FEFF.
fn is_js_whitespace(c: char) -> bool {
    match c {
        '\u{0085}' => false,
        '\u{feff}' => true,
        other => other.is_whitespace(),
    }
}

pub(crate) fn require_id(kind: IdKind, value: &str, field: &'static str) -> Result<()> {
    if is_id(kind, value) {
        Ok(())
    } else {
        Err(Error::InvalidId {
            field,
            prefix: kind.prefix(),
        })
    }
}

pub(crate) fn require(valid: bool, field: &'static str, expected: &'static str) -> Result<()> {
    if valid {
        Ok(())
    } else {
        Err(Error::Invalid { field, expected })
    }
}

pub(crate) fn require_commit(value: &str, field: &'static str) -> Result<()> {
    require(is_commit_sha(value), field, "a commit id")
}

/// A SHA-256 digest: 64 lowercase hexadecimal characters.
pub(crate) fn require_digest(value: &str, field: &'static str) -> Result<()> {
    require(
        value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        field,
        "a SHA-256 digest",
    )
}

pub(crate) fn require_positive(value: SafeInteger, field: &'static str) -> Result<()> {
    if value.get() >= 1 {
        Ok(())
    } else {
        Err(Error::NotPositive { field })
    }
}

/// Text that is not blank and at most `max` UTF-16 code units long.
pub(crate) fn require_text(
    value: &str,
    max: usize,
    field: &'static str,
    expected: &'static str,
) -> Result<()> {
    require(
        !value.trim_matches(is_js_whitespace).is_empty(),
        field,
        expected,
    )?;
    require_length(value, max, field, expected)
}

pub(crate) fn require_length(
    value: &str,
    max: usize,
    field: &'static str,
    expected: &'static str,
) -> Result<()> {
    require(utf16_length(value) <= max, field, expected)
}

/// `^[a-z][a-z0-9-]*$`, at most [`MAX_AGENT_NAME_LENGTH`] long.
pub(crate) fn require_agent_name(name: &str) -> Result<()> {
    require(
        starts_lowercase_then(name, 1, MAX_AGENT_NAME_LENGTH, |b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'
        }),
        "name",
        "a valid agent name",
    )
}

/// `^[a-z][a-z0-9_]{0,31}$`.
pub(crate) fn require_option_key(value: &str, field: &'static str) -> Result<()> {
    require(
        starts_lowercase_then(value, 1, 32, |b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'
        }),
        field,
        "a valid option key",
    )
}

/// `SHA256:` followed by 43 base64 characters, an OpenSSH key fingerprint.
pub(crate) fn require_key_fingerprint(value: &str) -> Result<()> {
    require(
        value
            .strip_prefix("SHA256:")
            .is_some_and(|body| body.len() == 43 && body.bytes().all(is_base64_byte)),
        "keyFingerprint",
        "an OpenSSH SHA256 fingerprint",
    )
}

/// A Git ref: starts with `refs/`, at most [`MAX_PATH_LENGTH`] long.
pub(crate) fn require_ref(value: &str) -> Result<()> {
    require(
        value.starts_with("refs/") && utf16_length(value) <= MAX_PATH_LENGTH,
        "ref",
        "a Git ref",
    )
}

/// A relative repository path with no empty, `.` or `..` segment.
pub(crate) fn require_path(value: &str, field: &'static str) -> Result<()> {
    require(
        !value.is_empty()
            && utf16_length(value) <= MAX_PATH_LENGTH
            && !value.starts_with('/')
            && value
                .split('/')
                .all(|segment| !matches!(segment, "" | "." | "..")),
        field,
        "a repository path",
    )
}

pub(crate) fn require_list<T>(list: &[T], field: &'static str) -> Result<()> {
    require(
        list.len() <= MAX_LIST_LENGTH,
        field,
        "a list of at most 64 entries",
    )
}

pub(crate) fn require_unique<'a>(
    values: impl ExactSizeIterator<Item = &'a str>,
    field: &'static str,
) -> Result<()> {
    let count = values.len();
    let distinct: HashSet<&str> = values.collect();
    require(distinct.len() == count, field, "free of duplicate entries")
}

#[cfg(test)]
mod tests {
    use super::{
        IdKind, MAX_PATH_LENGTH, is_armored_signature, is_challenge_id, is_commit_sha,
        is_ed25519_public_key, is_id, require_agent_name, require_option_key, require_path,
        require_text,
    };

    #[test]
    fn identifiers_follow_their_kind() {
        assert!(is_id(IdKind::Repo, "rep_abc123"));
        assert!(is_id(IdKind::Repo, &format!("rep_{}", "A1".repeat(32))));
        assert!(!is_id(IdKind::Repo, &format!("rep_{}", "a".repeat(65))));
        assert!(!is_id(IdKind::Repo, "rep_abc12"));
        assert!(!is_id(IdKind::Repo, "rep_abc-123"));
        assert!(!is_id(IdKind::Repo, "agt_abc123"));
        assert!(is_id(IdKind::System, "sys_a1"));
        assert!(!is_id(IdKind::System, "sys_t"));
        assert!(!is_id(IdKind::System, "sys_Train"));
        assert!(!is_id(IdKind::System, "sys_1train"));
    }

    #[test]
    fn challenges_are_chl_and_16_to_64_alphanumerics() {
        assert!(is_challenge_id("chl_3q27HkVb0nZ8pXa1"));
        assert!(is_challenge_id(&format!("chl_{}", "A1".repeat(32))));
        for bad in [
            "chl_short".to_owned(),
            format!("chl_{}", "a".repeat(15)),
            format!("chl_{}", "a".repeat(65)),
            "chl_3q27HkVb0nZ8pXa1\nagent=x".to_owned(),
            "3q27HkVb0nZ8pXa1abcd".to_owned(),
        ] {
            assert!(!is_challenge_id(&bad), "{bad:?}");
        }
    }

    #[test]
    fn commits_are_lowercase_hex_of_forty() {
        assert!(is_commit_sha(&"a1".repeat(20)));
        assert!(!is_commit_sha(&"A1".repeat(20)));
        assert!(!is_commit_sha(&"a".repeat(39)));
        assert!(!is_commit_sha(&"g".repeat(40)));
    }

    #[test]
    fn text_is_blank_and_long_by_javascript_rules() {
        assert!(require_text("ok", 2, "plan", "x").is_ok());
        // One astral character is two UTF-16 code units.
        assert!(require_text("\u{1F600}", 2, "plan", "x").is_ok());
        assert!(require_text("\u{1F600}a", 2, "plan", "x").is_err());
        assert!(require_text(" \t\n\u{feff}\u{3000}", 99, "plan", "x").is_err());
        // JavaScript's trim keeps U+0085, so it is not blank there.
        assert!(require_text("\u{0085}", 99, "plan", "x").is_ok());
    }

    #[test]
    fn paths_and_names_refuse_traversal_and_capitals() {
        assert!(require_path("src/upload.ts", "path").is_ok());
        for path in [
            "",
            "/etc",
            "a//b",
            "a/./b",
            "../a",
            "a/",
            &"a".repeat(MAX_PATH_LENGTH + 1),
        ] {
            assert!(require_path(path, "path").is_err(), "accepted {path:?}");
        }
        assert!(require_agent_name("atlas-2").is_ok());
        assert!(require_agent_name("Atlas").is_err());
        assert!(require_agent_name(&"a".repeat(33)).is_err());
        assert!(require_option_key(&format!("a{}", "_".repeat(31)), "key").is_ok());
        assert!(require_option_key(&"a".repeat(33), "key").is_err());
    }

    #[test]
    fn keys_and_signatures_have_their_armor() {
        let blob = format!("AAAAC3NzaC1lZDI1NTE5AAAAI{}", "A".repeat(43));
        assert!(is_ed25519_public_key(&format!("ssh-ed25519 {blob}")));
        assert!(!is_ed25519_public_key(&format!(
            "ssh-ed25519 {blob} me@host"
        )));
        assert!(is_armored_signature(
            "-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n"
        ));
        assert!(is_armored_signature(
            "-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----"
        ));
        assert!(!is_armored_signature(
            "-----BEGIN SSH SIGNATURE-----\n-----END SSH SIGNATURE-----\n"
        ));
        assert!(!is_armored_signature(&format!(
            "-----BEGIN SSH SIGNATURE-----\n{}\n-----END SSH SIGNATURE-----\n",
            "A".repeat(77)
        )));
    }
}
