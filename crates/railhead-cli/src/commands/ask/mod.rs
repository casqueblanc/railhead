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
    AGENT_REQUEST_TIMEOUT_MS, AgentErrorCode, AgentSuccess, AskRequest, IdKind, MAX_LONG_POLL_MS,
    NextCommand, QuestionOption, QuestionResult, QuestionState, is_id,
};
use serde::Serialize;
use ssh_key::rand_core::{OsRng, RngCore};

use crate::commands::claim::{session, workspace};
use crate::commands::join;
use crate::commands::sync::{quoted, render_decision};
use crate::http::{self, Endpoint};
use crate::output::{LocalCode, Output, Render};
use crate::{Agent, Error, Result};

/// Longest `--wait`, in seconds.
pub const MAX_WAIT_SECONDS: u64 = 3600;

/// The part of a poll's time left for the backend's answer to travel back after it holds the poll.
const POLL_MARGIN: Duration = Duration::from_millis(500);

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
/// inconsistently. Any failure after the question may have reached the backend names the request
/// id to repeat it with.
pub fn run(agent: &Agent<'_>, args: &Args, out: &mut Output<'_>) -> Result<()> {
    let wait = args.wait.map(Duration::from_secs);
    let (response, request_id, timed_out) = match (&args.question, wait) {
        (Some(question_id), None) => (read(agent, question_id)?, None, false),
        (Some(question_id), Some(wait)) => {
            let (response, timed_out) = wait_for(agent, question_id, wait, None, out)?;
            (response, None, timed_out)
        }
        (None, wait) => {
            let (asked, request_id) = ask(agent, args, out)?;
            match wait {
                Some(wait) if asked.data.state == QuestionState::Open => {
                    let question_id = asked.data.question_id.clone();
                    let seconds = wait.as_secs();
                    let (response, timed_out) =
                        wait_for(agent, &question_id, wait, Some(asked), out).map_err(|error| {
                            resumable(error, &question_id, &request_id, seconds)
                        })?;
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
fn ask(
    agent: &Agent<'_>,
    args: &Args,
    out: &mut Output<'_>,
) -> Result<(AgentSuccess<QuestionResult>, String)> {
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
    let (request_id, generated) = match &args.request_id {
        Some(request_id) => (request_id.clone(), false),
        None => (new_request_id()?, true),
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
    if generated {
        // Said before anything is sent: a process stopped while the request is in flight never
        // reaches the failure handlers below, and the key is the only way to find the question.
        out.notice(&format!(
            "asking with --request-id {request_id}; if interrupted, repeat the same rh ask with --request-id {request_id} to find the question without asking twice"
        ))
        .map_err(Error::Output)?;
    }
    let endpoint = Endpoint::Ask {
        claim_id: &binding.claim_id,
    };
    // Once the request may have reached the backend, the question may have been recorded; only
    // the same key finds it without asking twice, so every such failure names it.
    let uncertain = |code| Error::Local {
        code,
        message: format!(
            "the question may or may not have been recorded; repeat the same rh ask with --request-id {request_id} to find out without asking twice"
        ),
        retryable: true,
        next: Some(NextCommand::Ask),
    };
    let response = match agent
        .invocation
        .runtime
        .block_on(client.send::<_, QuestionResult>(&endpoint, Some(&session), &request))
    {
        Ok(response) => response,
        Err(http::Error::Timeout(_)) => return Err(uncertain(LocalCode::Timeout)),
        Err(http::Error::Transport(_)) => return Err(uncertain(LocalCode::Unreachable)),
        Err(http::Error::Malformed { .. } | http::Error::ResponseTooLarge(_)) => {
            return Err(uncertain(LocalCode::MalformedResponse));
        }
        Err(http::Error::Rejected {
            route,
            status,
            mut error,
        }) => {
            if error.retryable {
                error.message = format!(
                    "{} (to retry this question without asking it twice, repeat the same rh ask with --request-id {request_id})",
                    error.message
                );
                error.next = Some(NextCommand::Ask);
            }
            return Err(http::Error::Rejected {
                route,
                status,
                error,
            }
            .into());
        }
        Err(other) => return Err(other.into()),
    };
    if check(&response.data, None).is_err() {
        return Err(uncertain(LocalCode::MalformedResponse));
    }
    Ok((response, request_id))
}

/// Reads a question once.
fn read(agent: &Agent<'_>, question_id: &str) -> Result<AgentSuccess<QuestionResult>> {
    let session = session(agent)?;
    let client = agent.client()?;
    let response = agent
        .invocation
        .runtime
        .block_on(client.get::<QuestionResult>(
            &Endpoint::Question {
                question_id,
                wait_ms: None,
            },
            Some(&session),
        ))?;
    check(&response.data, Some(question_id))?;
    Ok(response)
}

/// A failure while waiting on a question just asked, naming the question and the command that
/// resumes the wait: repeating the ask itself would ask again under a new key. The failure keeps
/// its code and whether it may be retried.
fn resumable(error: Error, question_id: &str, request_id: &str, seconds: u64) -> Error {
    let hint = format!(
        "question {question_id} was asked with --request-id {request_id}; resume with rh ask --question {question_id} --wait {seconds}"
    );
    let local = |code, retryable, error: &dyn std::fmt::Display| Error::Local {
        code,
        message: format!("{error}; {hint}"),
        retryable,
        next: retryable.then_some(NextCommand::Ask),
    };
    match error {
        Error::Http(http::Error::Rejected {
            route,
            status,
            mut error,
        }) => {
            error.message = format!("{} ({hint})", error.message);
            if error.retryable {
                error.next = Some(NextCommand::Ask);
            }
            Error::Http(http::Error::Rejected {
                route,
                status,
                error,
            })
        }
        Error::Http(error @ http::Error::Timeout(_)) => local(LocalCode::Timeout, true, &error),
        Error::Http(error @ (http::Error::Unreachable(_) | http::Error::Transport(_))) => {
            local(LocalCode::Unreachable, true, &error)
        }
        Error::Http(error @ (http::Error::Malformed { .. } | http::Error::ResponseTooLarge(_))) => {
            local(LocalCode::MalformedResponse, false, &error)
        }
        Error::Http(
            error @ (http::Error::InvalidRequest { .. }
            | http::Error::InvalidTarget { .. }
            | http::Error::RequestTooLarge(_)),
        ) => local(LocalCode::InvalidInput, false, &error),
        Error::Local {
            code,
            message,
            retryable,
            next,
        } => Error::Local {
            code,
            message: format!("{message}; {hint}"),
            retryable,
            next: next.or_else(|| retryable.then_some(NextCommand::Ask)),
        },
        other @ (Error::Context(_)
        | Error::Identity(_)
        | Error::Credential(_)
        | Error::Unavailable(_)
        | Error::WorkingDirectory(_)
        | Error::Runtime(_)
        | Error::Output(_)) => other,
    }
}

/// Polls until the question is answered or `wait` has passed, after telling a person on stderr how
/// to resume if the wait is interrupted. `last` is what is already known of the question, such as
/// the result of asking it. Returns the last answer and whether the wait ran out.
///
/// A poll never runs past the deadline: one still pending then is dropped, and the wait ends with
/// the last known state. A session renewal is bounded by the same deadline, both its wait for
/// another process's login on the session lock and its own login.
///
/// A `busy` or `rate_limited` refusal is polled again after [`retry_delay`] when that pause ends
/// before the deadline; any other failure ends the wait.
///
/// # Errors
///
/// When a poll fails as [`read`] does and is not retried, and [`LocalCode::Timeout`] when the wait ran out before
/// any state of the question was known.
fn wait_for(
    agent: &Agent<'_>,
    question_id: &str,
    wait: Duration,
    mut last: Option<AgentSuccess<QuestionResult>>,
    out: &mut Output<'_>,
) -> Result<(AgentSuccess<QuestionResult>, bool)> {
    let seconds = wait.as_secs();
    out.notice(&format!(
        "waiting up to {seconds} s for the answer to {question_id}; if interrupted, resume with rh ask --question {question_id} --wait {seconds}"
    ))
    .map_err(Error::Output)?;
    let deadline = Instant::now() + wait;
    loop {
        let started = Instant::now();
        let early = match poll(agent, question_id, deadline) {
            Ok(None) => break,
            Ok(Some(current)) => {
                if current.data.state == QuestionState::Answered {
                    return Ok((current, false));
                }
                last = Some(current);
                MIN_POLL_INTERVAL.saturating_sub(started.elapsed())
            }
            Err(error) => {
                let left = deadline.saturating_duration_since(Instant::now());
                let Some(delay) = retry_delay(&error).filter(|delay| *delay < left) else {
                    return Err(error);
                };
                out.notice(&format!(
                    "{error}; polling again in {} s",
                    delay.as_secs_f64().ceil()
                ))
                .map_err(Error::Output)?;
                delay
            }
        };
        let pause = early.min(deadline.saturating_duration_since(Instant::now()));
        if !pause.is_zero() {
            // The timer must be created inside the runtime.
            agent
                .invocation
                .runtime
                .block_on(async { tokio::time::sleep(pause).await });
        }
    }
    last.map(|last| (last, true)).ok_or_else(|| Error::Local {
        code: LocalCode::Timeout,
        message: format!(
            "no state of question {question_id} arrived within {seconds} s; wait again with rh ask --question {question_id} --wait {seconds}"
        ),
        retryable: true,
        next: Some(NextCommand::Ask),
    })
}

/// How long to pause before polling again after `error`, or `None` when the poll must not be
/// repeated. Only a refusal that asks to come back later is retried: `busy` and `rate_limited`,
/// after the backend's `retryAfterMs` and never sooner than [`MIN_POLL_INTERVAL`].
fn retry_delay(error: &Error) -> Option<Duration> {
    let Error::Http(http::Error::Rejected { error, .. }) = error else {
        return None;
    };
    if !error.retryable
        || !matches!(
            error.code,
            AgentErrorCode::Busy | AgentErrorCode::RateLimited
        )
    {
        return None;
    }
    let advised = error
        .retry_after_ms
        .map_or(Duration::ZERO, |ms| Duration::from_millis(u64::from(ms)));
    Some(advised.max(MIN_POLL_INTERVAL))
}

/// One poll that ends by `deadline`: the backend holds it for the time left less
/// [`POLL_MARGIN`], at most [`MAX_LONG_POLL_MS`], and a lapsed session is renewed within the same
/// time. Each request still fails after the protocol's timeout when that comes first. Returns
/// `None` when the deadline passes first.
fn poll(
    agent: &Agent<'_>,
    question_id: &str,
    deadline: Instant,
) -> Result<Option<AgentSuccess<QuestionResult>>> {
    let left = || deadline.saturating_duration_since(Instant::now());
    let passed = |error: &Error| {
        matches!(
            error,
            Error::Http(http::Error::Timeout(_))
                | Error::Local {
                    code: LocalCode::Timeout,
                    ..
                }
        ) && left().is_zero()
    };
    if left().is_zero() {
        return Ok(None);
    }
    let timeout = left().min(Duration::from_millis(AGENT_REQUEST_TIMEOUT_MS));
    let client = http::Client::with_timeout(&agent.identity.origin, &agent.identity.repo, timeout)?;
    let session = match join::session_with(agent, &client, Some(deadline)) {
        Ok(session) => session.into_token(),
        Err(error) if passed(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let budget = left();
    if budget.is_zero() {
        return Ok(None);
    }
    let endpoint = Endpoint::Question {
        question_id,
        wait_ms: Some(hold_ms(budget)),
    };
    let response = agent.invocation.runtime.block_on(async {
        tokio::time::timeout(
            budget,
            client.get::<QuestionResult>(&endpoint, Some(&session)),
        )
        .await
    });
    let response = match response {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            let error = Error::from(error);
            if passed(&error) {
                return Ok(None);
            }
            return Err(error);
        }
        Err(_elapsed) => return Ok(None),
    };
    check(&response.data, Some(question_id))?;
    Ok(Some(response))
}

/// How long the backend may hold a poll with `left` to the deadline, in whole milliseconds: the
/// time left less [`POLL_MARGIN`] for the answer to travel, at most [`MAX_LONG_POLL_MS`].
fn hold_ms(left: Duration) -> u64 {
    let millis = u64::try_from(left.saturating_sub(POLL_MARGIN).as_millis()).unwrap_or(u64::MAX);
    millis.min(MAX_LONG_POLL_MS)
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
    fn each_poll_is_held_for_the_time_left_less_the_margin_up_to_the_protocol_limit() {
        assert_eq!(hold_ms(Duration::from_secs(3600)), MAX_LONG_POLL_MS);
        assert_eq!(hold_ms(Duration::from_millis(25_501)), 25_000);
        assert_eq!(hold_ms(Duration::from_millis(25_499)), 24_999);
        assert_eq!(hold_ms(Duration::from_millis(1_500)), 1_000);
        assert_eq!(hold_ms(Duration::from_millis(500)), 0);
        assert_eq!(hold_ms(Duration::ZERO), 0);
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
