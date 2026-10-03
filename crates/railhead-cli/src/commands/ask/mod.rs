//! `rh ask`: Ask the owner a question about the claim.
//!
//! Asking returns the question at once. `--wait` then long-polls for the answer, each request held
//! by the backend for at most [`MAX_LONG_POLL_MS`], until the answer arrives or the wait the agent
//! named runs out. The process sleeps meanwhile; it calls no model and acknowledges nothing. An
//! answer is a decision, and it reaches the inbox like any other, for the agent to acknowledge
//! with `rh ack`.
//!
//! `rh ask --question <id>` reads, or waits on, a question asked earlier, so a wait that timed out
//! or was interrupted resumes without asking again.

use std::fmt::Write as _;
use std::io::{self, Write};
use std::time::{Duration, Instant};

use railhead_protocol::{
    AgentSuccess, AskRequest, IdKind, MAX_LONG_POLL_MS, NextCommand, QuestionOption,
    QuestionResult, QuestionState, is_id,
};
use serde::Serialize;
use ssh_key::rand_core::{OsRng, RngCore};

use crate::commands::claim::{session, workspace};
use crate::commands::sync::{quoted, render_decision};
use crate::http::{self, Endpoint};
use crate::output::{LocalCode, Output, Render};
use crate::{Agent, Error, Result};

/// Longest `--wait`, in seconds.
pub const MAX_WAIT_SECONDS: u64 = 3600;

/// The shortest time between two polls. A backend that answers before the wait it was given is
/// not polled faster than this.
const MIN_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// Arguments of `rh ask`.
#[derive(Debug, Clone, clap::Args)]
pub struct Args {
    /// The question for the owner. Up to 2000 characters.
    #[arg(required_unless_present = "question")]
    pub text: Option<String>,

    /// An answer to offer, as `key=label`, such as `reject="Reject them"`. Give 2 to 8.
    #[arg(long = "option", value_name = "KEY=LABEL", value_parser = parse_option)]
    pub options: Vec<QuestionOption>,

    /// A repository path the answer applies to. Give at least one.
    #[arg(long, value_name = "PATH")]
    pub scope: Vec<String>,

    /// Wait up to this many seconds for the answer, from 1 to 3600.
    #[arg(long, value_name = "SECONDS",
        value_parser = clap::value_parser!(u64).range(1..=MAX_WAIT_SECONDS))]
    pub wait: Option<u64>,

    /// The idempotency key of an ask whose outcome is unknown. Repeating the same question with it
    /// returns the recorded question instead of asking twice.
    #[arg(long, value_name = "ID")]
    pub request_id: Option<String>,

    /// Read, or with `--wait` wait on, a question asked earlier instead of asking one.
    #[arg(long, value_name = "ID", value_parser = parse_question,
        conflicts_with_all = ["text", "options", "scope", "request_id"])]
    pub question: Option<String>,
}

fn parse_option(value: &str) -> std::result::Result<QuestionOption, String> {
    value
        .split_once('=')
        .map(|(key, label)| QuestionOption {
            key: key.to_owned(),
            label: label.to_owned(),
        })
        .ok_or_else(|| "not KEY=LABEL, such as reject=\"Reject them\"".to_owned())
}

fn parse_question(value: &str) -> std::result::Result<String, String> {
    if is_id(IdKind::Question, value) {
        Ok(value.to_owned())
    } else {
        Err("not a question id, such as qst_upload1".to_owned())
    }
}

/// Runs `rh ask`.
///
/// # Errors
///
/// When the question breaks a protocol rule (checked before anything is sent), when it is asked
/// outside a claim's clone, when the agent has no session, when the backend refuses or answers
/// inconsistently, or when the ask's outcome is unknown, which names the request id to repeat it
/// with.
pub fn run(agent: &Agent<'_>, args: &Args, out: &mut Output<'_>) -> Result<()> {
    let wait = args.wait.map(Duration::from_secs);
    let (response, request_id, timed_out) = match (&args.question, wait) {
        (Some(question_id), None) => (read(agent, question_id, None)?, None, false),
        (Some(question_id), Some(wait)) => {
            let (response, timed_out) = wait_for(agent, question_id, wait, out)?;
            (response, None, timed_out)
        }
        (None, wait) => {
            let (asked, request_id) = ask(agent, args)?;
            match wait {
                Some(wait) if asked.data.state == QuestionState::Open => {
                    let question_id = asked.data.question_id.clone();
                    let (response, timed_out) = wait_for(agent, &question_id, wait, out)?;
                    (response, Some(request_id), timed_out)
                }
                Some(_) | None => (asked, Some(request_id), false),
            }
        }
    };
    let next = if timed_out {
        Some(NextCommand::Ask)
    } else {
        response.next
    };
    let result = Asked {
        question: response.data,
        request_id,
        waited_seconds: args.wait,
        timed_out,
    };
    out.success(&result, response.inbox.as_ref(), next)
        .map_err(Error::Output)
}

