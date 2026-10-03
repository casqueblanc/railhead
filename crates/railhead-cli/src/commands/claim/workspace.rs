//! A claim's clone on disk.
//!
//! A new clone is built in a staging directory that this run creates beside its target and alone
//! owns, and is renamed into place only once its fork is fetched and checked out, so a failed
//! fetch leaves nothing behind and the next `rh work` or `rh claim` starts clean. An existing clone of the same claim and agent is reused:
//! its Railhead settings are refreshed and its working tree, index and refs are never touched.
//!
//! Every remote is checked against the agent's own origin and repository before Git sees it, so
//! a backend answer cannot point a clone, or the credential helper, at another host.

use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use railhead_protocol::{ClaimView, IdKind, NextCommand, SafeInteger, is_commit_sha, is_id};

use crate::context::{CloneBinding, GIT_IDENTITY_CONFIG_KEY};
use crate::identity::Identity;
use crate::output::LocalCode;
use crate::{Error, Result};

/// The Git setting that records the ownership generation the clone's agent last saw.
pub const GIT_GENERATION_CONFIG_KEY: &str = "railhead.generation";

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
            let ours = binding.identity == identity.agent_id
                && binding.origin == identity.origin
                && binding.repo == identity.repo
                && binding.claim_id == claim.claim_id;
            if !ours {
                return Err(conflict(dir, "is a clone of another claim"));
            }
            configure(dir, identity, claim.generation, remotes)?;
            Ok(CloneState::Reused)
        }
        Occupant::Other => Err(conflict(dir, "is not empty")),
        Occupant::Nothing => {
            create(dir, identity, claim, remotes)?;
            Ok(CloneState::Created)
        }
    }
}

