//! Where a command runs: the Railhead origin and repository, the clone it runs in, and the agent
//! identity every request authenticates as.
//!
//! A claim's clone is bound to the identity that claimed it by the Git setting
//! `railhead.identity`. Inside such a clone every command authenticates as that identity; naming a
//! different agent with `--agent` or `RAILHEAD_AGENT` is refused before any request is sent.

use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::str::FromStr;

use railhead_protocol::{IdKind, is_id};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::identity::{self, AgentId, AgentSelector, FileStore, Identity};

/// The Git setting that binds a clone to the agent identity that claimed it.
pub const GIT_IDENTITY_CONFIG_KEY: &str = "railhead.identity";

/// The environment variable that names the agent to act as.
pub const AGENT_ENV: &str = "RAILHEAD_AGENT";

/// The environment variable that overrides where identities are stored.
pub const HOME_ENV: &str = "RAILHEAD_HOME";

/// A context failure. Each one stops the command before any request is sent.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The origin is not a Railhead origin `rh` will send credentials to.
    #[error("`{0}` is not a Railhead origin: use https://host, or http only for localhost")]
    InvalidOrigin(String),
    /// The repository is not `org/repo` of lowercase names.
    #[error("`{0}` is not a repository: use org/repo in lowercase letters, digits and dashes")]
    InvalidRepo(String),
    /// The clone names an identity, but its remote is not a Railhead claim.
    #[error("this clone sets {GIT_IDENTITY_CONFIG_KEY} but its origin is not a Railhead claim")]
    InvalidClone,
    /// The agent named on the command line or in the environment is not the clone's.
    #[error(
        "this clone belongs to {bound}, not {requested}; run rh from another directory or unset {AGENT_ENV}"
    )]
    IdentityMismatch {
        /// The identity the clone is bound to.
        bound: AgentId,
        /// The agent that was asked for.
        requested: String,
    },
    /// The stored identity belongs to another origin or repository than the clone.
    #[error("{0} joined another Railhead repository than this clone's")]
    RepositoryMismatch(AgentId),
    /// No agent was named and the directory is not a claim's clone.
    #[error("no agent selected: run rh inside a claim's clone, or set {AGENT_ENV}")]
    NoIdentity,
    /// Git could not be run.
    #[error("running git: {0}")]
    Git(#[source] std::io::Error),
    /// The directory is in a Git repository whose binding Git could not read, so whether it is a
    /// claim's clone is unknown.
    #[error("git could not read this repository's configuration; repair it or run rh elsewhere")]
    GitInspection,
    /// No per-user config directory exists and `RAILHEAD_HOME` is unset.
    #[error("no config directory found; set {HOME_ENV}")]
    NoHome,
    /// The identity store failed.
    #[error(transparent)]
    Identity(#[from] identity::Error),
}

/// Result of a context operation.
pub type Result<T> = std::result::Result<T, Error>;

/// A Railhead origin: `https://host[:port]`, or `http://` on a loopback host for local testing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Origin(Url);

impl Origin {
    /// The origin as the login message and the remotes write it, without a trailing slash.
    #[must_use]
    pub fn as_str(&self) -> String {
        self.0.origin().ascii_serialization()
    }

    /// The URL of `path`, which must start with `/`, on this origin.
    #[must_use]
    pub fn join_path(&self, path: &str) -> Url {
        let mut url = self.0.clone();
        url.set_path(path);
        url
    }
}

impl FromStr for Origin {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        let invalid = || Error::InvalidOrigin(value.to_owned());
        let url = Url::parse(value).map_err(|_| invalid())?;
        let secure = match url.scheme() {
            "https" => true,
            "http" => is_loopback(&url),
            _ => false,
        };
        let bare = url.username().is_empty()
            && url.password().is_none()
            && url.host().is_some()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none();
        if secure && bare {
            Ok(Self(url))
        } else {
            Err(invalid())
        }
    }
}

impl TryFrom<String> for Origin {
    type Error = Error;

    fn try_from(value: String) -> Result<Self> {
        value.parse()
    }
}

impl From<Origin> for String {
    fn from(origin: Origin) -> Self {
        origin.as_str()
    }
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(domain)) => domain == "localhost",
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// An organisation or repository name: lowercase letters, digits and inner dashes, 1 to 64.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoSegment(String);

impl RepoSegment {
    fn new(value: &str) -> Option<Self> {
        let bytes = value.as_bytes();
        let edge = |b: Option<&u8>| b.is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
        let valid = (1..=64).contains(&bytes.len())
            && edge(bytes.first())
            && edge(bytes.last())
            && bytes
                .iter()
                .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        valid.then(|| Self(value.to_owned()))
    }

