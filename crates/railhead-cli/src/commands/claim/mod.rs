//! `rh claim`: Claim a named issue and clone its fork.
//!
//! `rh work` shares everything after the request: the remotes are checked, the clone is created
//! or reused, and the durable task is printed with the pending inbox.

pub mod workspace;

use std::io::{self, Write};
use std::path::{Path, PathBuf};

use railhead_protocol::{
    AgentSuccess, ClaimRequest, ClaimResult, ClaimView, IdKind, NextCommand, is_id,
};
use serde::Serialize;

use crate::http::Endpoint;
use crate::identity::SessionToken;
use crate::output::{LocalCode, Output, Render, inert};
use crate::{Agent, Error, Result};

use workspace::{CloneState, Remotes};

/// Arguments of `rh claim`.
#[derive(Debug, Clone, clap::Args)]
pub struct Args {
    /// The issue to claim, such as `iss_upload1`.
    #[arg(value_parser = parse_issue)]
    pub issue: String,

    /// Where to clone the fork. Defaults to `<repo>-<claim>` beside the current clone, or in the
    /// working directory.
    #[arg(long, value_name = "DIR")]
    pub dir: Option<PathBuf>,
}

fn parse_issue(value: &str) -> std::result::Result<String, String> {
    if is_id(IdKind::Issue, value) {
        Ok(value.to_owned())
    } else {
        Err("not an issue id, such as iss_upload1".to_owned())
    }
}

/// Runs `rh claim`.
///
/// # Errors
///
/// When the named directory cannot hold the clone (checked before anything is sent), when the
/// agent has no session, when the backend refuses, or when the clone cannot be made.
pub fn run(agent: &Agent<'_>, args: &Args, out: &mut Output<'_>) -> Result<()> {
    let target = Target::new(agent, args.dir.as_deref())?;
    let session = session(agent)?;
    let client = agent.client()?;
    let request = ClaimRequest {
        issue_id: args.issue.clone(),
    };
    let response = agent
        .invocation
        .runtime
        .block_on(client.send::<_, ClaimResult>(&Endpoint::Claim, Some(&session), &request))?;
    finish(agent, &target, response, out)
}

/// Where a claim's clone will go, decided as far as possible before any request.
#[derive(Debug)]
pub struct Target {
    cwd: PathBuf,
    dir: Option<PathBuf>,
}

impl Target {
    /// Resolves `--dir` against the working directory and refuses one that could not become this
    /// agent's clone.
    ///
    /// # Errors
    ///
    /// [`LocalCode::WorkspaceConflict`] when the directory holds something else,
    /// [`LocalCode::InvalidInput`] when the Git deadline setting is invalid.
    pub fn new(agent: &Agent<'_>, dir: Option<&Path>) -> Result<Self> {
        workspace::check_git_timeout()?;
        let cwd = std::env::current_dir().map_err(Error::WorkingDirectory)?;
        let dir = dir.map(|dir| cwd.join(dir));
        if let Some(dir) = &dir {
            workspace::check_target(dir, &agent.identity)?;
        }
        Ok(Self { cwd, dir })
    }

    fn resolve(&self, agent: &Agent<'_>, claim_id: &str) -> PathBuf {
        self.dir.clone().unwrap_or_else(|| {
            workspace::default_dir(
                &self.cwd,
                agent.invocation.context.clone_binding(),
                &agent.identity,
                claim_id,
            )
        })
    }
}

/// The agent's session token.
///
/// # Errors
///
/// [`LocalCode::NoSession`] when it has none.
pub fn session(agent: &Agent<'_>) -> Result<SessionToken> {
    agent.stored_session()?.ok_or_else(|| Error::Local {
        code: LocalCode::NoSession,
        message: format!(
            "{} has no session; log in with rh join",
            agent.identity.name
        ),
        retryable: false,
        next: Some(NextCommand::Join),
    })
}

