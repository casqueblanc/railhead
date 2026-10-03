//! A claim's clone on disk.
//!
//! A new clone is built in a staging directory that this run creates beside its target and alone
//! owns, and is renamed into place only once its fork is fetched and checked out, so a failed
//! fetch leaves nothing behind and the next `rh work` or `rh claim` starts clean. A staging
//! directory is renamed to a discard name before it is removed, by this run or, when a signal ends
//! `rh` first, by the signal watcher; the next run removes what is left under that name. The rename never
//! replaces another run's clone: when a run of the same claim published first, this run's clone is
//! discarded and that one reused. An existing clone of the same claim and agent is reused:
//! its Railhead settings are refreshed and its working tree, index and refs are never touched.
//!
//! Every Git process has an overall deadline, [`DEFAULT_GIT_TIMEOUT`] unless
//! [`GIT_TIMEOUT_ENV`] names another; one still running then is stopped with everything it started,
//! and the command fails as retryable with the clone as it was before, or no new clone at all.
//!
//! Every remote is checked against the agent's own origin and repository before Git sees it, so
//! a backend answer cannot point a clone, or the credential helper, at another host.

use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use railhead_protocol::{ClaimView, IdKind, NextCommand, SafeInteger, is_commit_sha, is_id};

use crate::context::{CloneBinding, GIT_IDENTITY_CONFIG_KEY};
use crate::identity::Identity;
use crate::output::LocalCode;
use crate::subprocess::{self, RunError};
use crate::{Error, Result};

/// The Git setting that records the ownership generation the clone's agent last saw.
pub const GIT_GENERATION_CONFIG_KEY: &str = "railhead.generation";

/// The environment variable that sets how many seconds one Git process may run.
pub const GIT_TIMEOUT_ENV: &str = "RAILHEAD_GIT_TIMEOUT";

/// How long one Git process may run when [`GIT_TIMEOUT_ENV`] is unset.
pub const DEFAULT_GIT_TIMEOUT: Duration = Duration::from_secs(600);

/// The longest deadline [`GIT_TIMEOUT_ENV`] may set.
const MAX_GIT_TIMEOUT_SECS: u64 = 3600;

/// The branch a claim's fork carries; forks are made from the default branch only.
const BRANCH: &str = "main";

/// The push URL of `upstream`. Git cannot push to it, and its name says why.
const UPSTREAM_PUSH_URL: &str = "upstream-is-read-only";

/// Environment variables that would point Git at another repository than the one named.
const GIT_LOCATION_ENV: [&str; 5] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_COMMON_DIR",
];

/// What happened to the clone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CloneState {
    /// The fork was fetched into a new clone.
    Created,
    /// An existing clone of this claim was kept as it was.
    Reused,
}

/// A claim's fork and the main repository, as this agent's Railhead origin names them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Remotes {
    /// The claim's fork: fetch and push.
    pub origin: String,
    /// The main repository: fetch only.
    pub upstream: String,
}

impl Remotes {
    /// The remotes `claim` must have for `identity`.
    ///
    /// # Errors
    ///
    /// [`LocalCode::UntrustedRemote`] when the backend named any other address, or a claim or
    /// base that is not an identifier. Nothing is written.
    pub fn check(identity: &Identity, claim: &ClaimView) -> Result<Self> {
        let untrusted = |what: &str| {
            local(
                LocalCode::UntrustedRemote,
                format!(
                    "the backend named {what} outside {} {}; nothing was cloned",
                    identity.origin.as_str(),
                    identity.repo
                ),
                false,
                None,
            )
        };
        if !is_id(IdKind::Claim, &claim.claim_id) || !is_commit_sha(&claim.base) {
            return Err(untrusted("a claim"));
        }
        let (org, repo) = (identity.repo.org.as_str(), identity.repo.repo.as_str());
        let origin = identity
            .origin
            .join_path(&format!("/git/{org}/{repo}/claims/{}.git", claim.claim_id));
        let upstream = identity.origin.join_path(&format!("/git/{org}/{repo}.git"));
        if claim.origin_url != origin.as_str() {
            return Err(untrusted("a fork"));
        }
        if claim.upstream_url != upstream.as_str() {
            return Err(untrusted("an upstream"));
        }
        Ok(Self {
            origin: origin.into(),
            upstream: upstream.into(),
        })
    }
}

