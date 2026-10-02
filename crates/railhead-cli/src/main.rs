//! `rh`, the Railhead command line for coding agents.
//!
//! The dispatcher is fixed: every command has one entry point in `commands/<name>/mod.rs`, and
//! every command that acts as an agent resolves that agent here, before its entry point runs. A
//! command run inside a claim's clone therefore always acts as the clone's identity; naming another
//! agent stops the command before any request is sent.

mod context;
mod http;
mod identity;
mod output;

mod commands {
    pub mod ack;
    pub mod ask;
    pub mod claim;
    pub mod credential;
    pub mod join;
    pub mod ready;
    pub mod status;
    pub mod sync;
    pub mod work;
}

use std::fmt;
use std::io::{self, Write};
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use serde::Serialize;

use crate::context::{AGENT_ENV, Context, HOME_ENV};
use crate::identity::{AgentSelector, Identity, SecretKind, SecretStore as _, SessionToken};
use crate::output::{Code, Failure, LocalCode, Mode, Output, Render};

/// Join a Railhead repository, claim work and answer its decisions.
#[derive(Debug, Parser)]
#[command(name = "rh", version, about)]
struct Cli {
    /// Print one JSON envelope on stdout instead of text.
    #[arg(long, global = true)]
    json: bool,

    /// Act as this agent, by name or id. Overrides `RAILHEAD_AGENT`; inside a claim's clone it must
    /// name the clone's own agent.
    #[arg(long, global = true, value_name = "AGENT")]
    agent: Option<AgentSelector>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Print the version of `rh` and the event schema it reads.
    Version,
    /// Register this machine's agent key with an invite.
    Join(commands::join::Args),
    /// Answer Git's credential requests in a claim's clone. Git runs this, not people.
    #[command(hide = true)]
    Credential(commands::credential::Args),
    /// Claim the next ready issue.
    Work(commands::work::Args),
    /// Claim a named issue.
    Claim(commands::claim::Args),
    /// Pin the clone's HEAD commit for the merge train.
    Ready(commands::ready::Args),
    /// Show the agent, its claim and its inbox.
    Status(commands::status::Args),
    /// Read unacknowledged inbox items.
    Sync(commands::sync::Args),
    /// Acknowledge one inbox item with a plan.
    Ack(commands::ack::Args),
    /// Ask the owner a question.
    Ask(commands::ask::Args),
}

impl Cli {
    fn mode(&self) -> Mode {
        match (&self.command, self.json) {
            (Command::Credential(_), _) => Mode::Credential,
            (_, true) => Mode::Json,
            (_, false) => Mode::Text,
        }
    }
}

/// A command, by the name `rh` gives it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandName {
    /// `rh join`.
    Join,
    /// `rh credential`.
    Credential,
    /// `rh work`.
    Work,
    /// `rh claim`.
    Claim,
    /// `rh ready`.
    Ready,
    /// `rh status`.
    Status,
    /// `rh sync`.
    Sync,
    /// `rh ack`.
    Ack,
    /// `rh ask`.
    Ask,
}

impl fmt::Display for CommandName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Join => "join",
            Self::Credential => "credential",
            Self::Work => "work",
            Self::Claim => "claim",
            Self::Ready => "ready",
            Self::Status => "status",
            Self::Sync => "sync",
            Self::Ack => "ack",
            Self::Ask => "ask",
        })
    }
}

