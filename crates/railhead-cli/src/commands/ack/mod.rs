//! `rh ack`: Acknowledge one inbox item with a plan.
//!
//! Each item takes its own plan, written by the agent; `rh` never acknowledges anything on its
//! own. The first acknowledgement of an item stands: repeating it changes nothing and returns the
//! plan recorded first.

use std::io::{self, Write};

use railhead_protocol::{AckRequest, AckResult, AgentErrorCode, NextCommand, SafeInteger};
use serde::Serialize;

use crate::commands::claim::session;
use crate::commands::sync::quoted;
use crate::http::{self, Endpoint};
use crate::output::{LocalCode, Output, Render, command_line};
use crate::{Agent, Error, Result};

/// Arguments of `rh ack`.
#[derive(Debug, Clone, clap::Args)]
pub struct Args {
    /// The inbox item, as `rh sync` numbers it.
    #[arg(value_parser = parse_item)]
    pub item: SafeInteger,

    /// What you will change because of the item, or why it does not apply. Up to 4000 characters.
    #[arg(long)]
    pub plan: String,
}

fn parse_item(value: &str) -> std::result::Result<SafeInteger, String> {
    value
        .parse::<u64>()
        .ok()
        .filter(|&item| item > 0)
        .and_then(SafeInteger::new)
        .ok_or_else(|| "not an inbox item number, such as 17".to_owned())
}

/// Runs `rh ack`.
///
/// # Errors
///
/// When the plan is blank or too long (checked before anything is sent), when the agent has no
/// session, or when the backend refuses, as it does for an item that is not this agent's.
pub fn run(agent: &Agent<'_>, args: &Args, out: &mut Output<'_>) -> Result<()> {
    let request = AckRequest {
        plan: args.plan.clone(),
    };
    request.validate().map_err(|source| {
        Error::Http(http::Error::InvalidRequest {
            route: railhead_protocol::AgentRoute::Ack,
            source,
        })
    })?;
    let session = session(agent)?;
    let client = agent.client()?;
    let response = agent
        .invocation
        .runtime
        .block_on(client.send::<_, AckResult>(
            &Endpoint::Ack { item: args.item },
            Some(&session),
            &request,
        ));
    if let Err(http::Error::Rejected { error, .. }) = &response
        && error.code == AgentErrorCode::NotFound
    {
        out.notice(&format!(
            "item {} is not pending in this agent's inbox; {} lists the items that are",
            args.item,
            command_line(NextCommand::Sync)
        ))
        .map_err(Error::Output)?;
    }
    let response = response?;
    let data = response.data;
    if data.item != args.item {
        return Err(Error::Local {
            code: LocalCode::MalformedResponse,
            message: format!(
                "rh ack {} was answered for item {}; check the inbox with rh sync",
                args.item, data.item
            ),
            retryable: false,
            next: Some(NextCommand::Sync),
        });
    }
    if data.repeated && data.plan != args.plan {
        out.notice(&format!(
            "item {} was already acknowledged; its first plan stands and this one was not recorded",
            data.item
        ))
        .map_err(Error::Output)?;
    }
    out.success(&Acked(data), response.inbox.as_ref(), response.next)
        .map_err(Error::Output)
}

/// The result of `rh ack`.
#[derive(Debug, Serialize)]
#[serde(transparent)]
struct Acked(AckResult);

impl Render for Acked {
    fn render(&self, out: &mut dyn Write) -> io::Result<()> {
        let verb = if self.0.repeated {
            "already acknowledged"
        } else {
            "acknowledged"
        };
        writeln!(out, "{verb} item {}", self.0.item)?;
        writeln!(out, "plan: {}", quoted(&self.0.plan))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn items_are_positive_safe_integers() {
        assert_eq!(parse_item("17").map(SafeInteger::get), Ok(17));
        assert_eq!(
            parse_item("9007199254740991").map(SafeInteger::get),
            Ok(9_007_199_254_740_991)
        );
        for bad in ["0", "-1", "9007199254740992", "x17", "", "1.5"] {
            assert!(parse_item(bad).is_err(), "{bad:?} was accepted");
        }
    }

    #[test]
    fn a_repeat_says_the_first_plan_stands() -> anyhow::Result<()> {
        let acked = |repeated| -> anyhow::Result<String> {
            let result: AckResult = serde_json::from_value(serde_json::json!({"item": 17,
                "plan": "Switch to\nchunks", "ackedAt": 1, "repeated": repeated}))?;
            let mut text = Vec::new();
            Acked(result).render(&mut text)?;
            Ok(String::from_utf8(text)?)
        };
        assert_eq!(
            acked(false)?,
            "acknowledged item 17\nplan: \"Switch to\\nchunks\"\n"
        );
        assert_eq!(
            acked(true)?,
            "already acknowledged item 17\nplan: \"Switch to\\nchunks\"\n"
        );
        Ok(())
    }
}