/// Where a claim's clone goes when no directory is named: `<repo>-<claimId>` beside the clone the
/// command runs in, or in the working directory. Inside the claim's own clone, that clone.
#[must_use]
pub fn default_dir(
    cwd: &Path,
    current: Option<&CloneBinding>,
    identity: &Identity,
    claim_id: &str,
) -> PathBuf {
    let base = match current {
        Some(binding) if binding.claim_id == claim_id => return binding.dir.clone(),
        Some(binding) => binding.dir.parent().unwrap_or(&binding.dir),
        None => cwd,
    };
    base.join(format!("{}-{claim_id}", identity.repo.repo.as_str()))
}

/// Refuses a named directory that could not become this agent's clone, before any request.
///
/// A missing or empty directory is fine, and so is a clone already bound to this agent and
/// repository; anything else would be overwritten or adopted.
///
/// # Errors
///
/// [`LocalCode::WorkspaceConflict`] when `dir` holds something else.
pub fn check_target(dir: &Path, identity: &Identity) -> Result<()> {
    match occupant(dir)? {
        Occupant::Nothing => Ok(()),
        Occupant::Clone(binding)
            if binding.identity == identity.agent_id
                && binding.origin == identity.origin
                && binding.repo == identity.repo =>
        {
            Ok(())
        }
        Occupant::Clone(_) | Occupant::Other => {
            Err(conflict(dir, "is not a clone of this agent's claims"))
        }
    }
}

/// Opens the clone of `claim` at `dir`: reuses it when it is this claim's, otherwise fetches the
/// fork into a new one. Records the agent and the generation in the clone's Git settings.
///
/// # Errors
///
/// [`LocalCode::WorkspaceConflict`] when `dir` holds anything else, [`LocalCode::Git`] when Git
/// fails; a failed fetch removes everything it created.
pub fn open(
    dir: &Path,
    identity: &Identity,
    claim: &ClaimView,
    remotes: &Remotes,
) -> Result<CloneState> {
    match occupant(dir)? {
        Occupant::Clone(binding) => {
            if !is_clone_of(&binding, identity, claim) {
                return Err(conflict(dir, "is a clone of another claim"));
            }
            configure(dir, identity, claim.generation, remotes)?;
            Ok(CloneState::Reused)
        }
        Occupant::Other => Err(conflict(dir, "is not empty")),
        Occupant::Nothing => {
            let state = create(dir, identity, claim, remotes)?;
            if state == CloneState::Reused {
                configure(dir, identity, claim.generation, remotes)?;
            }
            Ok(state)
        }
    }
}

/// Whether `binding` is this agent's clone of `claim`.
fn is_clone_of(binding: &CloneBinding, identity: &Identity, claim: &ClaimView) -> bool {
    binding.identity == identity.agent_id
        && binding.origin == identity.origin
        && binding.repo == identity.repo
        && binding.claim_id == claim.claim_id
}

/// The ownership generation a clone recorded.
///
/// # Errors
///
/// [`LocalCode::InvalidClone`] when it is missing or not a positive integer, [`LocalCode::Git`]
/// when Git outlived its deadline.
pub fn generation(dir: &Path) -> Result<SafeInteger> {
    let value = unless_timed_out(git(
        dir,
        &["config", "--local", "--get", GIT_GENERATION_CONFIG_KEY],
    ))?;
    value
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|&value| value > 0)
        .and_then(SafeInteger::new)
        .ok_or_else(|| {
            local(
                LocalCode::InvalidClone,
                format!("this clone has no valid {GIT_GENERATION_CONFIG_KEY}; run rh work again to repair it"),
                false,
                Some(NextCommand::Work),
            )
        })
}

/// The commit `HEAD` names in `dir`.
///
/// # Errors
///
/// [`LocalCode::Git`] when the clone has no commit or Git outlived its deadline.
pub fn head(dir: &Path) -> Result<String> {
    unless_timed_out(git(
        dir,
        &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    ))?
    .filter(|sha| is_commit_sha(sha))
    .ok_or_else(|| {
        local(
            LocalCode::Git,
            "this clone has no commit at HEAD to pin".to_owned(),
            false,
            None,
        )
    })
}