/// Asks the question in the clone's claim, at the clone's generation.
fn ask(agent: &Agent<'_>, args: &Args) -> Result<(AgentSuccess<QuestionResult>, String)> {
    let binding = agent
        .invocation
        .context
        .clone_binding()
        .ok_or_else(|| Error::Local {
            code: LocalCode::NoClone,
            message: "rh ask asks about a claim; run it inside the claim's clone".to_owned(),
            retryable: false,
            next: Some(NextCommand::Status),
        })?;
    let request_id = match &args.request_id {
        Some(request_id) => request_id.clone(),
        None => new_request_id()?,
    };
    let request = AskRequest {
        generation: workspace::generation(&binding.dir)?,
        request_id: request_id.clone(),
        text: args.text.clone().unwrap_or_default(),
        options: args.options.clone(),
        scope: args.scope.clone(),
    };
    let route = railhead_protocol::AgentRoute::Ask;
    request
        .validate()
        .map_err(|source| Error::Http(http::Error::InvalidRequest { route, source }))?;
    let session = session(agent)?;
    let client = agent.client()?;
    let endpoint = Endpoint::Ask {
        claim_id: &binding.claim_id,
    };
    let response = agent
        .invocation
        .runtime
        .block_on(client.send::<_, QuestionResult>(&endpoint, Some(&session), &request))
        .map_err(|error| match error {
            // The question may have been recorded; the same key finds it without asking twice.
            http::Error::Timeout(_) | http::Error::Transport(_) => Error::Local {
                code: LocalCode::Timeout,
                message: format!(
                    "the question may or may not have been recorded; repeat the same rh ask with --request-id {request_id} to find out without asking twice"
                ),
                retryable: true,
                next: Some(NextCommand::Ask),
            },
            other => other.into(),
        })?;
    check(&response.data, None)?;
    Ok((response, request_id))
}

/// Reads a question once, or long-polls it for up to `wait_ms`.
fn read(
    agent: &Agent<'_>,
    question_id: &str,
    wait_ms: Option<u64>,
) -> Result<AgentSuccess<QuestionResult>> {
    let session = session(agent)?;
    let client = agent.client()?;
    let response = agent
        .invocation
        .runtime
        .block_on(client.get::<QuestionResult>(
            &Endpoint::Question {
                question_id,
                wait_ms,
            },
            Some(&session),
        ))?;
    check(&response.data, Some(question_id))?;
    Ok(response)
}

/// Polls until the question is answered or `wait` has passed, after telling a person on stderr how
/// to resume if the wait is interrupted. Each poll asks the backend to hold
/// it for the time left, at most [`MAX_LONG_POLL_MS`]; the session is renewed between polls when
/// it lapses. Returns the last answer and whether the wait ran out.
fn wait_for(
    agent: &Agent<'_>,
    question_id: &str,
    wait: Duration,
    out: &mut Output<'_>,
) -> Result<(AgentSuccess<QuestionResult>, bool)> {
    let seconds = wait.as_secs();
    out.notice(&format!(
        "waiting up to {seconds} s for the answer to {question_id}; if interrupted, resume with rh ask --question {question_id} --wait {seconds}"
    ))
    .map_err(Error::Output)?;
    let deadline = Instant::now() + wait;
    let left = || poll_wait_ms(deadline.saturating_duration_since(Instant::now()));
    // The first poll always runs, so the result is the backend's even when no time is left.
    let mut started = Instant::now();
    let mut current = read(agent, question_id, Some(left().unwrap_or(0)))?;
    loop {
        if current.data.state == QuestionState::Answered {
            return Ok((current, false));
        }
        let early = MIN_POLL_INTERVAL.saturating_sub(started.elapsed());
        let pause = early.min(deadline.saturating_duration_since(Instant::now()));
        if !pause.is_zero() {
            // The timer must be created inside the runtime.
            agent
                .invocation
                .runtime
                .block_on(async { tokio::time::sleep(pause).await });
        }
        let Some(wait_ms) = left() else {
            return Ok((current, true));
        };
        started = Instant::now();
        current = read(agent, question_id, Some(wait_ms))?;
    }
}

/// How long the next poll may be held, in whole milliseconds, or `None` when no time is left.
fn poll_wait_ms(left: Duration) -> Option<u64> {
    let millis = u64::try_from(left.as_millis()).unwrap_or(u64::MAX);
    (millis > 0).then(|| millis.min(MAX_LONG_POLL_MS))
}

