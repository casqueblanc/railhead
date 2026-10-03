//! `rh status`: Show the agent, its claim with the durable task, and its inbox.

use std::io::{self, Write};

use railhead_protocol::{
    AgentView, ClaimView, EnrollmentState, InboxEntry, InboxItem, StatusResult,
};
use serde::Serialize;

use crate::commands::claim::{render_claim, session};
use crate::http::Endpoint;
use crate::output::{Output, Render, inert};
use crate::{Agent, Error, Result};

/// Arguments of `rh status`.
#[derive(Debug, Clone, clap::Args)]
pub struct Args {}

/// Runs `rh status`.
///
/// # Errors
///
/// When the agent has no session or the backend refuses.
pub fn run(agent: &Agent<'_>, _args: &Args, out: &mut Output<'_>) -> Result<()> {
    let session = session(agent)?;
    let client = agent.client()?;
    let response = agent
        .invocation
        .runtime
        .block_on(client.get::<StatusResult>(&Endpoint::Status, Some(&session)))?;
    let status = Status {
        agent: response.data.agent,
        claim: response.data.claim,
        clone: agent
            .invocation
            .context
            .clone_binding()
            .map(|binding| binding.dir.display().to_string()),
        items: response
            .inbox
            .as_ref()
            .map(|inbox| inbox.items.clone())
            .unwrap_or_default(),
    };
    out.success(&status, response.inbox.as_ref(), response.next)
        .map_err(Error::Output)
}

/// The result of `rh status`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    agent: AgentView,
    claim: Option<ClaimView>,
    /// The clone the command ran in, if any.
    clone: Option<String>,
    /// The inbox items to list; the envelope already carries them in JSON.
    #[serde(skip)]
    items: Vec<InboxItem>,
}

impl Render for Status {
    fn render(&self, out: &mut dyn Write) -> io::Result<()> {
        let state = match self.agent.state {
            EnrollmentState::Pending => "pending confirmation",
            EnrollmentState::Confirmed => "confirmed",
        };
        writeln!(
            out,
            "agent {} ({}), {state}",
            inert(&self.agent.name),
            inert(&self.agent.agent_id)
        )?;
        match &self.claim {
            Some(claim) => {
                writeln!(out, "claim {}", inert(&claim.claim_id))?;
                render_claim(out, claim)?;
            }
            None => writeln!(out, "no claim")?,
        }
        if let Some(dir) = &self.clone {
            writeln!(out, "clone: {}", inert(dir))?;
        }
        for item in &self.items {
            let what = match &item.entry {
                InboxEntry::Decision { decision } => {
                    format!("decision {} v{}", decision.decision_id, decision.version)
                }
                InboxEntry::Rework { decision } => {
                    format!(
                        "rework for decision {} v{}",
                        decision.decision_id, decision.version
                    )
                }
                InboxEntry::Conflict {
                    other_claim_id,
                    path,
                } => format!("conflict with {other_claim_id} on {path}"),
            };
            writeln!(out, "inbox item {}: {}", item.item, inert(&what))?;
        }
        Ok(())
    }
}