enum Occupant {
    Nothing,
    Clone(Box<CloneBinding>),
    Other,
}

/// What `dir` holds. A directory inside some other repository is `Other`, not that repository.
fn occupant(dir: &Path) -> Result<Occupant> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Occupant::Nothing),
        Err(error) if error.kind() == io::ErrorKind::NotADirectory => return Ok(Occupant::Other),
        Err(error) => return Err(io_error("reading", dir, &error)),
    };
    if entries.count() == 0 {
        return Ok(Occupant::Nothing);
    }
    let binding =
        CloneBinding::read(dir).map_err(|_| conflict(dir, "has damaged Railhead settings"))?;
    let Some(binding) = binding else {
        return Ok(Occupant::Other);
    };
    let same = |a: &Path, b: &Path| matches!((fs::canonicalize(a), fs::canonicalize(b)), (Ok(a), Ok(b)) if a == b);
    Ok(if same(&binding.dir, dir) {
        Occupant::Clone(Box::new(binding))
    } else {
        Occupant::Other
    })
}

/// Builds a new clone and publishes it at `dir`. When another run of the same claim published
/// first, its clone is kept and this run's is discarded: the result is then `Reused`.
fn create(
    dir: &Path,
    identity: &Identity,
    claim: &ClaimView,
    remotes: &Remotes,
) -> Result<CloneState> {
    let name = dir
        .file_name()
        .ok_or_else(|| conflict(dir, "is not a directory a clone can be created in"))?;
    let parent = dir.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|error| io_error("creating", parent, &error))?;
    remove_discarded(parent, name)?;
    // Reserved before the staging directory exists, so a signal from here on lets this run set it
    // aside rather than end `rh` with it in place.
    let mut aside = subprocess::SetAside::reserve().map_err(interrupted)?;
    let Staging { staging, discard } = stage(parent, name)?;
    aside.watch(staging.clone(), discard.clone());

    let placed =
        build(&staging, identity, claim, remotes).and_then(|()| match publish(&staging, dir) {
            Ok(()) => Ok(CloneState::Created),
            Err(error) => match occupant(dir)? {
                Occupant::Clone(binding) if is_clone_of(&binding, identity, claim) => {
                    Ok(CloneState::Reused)
                }
                Occupant::Clone(_) | Occupant::Other => Err(conflict(
                    dir,
                    "was filled by something else while the clone was fetched",
                )),
                Occupant::Nothing => Err(io_error("moving the clone to", dir, &error)),
            },
        });
    // Only this run's own staging directory is removed; it never held anything an agent wrote.
    // A published clone has left it. It is renamed to its discard name first, so should `rh` end
    // before the removal finishes, the next run removes the rest.
    if staging.exists() {
        aside
            .now()
            .map_err(|cleanup| io_error("setting aside", &staging, &cleanup))?;
        #[cfg(debug_assertions)]
        subprocess::stall_for_test("cleanup");
        fs::remove_dir_all(&discard).map_err(|cleanup| io_error("removing", &discard, &cleanup))?;
    }
    placed
}

/// The error for a step `rh` did not start because it received `signal`. Never printed: `rh` ends
/// on the signal.
fn interrupted(signal: i32) -> Error {
    local(
        LocalCode::Git,
        format!("cloning was not started because rh received signal {signal}"),
        true,
        None,
    )
}

/// Removes the discarded staging directories of `name` in `parent`: those an earlier run set aside
/// but did not finish removing. Nothing else is touched.
fn remove_discarded(parent: &Path, name: &OsStr) -> Result<()> {
    let mut prefix = OsStr::new(".").to_os_string();
    prefix.push(name);
    prefix.push(DISCARD_INFIX);
    let prefix = prefix.to_string_lossy().into_owned();
    let entries = fs::read_dir(parent).map_err(|error| io_error("reading", parent, &error))?;
    for entry in entries {
        let entry = entry.map_err(|error| io_error("reading", parent, &error))?;
        let file_name = entry.file_name();
        let is_discard = file_name
            .to_str()
            .and_then(|file_name| file_name.strip_prefix(&prefix))
            .is_some_and(is_staging_suffix);
        // A symbolic link with a discard name is never followed or removed.
        let is_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
        if !(is_discard && is_dir) {
            continue;
        }
        let path = entry.path();
        match fs::remove_dir_all(&path) {
            Ok(()) => {}
            // Another run removed it first.
            Err(_) if !path.exists() => {}
            Err(error) => return Err(io_error("removing", &path, &error)),
        }
    }
    Ok(())
}

