//! `rh pin`: Show where the agent's pin stands on the merge train.
//!
//! The backend answers only for the agent's active claim at its current generation, so the command
//! needs no clone: run anywhere, it reads the pin of the agent it acts as.

use std::io::{self, Write};

use railhead_protocol::{PinBatchState, PinLeaveReason, PinResult, PinTrainState, PinView};
use serde::Serialize;

use crate::commands::claim::session;
use crate::http::Endpoint;
use crate::output::{Output, Render, quoted};
use crate::{Agent, Error, Result};

/// Arguments of `rh pin`.
#[derive(Debug, Clone, clap::Args)]
pub struct Args {}

/// Runs `rh pin`.
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
        .block_on(client.get::<PinResult>(&Endpoint::Pin, Some(&session)))?;
    let pinned = Pinned {
        pin: response.data.pin,
    };
    out.success(&pinned, response.inbox.as_ref(), response.next)
        .map_err(Error::Output)
}

/// The result of `rh pin`.
#[derive(Debug, Serialize)]
struct Pinned {
    /// The pin, or `None` when the train holds none for the agent.
    pin: Option<PinView>,
}

impl Render for Pinned {
    fn render(&self, out: &mut dyn Write) -> io::Result<()> {
        let Some(pin) = &self.pin else {
            return writeln!(out, "no pin on the train");
        };
        writeln!(
            out,
            "claim {} gen {}, commit {}",
            quoted(&pin.claim_id),
            pin.generation,
            quoted(&pin.commit)
        )?;
        match &pin.state {
            PinTrainState::Queued { position } => writeln!(out, "queued at position {position}")?,
            PinTrainState::Batched {
                batch_id,
                batch,
                check_run_id,
            } => {
                let stage = match batch {
                    PinBatchState::Forming => "forming",
                    PinBatchState::Checking => "checking",
                    PinBatchState::Held => "held for a person",
                    PinBatchState::Landing => "landing",
                };
                let check = check_run_id.as_deref().map_or_else(
                    || "no check run yet".to_owned(),
                    |id| format!("check run {}", quoted(id)),
                );
                writeln!(out, "in batch {batch_id}, {stage}; {check}")?;
            }
            PinTrainState::Landed => writeln!(out, "landed on main")?,
            PinTrainState::Dropped { reason } => writeln!(
                out,
                "dropped: {}; rh ready queues it again",
                leave_reason(*reason)
            )?,
            PinTrainState::Parked { reason } => writeln!(
                out,
                "parked: {}; a person or a new push returns it",
                leave_reason(*reason)
            )?,
        }
        if let Some(next) = &pin.next_commit {
            writeln!(out, "next commit {} waits for the batch", quoted(next))?;
        }
        Ok(())
    }
}

/// Why the train took the pin out of its queue, in words.
const fn leave_reason(reason: PinLeaveReason) -> &'static str {
    match reason {
        PinLeaveReason::PinChanged => "the claim was pinned again",
        PinLeaveReason::RequirementsRefused => "its decision requirements could not be read",
        PinLeaveReason::CheckFailed => "its check failed",
        PinLeaveReason::ComposeFailed => "it could not be composed on main",
        PinLeaveReason::RetriesExhausted => "its batches failed too often",
        PinLeaveReason::Conflict => "it conflicts with another claim",
        PinLeaveReason::CheckHeld => "its check waits for a person",
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn rendered(pin: Value) -> anyhow::Result<String> {
        let pinned = Pinned {
            pin: serde_json::from_value(pin)?,
        };
        let mut text = Vec::new();
        pinned.render(&mut text)?;
        Ok(String::from_utf8(text)?)
    }

    fn pin(state: &Value, next_commit: Option<&str>) -> Value {
        pin_of("clm_42abcd", state, next_commit)
    }

    fn pin_of(claim_id: &str, state: &Value, next_commit: Option<&str>) -> Value {
        json!({"claimId": claim_id, "generation": 1, "commit": "b".repeat(40),
            "nextCommit": next_commit, "state": state})
    }

    fn head() -> String {
        format!(
            "claim \"clm_42abcd\" gen 1, commit \"{}\"\n",
            "b".repeat(40)
        )
    }

    #[test]
    fn each_train_state_prints_one_line() -> anyhow::Result<()> {
        let cases = [
            (
                json!({"kind": "queued", "position": 2}),
                "queued at position 2",
            ),
            (
                json!({"kind": "batched", "batchId": 7, "batch": "forming", "checkRunId": null}),
                "in batch 7, forming; no check run yet",
            ),
            (
                json!({"kind": "batched", "batchId": 7, "batch": "held", "checkRunId": "chk_run0001"}),
                "in batch 7, held for a person; check run \"chk_run0001\"",
            ),
            (json!({"kind": "landed"}), "landed on main"),
            (
                json!({"kind": "dropped", "reason": "check_failed"}),
                "dropped: its check failed; rh ready queues it again",
            ),
            (
                json!({"kind": "parked", "reason": "conflict"}),
                "parked: it conflicts with another claim; a person or a new push returns it",
            ),
        ];
        for (state, line) in cases {
            assert_eq!(rendered(pin(&state, None))?, format!("{}{line}\n", head()));
        }
        Ok(())
    }

    #[test]
    fn no_pin_and_a_waiting_commit_stay_visible() -> anyhow::Result<()> {
        assert_eq!(rendered(Value::Null)?, "no pin on the train\n");
        let next = "c".repeat(40);
        let text = rendered(pin(&json!({"kind": "landed"}), Some(&next)))?;
        assert_eq!(
            text,
            format!(
                "{}landed on main\nnext commit \"{next}\" waits for the batch\n",
                head()
            )
        );
        Ok(())
    }

    #[test]
    fn backend_values_cannot_forge_a_line() -> anyhow::Result<()> {
        let forged = pin_of(
            "clm_42abcd\u{1b}[2J",
            &json!({"kind": "batched", "batchId": 7, "batch": "checking",
                "checkRunId": "chk_x\nlanded on main"}),
            Some("c\u{2028}queued at position 1"),
        );
        let text = rendered(forged)?;
        assert_eq!(
            text,
            format!(
                "claim \"clm_42abcd\\u001b[2J\" gen 1, commit \"{}\"\n\
                 in batch 7, checking; check run \"chk_x\\nlanded on main\"\n\
                 next commit \"c\\u2028queued at position 1\" waits for the batch\n",
                "b".repeat(40)
            )
        );
        Ok(())
    }

    #[test]
    fn an_unknown_state_is_refused() {
        let unknown = pin(&json!({"kind": "teleported"}), None);
        assert!(serde_json::from_value::<Option<PinView>>(unknown).is_err());
        let bad_reason = pin(&json!({"kind": "parked", "reason": "bored"}), None);
        assert!(serde_json::from_value::<Option<PinView>>(bad_reason).is_err());
    }
}