    /// The name.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A repository on a Railhead origin, `org/repo`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct RepoRef {
    /// The organisation.
    pub org: RepoSegment,
    /// The repository.
    pub repo: RepoSegment,
}

impl FromStr for RepoRef {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        value
            .split_once('/')
            .and_then(|(org, repo)| Some((RepoSegment::new(org)?, RepoSegment::new(repo)?)))
            .map(|(org, repo)| Self { org, repo })
            .ok_or_else(|| Error::InvalidRepo(value.to_owned()))
    }
}

impl TryFrom<String> for RepoRef {
    type Error = Error;

    fn try_from(value: String) -> Result<Self> {
        value.parse()
    }
}

impl From<RepoRef> for String {
    fn from(repo: RepoRef) -> Self {
        repo.to_string()
    }
}

impl fmt::Display for RepoRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.org.as_str(), self.repo.as_str())
    }
}

/// A clone made by `rh claim`: bound to one identity, with the claim's fork as `origin`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloneBinding {
    /// The clone's working directory.
    pub dir: PathBuf,
    /// The identity in `railhead.identity`.
    pub identity: AgentId,
    /// The Railhead origin of the clone's `origin` remote.
    pub origin: Origin,
    /// The repository the claim belongs to.
    pub repo: RepoRef,
    /// The claim whose fork `origin` is.
    pub claim_id: String,
}

impl CloneBinding {
    /// Reads the binding of the clone containing `dir`, or `None` when `dir` is not a bound clone.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidClone`] when the clone names an identity but its remote is not a claim's
    /// fork, [`Error::GitInspection`] when `dir` is in a repository Git cannot read, or
    /// [`Error::Git`] when Git cannot be run.
    pub fn read(dir: &Path) -> Result<Option<Self>> {
        let Some(top) = repository_top(dir)? else {
            return Ok(None);
        };
        let Some(identity) = git_config(dir, GIT_IDENTITY_CONFIG_KEY)? else {
            return Ok(None);
        };
        let identity = AgentId::new(&identity).map_err(|_| Error::InvalidClone)?;
        let remote = git_config(dir, "remote.origin.url")?.ok_or(Error::InvalidClone)?;
        let (origin, repo, claim_id) = parse_claim_remote(&remote).ok_or(Error::InvalidClone)?;
        Ok(Some(Self {
            dir: top,
            identity,
            origin,
            repo,
            claim_id,
        }))
    }
}

/// Splits `{origin}/git/{org}/{repo}/claims/{claimId}.git` into its parts.
fn parse_claim_remote(remote: &str) -> Option<(Origin, RepoRef, String)> {
    let url = Url::parse(remote).ok()?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let mut segments = url.path_segments()?;
    let (Some("git"), Some(org), Some(repo), Some("claims"), Some(claim), None) = (
        segments.next(),
        segments.next(),
        segments.next(),
        segments.next(),
        segments.next(),
        segments.next(),
    ) else {
        return None;
    };
    let claim_id = claim.strip_suffix(".git")?;
    if !is_id(IdKind::Claim, claim_id) {
        return None;
    }
    let repo = RepoRef {
        org: RepoSegment::new(org)?,
        repo: RepoSegment::new(repo)?,
    };
    let origin = url.origin().ascii_serialization().parse().ok()?;
    Some((origin, repo, claim_id.to_owned()))
}

/// The top of the work tree containing `dir`, or `None` when `dir` is positively outside any
/// repository: Git says so and no `.git` entry or `GIT_DIR` suggests otherwise.
///
/// Any other failure is [`Error::GitInspection`], so a repository whose binding cannot be read is
/// never mistaken for an unbound directory.
fn repository_top(dir: &Path) -> Result<Option<PathBuf>> {
    match run_git(dir, &["rev-parse", "--show-toplevel"]) {
        Ok(output) if output.status.success() => Ok(Some(PathBuf::from(stdout_line(output)?))),
        Ok(_) if !may_be_repository(dir) => Ok(None),
        Ok(_) => Err(Error::GitInspection),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !may_be_repository(dir) => {
            Ok(None)
        }
        Err(error) => Err(Error::Git(error)),
    }
}

/// True unless `dir` and every ancestor positively lack a `.git` entry and `GIT_DIR` is unset.
fn may_be_repository(dir: &Path) -> bool {
    std::env::var_os("GIT_DIR").is_some()
        || dir.ancestors().any(|ancestor| {
            !matches!(
                std::fs::symlink_metadata(ancestor.join(".git")),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound
            )
        })
}