/// Whether `suffix` is the `<pid>-<attempt>` that ends a staging or discard name.
fn is_staging_suffix(suffix: &str) -> bool {
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    suffix
        .split_once('-')
        .is_some_and(|(pid, attempt)| digits(pid) && digits(attempt))
}

/// Moves the finished clone in `staging` to `dir` in one step. A rename replaces a missing or
/// empty directory and fails on any other, so when two runs race for `dir` the first to publish
/// keeps it and nothing it holds is removed.
fn publish(staging: &Path, dir: &Path) -> io::Result<()> {
    // Elsewhere a rename never replaces a directory, so an empty one is removed first;
    // `remove_dir` refuses once another run has published into it.
    #[cfg(not(unix))]
    match fs::remove_dir(dir) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    fs::rename(staging, dir)
}

/// How many staging names `stage` tries before giving up.
const STAGING_ATTEMPTS: u32 = 64;

/// What follows the target's name in a staging directory's name.
const STAGING_INFIX: &str = ".rh-partial-";

/// What follows the target's name in a discarded staging directory's name.
const DISCARD_INFIX: &str = ".rh-discard-";

/// A staging directory this run created, and the name it is renamed to before it is removed.
struct Staging {
    staging: PathBuf,
    discard: PathBuf,
}

/// Creates a staging directory beside the target that belongs to this run alone.
///
/// The directory is created with `create_dir`, which fails when the name is taken, so this run
/// owns exactly what it created and never adopts or deletes anything already there. A directory
/// left by a killed run is kept for a person to inspect: its name says what it is, but nothing
/// proves no other run is still using it. Its discard name is where it goes once this run gives it
/// up; only then may another run remove it.
fn stage(parent: &Path, name: &OsStr) -> Result<Staging> {
    let pid = std::process::id();
    let named = |infix: &str, attempt: u32| {
        let mut file_name = OsStr::new(".").to_os_string();
        file_name.push(name);
        file_name.push(format!("{infix}{pid}-{attempt}"));
        parent.join(file_name)
    };
    for attempt in 0..STAGING_ATTEMPTS {
        let staging = named(STAGING_INFIX, attempt);
        match fs::create_dir(&staging) {
            Ok(()) => {
                return Ok(Staging {
                    staging,
                    discard: named(DISCARD_INFIX, attempt),
                });
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(io_error("creating", &staging, &error)),
        }
    }
    Err(conflict(
        parent,
        "has no free name for a staging directory; remove old .rh-partial directories",
    ))
}

/// Builds the clone in `staging`. A failed fetch and a Git step stopped at its deadline are
/// retryable: `create` removes the staging directory, and the next run starts again.
fn build(staging: &Path, identity: &Identity, claim: &ClaimView, remotes: &Remotes) -> Result<()> {
    build_steps(staging, identity, claim, remotes).map_err(|error| match error {
        Error::Local {
            code,
            message,
            retryable: true,
            next,
        } => local(
            code,
            format!("{message}; nothing was kept, and running the command again resumes the claim"),
            true,
            next,
        ),
        other => other,
    })
}

fn build_steps(
    staging: &Path,
    identity: &Identity,
    claim: &ClaimView,
    remotes: &Remotes,
) -> Result<()> {
    let mut init = git_command(Path::new("."));
    init.args(["init", "--quiet", "--initial-branch", BRANCH])
        .arg(staging);
    run_git("creating the clone", &mut init, false)?;
    configure(staging, identity, claim.generation, remotes)?;
    let mut fetch = git_command(staging);
    fetch.args(["fetch", "--quiet", "origin"]);
    // A fetch fails when the fork is briefly unreachable; a later run may reach it.
    run_git("fetching the claim's fork", &mut fetch, false).map_err(|error| match error {
        Error::Local {
            code,
            message,
            next,
            ..
        } => local(code, message, true, next),
        other => other,
    })?;
    let tracking = format!("origin/{BRANCH}");
    let mut checkout = git_command(staging);
    checkout.args(["checkout", "--quiet", "-B", BRANCH, "--track", &tracking]);
    run_git("checking out the fork", &mut checkout, false).map(drop)
}

/// Writes the clone's Railhead settings: its agent, the generation it saw, both remotes and the
/// credential helper. Each replaces every value the key had, so a key the agent gave a second
/// value cannot make a resumed claim fail. Leaves the working tree alone.
fn configure(
    dir: &Path,
    identity: &Identity,
    generation: SafeInteger,
    remotes: &Remotes,
) -> Result<()> {
    let helper = credential_helper()?;
    let generation = generation.get().to_string();
    let settings: [&[&str]; 11] = [
        &[
            "config",
            "--replace-all",
            GIT_IDENTITY_CONFIG_KEY,
            identity.agent_id.as_str(),
        ],
        &[
            "config",
            "--replace-all",
            GIT_GENERATION_CONFIG_KEY,
            &generation,
        ],
        &[
            "config",
            "--replace-all",
            "remote.origin.url",
            &remotes.origin,
        ],
        &[
            "config",
            "--replace-all",
            "remote.origin.fetch",
            "+refs/heads/*:refs/remotes/origin/*",
        ],
        &[
            "config",
            "--replace-all",
            "remote.upstream.url",
            &remotes.upstream,
        ],
        &[
            "config",
            "--replace-all",
            "remote.upstream.fetch",
            "+refs/heads/*:refs/remotes/upstream/*",
        ],
        &[
            "config",
            "--replace-all",
            "remote.upstream.pushurl",
            UPSTREAM_PUSH_URL,
        ],
        // An empty value drops every helper configured outside this clone, so Git asks only rh.
        &["config", "--replace-all", "credential.helper", ""],
        &["config", "--add", "credential.helper", &helper],
        &["config", "--replace-all", "credential.useHttpPath", "true"],
        &["config", "--replace-all", "push.default", "upstream"],
    ];
    for args in settings {
        git(dir, args)?;
    }
    Ok(())
}

/// `!'<this executable>' credential`, quoted for the shell Git runs helpers in.
fn credential_helper() -> Result<String> {
    let exe =
        std::env::current_exe().map_err(|error| io_error("locating", Path::new("rh"), &error))?;
    let exe = exe.to_str().ok_or_else(|| {
        local(
            LocalCode::Git,
            "the path of rh is not UTF-8, so Git cannot run it as a credential helper".to_owned(),
            false,
            None,
        )
    })?;
    Ok(format!("!'{}' credential", exe.replace('\'', r"'\''")))
}

/// Git in `dir`, never prompting, with stalled transfers aborted and nothing redirecting it.
fn git_command(dir: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_HTTP_LOW_SPEED_LIMIT", "1000")
        .env("GIT_HTTP_LOW_SPEED_TIME", "60")
        .stdin(Stdio::null())
        // Git's messages include text from the remote, which is untrusted.
        .stderr(Stdio::null());
    for key in GIT_LOCATION_ENV {
        command.env_remove(key);
    }
    command
}

/// Runs Git in `dir` and returns its first line of output.
fn git(dir: &Path, args: &[&str]) -> Result<String> {
    let action = args.first().copied().unwrap_or("git");
    let mut command = git_command(dir);
    command.args(args);
    let stdout = run_git(action, &mut command, true)?;
    let text = String::from_utf8(stdout).map_err(|_| {
        local(
            LocalCode::Git,
            format!("{action}: git wrote output that is not UTF-8"),
            false,
            None,
        )
    })?;
    Ok(text.lines().next().unwrap_or_default().to_owned())
}

/// Runs `command` within the Git deadline and returns its stdout when `capture` is set.
fn run_git(action: &str, command: &mut Command, capture: bool) -> Result<Vec<u8>> {
    let limit = git_timeout(std::env::var_os(GIT_TIMEOUT_ENV).as_deref())?;
    match subprocess::run(command, limit, capture) {
        Ok(done) if done.status.success() => Ok(done.stdout),
        Ok(done) => Err(git_failed(action, done.status)),
        Err(RunError::Io(error)) => Err(git_unavailable(action, &error)),
        Err(error @ RunError::TimedOut(_)) => Err(local(
            LocalCode::Git,
            format!("{action}: git {error}; {GIT_TIMEOUT_ENV} sets a longer limit in seconds"),
            true,
            None,
        )),
        // Never printed: `rh` ends on the signal once this step has cleaned up.
        Err(error @ RunError::Interrupted(_)) => Err(local(
            LocalCode::Git,
            format!("{action}: git {error}"),
            true,
            None,
        )),
    }
}

/// Refuses an invalid [`GIT_TIMEOUT_ENV`], before any request.
///
/// # Errors
///
/// [`LocalCode::InvalidInput`] unless it is unset or whole seconds from 1 to 3600.
pub fn check_git_timeout() -> Result<()> {
    git_timeout(std::env::var_os(GIT_TIMEOUT_ENV).as_deref()).map(drop)
}

/// The deadline `value` of [`GIT_TIMEOUT_ENV`] sets: whole seconds from 1 to 3600.
fn git_timeout(value: Option<&OsStr>) -> Result<Duration> {
    let Some(value) = value else {
        return Ok(DEFAULT_GIT_TIMEOUT);
    };
    value
        .to_str()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|seconds| (1..=MAX_GIT_TIMEOUT_SECS).contains(seconds))
        .map(Duration::from_secs)
        .ok_or_else(|| {
            local(
                LocalCode::InvalidInput,
                format!("{GIT_TIMEOUT_ENV} must be whole seconds from 1 to {MAX_GIT_TIMEOUT_SECS}"),
                false,
                None,
            )
        })
}

