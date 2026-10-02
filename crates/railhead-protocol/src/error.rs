//! The crate's one error type.

use crate::integer::MAX_SAFE_INTEGER;

/// Why a wire value was refused.
///
/// Field names in these errors are static strings chosen by this crate. Values from the wire are
/// never echoed, apart from integers, since the input is untrusted text.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// The input is not JSON of the expected shape: malformed, a required field missing, a field
    /// of the wrong type, an unknown tag, or an integer that is negative, fractional or above
    /// [`MAX_SAFE_INTEGER`].
    ///
    /// Only the position is kept: `serde_json`'s message can quote the untrusted input.
    #[error("value is not valid JSON of the expected shape (line {line}, column {column})")]
    Json {
        /// The 1-based line of the error, or 0 when the input was already parsed.
        line: usize,
        /// The 1-based column of the error, or 0 when the input was already parsed.
        column: usize,
    },
    /// The event names a schema version this crate does not read.
    #[error("event schema version is not supported: {0}")]
    UnsupportedVersion(u64),
    /// An integer that must be at least 1 is zero.
    #[error("{field} must be an integer from 1 to {MAX_SAFE_INTEGER}")]
    NotPositive {
        /// The field that held the value.
        field: &'static str,
    },
    /// An identifier lacks its kind's prefix or has a malformed body.
    #[error("{field} is not a valid {prefix} identifier")]
    InvalidId {
        /// The field that held the identifier.
        field: &'static str,
        /// The prefix its kind requires, such as `rep_`.
        prefix: &'static str,
    },
    /// A value breaks a format, length or range rule other than an identifier's.
    #[error("{field} is not {expected}")]
    Invalid {
        /// The field that held the value.
        field: &'static str,
        /// What the field must be, such as `a commit id`.
        expected: &'static str,
    },
    /// The event was recorded by an actor kind that may not record it.
    #[error("{event_type} must be recorded by {required}")]
    WrongActor {
        /// The event type, such as `decision.recorded`.
        event_type: &'static str,
        /// Who may record it, such as `a person`.
        required: &'static str,
    },
    /// An agent recorded an event about another agent.
    #[error("an agent may record {event_type} only for itself")]
    ActorNotSubject {
        /// The event type, such as `inbox.acked`.
        event_type: &'static str,
    },
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self::Json {
            line: error.line(),
            column: error.column(),
        }
    }
}

/// The result type of this crate.
pub type Result<T> = std::result::Result<T, Error>;
