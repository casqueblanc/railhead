//! What `rh` prints: a result, a failure or a notice, as text or as a JSON envelope.
//!
//! Text mode prints results on stdout and failures and notices on stderr. JSON mode prints exactly
//! one envelope on stdout, `{"ok":true,"data","inbox","next"}` or `{"ok":false,"error"}`, so an
//! agent can parse every outcome. Credential mode is Git's: stdout carries the credential protocol
//! and nothing else, and everything a person might read goes to stderr.
//!
//! Text from the backend, a repository or another agent is untrusted. Text mode passes it through
//! [`inert`], which neutralises control and bidirectional characters so it cannot drive the
//! terminal or disguise itself.

use std::borrow::Cow;
use std::fmt;
use std::io::{self, Write};

use railhead_protocol::{AgentErrorCode, InboxDigest, NextCommand};
use serde::Serialize;

/// Where output goes and in what form.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Readable text.
    Text,
    /// One JSON envelope per command on stdout.
    Json,
    /// The Git credential protocol on stdout; everything else on stderr.
    Credential,
}

/// A command result that can print itself as text.
pub trait Render {
    /// Writes the result for a person to read. Untrusted fields go through [`inert`].
    ///
    /// # Errors
    ///
    /// When writing fails.
    fn render(&self, out: &mut dyn Write) -> io::Result<()>;
}

/// An error code: one the backend returned, or one `rh` raised itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Code {
    /// Returned by the backend.
    Agent(AgentErrorCode),
    /// Raised by `rh` before or instead of a response.
    Local(LocalCode),
}

/// The failures `rh` raises itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalCode {
    /// An argument, setting or request is invalid.
    InvalidInput,
    /// No agent was selected.
    NoIdentity,
    /// The selected agent is not the one the clone is bound to.
    IdentityMismatch,
    /// The clone's Railhead settings are damaged.
    InvalidClone,
    /// The local identity store failed.
    Store,
    /// The backend did not answer in time.
    Timeout,
    /// The backend could not be reached.
    Unreachable,
    /// The backend's answer was not a valid response.
    MalformedResponse,
    /// The command exists but is not built yet.
    CommandUnavailable,
    /// Output could not be written.
    Output,
    /// The agent has no session token.
    NoSession,
    /// The command must run inside a claim's clone.
    NoClone,
    /// A Git step failed.
    Git,
    /// The clone's remote is not the Railhead repository it should be.
    UntrustedRemote,
    /// The working tree holds changes the command would overwrite.
    WorkspaceConflict,
}

/// A failure as `rh` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    /// What went wrong.
    pub code: Code,
    /// One sentence; any untrusted part is already [`inert`].
    pub message: String,
    /// Whether repeating the command may succeed.
    pub retryable: bool,
    /// The command to run next.
    pub next: Option<NextCommand>,
}

/// A value Git's credential protocol cannot carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CredentialError {
    /// Credentials are printed only in credential mode.
    #[error("credentials are printed only for Git")]
    WrongMode,
    /// A key or value contains a newline, a NUL, or a key contains `=`.
    #[error("credential field `{0}` cannot be written in the Git credential protocol")]
    Unrepresentable(&'static str),
    /// Writing failed.
    #[error("writing credentials: {0}")]
    Io(io::ErrorKind),
}

/// The process's output streams in one mode.
pub struct Output<'a> {
    mode: Mode,
    stdout: &'a mut dyn Write,
    stderr: &'a mut dyn Write,
}

impl fmt::Debug for Output<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Output")
            .field("mode", &self.mode)
            .finish_non_exhaustive()
    }
}

#[derive(Serialize)]
struct SuccessEnvelope<'a, T> {
    ok: bool,
    data: &'a T,
    inbox: Option<&'a InboxDigest>,
    next: Option<&'static str>,
}

#[derive(Serialize)]
struct FailureEnvelope<'a> {
    ok: bool,
    error: FailureBody<'a>,
}

#[derive(Serialize)]
struct FailureBody<'a> {
    code: Code,
    message: &'a str,
    retryable: bool,
    next: Option<&'static str>,
}