/// The ownership generation a clone recorded.
///
/// # Errors
///
/// [`LocalCode::InvalidClone`] when it is missing or not a positive integer.
pub fn generation(dir: &Path) -> Result<SafeInteger> {
    let value = git(
        dir,
        &["config", "--local", "--get", GIT_GENERATION_CONFIG_KEY],
    )
    .ok();
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
/// [`LocalCode::Git`] when the clone has no commit.
pub fn head(dir: &Path) -> Result<String> {
    git(dir, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
        .ok()
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

fn create(dir: &Path, identity: &Identity, claim: &ClaimView, remotes: &Remotes) -> Result<()> {
    let name = dir
        .file_name()
        .ok_or_else(|| conflict(dir, "is not a directory a clone can be created in"))?;
    let parent = dir.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|error| io_error("creating", parent, &error))?;
    let staging = stage(parent, name)?;

    let built = build(&staging, identity, claim, remotes);
    let placed = built.and_then(|()| {
        // An empty target directory is replaced by the finished clone. Renaming a directory onto
        // a non-empty one fails, so when two runs race for the same target the first one to
        // publish keeps it and the other fails without touching it.
        if dir.exists() {
            fs::remove_dir(dir).map_err(|error| io_error("replacing", dir, &error))?;
        }
        fs::rename(&staging, dir).map_err(|error| io_error("moving the clone to", dir, &error))
    });
    if let Err(error) = placed {
        // Only this run's own staging directory is removed; it never held anything an agent wrote.
        if staging.exists() {
            fs::remove_dir_all(&staging)
                .map_err(|cleanup| io_error("removing", &staging, &cleanup))?;
        }
        return Err(error);
    }
    Ok(())
}

/// How many staging names `stage` tries before giving up.
const STAGING_ATTEMPTS: u32 = 64;

/// Creates a staging directory beside the target that belongs to this run alone.
///
/// The directory is created with `create_dir`, which fails when the name is taken, so this run
/// owns exactly what it created and never adopts or deletes anything already there. A directory
/// left by a killed run is kept for a person to inspect: its name says what it is, but nothing
/// proves no other run is still using it.
fn stage(parent: &Path, name: &OsStr) -> Result<PathBuf> {
    let pid = std::process::id();
    for attempt in 0..STAGING_ATTEMPTS {
        let mut staging_name = OsStr::new(".").to_os_string();
        staging_name.push(name);
        staging_name.push(format!(".rh-partial-{pid}-{attempt}"));
        let staging = parent.join(staging_name);
        match fs::create_dir(&staging) {
            Ok(()) => return Ok(staging),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(io_error("creating", &staging, &error)),
        }
    }
    Err(conflict(
        parent,
        "has no free name for a staging directory; remove old .rh-partial directories",
    ))
}

fn build(staging: &Path, identity: &Identity, claim: &ClaimView, remotes: &Remotes) -> Result<()> {
    let created = git_command(Path::new("."))
        .args(["init", "--quiet", "--initial-branch", BRANCH])
        .arg(staging)
        .status();
    check_status("creating the clone", created)?;
    configure(staging, identity, claim.generation, remotes)?;
    let fetched = git_command(staging)
        .args(["fetch", "--quiet", "origin"])
        .status();
    check_status("fetching the claim's fork", fetched).map_err(|error| match error {
        Error::Local { message, .. } => local(
            LocalCode::Git,
            format!("{message}; nothing was kept, and running the command again resumes the claim"),
            true,
            None,
        ),
        other => other,
    })?;
    let tracking = format!("origin/{BRANCH}");
    let checkout = git_command(staging)
        .args(["checkout", "--quiet", "-B", BRANCH, "--track", &tracking])
        .status();
    check_status("checking out the fork", checkout)
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
        .stdout(Stdio::null())
        // Git's messages include text from the remote, which is untrusted.
        .stderr(Stdio::null());
    for key in GIT_LOCATION_ENV {
        command.env_remove(key);
    }
    command
}

/// Runs Git in `dir` and returns its first line of output.
fn git(dir: &Path, args: &[&str]) -> Result<String> {
    let output = git_command(dir).args(args).stdout(Stdio::piped()).output();
    let action = args.first().copied().unwrap_or("git");
    let output = output.map_err(|error| git_unavailable(action, &error))?;
    if !output.status.success() {
        return Err(git_failed(action, output.status));
    }
    let text = String::from_utf8(output.stdout).map_err(|_| git_failed(action, output.status))?;
    Ok(text.lines().next().unwrap_or_default().to_owned())
}

fn check_status(action: &str, status: io::Result<std::process::ExitStatus>) -> Result<()> {
    let status = status.map_err(|error| git_unavailable(action, &error))?;
    if status.success() {
        Ok(())
    } else {
        Err(git_failed(action, status))
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

    #[test]
    fn staging_creates_a_new_empty_directory_of_its_own() -> anyhow::Result<()> {
        let parent = tempfile::tempdir()?;
        let first = stage(parent.path(), OsStr::new("demo"))?;
        assert_eq!(first, staging_path(parent.path(), 0));
        assert_eq!(fs::read_dir(&first)?.count(), 0);
        let second = stage(parent.path(), OsStr::new("demo"))?;
        assert_eq!(second, staging_path(parent.path(), 1));
        Ok(())
    }

    #[test]
    fn staging_never_adopts_or_empties_a_taken_name() -> anyhow::Result<()> {
        let parent = tempfile::tempdir()?;
        let taken = staging_path(parent.path(), 0);
        fs::create_dir(&taken)?;
        fs::write(taken.join("work.txt"), "unpublished\n")?;
        let staging = stage(parent.path(), OsStr::new("demo"))?;
        assert_eq!(staging, staging_path(parent.path(), 1));
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
    fn the_helper_quotes_its_path_for_the_shell() -> anyhow::Result<()> {
        let helper = credential_helper()?;
        assert!(
            helper.starts_with("!'") && helper.ends_with("' credential"),
            "{helper}"
        );
        Ok(())
    }
}
