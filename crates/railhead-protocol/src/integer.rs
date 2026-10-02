//! Integers and nullable fields as the TypeScript side writes them.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, de};

/// The largest integer a JavaScript number holds exactly, `2^53 - 1`.
///
/// An integer above it cannot have been written by the TypeScript backend.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// A wire integer: a whole number from 0 to [`MAX_SAFE_INTEGER`].
///
/// Decoding refuses a negative, fractional or larger value, so every integer this crate hands out
/// is one TypeScript represents exactly.
///
/// ```
/// use railhead_protocol::SafeInteger;
///
/// let n: SafeInteger = serde_json::from_str("9007199254740991")?;
/// assert_eq!(n.get(), railhead_protocol::MAX_SAFE_INTEGER);
/// assert!(serde_json::from_str::<SafeInteger>("9007199254740992").is_err());
/// # Ok::<(), serde_json::Error>(())
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct SafeInteger(u64);

impl SafeInteger {
    /// Zero.
    pub const ZERO: Self = Self(0);

    /// Wraps `value`, or returns `None` when it is above [`MAX_SAFE_INTEGER`].
    #[must_use]
    pub const fn new(value: u64) -> Option<Self> {
        if value <= MAX_SAFE_INTEGER {
            Some(Self(value))
        } else {
            None
        }
    }

    /// The value.
    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

impl fmt::Display for SafeInteger {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl From<SafeInteger> for u64 {
    fn from(value: SafeInteger) -> Self {
        value.0
    }
}

impl<'de> Deserialize<'de> for SafeInteger {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = u64::deserialize(deserializer)?;
        Self::new(value).ok_or_else(|| {
            de::Error::custom(format_args!(
                "integer {value} is above the largest safe integer {MAX_SAFE_INTEGER}"
            ))
        })
    }
}

/// Deserializes a field that may be `null` but must be present.
///
/// Serde reads a missing `Option` field as `None`; the wire writes absence as `null` and never
/// omits a key, so a missing key is a shape error. Use with `#[serde(deserialize_with)]`, which
/// makes serde report the field as missing instead of defaulting it.
pub(crate) fn nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[cfg(test)]
mod tests {
    use super::{MAX_SAFE_INTEGER, SafeInteger};

    #[test]
    fn decodes_zero_and_the_largest_safe_integer() -> Result<(), serde_json::Error> {
        assert_eq!(serde_json::from_str::<SafeInteger>("0")?, SafeInteger::ZERO);
        let max: SafeInteger = serde_json::from_str("9007199254740991")?;
        assert_eq!(max.get(), MAX_SAFE_INTEGER);
        assert_eq!(serde_json::to_string(&max)?, "9007199254740991");
        Ok(())
    }

    #[test]
    fn refuses_unsafe_negative_fractional_and_string_integers() {
        for json in [
            "9007199254740992",
            "18446744073709551615",
            "18446744073709551616",
            "-1",
            "1.5",
            "1.0",
            "1e3",
            "\"1\"",
            "null",
        ] {
            assert!(
                serde_json::from_str::<SafeInteger>(json).is_err(),
                "accepted {json}"
            );
        }
    }

    #[test]
    fn new_refuses_the_first_unsafe_integer() {
        assert_eq!(
            SafeInteger::new(MAX_SAFE_INTEGER).map(SafeInteger::get),
            Some(MAX_SAFE_INTEGER)
        );
        assert_eq!(SafeInteger::new(MAX_SAFE_INTEGER + 1), None);
    }
}
