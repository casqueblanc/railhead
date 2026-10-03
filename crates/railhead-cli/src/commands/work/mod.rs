//! `rh work`: Claim the next ready issue and clone its fork.
//!
//! An agent that already holds a claim gets that claim back, and its existing clone is kept.

use std::path::PathBuf;

use railhead_protocol::ClaimResult;

use crate::commands::claim::{Target, finish, session};
use crate::http::Endpoint;
use crate::output::Output;
use crate::{Agent, Result};

/// Arguments of `rh work`.
#[derive(Debug, Clone, clap::Args)]
pub struct Args {
    /// Where to clone the fork. Defaults to `<repo>-<claim>` beside the current clone, or in the
    /// working directory.
    #[arg(long, value_name = "DIR")]
    pub dir: Option<PathBuf>,
}

/// Runs `rh work`.
///
/// # Errors
///
/// When the named directory cannot hold the clone (checked before anything is sent), when the
/// agent has no session, when no issue is ready or the backend refuses, or when the clone cannot
/// be made.
pub fn run(agent: &Agent<'_>, args: &Args, out: &mut Output<'_>) -> Result<()> {
    let target = Target::new(agent, args.dir.as_deref())?;
    let session = session(agent)?;
    let client = agent.client()?;
    let response = agent
        .invocation
        .runtime
        .block_on(client.get::<ClaimResult>(&Endpoint::Work, Some(&session)))?;
    finish(agent, &target, response, out)
}