/// Refuses a question result that names another question, or whose state and decision disagree.
fn check(result: &QuestionResult, expected: Option<&str>) -> Result<()> {
    let id = &result.question_id;
    let consistent = is_id(IdKind::Question, id)
        && is_id(IdKind::Decision, &result.decision_id)
        && expected.is_none_or(|expected| expected == id)
        && match (&result.state, &result.decision) {
            (QuestionState::Open, None) => true,
            (QuestionState::Answered, Some(decision)) => {
                &decision.question_id == id && decision.decision_id == result.decision_id
            }
            (QuestionState::Open, Some(_)) | (QuestionState::Answered, None) => false,
        };
    if consistent {
        Ok(())
    } else {
        Err(Error::Local {
            code: LocalCode::MalformedResponse,
            message: "the backend answered with an inconsistent question".to_owned(),
            retryable: false,
            next: None,
        })
    }
}

/// A new idempotency key: `req_` and 128 random bits in hex.
fn new_request_id() -> Result<String> {
    let mut bytes = [0_u8; 16];
    OsRng.try_fill_bytes(&mut bytes).map_err(|_| Error::Local {
        code: LocalCode::InvalidInput,
        message: "the system's random source failed; pass --request-id".to_owned(),
        retryable: true,
        next: None,
    })?;
    Ok(bytes.iter().fold(String::from("req_"), |mut id, byte| {
        // Writing to a String cannot fail.
        let _ = write!(id, "{byte:02x}");
        id
    }))
}

/// The result of `rh ask`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Asked {
    question: QuestionResult,
    /// The idempotency key the question was asked with, or `None` when it was only read.
    request_id: Option<String>,
    /// The `--wait` given, in seconds.
    waited_seconds: Option<u64>,
    /// `true` when the wait ran out before an answer.
    timed_out: bool,
}

