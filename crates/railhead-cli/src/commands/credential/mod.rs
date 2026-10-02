//! `rh credential`: Answer Git's credential requests for a claim's clone.
//!
//! Git runs `rh credential <operation>` with the request on stdin. Stdout carries only the Git
//! credential protocol; every notice goes to stderr.

use std::convert::Infallible;
use std::str::FromStr;

use crate::output::Output;
use crate::{Agent, CommandName, Error, Result};

/// Arguments of `rh credential`.
#[derive(Debug, Clone, clap::Args)]
pub struct Args {
    /// The operation Git asks for: `get`, `store` or `erase`.
    pub operation: Operation,
}

/// A credential helper operation. Git may add operations; a helper ignores those it does not know.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    /// Git wants a credential.
    Get,
    /// Git reports that a credential worked.
    Store,
    /// Git reports that a credential was refused.
    Erase,
    /// An operation this helper does not know.
    Other,
}

impl FromStr for Operation {
    type Err = Infallible;

    fn from_str(value: &str) -> std::result::Result<Self, Infallible> {
        Ok(match value {
            "get" => Self::Get,
            "store" => Self::Store,
            "erase" => Self::Erase,
            _ => Self::Other,
        })
    }
}

/// Runs `rh credential`. Not built yet: it reports itself unavailable and prints nothing on stdout.
///
/// # Errors
///
/// Always [`Error::Unavailable`] until the command is implemented.
pub fn run(_agent: &Agent<'_>, _args: &Args, _out: &mut Output<'_>) -> Result<()> {
    Err(Error::Unavailable(CommandName::Credential))
}
