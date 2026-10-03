//! `rh ask`: Ask the owner a question about the claim.

use crate::output::Output;
use crate::{Agent, CommandName, Error, Result};

/// Arguments of `rh ask`.
#[derive(Debug, Clone, clap::Args)]
pub struct Args {}

/// Runs `rh ask`. Not built yet: it reports itself unavailable and sends nothing.
///
/// # Errors
///
/// Always [`Error::Unavailable`] until the command is implemented.
pub fn run(_agent: &Agent<'_>, _args: &Args, _out: &mut Output<'_>) -> Result<()> {
    Err(Error::Unavailable(CommandName::Ask))
}