impl<'a> Output<'a> {
    /// Output in `mode` to the given streams.
    pub fn new(mode: Mode, stdout: &'a mut dyn Write, stderr: &'a mut dyn Write) -> Self {
        Self {
            mode,
            stdout,
            stderr,
        }
    }

    /// Prints a command's result with the pending inbox and the next command.
    ///
    /// # Errors
    ///
    /// When writing fails.
    pub fn success<T: Serialize + Render>(
        &mut self,
        data: &T,
        inbox: Option<&InboxDigest>,
        next: Option<NextCommand>,
    ) -> io::Result<()> {
        match self.mode {
            Mode::Json => {
                let envelope = SuccessEnvelope {
                    ok: true,
                    data,
                    inbox,
                    next: next.map(command_line),
                };
                write_json(self.stdout, &envelope)
            }
            Mode::Text => write_text(self.stdout, data, inbox, next),
            Mode::Credential => write_text(self.stderr, data, inbox, next),
        }
    }

    /// Prints a failure: on stdout as an envelope in JSON mode, on stderr otherwise.
    ///
    /// # Errors
    ///
    /// When writing fails.
    pub fn failure(&mut self, failure: &Failure) -> io::Result<()> {
        match self.mode {
            Mode::Json => write_json(
                self.stdout,
                &FailureEnvelope {
                    ok: false,
                    error: FailureBody {
                        code: failure.code,
                        message: &failure.message,
                        retryable: failure.retryable,
                        next: failure.next.map(command_line),
                    },
                },
            ),
            Mode::Text | Mode::Credential => {
                writeln!(self.stderr, "rh: {}", inert(&failure.message))?;
                if let Some(next) = failure.next {
                    writeln!(self.stderr, "next: {}", command_line(next))?;
                }
                self.stderr.flush()
            }
        }
    }

    /// Prints a notice for a person on stderr, in every mode. `text` is `rh`'s own words.
    ///
    /// # Errors
    ///
    /// When writing fails.
    #[allow(
        dead_code,
        reason = "the rh join and rh credential entry points (#47) print notices"
    )]
    pub fn notice(&mut self, text: &str) -> io::Result<()> {
        writeln!(self.stderr, "rh: {}", inert(text))?;
        self.stderr.flush()
    }

    /// Answers Git with `key=value` lines on stdout, in credential mode only.
    ///
    /// # Errors
    ///
    /// [`CredentialError::WrongMode`] outside credential mode; an unrepresentable field is refused
    /// before anything is written.
    #[allow(
        dead_code,
        reason = "the rh credential entry point (#47) answers Git with it"
    )]
    pub fn credential(&mut self, fields: &[(&'static str, &str)]) -> Result<(), CredentialError> {
        if self.mode != Mode::Credential {
            return Err(CredentialError::WrongMode);
        }
        for &(key, value) in fields {
            let breaks = |c: char| c == '\n' || c == '\0';
            if key.is_empty() || key.contains('=') || key.contains(breaks) || value.contains(breaks)
            {
                return Err(CredentialError::Unrepresentable(key));
            }
        }
        let mut reply = String::new();
        for &(key, value) in fields {
            reply.push_str(key);
            reply.push('=');
            reply.push_str(value);
            reply.push('\n');
        }
        self.stdout
            .write_all(reply.as_bytes())
            .and_then(|()| self.stdout.flush())
            .map_err(|error| CredentialError::Io(error.kind()))
    }
}

fn write_json(out: &mut dyn Write, value: &impl Serialize) -> io::Result<()> {
    serde_json::to_writer(&mut *out, value).map_err(io::Error::other)?;
    out.write_all(b"\n")?;
    out.flush()
}

fn write_text(
    out: &mut dyn Write,
    data: &dyn Render,
    inbox: Option<&InboxDigest>,
    next: Option<NextCommand>,
) -> io::Result<()> {
    data.render(out)?;
    if let Some(inbox) = inbox.filter(|inbox| inbox.pending.get() > 0) {
        writeln!(
            out,
            "inbox: {} unacknowledged; read them with {}",
            inbox.pending.get(),
            command_line(NextCommand::Sync)
        )?;
    }
    if let Some(next) = next {
        writeln!(out, "next: {}", command_line(next))?;
    }
    out.flush()
}

/// The full command line of a next-command hint, such as `rh sync`.
#[must_use]
pub const fn command_line(next: NextCommand) -> &'static str {
    match next {
        NextCommand::Join => "rh join",
        NextCommand::Work => "rh work",
        NextCommand::Claim => "rh claim",
        NextCommand::Sync => "rh sync",
        NextCommand::Ack => "rh ack",
        NextCommand::Ask => "rh ask",
        NextCommand::Ready => "rh ready",
        NextCommand::Status => "rh status",
    }
}

