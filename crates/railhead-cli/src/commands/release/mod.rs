//! `rh release`: Give up the clone's claim when the agent cannot finish it.
//!
//! The claim and the generation come from the clone's own settings, written when it was claimed,
//! so a clone whose claim moved to another agent sends its old generation and is refused. A ready
//! claim's pin is on the train, so the backend refuses its release.

use std::io::{self, Write};

use railhead_protocol::{ClosedClaimView, NextCommand, ReleaseRequest, ReleaseResult};
use serde::Serialize;

use crate::commands::claim::{session, workspace};
use crate::http::Endpoint;
use crate::output::{LocalCode, Output, Render, quoted};
use crate::{Agent, Error, Result};

/// Arguments of `rh release`.
#[derive(Debug, Clone, clap::Args)]
pub struct Args {}

/// Runs `rh release`.
///
/// # Errors
///
/// When run outside a claim's clone, when the clone has no generation, when the agent has no
/// session, or when the backend refuses the release.
pub fn run(agent: &Agent<'_>, _args: &Args, out: &mut Output<'_>) -> Result<()> {
    let binding = agent
        .invocation
        .context
        .clone_binding()
        .ok_or_else(|| Error::Local {
            code: LocalCode::NoClone,
            message: "rh release gives up the claim of a clone; run it inside the clone".to_owned(),
            retryable: false,
            next: Some(NextCommand::Status),
        })?;
    let request = ReleaseRequest {
        generation: workspace::generation(&binding.dir)?,
    };
    let session = session(agent)?;
    let client = agent.client()?;
    let endpoint = Endpoint::Release {
        claim_id: &binding.claim_id,
    };
    let response = agent
        .invocation
        .runtime
        .block_on(client.send::<_, ReleaseResult>(&endpoint, Some(&session), &request))?;
    let released = Released {
        closed: response.data.closed,
        repeated: response.data.repeated,
    };
    out.success(&released, response.inbox.as_ref(), response.next)
        .map_err(Error::Output)
}

/// The result of `rh release`.
#[derive(Debug, Serialize)]
struct Released {
    closed: ClosedClaimView,
    repeated: bool,
}

impl Render for Released {
    fn render(&self, out: &mut dyn Write) -> io::Result<()> {
        let verb = if self.repeated {
            "already released"
        } else {
            "released"
        };
        writeln!(
            out,
            "{verb} claim {} on issue {}; another agent can take it over",
            quoted(&self.closed.claim_id),
            quoted(&self.closed.issue_id)
        )
    }
}