/// Opens the clone of a claimed issue and prints the claim, its task and the inbox.
///
/// # Errors
///
/// When the backend named untrusted remotes, the clone cannot be made, or output fails.
pub fn finish(
    agent: &Agent<'_>,
    target: &Target,
    response: AgentSuccess<ClaimResult>,
    out: &mut Output<'_>,
) -> Result<()> {
    let AgentSuccess { data, inbox, next } = response;
    let remotes = Remotes::check(&agent.identity, &data.claim)?;
    let dir = target.resolve(agent, &data.claim.claim_id);
    let clone = workspace::open(&dir, &agent.identity, &data.claim, &remotes)?;
    let claimed = Claimed {
        claim: data.claim,
        resumed: data.resumed,
        clone: CloneInfo {
            dir: dir.display().to_string(),
            state: clone,
        },
    };
    out.success(&claimed, inbox.as_ref(), next)
        .map_err(Error::Output)
}

/// The result of `rh work` and `rh claim`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Claimed {
    /// The claim.
    pub claim: ClaimView,
    /// `true` when the agent already held it.
    pub resumed: bool,
    /// Its clone.
    pub clone: CloneInfo,
}

/// Where a claim's clone is and whether this run made it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneInfo {
    /// The clone's directory.
    pub dir: String,
    /// Whether it was created or reused.
    pub state: CloneState,
}

impl Render for Claimed {
    fn render(&self, out: &mut dyn Write) -> io::Result<()> {
        let verb = if self.resumed { "resumed" } else { "claimed" };
        writeln!(out, "{verb} {}", inert(&self.claim.claim_id))?;
        render_claim(out, &self.claim)?;
        let state = match self.clone.state {
            CloneState::Created => "cloned into",
            CloneState::Reused => "kept the clone at",
        };
        writeln!(out, "{state} {}", inert(&self.clone.dir))
    }
}

/// Writes a claim and its durable task. The task is untrusted text.
///
/// # Errors
///
/// When writing fails.
pub fn render_claim(out: &mut dyn Write, claim: &ClaimView) -> io::Result<()> {
    let state = match claim.state {
        railhead_protocol::ClaimState::Working => "working",
        railhead_protocol::ClaimState::Ready => "ready",
        railhead_protocol::ClaimState::Merged => "merged",
        railhead_protocol::ClaimState::Expired => "expired",
    };
    writeln!(
        out,
        "issue {}, {state}, generation {}",
        inert(&claim.issue_id),
        claim.generation
    )?;
    if let Some(commit) = &claim.ready_commit {
        writeln!(out, "pinned commit {}", inert(commit))?;
    }
    writeln!(out, "task: {}", inert(&claim.task.title))?;
    for line in claim.task.body.lines() {
        writeln!(out, "  {}", inert(line))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issues_are_validated_before_anything_is_sent() {
        assert_eq!(parse_issue("iss_upload1"), Ok("iss_upload1".to_owned()));
        for bad in ["", "upload1", "clm_42abcd", "iss_", "iss_up load"] {
            assert!(parse_issue(bad).is_err(), "{bad:?} was accepted");
        }
    }

    #[test]
    fn a_task_renders_as_inert_indented_text() -> anyhow::Result<()> {
        let claim: ClaimView = serde_json::from_value(serde_json::json!({
            "claimId": "clm_42abcd", "issueId": "iss_upload1", "generation": 3,
            "base": "a".repeat(40), "state": "ready", "readyCommit": "b".repeat(40),
            "originUrl": "x", "upstreamUrl": "y",
            "task": {"title": "Fix \u{1b}[31muploads", "body": "line one\nline \u{202e}two"}
        }))?;
        let mut text = Vec::new();
        render_claim(&mut text, &claim)?;
        assert_eq!(
            String::from_utf8(text)?,
            format!(
                "issue iss_upload1, ready, generation 3\npinned commit {}\n\
                 task: Fix \u{fffd}[31muploads\n  line one\n  line \u{fffd}two\n",
                "b".repeat(40)
            )
        );
        Ok(())
    }
}