/// Every way a command fails. No variant carries a token, a key or response text other than the
/// backend's own error message, which is rendered inert.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The context could not be resolved.
    #[error(transparent)]
    Context(#[from] context::Error),
    /// The identity store failed.
    #[error(transparent)]
    Identity(#[from] identity::Error),
    /// A request failed.
    #[error(transparent)]
    Http(#[from] http::Error),
    /// A credential could not be printed for Git.
    #[error(transparent)]
    Credential(#[from] output::CredentialError),
    /// The command is part of `rh` but not built yet.
    #[error("rh {0} is not available in this build yet")]
    Unavailable(CommandName),
    /// The working directory could not be read.
    #[error("reading the working directory: {0}")]
    WorkingDirectory(#[source] io::Error),
    /// The async runtime could not start.
    #[error("starting the runtime: {0}")]
    Runtime(#[source] io::Error),
    /// Output could not be written.
    #[error("writing output: {0}")]
    Output(#[source] io::Error),
    /// A command failed on this machine, before or after its requests: no session, no clone, a Git
    /// step, an untrusted remote or a conflicting workspace. `message` is `rh`'s own words.
    #[error("{message}")]
    Local {
        /// What went wrong.
        code: LocalCode,
        /// One sentence for the agent; any untrusted part must already be inert.
        message: String,
        /// Whether repeating the command may succeed.
        retryable: bool,
        /// The command to run next.
        next: Option<railhead_protocol::NextCommand>,
    },
}

/// Result of a command.
pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// The failure as `rh` prints it.
    fn failure(&self) -> Failure {
        let local = |code, retryable, next| Failure {
            code: Code::Local(code),
            message: self.to_string(),
            retryable,
            next,
        };
        match self {
            Self::Context(error) => match error {
                context::Error::InvalidOrigin(_) | context::Error::InvalidRepo(_) => {
                    local(LocalCode::InvalidInput, false, None)
                }
                context::Error::InvalidClone | context::Error::Git(_) => {
                    local(LocalCode::InvalidClone, false, None)
                }
                context::Error::IdentityMismatch { .. } | context::Error::RepositoryMismatch(_) => {
                    local(LocalCode::IdentityMismatch, false, None)
                }
                context::Error::NoIdentity => local(
                    LocalCode::NoIdentity,
                    false,
                    Some(railhead_protocol::NextCommand::Join),
                ),
                context::Error::NoHome => local(LocalCode::Store, false, None),
                context::Error::Identity(error) => identity_failure(error, self),
            },
            Self::Identity(error) => identity_failure(error, self),
            Self::Http(error) => match error {
                http::Error::InvalidRequest { .. }
                | http::Error::InvalidTarget { .. }
                | http::Error::RequestTooLarge(_) => local(LocalCode::InvalidInput, false, None),
                http::Error::Timeout(_) => local(LocalCode::Timeout, true, None),
                http::Error::Unreachable(_) | http::Error::Transport(_) => {
                    local(LocalCode::Unreachable, true, None)
                }
                http::Error::ResponseTooLarge(_) | http::Error::Malformed { .. } => {
                    local(LocalCode::MalformedResponse, false, None)
                }
                http::Error::Rejected { route, error, .. } => Failure {
                    code: Code::Agent(error.code),
                    message: format!("{route}: {}", error.message),
                    retryable: error.retryable,
                    next: error.next,
                },
            },
            Self::Credential(_) | Self::Output(_) => local(LocalCode::Output, false, None),
            Self::Unavailable(_) => local(LocalCode::CommandUnavailable, false, None),
            Self::WorkingDirectory(_) | Self::Runtime(_) => {
                local(LocalCode::InvalidInput, false, None)
            }
            Self::Local {
                code,
                retryable,
                next,
                ..
            } => local(*code, *retryable, *next),
        }
    }
}

fn identity_failure(error: &identity::Error, whole: &Error) -> Failure {
    let (code, next) = match error {
        identity::Error::InvalidSelector(_) => (LocalCode::InvalidInput, None),
        identity::Error::NotFound(_) => (
            LocalCode::NoIdentity,
            Some(railhead_protocol::NextCommand::Join),
        ),
        identity::Error::Damaged(_)
        | identity::Error::InsecurePermissions(_)
        | identity::Error::AlreadyExists(_)
        | identity::Error::TooMany
        | identity::Error::Io { .. } => (LocalCode::Store, None),
    };
    Failure {
        code: Code::Local(code),
        message: whole.to_string(),
        retryable: false,
        next,
    }
}

/// What every command receives: where it runs and a runtime to wait on requests with.
#[derive(Debug)]
pub struct Invocation<'a> {
    /// The resolved context.
    pub context: &'a Context,
    /// A single-threaded runtime for the command's requests.
    pub runtime: &'a tokio::runtime::Runtime,
}

/// What a command that acts as an agent receives: the invocation and the agent, already checked
/// against the clone the command runs in.
#[derive(Debug)]
pub struct Agent<'a> {
    /// Where the command runs.
    pub invocation: &'a Invocation<'a>,
    /// The agent it acts as.
    pub identity: Identity,
}

impl Agent<'_> {
    /// A client for the agent's repository.
    ///
    /// # Errors
    ///
    /// When the HTTP client cannot be built.
    pub fn client(&self) -> Result<http::Client> {
        Ok(http::Client::new(
            &self.identity.origin,
            &self.identity.repo,
        )?)
    }

    /// The agent's stored session token, or `None` when it has none or it is not a token.
    ///
    /// # Errors
    ///
    /// When the store cannot be read safely.
    pub fn stored_session(&self) -> Result<Option<SessionToken>> {
        let secret = self
            .invocation
            .context
            .store()
            .read(&self.identity.name, SecretKind::SessionToken)?;
        Ok(secret.and_then(|secret| SessionToken::new(secret.expose().to_owned())))
    }
}

/// The `version` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionInfo {
    version: &'static str,
    event_schema: u64,
}

impl Render for VersionInfo {
    fn render(&self, out: &mut dyn Write) -> io::Result<()> {
        writeln!(
            out,
            "rh {} (event schema {})",
            self.version, self.event_schema
        )
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let (mut stdout, mut stderr) = (io::stdout().lock(), io::stderr().lock());
    let mut out = Output::new(cli.mode(), &mut stdout, &mut stderr);
    match run(&cli, &mut out) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            // Nothing is left to report a failure to if printing the failure fails.
            let _ = out.failure(&error.failure());
            ExitCode::FAILURE
        }
    }
}

