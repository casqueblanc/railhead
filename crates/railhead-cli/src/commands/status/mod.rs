//! `rh status`: Show the agent, its claim with the durable task, and its inbox.

use std::io::{self, Write};

use railhead_protocol::{
    AgentView, ClaimView, EnrollmentState, InboxEntry, InboxItem, StatusResult,
};
use serde::Serialize;

use crate::commands::claim::{render_claim, session};
use crate::http::Endpoint;
use crate::output::{Output, Render, inert, quoted};
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
            quoted(&self.agent.name),
            quoted(&self.agent.agent_id)
        )?;
        match &self.claim {
            Some(claim) => {
                writeln!(out, "claim {}", quoted(&claim.claim_id))?;
                render_claim(out, claim)?;
            }
            None => writeln!(out, "no claim")?,
        }
        if let Some(dir) = &self.clone {
            writeln!(out, "clone: {}", inert(dir))?;
        }
        for item in &self.items {
            let what = match &item.entry {
                InboxEntry::Decision { decision } => format!(
                    "decision {} v{}",
                    quoted(&decision.decision_id),
                    decision.version
                ),
                InboxEntry::Rework { decision } => format!(
                    "rework for decision {} v{}",
                    quoted(&decision.decision_id),
                    decision.version
                ),
                InboxEntry::Conflict {
                    other_claim_id,
                    path,
                } => format!(
                    "conflict with {} on {}",
                    quoted(other_claim_id),
                    quoted(path)
                ),
            };
            writeln!(out, "inbox item {}: {what}", item.item)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn status(agent_name: &str, items: &[Value]) -> anyhow::Result<Status> {
        Ok(Status {
            agent: serde_json::from_value(
                json!({"agentId": "agt_atlas01", "name": agent_name, "ownerId": "usr_lemarier", "state": "confirmed"}),
            )?,
            claim: None,
            clone: None,
            items: serde_json::from_value(Value::Array(items.to_vec()))?,
        })
    }

    fn conflict(path: &str) -> Value {
        json!({"item": 18, "claimId": "clm_42abcd", "queuedAt": 1,
            "entry": {"kind": "conflict", "otherClaimId": "clm_43abcd", "path": path},
            "decision": null})
    }

    fn rendered(status: &Status) -> anyhow::Result<String> {
        let mut text = Vec::new();
        status.render(&mut text)?;
        Ok(String::from_utf8(text)?)
    }

    #[test]
    fn inbox_items_print_quoted_backend_values() -> anyhow::Result<()> {
        let rework = json!({"item": 17, "claimId": "clm_42abcd", "queuedAt": 1,
            "entry": {"kind": "rework", "decision": {"decisionId": "dec_upload1", "version": 2}},
            "decision": null});
        let text = rendered(&status("atlas", &[rework, conflict("src/upload.ts")])?)?;
        assert_eq!(
            text,
            "agent \"atlas\" (\"agt_atlas01\"), confirmed\nno claim\n\
             inbox item 17: rework for decision \"dec_upload1\" v2\n\
             inbox item 18: conflict with \"clm_43abcd\" on \"src/upload.ts\"\n"
        );
        Ok(())
    }

    #[test]
    fn an_empty_path_and_inbox_stay_visible() -> anyhow::Result<()> {
        assert_eq!(
            rendered(&status("atlas", &[conflict("")])?)?.lines().last(),
            Some("inbox item 18: conflict with \"clm_43abcd\" on \"\"")
        );
        assert_eq!(
            rendered(&status("atlas", &[])?)?,
            "agent \"atlas\" (\"agt_atlas01\"), confirmed\nno claim\n"
        );
        Ok(())
    }

    #[test]
    fn a_path_cannot_forge_a_line() -> anyhow::Result<()> {
        let text = rendered(&status(
            "atlas\nno claim",
            &[conflict(
                "a.ts\ninbox item 99: forged\u{2028}inbox item 98: forged\u{1b}[2J",
            )],
        )?)?;
        assert_eq!(
            text,
            "agent \"atlas\\nno claim\" (\"agt_atlas01\"), confirmed\nno claim\n\
             inbox item 18: conflict with \"clm_43abcd\" on \
             \"a.ts\\ninbox item 99: forged\\u2028inbox item 98: forged\\u001b[2J\"\n"
        );
        assert!(
            !text
                .split(['\n', '\r', '\u{85}', '\u{2028}', '\u{2029}'])
                .any(|line| line.starts_with("inbox item 9")),
            "{text}"
        );
        Ok(())
    }
}