/// Reads one local Git setting of the repository containing `dir`, or `None` when it is unset.
///
/// Git exits with 1 only for an unset key; any other failure is [`Error::GitInspection`].
fn git_config(dir: &Path, key: &str) -> Result<Option<String>> {
    let output = run_git(dir, &["config", "--local", "--get", key]).map_err(Error::Git)?;
    match output.status.code() {
        Some(0) => stdout_line(output).map(Some),
        Some(1) => Ok(None),
        _ => Err(Error::GitInspection),
    }
}

fn run_git(dir: &Path, args: &[&str]) -> std::io::Result<std::process::Output> {
    Command::new("git").arg("-C").arg(dir).args(args).output()
}

fn stdout_line(output: std::process::Output) -> Result<String> {
    let value = String::from_utf8(output.stdout).map_err(|_| Error::InvalidClone)?;
    Ok(value.trim_end_matches(['\n', '\r']).to_owned())
}

/// Everything a command knows before it sends anything.
#[derive(Debug, Clone)]
pub struct Context {
    store: FileStore,
    requested: Option<AgentSelector>,
    clone: Option<CloneBinding>,
}

impl Context {
    /// Builds the context from the process: the working directory, the `--agent` flag (which wins
    /// over `RAILHEAD_AGENT`) and `RAILHEAD_HOME`.
    ///
    /// # Errors
    ///
    /// When the named agent is invalid, the store has no home, or the clone is bound but damaged.
    pub fn load(
        cwd: &Path,
        agent_flag: Option<AgentSelector>,
        agent_env: Option<OsString>,
        home_env: Option<OsString>,
    ) -> Result<Self> {
        let requested = match (agent_flag, agent_env) {
            (Some(selector), _) => Some(selector),
            (None, Some(value)) if !value.is_empty() => {
                let value = value.to_string_lossy();
                Some(value.parse::<AgentSelector>()?)
            }
            (None, _) => None,
        };
        let home = match home_env {
            Some(home) if !home.is_empty() => PathBuf::from(home),
            _ => dirs::config_dir().ok_or(Error::NoHome)?.join("railhead"),
        };
        Ok(Self {
            store: FileStore::new(home),
            requested,
            clone: CloneBinding::read(cwd)?,
        })
    }

    /// The identity store.
    #[must_use]
    pub fn store(&self) -> &FileStore {
        &self.store
    }

    /// The claim clone the command runs in, if any.
    #[must_use]
    pub fn clone_binding(&self) -> Option<&CloneBinding> {
        self.clone.as_ref()
    }

    /// The agent a command acts as.
    ///
    /// Inside a bound clone this is the clone's identity, and naming another agent is
    /// [`Error::IdentityMismatch`]. Elsewhere it is the agent named by `--agent` or
    /// `RAILHEAD_AGENT`.
    ///
    /// # Errors
    ///
    /// When no agent is selected, the selection disagrees with the clone, or the identity is not
    /// stored locally.
    pub fn identity(&self) -> Result<Identity> {
        let Some(clone) = &self.clone else {
            let requested = self.requested.as_ref().ok_or(Error::NoIdentity)?;
            return Ok(self.store.find(requested)?);
        };
        let bound = AgentSelector::Id(clone.identity.clone());
        let selector = self.requested.as_ref().unwrap_or(&bound);
        // A name is checked against the clone only once resolved, so a missing name still
        // reports the mismatch rather than a lookup error.
        if let AgentSelector::Id(id) = selector
            && id != &clone.identity
        {
            return Err(mismatch(clone, selector));
        }
        let identity = match self.store.find(selector) {
            Ok(identity) => identity,
            Err(identity::Error::NotFound(_)) if selector != &bound => {
                return Err(mismatch(clone, selector));
            }
            Err(error) => return Err(error.into()),
        };
        if identity.agent_id != clone.identity {
            return Err(mismatch(clone, selector));
        }
        if identity.origin != clone.origin || identity.repo != clone.repo {
            return Err(Error::RepositoryMismatch(identity.agent_id));
        }
        Ok(identity)
    }
}