fn run(cli: &Cli, out: &mut Output<'_>) -> Result<()> {
    match &cli.command {
        Command::Version => out
            .success(
                &VersionInfo {
                    version: env!("CARGO_PKG_VERSION"),
                    event_schema: railhead_protocol::EVENT_SCHEMA_VERSION,
                },
                None,
                None,
            )
            .map_err(Error::Output),
        Command::Join(args) => invoke(cli, |cx| commands::join::run(cx, args, out)),
        Command::Credential(args) => {
            as_agent(cli, |agent| commands::credential::run(agent, args, out))
        }
        Command::Work(args) => as_agent(cli, |agent| commands::work::run(agent, args, out)),
        Command::Claim(args) => as_agent(cli, |agent| commands::claim::run(agent, args, out)),
        Command::Ready(args) => as_agent(cli, |agent| commands::ready::run(agent, args, out)),
        Command::Status(args) => as_agent(cli, |agent| commands::status::run(agent, args, out)),
        Command::Sync(args) => as_agent(cli, |agent| commands::sync::run(agent, args, out)),
        Command::Ack(args) => as_agent(cli, |agent| commands::ack::run(agent, args, out)),
        Command::Ask(args) => as_agent(cli, |agent| commands::ask::run(agent, args, out)),
    }
}