impl Render for Asked {
    fn render(&self, out: &mut dyn Write) -> io::Result<()> {
        let id = &self.question.question_id;
        match (&self.question.state, &self.question.decision) {
            (QuestionState::Answered, Some(decision)) => {
                writeln!(out, "question {id} is answered")?;
                render_decision(out, decision)?;
                writeln!(
                    out,
                    "the decision is also in the inbox; acknowledge it there with a plan"
                )
            }
            (QuestionState::Open, _) | (QuestionState::Answered, None) => {
                if let (true, Some(seconds)) = (self.timed_out, self.waited_seconds) {
                    writeln!(out, "question {id} is still open after {seconds} s")?;
                    return writeln!(
                        out,
                        "wait again with: rh ask --question {id} --wait {seconds}"
                    );
                }
                let verb = if self.request_id.is_some() {
                    "asked"
                } else {
                    "open:"
                };
                writeln!(
                    out,
                    "{verb} question {id}; its answer will record decision {}",
                    quoted(&self.question.decision_id)
                )?;
                writeln!(
                    out,
                    "wait for the answer with: rh ask --question {id} --wait <seconds>"
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use clap::error::ErrorKind;
    use serde_json::json;

    use super::*;

    fn parse(args: &[&str]) -> std::result::Result<Args, clap::Error> {
        let command = <Args as clap::Args>::augment_args(clap::Command::new("ask"));
        let matches = command.no_binary_name(true).try_get_matches_from(args)?;
        <Args as clap::FromArgMatches>::from_arg_matches(&matches)
    }

    #[test]
    fn a_question_or_a_question_id_is_required_but_not_both() -> anyhow::Result<()> {
        let args = parse(&[
            "Reject?", "--option", "a=A", "--option", "b=B=C", "--scope", "src",
        ])?;
        assert_eq!(args.text.as_deref(), Some("Reject?"));
        assert_eq!(
            args.options
                .get(1)
                .map(|option| (&*option.key, &*option.label)),
            Some(("b", "B=C"))
        );
        assert!(parse(&["--question", "qst_upload1", "--wait", "60"]).is_ok());
        let kind = |args: &[&str]| parse(args).err().map(|error| error.kind());
        assert_eq!(kind(&[]), Some(ErrorKind::MissingRequiredArgument));
        assert_eq!(
            kind(&["Reject?", "--question", "qst_upload1"]),
            Some(ErrorKind::ArgumentConflict)
        );
        assert_eq!(
            kind(&["--question", "clm_42abcd"]),
            Some(ErrorKind::ValueValidation)
        );
        assert_eq!(
            kind(&["Reject?", "--option", "no-equals"]),
            Some(ErrorKind::ValueValidation)
        );
        Ok(())
    }

    #[test]
    fn the_wait_is_bounded() {
        let wait = |value: &str| parse(&["--question", "qst_upload1", "--wait", value]);
        assert!(wait("1").is_ok() && wait("3600").is_ok());
        for bad in ["0", "3601", "-1", "1.5"] {
            assert!(wait(bad).is_err(), "{bad} was accepted");
        }
    }

    #[test]
    fn each_poll_is_held_for_the_time_left_up_to_the_protocol_limit() {
        assert_eq!(
            poll_wait_ms(Duration::from_secs(3600)),
            Some(MAX_LONG_POLL_MS)
        );
        assert_eq!(poll_wait_ms(Duration::from_millis(25_001)), Some(25_000));
        assert_eq!(poll_wait_ms(Duration::from_millis(1_500)), Some(1_500));
        assert_eq!(poll_wait_ms(Duration::from_micros(999)), None);
        assert_eq!(poll_wait_ms(Duration::ZERO), None);
    }

    #[test]
    fn request_ids_are_fresh_valid_keys() -> anyhow::Result<()> {
        let (first, second) = (new_request_id()?, new_request_id()?);
        assert_ne!(first, second);
        let request = AskRequest {
            generation: railhead_protocol::SafeInteger::new(1)
                .ok_or_else(|| anyhow::anyhow!("range"))?,
            request_id: first,
            text: "Reject?".to_owned(),
            options: vec![
                parse_option("a=A").map_err(anyhow::Error::msg)?,
                parse_option("b=B").map_err(anyhow::Error::msg)?,
            ],
            scope: vec!["src".to_owned()],
        };
        request.validate()?;
        Ok(())
    }

    fn result(value: serde_json::Value) -> anyhow::Result<QuestionResult> {
        Ok(serde_json::from_value(value)?)
    }

    fn answered() -> serde_json::Value {
        json!({"questionId": "qst_upload1", "decisionId": "dec_upload1", "state": "answered",
            "decision": {"decisionId": "dec_upload1", "version": 1, "supersedes": null,
                "questionId": "qst_upload1", "question": "Reject?",
                "option": {"key": "reject", "label": "Reject them"}, "previous": null,
                "scope": ["src/upload.ts"], "decidedBy": "usr_lemarier", "decidedAt": 1}})
    }

    #[test]
    fn an_inconsistent_question_is_refused() -> anyhow::Result<()> {
        let open = json!({"questionId": "qst_upload1", "decisionId": "dec_upload1",
            "state": "open", "decision": null});
        check(&result(open.clone())?, Some("qst_upload1"))?;
        check(&result(answered())?, None)?;
        assert!(check(&result(open.clone())?, Some("qst_other01")).is_err());
        let with = |mut value: serde_json::Value, pointer: &str, new: serde_json::Value| {
            if let Some(slot) = value.pointer_mut(pointer) {
                *slot = new;
            }
            value
        };
        let no_decision = with(answered(), "/decision", json!(null));
        let early = with(answered(), "/state", json!("open"));
        let other = with(answered(), "/decision/questionId", json!("qst_other01"));
        let bad_id = with(open, "/questionId", json!("../status"));
        for value in [no_decision, early, other, bad_id] {
            assert!(check(&result(value.clone())?, None).is_err(), "{value}");
        }
        Ok(())
    }

    #[test]
    fn results_name_the_command_to_continue_with() -> anyhow::Result<()> {
        let render = |asked: &Asked| -> anyhow::Result<String> {
            let mut text = Vec::new();
            asked.render(&mut text)?;
            Ok(String::from_utf8(text)?)
        };
        let open = result(
            json!({"questionId": "qst_upload1", "decisionId": "dec_upload1",
            "state": "open", "decision": null}),
        )?;
        let timed_out = Asked {
            question: open.clone(),
            request_id: None,
            waited_seconds: Some(60),
            timed_out: true,
        };
        assert_eq!(
            render(&timed_out)?,
            "question qst_upload1 is still open after 60 s\n\
             wait again with: rh ask --question qst_upload1 --wait 60\n"
        );
        let asked = Asked {
            question: open,
            request_id: Some("req_x".to_owned()),
            waited_seconds: None,
            timed_out: false,
        };
        assert_eq!(
            render(&asked)?,
            "asked question qst_upload1; its answer will record decision \"dec_upload1\"\n\
             wait for the answer with: rh ask --question qst_upload1 --wait <seconds>\n"
        );
        let done = Asked {
            question: result(answered())?,
            request_id: None,
            waited_seconds: Some(60),
            timed_out: false,
        };
        let text = render(&done)?;
        assert!(
            text.starts_with("question qst_upload1 is answered\n     decision: \"dec_upload1\" v1"),
            "{text}"
        );
        assert!(
            text.contains("     chosen: \"reject\" \"Reject them\"\n"),
            "{text}"
        );
        Ok(())
    }
}