/// `None` for a Git failure that says something about the clone; a retryable failure, such as a
/// deadline or an invalid deadline setting, says nothing about it and is returned.
fn unless_timed_out(result: Result<String>) -> Result<Option<String>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error)
            if matches!(
                error,
                Error::Local {
                    code: LocalCode::InvalidInput,
                    ..
                } | Error::Local {
                    retryable: true,
                    ..
                }
            ) =>
        {
            Err(error)
        }
        Err(_) => Ok(None),
    }
}

fn git_unavailable(action: &str, error: &io::Error) -> Error {
    local(
        LocalCode::Git,
        format!("{action}: running git failed: {error}"),
        false,
        None,
    )
}

fn git_failed(action: &str, status: std::process::ExitStatus) -> Error {
    let code = status
        .code()
        .map_or_else(|| "a signal".to_owned(), |code| format!("status {code}"));
    local(
        LocalCode::Git,
        format!("{action}: git exited with {code}"),
        false,
        None,
    )
}

fn io_error(action: &str, path: &Path, error: &io::Error) -> Error {
    local(
        LocalCode::WorkspaceConflict,
        format!("{action} {}: {error}", path.display()),
        false,
        None,
    )
}

fn conflict(dir: &Path, why: &str) -> Error {
    local(
        LocalCode::WorkspaceConflict,
        format!(
            "{} {why}; move it away or name another directory with --dir",
            dir.display()
        ),
        false,
        None,
    )
}

