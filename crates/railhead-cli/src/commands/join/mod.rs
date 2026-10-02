//! `rh join`: Register this machine's agent key with an invite and wait for the owner to confirm it.

use crate::output::Output;
use crate::{CommandName, Error, Invocation, Result};

/// Arguments of `rh join`.
#[derive(Debug, Clone, clap::Args)]
pub struct Args {}

/// Runs `rh join`. Not built yet: it reports itself unavailable and sends nothing.
///
/// # Errors
///
/// Always [`Error::Unavailable`] until the command is implemented.
pub fn run(_invocation: &Invocation<'_>, _args: &Args, _out: &mut Output<'_>) -> Result<()> {
    Err(Error::Unavailable(CommandName::Join))
}