/// Untrusted text made safe for a terminal: control characters other than newline and tab, and
/// the characters that reorder text, become U+FFFD.
#[must_use]
pub fn inert(text: &str) -> Cow<'_, str> {
    let unsafe_char = |c: char| {
        (c.is_control() && c != '\n' && c != '\t')
            || matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
    };
    if text.contains(unsafe_char) {
        Cow::Owned(
            text.chars()
                .map(|c| if unsafe_char(c) { '\u{fffd}' } else { c })
                .collect(),
        )
    } else {
        Cow::Borrowed(text)
    }
}

#[cfg(test)]
mod tests {
    use railhead_protocol::SafeInteger;
    use serde_json::{Value, json};

    use super::*;

    #[derive(Serialize)]
    struct Greeting {
        text: String,
    }

    impl Render for Greeting {
        fn render(&self, out: &mut dyn Write) -> io::Result<()> {
            writeln!(out, "said: {}", inert(&self.text))
        }
    }

    struct Captured {
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    }

    fn capture(mode: Mode, act: impl FnOnce(&mut Output<'_>)) -> Captured {
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        act(&mut Output::new(mode, &mut stdout, &mut stderr));
        Captured { stdout, stderr }
    }

    fn text(bytes: &[u8]) -> String {
        String::from_utf8_lossy(bytes).into_owned()
    }

    fn digest(pending: u64) -> InboxDigest {
        InboxDigest {
            items: Vec::new(),
            pending: SafeInteger::new(pending).unwrap_or(SafeInteger::ZERO),
        }
    }

    fn failure() -> Failure {
        Failure {
            code: Code::Agent(AgentErrorCode::UnackedDecision),
            message: "Acknowledge item 17 first.".to_owned(),
            retryable: false,
            next: Some(NextCommand::Sync),
        }
    }

    #[test]
    fn text_results_name_the_inbox_and_next_command() {
        let greeting = Greeting {
            text: "hi".to_owned(),
        };
        let out = capture(Mode::Text, |out| {
            assert!(
                out.success(&greeting, Some(&digest(2)), Some(NextCommand::Ready))
                    .is_ok()
            );
        });
        assert_eq!(
            text(&out.stdout),
            "said: hi\ninbox: 2 unacknowledged; read them with rh sync\nnext: rh ready\n"
        );
        assert_eq!(text(&out.stderr), "");
        let quiet = capture(Mode::Text, |out| {
            assert!(out.success(&greeting, Some(&digest(0)), None).is_ok());
        });
        assert_eq!(text(&quiet.stdout), "said: hi\n");
    }

    #[test]
    fn json_prints_one_envelope_for_success_and_failure() -> anyhow::Result<()> {
        let greeting = Greeting {
            text: "hi".to_owned(),
        };
        let out = capture(Mode::Json, |out| {
            assert!(
                out.success(&greeting, Some(&digest(1)), Some(NextCommand::Sync))
                    .is_ok()
            );
        });
        let envelope: Value = serde_json::from_slice(&out.stdout)?;
        assert_eq!(
            envelope,
            json!({"ok": true, "data": {"text": "hi"}, "inbox": {"items": [], "pending": 1}, "next": "rh sync"})
        );
        let out = capture(Mode::Json, |out| assert!(out.failure(&failure()).is_ok()));
        let envelope: Value = serde_json::from_slice(&out.stdout)?;
        assert_eq!(
            envelope,
            json!({"ok": false, "error": {"code": "unacked_decision",
                "message": "Acknowledge item 17 first.", "retryable": false, "next": "rh sync"}})
        );
        assert_eq!(text(&out.stderr), "");
        let local = Failure {
            code: Code::Local(LocalCode::IdentityMismatch),
            next: None,
            ..failure()
        };
        let out = capture(Mode::Json, |out| assert!(out.failure(&local).is_ok()));
        let envelope: Value = serde_json::from_slice(&out.stdout)?;
        assert_eq!(
            envelope.pointer("/error/code"),
            Some(&json!("identity_mismatch"))
        );
        assert_eq!(envelope.pointer("/error/next"), Some(&Value::Null));
        Ok(())
    }

    #[test]
    fn text_failures_go_to_stderr_with_the_next_command() {
        let out = capture(Mode::Text, |out| assert!(out.failure(&failure()).is_ok()));
        assert_eq!(text(&out.stdout), "");
        assert_eq!(
            text(&out.stderr),
            "rh: Acknowledge item 17 first.\nnext: rh sync\n"
        );
    }

    #[test]
    fn credential_mode_keeps_stdout_for_git() {
        let greeting = Greeting {
            text: "hi".to_owned(),
        };
        let out = capture(Mode::Credential, |out| {
            assert!(out.notice("fetching a session").is_ok());
            assert!(
                out.success(&greeting, Some(&digest(3)), Some(NextCommand::Sync))
                    .is_ok()
            );
            assert!(out.failure(&failure()).is_ok());
            assert!(
                out.credential(&[("username", "agt_atlas01"), ("password", "a.b.c")])
                    .is_ok()
            );
        });
        assert_eq!(text(&out.stdout), "username=agt_atlas01\npassword=a.b.c\n");
        let stderr = text(&out.stderr);
        assert!(stderr.contains("fetching a session") && stderr.contains("said: hi"));
        assert!(stderr.contains("Acknowledge item 17"));
    }

    #[test]
    fn credentials_are_refused_outside_git_or_when_unrepresentable() {
        let out = capture(Mode::Text, |out| {
            assert_eq!(
                out.credential(&[("password", "x")]),
                Err(CredentialError::WrongMode)
            );
        });
        assert_eq!(text(&out.stdout), "");
        let out = capture(Mode::Credential, |out| {
            for fields in [
                [("username", "agt_a"), ("password", "a\nhost=evil.example")],
                [("username", "agt_a"), ("password", "a\0b")],
                [("user=name", "agt_a"), ("password", "x")],
                [("", "agt_a"), ("password", "x")],
            ] {
                assert!(matches!(
                    out.credential(&fields),
                    Err(CredentialError::Unrepresentable(_))
                ));
            }
        });
        assert!(
            out.stdout.is_empty(),
            "a refused reply wrote {:?}",
            text(&out.stdout)
        );
    }

    #[test]
    fn untrusted_text_cannot_drive_the_terminal() {
        assert_eq!(
            inert("plain text\nline two\ttab"),
            "plain text\nline two\ttab"
        );
        assert!(matches!(inert("plain"), Cow::Borrowed(_)));
        assert_eq!(inert("\u{1b}[31mred\u{7}"), "\u{fffd}[31mred\u{fffd}");
        assert_eq!(
            inert("a\u{202e}b\u{2066}c\rd"),
            "a\u{fffd}b\u{fffd}c\u{fffd}d"
        );
        assert_eq!(inert(""), "");
        let out = capture(Mode::Text, |out| {
            let hostile = Failure {
                message: "\u{1b}]52;c;bad\u{7}".to_owned(),
                ..failure()
            };
            assert!(out.failure(&hostile).is_ok());
        });
        assert!(!text(&out.stderr).contains('\u{1b}'));
    }

    struct Closed;

    impl Write for Closed {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::ErrorKind::BrokenPipe.into())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_closed_stream_is_reported() {
        let (mut stdout, mut stderr) = (Closed, Closed);
        let mut out = Output::new(Mode::Json, &mut stdout, &mut stderr);
        let greeting = Greeting {
            text: "hi".to_owned(),
        };
        assert!(out.success(&greeting, None, None).is_err());
        let mut out = Output::new(Mode::Credential, &mut stdout, &mut stderr);
        assert_eq!(
            out.credential(&[("username", "a")]),
            Err(CredentialError::Io(io::ErrorKind::BrokenPipe))
        );
    }
}