fn local(code: LocalCode, message: String, retryable: bool, next: Option<NextCommand>) -> Error {
    Error::Local {
        code,
        message,
        retryable,
        next,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{AgentId, AgentName};

    fn identity() -> anyhow::Result<Identity> {
        Ok(Identity {
            name: AgentName::new("atlas")?,
            agent_id: AgentId::new("agt_atlas01")?,
            origin: "https://railhead.dev".parse()?,
            repo: "casqueblanc/demo".parse()?,
        })
    }

    fn claim(origin_url: &str, upstream_url: &str) -> anyhow::Result<ClaimView> {
        Ok(serde_json::from_value(serde_json::json!({
            "claimId": "clm_42abcd", "issueId": "iss_upload1", "generation": 1,
            "base": "a".repeat(40), "state": "working", "readyCommit": null,
            "originUrl": origin_url, "upstreamUrl": upstream_url,
            "task": {"title": "t", "body": "b"}
        }))?)
    }

    const FORK: &str = "https://railhead.dev/git/casqueblanc/demo/claims/clm_42abcd.git";
    const MAIN: &str = "https://railhead.dev/git/casqueblanc/demo.git";

    #[test]
    fn remotes_must_be_this_repository_on_this_origin() -> anyhow::Result<()> {
        let remotes = Remotes::check(&identity()?, &claim(FORK, MAIN)?)?;
        assert_eq!(
            (remotes.origin.as_str(), remotes.upstream.as_str()),
            (FORK, MAIN)
        );
        for (fork, main) in [
            (
                "https://evil.example/git/casqueblanc/demo/claims/clm_42abcd.git",
                MAIN,
            ),
            (
                "https://railhead.dev/git/casqueblanc/other/claims/clm_42abcd.git",
                MAIN,
            ),
            (
                "https://railhead.dev/git/casqueblanc/demo/claims/clm_other1.git",
                MAIN,
            ),
            (
                "http://railhead.dev/git/casqueblanc/demo/claims/clm_42abcd.git",
                MAIN,
            ),
            (
                FORK,
                "https://railhead.dev/git/casqueblanc/demo/claims/clm_42abcd.git",
            ),
            (FORK, "https://user@railhead.dev/git/casqueblanc/demo.git"),
            (FORK, ""),
        ] {
            let error = Remotes::check(&identity()?, &claim(fork, main)?).err();
            assert!(
                matches!(
                    error,
                    Some(Error::Local {
                        code: LocalCode::UntrustedRemote,
                        ..
                    })
                ),
                "{fork} {main}: {error:?}"
            );
        }
        Ok(())
    }

    #[test]
    fn the_default_directory_follows_the_current_clone() -> anyhow::Result<()> {
        let identity = identity()?;
        let cwd = Path::new("/work");
        assert_eq!(
            default_dir(cwd, None, &identity, "clm_42abcd"),
            Path::new("/work/demo-clm_42abcd")
        );
        let binding = CloneBinding {
            dir: PathBuf::from("/work/demo-clm_old001"),
            identity: identity.agent_id.clone(),
            origin: identity.origin.clone(),
            repo: identity.repo.clone(),
            claim_id: "clm_old001".to_owned(),
        };
        assert_eq!(
            default_dir(cwd, Some(&binding), &identity, "clm_42abcd"),
            Path::new("/work/demo-clm_42abcd")
        );
        assert_eq!(
            default_dir(cwd, Some(&binding), &identity, "clm_old001"),
            Path::new("/work/demo-clm_old001")
        );
        Ok(())
    }

    fn staging_path(parent: &Path, attempt: u32) -> PathBuf {
        parent.join(format!(".demo.rh-partial-{}-{attempt}", std::process::id()))
    }

    fn discard_path(parent: &Path, attempt: u32) -> PathBuf {
        parent.join(format!(".demo.rh-discard-{}-{attempt}", std::process::id()))
    }

    #[test]
    fn staging_creates_a_new_empty_directory_of_its_own() -> anyhow::Result<()> {
        let parent = tempfile::tempdir()?;
        let first = stage(parent.path(), OsStr::new("demo"))?;
        assert_eq!(first.staging, staging_path(parent.path(), 0));
        assert_eq!(first.discard, discard_path(parent.path(), 0));
        assert_eq!(fs::read_dir(&first.staging)?.count(), 0);
        assert!(!first.discard.exists());
        let second = stage(parent.path(), OsStr::new("demo"))?;
        assert_eq!(second.staging, staging_path(parent.path(), 1));
        assert_eq!(second.discard, discard_path(parent.path(), 1));
        Ok(())
    }

    #[test]
    fn discarded_staging_of_the_target_alone_is_removed() -> anyhow::Result<()> {
        let parent = tempfile::tempdir()?;
        let discarded = parent.path().join(".demo.rh-discard-41-0");
        fs::create_dir_all(discarded.join("objects"))?;
        fs::write(discarded.join("objects/pack"), "partial\n")?;
        // Another target's discard, a staging directory still in use, a name that only looks
        // like a discard, and a file under a discard name are all kept.
        let kept = [
            ".other.rh-discard-41-0",
            ".demo.rh-partial-41-0",
            ".demo.rh-discard-41-x",
            ".demo.rh-discard-41",
            "demo",
        ];
        for name in kept {
            fs::create_dir(parent.path().join(name))?;
        }
        fs::write(parent.path().join(".demo.rh-discard-42-0"), "a file\n")?;
        remove_discarded(parent.path(), OsStr::new("demo"))?;
        assert!(!discarded.exists());
        for name in kept {
            assert!(parent.path().join(name).is_dir(), "{name} was removed");
        }
        assert!(parent.path().join(".demo.rh-discard-42-0").is_file());
        // Nothing to remove is not an error.
        remove_discarded(parent.path(), OsStr::new("demo"))?;
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn a_discard_name_on_a_symbolic_link_is_not_followed() -> anyhow::Result<()> {
        let parent = tempfile::tempdir()?;
        let elsewhere = tempfile::tempdir()?;
        fs::write(elsewhere.path().join("work.txt"), "kept\n")?;
        let link = parent.path().join(".demo.rh-discard-41-0");
        std::os::unix::fs::symlink(elsewhere.path(), &link)?;
        remove_discarded(parent.path(), OsStr::new("demo"))?;
        assert!(link.symlink_metadata()?.file_type().is_symlink());
        assert_eq!(
            fs::read_to_string(elsewhere.path().join("work.txt"))?,
            "kept\n"
        );
        Ok(())
    }

    #[test]
    fn a_parent_that_cannot_be_read_is_reported() -> anyhow::Result<()> {
        let parent = tempfile::tempdir()?;
        let missing = parent.path().join("missing");
        let error = remove_discarded(&missing, OsStr::new("demo")).err();
        assert!(
            matches!(
                error,
                Some(Error::Local {
                    code: LocalCode::WorkspaceConflict,
                    ..
                })
            ),
            "{error:?}"
        );
        Ok(())
    }

    #[test]
    fn staging_never_adopts_or_empties_a_taken_name() -> anyhow::Result<()> {
        let parent = tempfile::tempdir()?;
        let taken = staging_path(parent.path(), 0);
        fs::create_dir(&taken)?;
        fs::write(taken.join("work.txt"), "unpublished\n")?;
        let staging = stage(parent.path(), OsStr::new("demo"))?;
        assert_eq!(staging.staging, staging_path(parent.path(), 1));
        assert_eq!(fs::read_to_string(taken.join("work.txt"))?, "unpublished\n");
        Ok(())
    }

    #[test]
    fn staging_gives_up_when_every_name_is_taken() -> anyhow::Result<()> {
        let parent = tempfile::tempdir()?;
        for attempt in 0..STAGING_ATTEMPTS {
            fs::create_dir(staging_path(parent.path(), attempt))?;
        }
        let error = stage(parent.path(), OsStr::new("demo")).err();
        assert!(
            matches!(
                error,
                Some(Error::Local {
                    code: LocalCode::WorkspaceConflict,
                    ..
                })
            ),
            "{error:?}"
        );
        assert_eq!(
            fs::read_dir(parent.path())?.count(),
            usize::try_from(STAGING_ATTEMPTS)?
        );
        Ok(())
    }

    #[test]
    fn staging_reports_a_parent_it_cannot_write_in() -> anyhow::Result<()> {
        let parent = tempfile::tempdir()?;
        let missing = parent.path().join("missing");
        let error = stage(&missing, OsStr::new("demo")).err();
        assert!(
            matches!(
                error,
                Some(Error::Local {
                    code: LocalCode::WorkspaceConflict,
                    ..
                })
            ),
            "{error:?}"
        );
        assert!(!missing.exists());
        Ok(())
    }

    #[test]
    fn the_git_timeout_is_whole_seconds_within_an_hour() -> anyhow::Result<()> {
        assert_eq!(git_timeout(None)?, DEFAULT_GIT_TIMEOUT);
        assert_eq!(git_timeout(Some(OsStr::new("1")))?, Duration::from_secs(1));
        assert_eq!(
            git_timeout(Some(OsStr::new("3600")))?,
            Duration::from_secs(3600)
        );
        for value in ["0", "3601", "", " 5", "1.5", "-1", "18446744073709551616"] {
            let error = git_timeout(Some(OsStr::new(value))).err();
            assert!(
                matches!(
                    error,
                    Some(Error::Local {
                        code: LocalCode::InvalidInput,
                        retryable: false,
                        ..
                    })
                ),
                "{value:?}: {error:?}"
            );
        }
        Ok(())
    }

    #[test]
    fn the_helper_quotes_its_path_for_the_shell() -> anyhow::Result<()> {
        let helper = credential_helper()?;
        assert!(
            helper.starts_with("!'") && helper.ends_with("' credential"),
            "{helper}"
        );
        Ok(())
    }
}
