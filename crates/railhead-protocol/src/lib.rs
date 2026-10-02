//! Wire types shared by the Railhead CLI and server.
//!
//! The TypeScript module `@railhead/shared/events` owns the event schema; this crate decodes the
//! same JSON. It currently decodes the envelope every event shares and leaves each payload as raw
//! JSON. Decoding the payload variants is the next step of the protocol work.
//!
//! Event JSON comes from the network and is untrusted: every envelope field is checked here, and a
//! value the TypeScript side could not have produced is refused rather than adjusted.

use serde::Deserialize;

/// The event schema version this crate reads. A newer version is refused, never guessed at.
pub const EVENT_SCHEMA_VERSION: u64 = 1;

/// The largest integer a JavaScript number holds exactly, `2^53 - 1`.
///
/// Sequence numbers and timestamps above it cannot have been written by the TypeScript backend.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// Why an event could not be decoded.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum DecodeError {
    /// The input is not JSON of the expected shape.
    #[error("event is not valid JSON of the expected shape: {0}")]
    Json(#[from] serde_json::Error),
    /// The event names a schema version this crate does not read.
    #[error("event schema version is not supported: {0}")]
    UnsupportedVersion(u64),
    /// An integer field is zero or larger than [`MAX_SAFE_INTEGER`].
    #[error("{field} must be an integer from 1 to {MAX_SAFE_INTEGER}, got {value}")]
    IntegerOutOfRange {
        /// The envelope field that held the value.
        field: &'static str,
        /// The value received.
        value: u64,
    },
    /// An identifier lacks its kind's prefix or has a malformed body. The value is not echoed,
    /// since it is untrusted text.
    #[error("{field} is not a valid {prefix} identifier")]
    InvalidId {
        /// The envelope field that held the identifier.
        field: &'static str,
        /// The prefix its kind requires, such as `rep_`.
        prefix: &'static str,
    },
}

/// Who recorded an event, as authenticated by the backend.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Actor {
    /// A person, by user identifier.
    Human {
        /// The `usr_` identifier.
        id: String,
    },
    /// An agent, by agent identifier.
    Agent {
        /// The `agt_` identifier.
        id: String,
    },
    /// A system component, by system identifier.
    System {
        /// The `sys_` identifier.
        id: String,
    },
}

/// One entry in a repository's event log, with its payload still undecoded.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventEnvelope {
    /// The schema version, always [`EVENT_SCHEMA_VERSION`] after decoding.
    pub v: u64,
    /// Position in the repository's log, counting from 1.
    pub seq: u64,
    /// When the event was recorded, in milliseconds since the Unix epoch.
    pub at: u64,
    /// The repository whose log this is.
    pub repo: String,
    /// Who caused the event.
    pub actor: Actor,
    /// The event type, such as `claim.opened`.
    #[serde(rename = "type")]
    pub event_type: String,
    /// The type-specific payload, not yet decoded.
    pub data: serde_json::Value,
}

/// Decodes one event's envelope from JSON and checks its version, integer ranges and identifiers.
///
/// # Errors
///
/// Returns [`DecodeError::Json`] for malformed JSON, a missing or unknown field, or an integer
/// that is negative or fractional; [`DecodeError::UnsupportedVersion`] for any version other than
/// [`EVENT_SCHEMA_VERSION`]; [`DecodeError::IntegerOutOfRange`] for a zero or unsafe `seq` or
/// `at`; and [`DecodeError::InvalidId`] for a `repo` or `actor.id` that is not an identifier of its
/// kind, by the same rules as `isId` in `@railhead/shared/events`.
///
/// ```
/// let json = r#"{"v":1,"seq":1,"at":1700000000000,"repo":"rep_abc123",
///     "actor":{"kind":"system","id":"sys_train"},"type":"agent.revoked",
///     "data":{"agentId":"agt_abc123"}}"#;
/// let event = railhead_protocol::decode_event(json)?;
/// assert_eq!(event.event_type, "agent.revoked");
/// # Ok::<(), railhead_protocol::DecodeError>(())
/// ```
pub fn decode_event(json: &str) -> Result<EventEnvelope, DecodeError> {
    let event: EventEnvelope = serde_json::from_str(json)?;
    if event.v != EVENT_SCHEMA_VERSION {
        return Err(DecodeError::UnsupportedVersion(event.v));
    }
    require_safe_positive("seq", event.seq)?;
    require_safe_positive("at", event.at)?;
    require_id("repo", "rep_", &event.repo, is_id_body)?;
    match &event.actor {
        Actor::Human { id } => require_id("actor.id", "usr_", id, is_id_body)?,
        Actor::Agent { id } => require_id("actor.id", "agt_", id, is_id_body)?,
        Actor::System { id } => require_id("actor.id", "sys_", id, is_system_id_body)?,
    }
    Ok(event)
}

