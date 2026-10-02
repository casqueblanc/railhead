//! `rh ready`: Pin the clone's HEAD commit for the merge train.
//!
//! The claim and the generation come from the clone's own settings, written when it was claimed,
//! so a clone whose claim moved to another agent sends its old generation and is refused.

use std::io::{self, Write};

use railhead_protocol::{AgentErrorCode, NextCommand, ReadyRequest, ReadyResult};
use serde::Serialize;

use crate::commands::claim::{render_claim, session, workspace};
use crate::http::{self, Endpoint};
use crate::output::{LocalCode, Output, Render, command_line};
use crate::{Agent, Error, Result};

/// Arguments of `rh ready`.
#[derive(Debug, Clone, clap::Args)]
pub struct Args {}

/// Runs `rh ready`.
///
/// # Errors
///
/// When run outside a claim's clone, when the clone has no commit or generation, when the agent
/// has no session, or when the backend refuses the pin. An unacknowledged decision names
/// `rh sync` and `rh ack`.
pub fn run(agent: &Agent<'_>, _args: &Args, out: &mut Output<'_>) -> Result<()> {
    let binding = agent
        .invocation
        .context
        .clone_binding()
        .ok_or_else(|| Error::Local {
            code: LocalCode::NoClone,
            message: "rh ready pins the HEAD of a claim's clone; run it inside the clone"
                .to_owned(),
            retryable: false,
            next: Some(NextCommand::Status),
        })?;
    let request = ReadyRequest {
        generation: workspace::generation(&binding.dir)?,
        commit: workspace::head(&binding.dir)?,
    };
    let session = session(agent)?;
    let client = agent.client()?;
    let endpoint = Endpoint::Ready {
        claim_id: &binding.claim_id,
    };
    let response = agent
        .invocation
        .runtime
        .block_on(client.send::<_, ReadyResult>(&endpoint, Some(&session), &request));
    if let Err(http::Error::Rejected { error, .. }) = &response
        && error.code == AgentErrorCode::UnackedDecision
    {
        out.notice(&format!(
            "a decision for this claim is unacknowledged: read it with {}, then {} each item with a plan",
            command_line(NextCommand::Sync),
            command_line(NextCommand::Ack)
        ))
        .map_err(Error::Output)?;
    }
    let response = response?;
    let pinned = Pinned {
        claim: response.data.claim,
        repeated: response.data.repeated,
    };
    out.success(&pinned, response.inbox.as_ref(), response.next)
        .map_err(Error::Output)
}

/// The result of `rh ready`.
#[derive(Debug, Serialize)]
struct Pinned {
    claim: railhead_protocol::ClaimView,
    repeated: bool,
}

impl Render for Pinned {
    fn render(&self, out: &mut dyn Write) -> io::Result<()> {
        let verb = if self.repeated {
            "already pinned"
        } else {
            "pinned"
        };
        let commit = self.claim.ready_commit.as_deref().unwrap_or("no commit");
        writeln!(out, "{verb} {} for the train", crate::output::inert(commit))?;
        render_claim(out, &self.claim)
    }
}