fn mismatch(clone: &CloneBinding, selector: &AgentSelector) -> Error {
    Error::IdentityMismatch {
        bound: clone.identity.clone(),
        requested: selector.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use super::*;
    use crate::identity::AgentName;

    #[test]
    fn origins_are_https_or_local_http_and_nothing_else() -> anyhow::Result<()> {
        assert_eq!(
            "https://railhead.dev".parse::<Origin>()?.as_str(),
            "https://railhead.dev"
        );
        assert_eq!(
            "https://railhead.dev:8443/".parse::<Origin>()?.as_str(),
            "https://railhead.dev:8443"
        );
        assert!("http://127.0.0.1:8787".parse::<Origin>().is_ok());
        assert!("http://localhost:8787".parse::<Origin>().is_ok());
        assert!("http://[::1]:8787".parse::<Origin>().is_ok());
        for bad in [
            "",
            "railhead.dev",
            "http://railhead.dev",
            "ftp://railhead.dev",
            "https://user:pw@railhead.dev",
            "https://railhead.dev/agent",
            "https://railhead.dev/?x=1",
            "https://railhead.dev/#x",
            "file:///tmp",
        ] {
            assert!(bad.parse::<Origin>().is_err(), "{bad:?} was accepted");
        }
        Ok(())
    }

    #[test]
    fn repositories_are_two_lowercase_segments() -> anyhow::Result<()> {
        assert_eq!(
            "casqueblanc/demo".parse::<RepoRef>()?.to_string(),
            "casqueblanc/demo"
        );
        let longest = format!("{}/x", "a".repeat(64));
        assert!(longest.parse::<RepoRef>().is_ok());
        for bad in [
            "",
            "demo",
            "a/b/c",
            "Casque/demo",
            "-a/demo",
            "a-/demo",
            "a/",
            &format!("{}/x", "a".repeat(65)),
        ] {
            assert!(bad.parse::<RepoRef>().is_err(), "{bad:?} was accepted");
        }
        Ok(())
    }

    #[test]
    fn claim_remotes_parse_and_others_do_not() -> anyhow::Result<()> {
        let (origin, repo, claim) =
            parse_claim_remote("https://railhead.dev/git/casqueblanc/demo/claims/clm_42abcd.git")
                .ok_or_else(|| anyhow::anyhow!("claim remote refused"))?;
        assert_eq!(origin.as_str(), "https://railhead.dev");
        assert_eq!(repo.to_string(), "casqueblanc/demo");
        assert_eq!(claim, "clm_42abcd");
        for bad in [
            "https://railhead.dev/git/casqueblanc/demo.git",
            "https://railhead.dev/git/casqueblanc/demo/claims/clm_42abcd",
            "https://railhead.dev/git/casqueblanc/demo/claims/iss_42abcd.git",
            "https://railhead.dev/git/casqueblanc/demo/claims/clm_42abcd.git/x",
            "https://railhead.dev/git/casqueblanc/demo/claims/clm_42abcd.git?x=1",
            "http://railhead.dev/git/casqueblanc/demo/claims/clm_42abcd.git",
            "https://user@railhead.dev/git/casqueblanc/demo/claims/clm_42abcd.git",
            "git@railhead.dev:casqueblanc/demo.git",
        ] {
            assert!(parse_claim_remote(bad).is_none(), "{bad:?} was accepted");
        }
        Ok(())
    }

    struct Fixture {
        _home: tempfile::TempDir,
        home: PathBuf,
        clone: tempfile::TempDir,
    }

    fn git(dir: &Path, args: &[&str]) -> anyhow::Result<()> {
        let status = Command::new("git").arg("-C").arg(dir).args(args).status()?;
        anyhow::ensure!(status.success(), "git {args:?} failed");
        Ok(())
    }

    /// A store holding `atlas` and `boreas` on one repository, and a clone bound to `atlas`.
    fn fixture(remote: &str) -> anyhow::Result<Fixture> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        for (name, id) in [("atlas", "agt_atlas01"), ("boreas", "agt_boreas01")] {
            store.save_identity(&Identity {
                name: AgentName::new(name)?,
                agent_id: AgentId::new(id)?,
                origin: "https://railhead.dev".parse()?,
                repo: "casqueblanc/demo".parse()?,
            })?;
        }
        let clone = tempfile::tempdir()?;
        git(clone.path(), &["init", "--quiet"])?;
        git(
            clone.path(),
            &["config", GIT_IDENTITY_CONFIG_KEY, "agt_atlas01"],
        )?;
        git(clone.path(), &["remote", "add", "origin", remote])?;
        Ok(Fixture {
            home: home.path().to_owned(),
            _home: home,
            clone,
        })
    }

    const REMOTE: &str = "https://railhead.dev/git/casqueblanc/demo/claims/clm_42abcd.git";

    fn load(fixture: &Fixture, dir: &Path, agent: Option<&str>) -> Result<Context> {
        Context::load(
            dir,
            None,
            agent.map(OsString::from),
            Some(fixture.home.clone().into_os_string()),
        )
    }

    #[test]
    fn a_clone_acts_as_its_own_identity() -> anyhow::Result<()> {
        let fixture = fixture(REMOTE)?;
        let subdir = fixture.clone.path().join("src");
        std::fs::create_dir(&subdir)?;
        for (dir, agent) in [
            (fixture.clone.path(), None),
            (subdir.as_path(), Some("atlas")),
            (fixture.clone.path(), Some("agt_atlas01")),
        ] {
            let context = load(&fixture, dir, agent)?;
            assert_eq!(context.identity()?.agent_id.as_str(), "agt_atlas01");
            let binding = context.clone_binding().map(|b| b.claim_id.as_str());
            assert_eq!(binding, Some("clm_42abcd"));
        }
        Ok(())
    }

    #[test]
    fn naming_another_agent_inside_a_clone_is_a_mismatch() -> anyhow::Result<()> {
        let fixture = fixture(REMOTE)?;
        for agent in ["boreas", "agt_boreas01", "nobody", "agt_nobody01"] {
            let error = load(&fixture, fixture.clone.path(), Some(agent))?
                .identity()
                .err();
            assert!(
                matches!(&error, Some(Error::IdentityMismatch { requested, .. }) if requested == agent),
                "{agent}: {error:?}"
            );
        }
        let flag = Context::load(
            fixture.clone.path(),
            Some("boreas".parse()?),
            Some("atlas".into()),
            Some(fixture.home.clone().into_os_string()),
        )?;
        assert!(matches!(
            flag.identity(),
            Err(Error::IdentityMismatch { .. })
        ));
        Ok(())
    }

    #[test]
    fn a_clone_of_another_repository_is_refused() -> anyhow::Result<()> {
        let fixture = fixture("https://railhead.dev/git/casqueblanc/other/claims/clm_42abcd.git")?;
        let error = load(&fixture, fixture.clone.path(), None)?.identity().err();
        assert!(
            matches!(error, Some(Error::RepositoryMismatch(_))),
            "{error:?}"
        );
        Ok(())
    }

    #[test]
    fn a_bound_clone_with_a_foreign_remote_is_invalid() -> anyhow::Result<()> {
        let fixture = fixture("https://evil.example/steal.git")?;
        let error = load(&fixture, fixture.clone.path(), None).err();
        assert!(matches!(error, Some(Error::InvalidClone)), "{error:?}");
        Ok(())
    }

    #[test]
    fn a_clone_whose_config_git_cannot_read_is_refused() -> anyhow::Result<()> {
        let fixture = fixture(REMOTE)?;
        let config = fixture.clone.path().join(".git/config");
        let mut text = std::fs::read_to_string(&config)?;
        text.push_str("[broken\n");
        std::fs::write(&config, text)?;
        let subdir = fixture.clone.path().join("src");
        std::fs::create_dir(&subdir)?;
        for dir in [fixture.clone.path(), subdir.as_path()] {
            for agent in [None, Some("boreas"), Some("agt_boreas01")] {
                let error = load(&fixture, dir, agent).err();
                assert!(
                    matches!(error, Some(Error::GitInspection)),
                    "{agent:?}: {error:?}"
                );
            }
        }
        Ok(())
    }

    #[test]
    fn an_unbound_repository_uses_the_named_agent() -> anyhow::Result<()> {
        let fixture = fixture(REMOTE)?;
        let plain = tempfile::tempdir()?;
        git(plain.path(), &["init", "--quiet"])?;
        let context = load(&fixture, plain.path(), Some("boreas"))?;
        assert!(context.clone_binding().is_none());
        assert_eq!(context.identity()?.agent_id.as_str(), "agt_boreas01");
        Ok(())
    }

    #[test]
    fn outside_a_clone_the_named_agent_is_used() -> anyhow::Result<()> {
        let fixture = fixture(REMOTE)?;
        let outside = tempfile::tempdir()?;
        let context = load(&fixture, outside.path(), Some("boreas"))?;
        assert!(context.clone_binding().is_none());
        assert_eq!(context.identity()?.agent_id.as_str(), "agt_boreas01");
        let none = load(&fixture, outside.path(), None)?.identity().err();
        assert!(matches!(none, Some(Error::NoIdentity)));
        let empty = load(&fixture, outside.path(), Some(""))?.identity().err();
        assert!(matches!(empty, Some(Error::NoIdentity)));
        let invalid = load(&fixture, outside.path(), Some("Not A Name")).err();
        assert!(matches!(invalid, Some(Error::Identity(_))));
        Ok(())
    }
}
