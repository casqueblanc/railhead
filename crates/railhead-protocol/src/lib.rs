//! Wire types shared by the Railhead CLI and server.
//!
//! The TypeScript modules `@railhead/shared/events` and `@railhead/shared/agent-api` own the wire;
//! this crate reads and writes the same JSON, and `fixtures/protocol/wire/` holds the corpus both
//! sides test against.
//!
//! Wire JSON comes from the network and is untrusted. The encoding rules are TypeScript's: every
//! field is present and absence is `null`, integers lie between 0 and [`MAX_SAFE_INTEGER`], unions
//! carry a closed tag, and unknown fields are ignored and dropped. A value TypeScript would refuse
//! is refused here rather than adjusted.

mod agent;
mod error;
mod events;
mod integer;
mod payloads;
mod rules;

pub use agent::*;
pub use error::*;
pub use events::*;
pub use integer::{MAX_SAFE_INTEGER, SafeInteger};
pub use rules::*;
// Measurement-only edit 1.
// Measurement-only edit 2.
// Measurement-only edit 3.