fn invoke(cli: &Cli, command: impl FnOnce(&Invocation<'_>) -> Result<()>) -> Result<()> {
    let cwd = std::env::current_dir().map_err(Error::WorkingDirectory)?;
    let context = Context::load(
        &cwd,
        cli.agent.clone(),
        std::env::var_os(AGENT_ENV),
        std::env::var_os(HOME_ENV),
    )?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(Error::Runtime)?;
    command(&Invocation {
        context: &context,
        runtime: &runtime,
    })
}

fn as_agent(cli: &Cli, command: impl FnOnce(&Agent<'_>) -> Result<()>) -> Result<()> {
    invoke(cli, |invocation| {
        let identity = invocation.context.identity()?;
        command(&Agent {
            invocation,
            identity,
        })
    })
}

#[cfg(test)]
mod tests {
    use std::io::{self, Write};

    use clap::error::ErrorKind;
    use railhead_protocol::{AgentError, AgentErrorCode, AgentRoute, NextCommand};

    use super::*;

    fn run_args(args: &[&str]) -> anyhow::Result<(String, String)> {
        let cli = Cli::try_parse_from(args)?;
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        let mut out = Output::new(cli.mode(), &mut stdout, &mut stderr);
        run(&cli, &mut out)?;
        Ok((String::from_utf8(stdout)?, String::from_utf8(stderr)?))
    }

    #[test]
    fn version_prints_the_crate_and_schema_versions() -> anyhow::Result<()> {
        assert_eq!(
            run_args(&["rh", "version"])?,
            ("rh 0.1.0 (event schema 1)\n".to_owned(), String::new())
        );
        let (json, _) = run_args(&["rh", "version", "--json"])?;
        let envelope: serde_json::Value = serde_json::from_str(&json)?;
        assert_eq!(
            envelope,
            serde_json::json!({"ok": true, "data": {"version": "0.1.0", "eventSchema": 1},
                "inbox": null, "next": null})
        );
        Ok(())
    }

    #[test]
    fn version_flag_is_handled_by_the_parser() {
        let error = Cli::try_parse_from(["rh", "--version"]).err();
        assert_eq!(error.map(|e| e.kind()), Some(ErrorKind::DisplayVersion));
    }

    #[test]
    fn a_missing_or_unknown_command_or_agent_is_refused() {
        let kind = |args: &[&str]| Cli::try_parse_from(args).err().map(|e| e.kind());
        assert_eq!(
            kind(&["rh"]),
            Some(ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand)
        );
        assert_eq!(kind(&["rh", "deploy"]), Some(ErrorKind::InvalidSubcommand));
        assert_eq!(
            kind(&["rh", "version", "--yaml"]),
            Some(ErrorKind::UnknownArgument)
        );
        assert_eq!(
            kind(&["rh", "status", "--agent", "Not Valid"]),
            Some(ErrorKind::ValueValidation)
        );
        assert_eq!(
            kind(&["rh", "credential"]),
            Some(ErrorKind::MissingRequiredArgument)
        );
    }

    #[test]
    fn credential_mode_wins_over_json() -> anyhow::Result<()> {
        let cli = Cli::try_parse_from(["rh", "credential", "get", "--json"])?;
        assert_eq!(cli.mode(), Mode::Credential);
        let cli = Cli::try_parse_from(["rh", "--json", "status"])?;
        assert_eq!(cli.mode(), Mode::Json);
        Ok(())
    }

    #[test]
    fn failures_carry_codes_retry_advice_and_next_commands() -> anyhow::Result<()> {
        let mismatch = Error::Context(context::Error::IdentityMismatch {
            bound: identity::AgentId::new("agt_atlas01")?,
            requested: "boreas".to_owned(),
        });
        let failure = mismatch.failure();
        assert_eq!(
            (failure.code, failure.next),
            (Code::Local(LocalCode::IdentityMismatch), None)
        );
        assert!(failure.message.contains("agt_atlas01") && failure.message.contains("boreas"));

        let none = Error::Context(context::Error::NoIdentity).failure();
        assert_eq!(
            (none.code, none.next),
            (Code::Local(LocalCode::NoIdentity), Some(NextCommand::Join))
        );

        let timeout = Error::Http(http::Error::Timeout(AgentRoute::Ready)).failure();
        assert_eq!(
            (timeout.code, timeout.retryable),
            (Code::Local(LocalCode::Timeout), true)
        );

        let rejected = Error::Http(http::Error::Rejected {
            route: AgentRoute::Ready,
            status: 409,
            error: AgentError {
                code: AgentErrorCode::UnackedDecision,
                message: "Acknowledge item 17 first.".to_owned(),
                retryable: false,
                retry_after_ms: None,
                next: Some(NextCommand::Sync),
            },
        })
        .failure();
        assert_eq!(rejected.code, Code::Agent(AgentErrorCode::UnackedDecision));
        assert_eq!(rejected.message, "ready: Acknowledge item 17 first.");
        assert_eq!(rejected.next, Some(NextCommand::Sync));

        let unavailable = Error::Unavailable(CommandName::Work).failure();
        assert_eq!(unavailable.code, Code::Local(LocalCode::CommandUnavailable));
        assert_eq!(
            unavailable.message,
            "rh work is not available in this build yet"
        );
        Ok(())
    }

    fn print(mode: Mode, error: &Error) -> anyhow::Result<(String, String)> {
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        Output::new(mode, &mut stdout, &mut stderr).failure(&error.failure())?;
        Ok((String::from_utf8(stdout)?, String::from_utf8(stderr)?))
    }

    #[test]
    fn local_failures_render_their_code_retry_advice_and_next_command() -> anyhow::Result<()> {
        let cases = [
            (
                LocalCode::NoSession,
                "no_session",
                false,
                Some(NextCommand::Join),
            ),
            (
                LocalCode::NoClone,
                "no_clone",
                false,
                Some(NextCommand::Claim),
            ),
            (LocalCode::Git, "git", true, None),
            (LocalCode::UntrustedRemote, "untrusted_remote", false, None),
            (
                LocalCode::WorkspaceConflict,
                "workspace_conflict",
                false,
                Some(NextCommand::Status),
            ),
        ];
        for (code, wire, retryable, next) in cases {
            let error = Error::Local {
                code,
                message: format!("{wire} happened."),
                retryable,
                next,
            };
            let failure = error.failure();
            assert_eq!(
                (failure.code, failure.retryable, failure.next),
                (Code::Local(code), retryable, next)
            );

            let (stdout, stderr) = print(Mode::Json, &error)?;
            let envelope: serde_json::Value = serde_json::from_str(&stdout)?;
            assert_eq!(
                envelope,
                serde_json::json!({"ok": false, "error": {"code": wire,
                    "message": format!("{wire} happened."), "retryable": retryable,
                    "next": next.map(output::command_line)}})
            );
            assert_eq!(stderr, "");

            let hint = next.map_or(String::new(), |next| {
                format!("next: {}\n", output::command_line(next))
            });
            let (stdout, stderr) = print(Mode::Text, &error)?;
            assert_eq!(stdout, "");
            assert_eq!(stderr, format!("rh: {wire} happened.\n{hint}"));

            let (stdout, stderr) = print(Mode::Credential, &error)?;
            assert_eq!(stdout, "", "credential mode wrote a {wire} failure to Git");
            assert_eq!(stderr, format!("rh: {wire} happened.\n{hint}"));
        }
        Ok(())
    }

    #[test]
    fn a_local_message_is_rendered_inert_in_text_and_kept_whole_in_json() -> anyhow::Result<()> {
        let error = Error::Local {
            code: LocalCode::Git,
            message: "git fetch failed: \u{1b}[2J".to_owned(),
            retryable: false,
            next: None,
        };
        let (_, stderr) = print(Mode::Text, &error)?;
        assert_eq!(stderr, "rh: git fetch failed: \u{fffd}[2J\n");
        let (stdout, _) = print(Mode::Json, &error)?;
        let envelope: serde_json::Value = serde_json::from_str(&stdout)?;
        assert_eq!(
            envelope.pointer("/error/message"),
            Some(&serde_json::json!("git fetch failed: \u{1b}[2J"))
        );
        Ok(())
    }

    /// A writer that always fails, as stdout does when its pipe is closed.
    struct ClosedPipe;

    impl Write for ClosedPipe {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::ErrorKind::BrokenPipe.into())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_failed_write_is_reported_not_ignored() -> anyhow::Result<()> {
        let cli = Cli::try_parse_from(["rh", "version"])?;
        let (mut stdout, mut stderr) = (ClosedPipe, Vec::new());
        let mut out = Output::new(cli.mode(), &mut stdout, &mut stderr);
        let error = run(&cli, &mut out).err();
        assert_eq!(
            error.map(|e| e.to_string()),
            Some("writing output: broken pipe".to_owned())
        );
        Ok(())
    }
}