fn require_id(
    field: &'static str,
    prefix: &'static str,
    value: &str,
    body_is_valid: fn(&str) -> bool,
) -> Result<(), DecodeError> {
    match value.strip_prefix(prefix) {
        Some(body) if body_is_valid(body) => Ok(()),
        _ => Err(DecodeError::InvalidId { field, prefix }),
    }
}

/// `[A-Za-z0-9]{6,64}`, the body of every identifier kind except a system's.
fn is_id_body(body: &str) -> bool {
    (6..=64).contains(&body.len()) && body.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// `[a-z][a-z0-9_]{1,63}`, the body of a system identifier such as `sys_train`.
fn is_system_id_body(body: &str) -> bool {
    let mut bytes = body.bytes();
    (2..=64).contains(&body.len())
        && bytes.next().is_some_and(|b| b.is_ascii_lowercase())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn require_safe_positive(field: &'static str, value: u64) -> Result<(), DecodeError> {
    if (1..=MAX_SAFE_INTEGER).contains(&value) {
        Ok(())
    } else {
        Err(DecodeError::IntegerOutOfRange { field, value })
    }
}

#[cfg(test)]
mod tests {
    use super::{Actor, DecodeError, MAX_SAFE_INTEGER, decode_event};

    fn event_json(v: &str, seq: &str, at: &str) -> String {
        format!(
            r#"{{"v":{v},"seq":{seq},"at":{at},"repo":"rep_abc123",
                "actor":{{"kind":"agent","id":"agt_abc123"}},"type":"inbox.acked",
                "data":{{"agentId":"agt_abc123","claimId":"clm_abc123","item":3,"plan":"redo"}}}}"#
        )
    }

    #[test]
    fn decodes_the_envelope_and_keeps_the_payload() -> Result<(), DecodeError> {
        let event = decode_event(&event_json("1", "42", "1700000000000"))?;
        assert_eq!(event.seq, 42);
        assert_eq!(event.at, 1_700_000_000_000);
        assert_eq!(event.repo, "rep_abc123");
        assert_eq!(
            event.actor,
            Actor::Agent {
                id: "agt_abc123".to_owned()
            }
        );
        assert_eq!(event.event_type, "inbox.acked");
        assert_eq!(event.data.get("item"), Some(&serde_json::Value::from(3)));
        Ok(())
    }

    #[test]
    fn accepts_the_largest_safe_integer() -> Result<(), DecodeError> {
        let max = MAX_SAFE_INTEGER.to_string();
        let event = decode_event(&event_json("1", &max, &max))?;
        assert_eq!(event.seq, 9_007_199_254_740_991);
        assert_eq!(event.at, 9_007_199_254_740_991);
        Ok(())
    }

    #[test]
    fn refuses_an_integer_javascript_cannot_hold() {
        let unsafe_seq = (MAX_SAFE_INTEGER + 1).to_string();
        let result = decode_event(&event_json("1", &unsafe_seq, "1"));
        assert!(matches!(
            result,
            Err(DecodeError::IntegerOutOfRange {
                field: "seq",
                value: 9_007_199_254_740_992
            })
        ));
    }

    #[test]
    fn refuses_zero_negative_and_fractional_integers() {
        assert!(matches!(
            decode_event(&event_json("1", "1", "0")),
            Err(DecodeError::IntegerOutOfRange {
                field: "at",
                value: 0
            })
        ));
        assert!(matches!(
            decode_event(&event_json("1", "-1", "1")),
            Err(DecodeError::Json(_))
        ));
        assert!(matches!(
            decode_event(&event_json("1", "1.5", "1")),
            Err(DecodeError::Json(_))
        ));
    }

    #[test]
    fn refuses_another_schema_version() {
        assert!(matches!(
            decode_event(&event_json("2", "1", "1")),
            Err(DecodeError::UnsupportedVersion(2))
        ));
    }

    #[test]
    fn refuses_unknown_actor_kinds_and_fields() {
        let unknown_kind =
            event_json("1", "1", "1").replace(r#""kind":"agent""#, r#""kind":"bot""#);
        assert!(matches!(
            decode_event(&unknown_kind),
            Err(DecodeError::Json(_))
        ));
        let extra_field = event_json("1", "1", "1").replace(r#""v":1,"#, r#""v":1,"token":"x","#);
        assert!(matches!(
            decode_event(&extra_field),
            Err(DecodeError::Json(_))
        ));
    }

    fn with_ids(repo: &str, kind: &str, id: &str) -> String {
        event_json("1", "1", "1")
            .replace("\"repo\":\"rep_abc123\"", &format!("\"repo\":\"{repo}\""))
            .replace(
                r#"{"kind":"agent","id":"agt_abc123"}"#,
                &format!(r#"{{"kind":"{kind}","id":"{id}"}}"#),
            )
    }

    #[test]
    fn accepts_identifiers_at_their_length_bounds() -> Result<(), DecodeError> {
        let longest = format!("rep_{}", "A1".repeat(32));
        let event = decode_event(&with_ids(&longest, "human", "usr_a1B2c3"))?;
        assert_eq!(event.repo, longest);
        let event = decode_event(&with_ids("rep_abc123", "system", "sys_a1"))?;
        assert_eq!(
            event.actor,
            Actor::System {
                id: "sys_a1".to_owned()
            }
        );
        Ok(())
    }

    #[test]
    fn refuses_a_malformed_repository_identifier() {
        let too_long = format!("rep_{}", "a".repeat(65));
        for repo in [
            "",
            "rep_",
            "rep_abc12",
            "agt_abc123",
            "rep_abc-123",
            too_long.as_str(),
        ] {
            assert!(
                matches!(
                    decode_event(&with_ids(repo, "agent", "agt_abc123")),
                    Err(DecodeError::InvalidId {
                        field: "repo",
                        prefix: "rep_"
                    })
                ),
                "accepted repo {repo:?}"
            );
        }
    }

    #[test]
    fn refuses_an_actor_identifier_of_another_kind() {
        let cases = [
            ("human", "agt_abc123", "usr_"),
            ("agent", "usr_abc123", "agt_"),
            ("system", "sys_Train", "sys_"),
            ("system", "sys_1train", "sys_"),
            ("system", "sys_t", "sys_"),
        ];
        for (kind, id, prefix) in cases {
            let result = decode_event(&with_ids("rep_abc123", kind, id));
            assert!(
                matches!(
                    result,
                    Err(DecodeError::InvalidId { field: "actor.id", prefix: p }) if p == prefix
                ),
                "accepted {kind} actor {id:?}"
            );
        }
    }

    #[test]
    fn refuses_malformed_and_incomplete_json() {
        assert!(matches!(decode_event(""), Err(DecodeError::Json(_))));
        assert!(matches!(decode_event("{"), Err(DecodeError::Json(_))));
        let missing_data = r#"{"v":1,"seq":1,"at":1,"repo":"rep_abc123",
            "actor":{"kind":"system","id":"sys_train"},"type":"agent.revoked"}"#;
        assert!(matches!(
            decode_event(missing_data),
            Err(DecodeError::Json(_))
        ));
    }
}
