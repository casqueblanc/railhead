//! Local agent identities and the store that keeps their keys and session tokens.
//!
//! Each identity lives under `<home>/agents/<name>/`: `identity.json` names the agent and the
//! repository it joined, `key` holds its OpenSSH private key and `session` its current session
//! token. The two secrets go through [`SecretStore`], so a system keychain can replace the file
//! store without touching the commands. Secrets never reach `Debug`, `Display` or an error.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};

use railhead_protocol::{IdKind, MAX_AGENT_NAME_LENGTH, MAX_SESSION_TOKEN_LENGTH, is_id};
use serde::{Deserialize, Serialize};

use crate::context::{Origin, RepoRef};

/// Largest file the store reads, in bytes. Every record and secret is far smaller.
const MAX_STORED_BYTES: u64 = 64 * 1024;

/// Most identities the store looks through when finding one by agent id.
const MAX_IDENTITIES: usize = 256;

/// Most names a write tries for its temporary file before giving up.
const MAX_TEMP_ATTEMPTS: u32 = 16;

/// Distinguishes the temporary files of writes made by this process.
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

/// A store or identity failure. No variant carries a secret or file contents.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A name given on the command line or in `RAILHEAD_AGENT` is not an agent name or id.
    #[error("`{0}` is not an agent name or an agent id")]
    InvalidSelector(String),
    /// A stored file is not what the store wrote.
    #[error("{} is damaged; remove it and join again", .0.display())]
    Damaged(PathBuf),
    /// A store file or directory is open to other users.
    #[error(
        "{} is open to other users; restrict it to mode 700 for a directory or 600 for a file",
        .0.display()
    )]
    InsecurePermissions(PathBuf),
    /// A store file or directory belongs to another user.
    #[error("{} belongs to another user; the store must be yours alone", .0.display())]
    NotOwned(PathBuf),
    /// The file store cannot check ownership and permissions on this platform, so it refuses
    /// to read or write anything.
    #[error(
        "the local agent store at {} needs a Unix system; this platform cannot check who owns it or can read it",
        .0.display()
    )]
    Unsupported(PathBuf),
    /// A secret that must not be overwritten already exists.
    #[error("{} already exists and is never overwritten", .0.display())]
    AlreadyExists(PathBuf),
    /// No stored identity matches.
    #[error("no local agent named {0}; run `rh join` first")]
    NotFound(String),
    /// More identities exist than the store looks through.
    #[error("more than {MAX_IDENTITIES} local agents exist; name one with RAILHEAD_AGENT")]
    TooMany,
    /// The file system refused an operation.
    #[error("{action} {}: {source}", .path.display())]
    Io {
        /// What the store was doing.
        action: &'static str,
        /// The file or directory.
        path: PathBuf,
        /// The underlying error.
        #[source]
        source: io::Error,
    },
}

/// Result of an identity or store operation.
pub type Result<T> = std::result::Result<T, Error>;

/// An agent name: a lowercase letter, then lowercase letters, digits and dashes, at most 32.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct AgentName(String);

impl AgentName {
    /// Validates `value` as an agent name.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidSelector`] when it is not one.
    pub fn new(value: &str) -> Result<Self> {
        let mut bytes = value.bytes();
        let valid = value.len() <= MAX_AGENT_NAME_LENGTH
            && bytes.next().is_some_and(|b| b.is_ascii_lowercase())
            && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if valid {
            Ok(Self(value.to_owned()))
        } else {
            Err(Error::InvalidSelector(value.to_owned()))
        }
    }

    /// The name.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for AgentName {
    type Error = Error;

    fn try_from(value: String) -> Result<Self> {
        Self::new(&value)
    }
}

impl From<AgentName> for String {
    fn from(name: AgentName) -> Self {
        name.0
    }
}

impl fmt::Display for AgentName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// An agent id, `agt_` and 6 to 64 letters or digits, as the backend assigns it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct AgentId(String);

impl AgentId {
    /// Validates `value` as an agent id.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidSelector`] when it is not one.
    pub fn new(value: &str) -> Result<Self> {
        if is_id(IdKind::Agent, value) {
            Ok(Self(value.to_owned()))
        } else {
            Err(Error::InvalidSelector(value.to_owned()))
        }
    }

    /// The id.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for AgentId {
    type Error = Error;

    fn try_from(value: String) -> Result<Self> {
        Self::new(&value)
    }
}

impl From<AgentId> for String {
    fn from(id: AgentId) -> Self {
        id.0
    }
}

impl fmt::Display for AgentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// How the person or a clone names an agent: by its local name or by its id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentSelector {
    /// A local name, such as `atlas`.
    Name(AgentName),
    /// An agent id, such as `agt_atlas01`.
    Id(AgentId),
}

impl FromStr for AgentSelector {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        if value.starts_with(IdKind::Agent.prefix()) {
            AgentId::new(value).map(Self::Id)
        } else {
            AgentName::new(value).map(Self::Name)
        }
    }
}

impl fmt::Display for AgentSelector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Name(name) => name.fmt(f),
            Self::Id(id) => id.fmt(f),
        }
    }
}

/// One local agent: who it is and which repository it belongs to. Holds no secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    /// The local name, which is also its directory in the store.
    pub name: AgentName,
    /// The id the backend assigned at join.
    pub agent_id: AgentId,
    /// The Railhead origin it joined.
    pub origin: Origin,
    /// The repository it joined.
    pub repo: RepoRef,
}

impl Identity {
    /// True when `selector` names this identity.
    #[must_use]
    pub fn matches(&self, selector: &AgentSelector) -> bool {
        match selector {
            AgentSelector::Name(name) => &self.name == name,
            AgentSelector::Id(id) => &self.agent_id == id,
        }
    }
}

/// A secret value. Its `Debug` is redacted and it has no `Display`.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    /// Wraps a secret value.
    #[must_use]
    pub fn new(value: String) -> Self {
        Self(value)
    }

    /// The secret itself. Pass it only to the party it is meant for.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

/// A session token: three base64url segments joined by dots, at most 4096 characters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionToken(Secret);

impl SessionToken {
    /// Validates a token's shape. The value is not echoed on failure.
    #[must_use]
    pub fn new(value: String) -> Option<Self> {
        let segments_valid = value.split('.').count() == 3
            && value.split('.').all(|segment| {
                !segment.is_empty()
                    && segment
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            });
        (segments_valid && value.len() <= MAX_SESSION_TOKEN_LENGTH)
            .then(|| Self(Secret::new(value)))
    }

    /// The token, for the `Authorization` header and the credential helper only.
    #[must_use]
    pub fn expose(&self) -> &str {
        self.0.expose()
    }
}

/// A kind of secret the store keeps per agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretKind {
    /// The agent's OpenSSH private key. Written once and never replaced.
    #[allow(dead_code, reason = "the rh join entry point (#47) stores the key")]
    SigningKey,
    /// The agent's current session token.
    SessionToken,
}

impl SecretKind {
    const fn file_name(self) -> &'static str {
        match self {
            Self::SigningKey => "key",
            Self::SessionToken => "session",
        }
    }
}

/// Where an agent's secrets are kept. The file store is the default; a keychain can stand in.
#[allow(
    dead_code,
    reason = "the rh join entry point (#47) writes the key and the session"
)]
pub trait SecretStore {
    /// Reads a secret, or `None` when it was never stored.
    ///
    /// # Errors
    ///
    /// When the secret exists but cannot be read safely.
    fn read(&self, agent: &AgentName, kind: SecretKind) -> Result<Option<Secret>>;

    /// Stores a secret that must not exist yet.
    ///
    /// # Errors
    ///
    /// [`Error::AlreadyExists`] when it does, or when it cannot be written.
    fn create(&self, agent: &AgentName, kind: SecretKind, secret: &Secret) -> Result<()>;

    /// Stores a secret, replacing any earlier value atomically. A signing key is never replaced:
    /// for one, this behaves as [`SecretStore::create`].
    ///
    /// # Errors
    ///
    /// [`Error::AlreadyExists`] for a signing key that exists, or when it cannot be written.
    fn replace(&self, agent: &AgentName, kind: SecretKind, secret: &Secret) -> Result<()>;

    /// Removes a secret. Removing one that does not exist succeeds.
    ///
    /// # Errors
    ///
    /// When it exists and cannot be removed.
    fn remove(&self, agent: &AgentName, kind: SecretKind) -> Result<()>;
}

/// The file store: one directory per agent, mode 700, and files of mode 600.
///
/// Every directory from the root down is checked before the store reads or writes in it: a real
/// directory, not a link, owned by the current user. The root may be readable by others, since it
/// is often a shared config directory, but never writable; `agents/` and each agent's directory
/// must be private. An existing directory that fails is refused, never repaired. On a platform
/// without Unix ownership and modes every operation fails with [`Error::Unsupported`].
#[derive(Debug, Clone)]
pub struct FileStore {
    root: PathBuf,
}

impl FileStore {
    /// A store rooted at `home`, normally the per-user config directory's `railhead`.
    #[must_use]
    pub fn new(home: impl Into<PathBuf>) -> Self {
        Self { root: home.into() }
    }

    fn agents_dir(&self) -> PathBuf {
        self.root.join("agents")
    }

    fn agent_dir(&self, agent: &AgentName) -> PathBuf {
        self.agents_dir().join(agent.as_str())
    }

    /// Saves an identity record, replacing an earlier record of the same name.
    ///
    /// # Errors
    ///
    /// When it cannot be written.
    pub fn save_identity(&self, identity: &Identity) -> Result<()> {
        let path = self.agent_dir(&identity.name).join("identity.json");
        let json =
            serde_json::to_string_pretty(identity).map_err(|_| Error::Damaged(path.clone()))?;
        self.write_atomic(&identity.name, &path, json.as_bytes())
    }

    /// Finds the identity `selector` names.
    ///
    /// # Errors
    ///
    /// [`Error::NotFound`] when none does; an error when a record cannot be read.
    pub fn find(&self, selector: &AgentSelector) -> Result<Identity> {
        let found = match selector {
            AgentSelector::Name(name) => self.load_identity(name)?,
            AgentSelector::Id(_) => self
                .list()?
                .into_iter()
                .find(|identity| identity.matches(selector)),
        };
        found.ok_or_else(|| Error::NotFound(selector.to_string()))
    }

    /// Every stored identity, in name order.
    ///
    /// # Errors
    ///
    /// When the store cannot be read, a record is damaged, or it holds too many identities.
    pub fn list(&self) -> Result<Vec<Identity>> {
        if !self.check_dirs(None)? {
            return Ok(Vec::new());
        }
        let dir = self.agents_dir();
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(source) => return Err(io_error("reading", &dir, source)),
        };
        let mut identities = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|source| io_error("reading", &dir, source))?;
            // A directory that is not an agent name was not written by the store; skip it.
            let Some(name) = entry
                .file_name()
                .to_str()
                .and_then(|name| AgentName::new(name).ok())
            else {
                continue;
            };
            if identities.len() == MAX_IDENTITIES {
                return Err(Error::TooMany);
            }
            if let Some(identity) = self.load_identity(&name)? {
                identities.push(identity);
            }
        }
        identities.sort_by(|a, b| a.name.as_str().cmp(b.name.as_str()));
        Ok(identities)
    }

    fn load_identity(&self, name: &AgentName) -> Result<Option<Identity>> {
        if !self.check_dirs(Some(name))? {
            return Ok(None);
        }
        let path = self.agent_dir(name).join("identity.json");
        let Some(bytes) = read_private(&path)? else {
            return Ok(None);
        };
        let identity: Identity =
            serde_json::from_slice(&bytes).map_err(|_| Error::Damaged(path.clone()))?;
        if &identity.name == name {
            Ok(Some(identity))
        } else {
            Err(Error::Damaged(path))
        }
    }

    /// Checks the store's directories down to `agent`'s, or down to `agents/` without one.
    /// Returns `false` when one of them does not exist yet.
    fn check_dirs(&self, agent: Option<&AgentName>) -> Result<bool> {
        check_platform(&self.root, cfg!(unix))?;
        if !check_dir(&self.root, 0o022)? || !check_dir(&self.agents_dir(), 0o077)? {
            return Ok(false);
        }
        match agent {
            Some(agent) => check_dir(&self.agent_dir(agent), 0o077),
            None => Ok(true),
        }
    }

    fn ensure_agent_dir(&self, agent: &AgentName) -> Result<PathBuf> {
        let dir = self.agent_dir(agent);
        // An existing directory, perhaps left by an interrupted attempt, must pass its check
        // before anything is created beneath it.
        self.check_dirs(Some(agent))?;
        create_private_dir(&dir)?;
        // Another process may have changed the path meanwhile, so check it again.
        if self.check_dirs(Some(agent))? {
            Ok(dir)
        } else {
            Err(Error::Damaged(dir))
        }
    }

    fn write_atomic(&self, agent: &AgentName, path: &Path, bytes: &[u8]) -> Result<()> {
        self.stage(agent, bytes)?.publish(path)
    }

    /// Stores a secret that must not exist yet, written by `write`. The secret appears at its
    /// path complete or not at all, so a failed attempt never blocks the next one.
    fn create_with(
        &self,
        agent: &AgentName,
        kind: SecretKind,
        write: impl FnOnce(&mut File) -> io::Result<()>,
    ) -> Result<()> {
        let path = self.agent_dir(agent).join(kind.file_name());
        self.stage_with(agent, write)?.publish_new(&path)
    }

    /// Writes `bytes` to a temporary file in the agent's directory that no other write uses.
    fn stage(&self, agent: &AgentName, bytes: &[u8]) -> Result<Staged> {
        self.stage_with(agent, |file| file.write_all(bytes))
    }

    /// Stages the bytes `write` produces, as [`FileStore::stage`] does.
    fn stage_with(
        &self,
        agent: &AgentName,
        write: impl FnOnce(&mut File) -> io::Result<()>,
    ) -> Result<Staged> {
        let dir = self.ensure_agent_dir(agent)?;
        let mut attempt = 0;
        let (temp, mut file) = loop {
            let n = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let temp = dir.join(format!(".tmp-{}-{n}", std::process::id()));
            match create_private_file(&temp) {
                Ok(file) => break (temp, file),
                // A file left by an earlier process with the same id; try the next name.
                Err(Error::AlreadyExists(_)) if attempt + 1 < MAX_TEMP_ATTEMPTS => attempt += 1,
                Err(error) => return Err(error),
            }
        };
        let staged = Staged {
            dir,
            temp,
            published: false,
        };
        write(&mut file)
            .and_then(|()| file.sync_all())
            .map_err(|source| io_error("writing", &staged.temp, source))?;
        Ok(staged)
    }
}

/// A complete file written under a name only its own write uses, not yet at its destination.
/// Dropping it unpublished removes it.
#[derive(Debug)]
struct Staged {
    dir: PathBuf,
    temp: PathBuf,
    published: bool,
}

impl Staged {
    /// Renames the file over `path`, which then holds exactly the staged bytes.
    fn publish(mut self, path: &Path) -> Result<()> {
        fs::rename(&self.temp, path).map_err(|source| io_error("replacing", path, source))?;
        self.published = true;
        sync_dir(&self.dir)
    }

    /// Links the file at `path` only if nothing is there, so `path` then holds exactly the staged
    /// bytes and an existing file is never touched. The temporary name is removed on drop.
    fn publish_new(self, path: &Path) -> Result<()> {
        fs::hard_link(&self.temp, path).map_err(|source| {
            if source.kind() == io::ErrorKind::AlreadyExists {
                Error::AlreadyExists(path.to_owned())
            } else {
                io_error("creating", path, source)
            }
        })?;
        sync_dir(&self.dir)
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        if !self.published {
            // The write already failed or was abandoned; a file left behind is never read.
            let _ = fs::remove_file(&self.temp);
        }
    }
}

impl SecretStore for FileStore {
    fn read(&self, agent: &AgentName, kind: SecretKind) -> Result<Option<Secret>> {
        if !self.check_dirs(Some(agent))? {
            return Ok(None);
        }
        let path = self.agent_dir(agent).join(kind.file_name());
        let Some(bytes) = read_private(&path)? else {
            return Ok(None);
        };
        String::from_utf8(bytes)
            .map(|text| Some(Secret::new(text)))
            .map_err(|_| Error::Damaged(path))
    }

    fn create(&self, agent: &AgentName, kind: SecretKind, secret: &Secret) -> Result<()> {
        self.create_with(agent, kind, |file| {
            file.write_all(secret.expose().as_bytes())
        })
    }

    fn replace(&self, agent: &AgentName, kind: SecretKind, secret: &Secret) -> Result<()> {
        match kind {
            SecretKind::SigningKey => self.create(agent, kind, secret),
            SecretKind::SessionToken => {
                let path = self.agent_dir(agent).join(kind.file_name());
                self.write_atomic(agent, &path, secret.expose().as_bytes())
            }
        }
    }

    fn remove(&self, agent: &AgentName, kind: SecretKind) -> Result<()> {
        if !self.check_dirs(Some(agent))? {
            return Ok(());
        }
        remove_if_present(&self.agent_dir(agent).join(kind.file_name()))
    }
}

fn io_error(action: &'static str, path: &Path, source: io::Error) -> Error {
    Error::Io {
        action,
        path: path.to_owned(),
        source,
    }
}

fn remove_if_present(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(io_error("removing", path, source)),
    }
}

fn create_private_dir(dir: &Path) -> Result<()> {
    create_private_dir_with(dir, sync_dir)
}

/// Creates `dir` and its missing ancestors, top down, and passes each new directory's parent to
/// `sync_parent` before creating the next, so a new directory's name survives a crash once this
/// returns. An existing directory is left as it was.
///
/// The deepest existing directory's parent is synced again too: an earlier attempt may have
/// created that directory and stopped before syncing it. Because creation runs top down and
/// stops at a failed sync, no directory above that one can have been left unsynced.
fn create_private_dir_with(
    dir: &Path,
    mut sync_parent: impl FnMut(&Path) -> Result<()>,
) -> Result<()> {
    let mut missing = Vec::new();
    for path in dir.ancestors().filter(|path| !path.as_os_str().is_empty()) {
        match fs::symlink_metadata(path) {
            Ok(_) => {
                if let Some(parent) = path.parent() {
                    sync_parent(parent_or_current(parent))?;
                }
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => missing.push(path),
            Err(source) => return Err(io_error("reading", path, source)),
        }
    }
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    for path in missing.into_iter().rev() {
        match builder.create(path) {
            Ok(()) => {}
            // Another process created it first; its entry still needs to be durable here.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(source) => return Err(io_error("creating", path, source)),
        }
        sync_parent(path.parent().map_or(Path::new("."), parent_or_current))?;
    }
    Ok(())
}

/// `parent`, or `.` for the empty parent of a relative single-component path.
fn parent_or_current(parent: &Path) -> &Path {
    if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    }
}

/// Refuses the store at `root` unless the platform has the Unix ownership and modes its checks
/// rely on. Checking nothing would accept a store other users can read or change.
fn check_platform(root: &Path, unix: bool) -> Result<()> {
    if unix {
        Ok(())
    } else {
        Err(Error::Unsupported(root.to_owned()))
    }
}

/// Checks a store directory: a real directory, not a link, owned by the current user, with none
/// of the `forbidden` mode bits. Returns `false` when it does not exist.
fn check_dir(dir: &Path, forbidden: u32) -> Result<bool> {
    let metadata = match fs::symlink_metadata(dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(source) => return Err(io_error("reading", dir, source)),
    };
    if !metadata.is_dir() {
        return Err(Error::Damaged(dir.to_owned()));
    }
    check_owner(dir, &metadata, forbidden)?;
    Ok(true)
}

/// Refuses a store entry another user owns, or one with any of the `forbidden` mode bits.
fn check_owner(path: &Path, metadata: &fs::Metadata, forbidden: u32) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        if metadata.uid() != rustix::process::geteuid().as_raw() {
            return Err(Error::NotOwned(path.to_owned()));
        }
        if metadata.mode() & forbidden != 0 {
            return Err(Error::InsecurePermissions(path.to_owned()));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = (metadata, forbidden);
        Err(Error::Unsupported(path.to_owned()))
    }
}

/// Makes a rename or link in `dir` survive a crash.
fn sync_dir(dir: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(dir)
        .and_then(|dir| dir.sync_all())
        .map_err(|source| io_error("syncing", dir, source))?;
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

fn create_private_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path).map_err(|source| {
        if source.kind() == io::ErrorKind::AlreadyExists {
            Error::AlreadyExists(path.to_owned())
        } else {
            io_error("creating", path, source)
        }
    })
}

/// Reads a store file, refusing a link, an oversized file, and one another user owns or can read.
///
/// The path is checked without following a link, then every check is repeated on the opened
/// handle, so a path swapped for a link between the two is refused rather than followed.
fn read_private(path: &Path) -> Result<Option<Vec<u8>>> {
    let checked = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(io_error("reading", path, source)),
    };
    if !checked.is_file() {
        return Err(Error::Damaged(path.to_owned()));
    }
    let file = File::open(path).map_err(|source| io_error("reading", path, source))?;
    check_opened(path, &checked, &file)?;
    let mut bytes = Vec::new();
    file.take(MAX_STORED_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|source| io_error("reading", path, source))?;
    Ok(Some(bytes))
}

/// Checks the file a handle actually opened: the one checked at `path`, regular, small, owned by
/// the current user and private.
fn check_opened(path: &Path, checked: &fs::Metadata, file: &File) -> Result<()> {
    let opened = file
        .metadata()
        .map_err(|source| io_error("reading", path, source))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        if (opened.dev(), opened.ino()) != (checked.dev(), checked.ino()) {
            return Err(Error::Damaged(path.to_owned()));
        }
    }
    #[cfg(not(unix))]
    let _ = checked;
    if !opened.is_file() || opened.len() > MAX_STORED_BYTES {
        return Err(Error::Damaged(path.to_owned()));
    }
    check_owner(path, &opened, 0o077)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhZ3RfYXRsYXMwMSJ9.c2lnbmF0dXJl";

    fn identity(name: &str, id: &str) -> anyhow::Result<Identity> {
        Ok(Identity {
            name: AgentName::new(name)?,
            agent_id: AgentId::new(id)?,
            origin: "https://railhead.dev".parse()?,
            repo: "casqueblanc/demo".parse()?,
        })
    }

    #[test]
    fn selectors_tell_names_from_ids() -> anyhow::Result<()> {
        assert_eq!(
            "atlas".parse::<AgentSelector>()?,
            AgentSelector::Name(AgentName::new("atlas")?)
        );
        assert_eq!(
            "agt_atlas01".parse::<AgentSelector>()?,
            AgentSelector::Id(AgentId::new("agt_atlas01")?)
        );
        let longest = "a".repeat(MAX_AGENT_NAME_LENGTH);
        assert!(longest.parse::<AgentSelector>().is_ok());
        for bad in [
            "",
            "Atlas",
            "1atlas",
            "atlas!",
            "agt_x",
            "../etc",
            &format!("{longest}a"),
        ] {
            assert!(
                bad.parse::<AgentSelector>().is_err(),
                "{bad:?} was accepted"
            );
        }
        Ok(())
    }

    #[test]
    fn session_tokens_are_shaped_and_never_printed() {
        let token = SessionToken::new(TOKEN.to_owned());
        assert_eq!(token.as_ref().map(SessionToken::expose), Some(TOKEN));
        assert!(!format!("{token:?}").contains("eyJ"));
        for bad in ["", "a.b", "a.b.c.d", "a..c", "a.b.c\n", "a b.c.d"] {
            assert!(
                SessionToken::new(bad.to_owned()).is_none(),
                "{bad:?} was accepted"
            );
        }
        let at_limit = format!("a.b.{}", "c".repeat(MAX_SESSION_TOKEN_LENGTH - 4));
        assert!(SessionToken::new(at_limit.clone()).is_some());
        assert!(SessionToken::new(format!("{at_limit}c")).is_none());
    }

    #[test]
    fn identities_round_trip_and_are_found_by_name_or_id() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        assert_eq!(store.list()?, Vec::new());
        let atlas = identity("atlas", "agt_atlas01")?;
        let boreas = identity("boreas", "agt_boreas01")?;
        store.save_identity(&boreas)?;
        store.save_identity(&atlas)?;
        assert_eq!(store.list()?, vec![atlas.clone(), boreas.clone()]);
        assert_eq!(store.find(&"agt_boreas01".parse()?)?, boreas);
        assert_eq!(store.find(&"atlas".parse()?)?, atlas);
        let missing = store.find(&"agt_nobody01".parse()?).err();
        assert!(matches!(missing, Some(Error::NotFound(_))));
        Ok(())
    }

    #[test]
    fn a_record_under_the_wrong_name_is_damaged() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        store.save_identity(&identity("atlas", "agt_atlas01")?)?;
        fs::rename(
            home.path().join("agents/atlas"),
            home.path().join("agents/boreas"),
        )?;
        let error = store.find(&"boreas".parse()?).err();
        assert!(matches!(error, Some(Error::Damaged(_))));
        Ok(())
    }

    #[test]
    fn a_signing_key_is_never_overwritten() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = AgentName::new("atlas")?;
        let first = Secret::new("first key".to_owned());
        store.create(&atlas, SecretKind::SigningKey, &first)?;
        let second = store.create(
            &atlas,
            SecretKind::SigningKey,
            &Secret::new("second".to_owned()),
        );
        assert!(matches!(second, Err(Error::AlreadyExists(_))));
        assert_eq!(store.read(&atlas, SecretKind::SigningKey)?, Some(first));
        Ok(())
    }

    #[test]
    fn replacing_a_signing_key_keeps_the_original() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = AgentName::new("atlas")?;
        let first = Secret::new("first key".to_owned());
        store.replace(&atlas, SecretKind::SigningKey, &first)?;
        let second = store.replace(
            &atlas,
            SecretKind::SigningKey,
            &Secret::new("second".to_owned()),
        );
        assert!(matches!(second, Err(Error::AlreadyExists(_))));
        assert_eq!(
            fs::read(home.path().join("agents/atlas/key"))?,
            b"first key"
        );
        Ok(())
    }

    /// The files in atlas's directory, in name order.
    fn atlas_files(home: &Path) -> anyhow::Result<Vec<String>> {
        let mut names = fs::read_dir(home.join("agents/atlas"))?
            .map(|entry| Ok(entry?.file_name().to_string_lossy().into_owned()))
            .collect::<anyhow::Result<Vec<_>>>()?;
        names.sort();
        Ok(names)
    }

    #[test]
    fn interleaved_writes_publish_only_their_own_bytes() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = AgentName::new("atlas")?;
        let dir = home.path().join("agents/atlas");

        // An identity write and a session write, both staged before either is published.
        let record = store.stage(&atlas, b"identity record")?;
        let session = store.stage(&atlas, b"session one")?;
        record.publish(&dir.join("identity.json"))?;
        assert_eq!(fs::read(dir.join("identity.json"))?, b"identity record");
        assert!(!dir.join("session").exists());
        session.publish(&dir.join("session"))?;
        assert_eq!(fs::read(dir.join("identity.json"))?, b"identity record");
        assert_eq!(fs::read(dir.join("session"))?, b"session one");

        // Two session replacements: a staged one is invisible until published, and each
        // publication is one whole value.
        let two = store.stage(&atlas, b"session two")?;
        let three = store.stage(&atlas, b"session three")?;
        assert_eq!(fs::read(dir.join("session"))?, b"session one");
        three.publish(&dir.join("session"))?;
        assert_eq!(fs::read(dir.join("session"))?, b"session three");
        two.publish(&dir.join("session"))?;
        assert_eq!(fs::read(dir.join("session"))?, b"session two");

        // An abandoned write leaves its destination alone and removes its file.
        drop(store.stage(&atlas, b"never published")?);
        assert_eq!(fs::read(dir.join("session"))?, b"session two");
        assert_eq!(atlas_files(home.path())?, ["identity.json", "session"]);
        Ok(())
    }

    #[test]
    fn a_leftover_temporary_file_is_neither_reused_nor_published() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = AgentName::new("atlas")?;
        let dir = home.path().join("agents/atlas");
        create_private_dir(&dir)?;
        let next = NEXT_TEMP.load(Ordering::Relaxed);
        // Fewer leftovers than attempts, at the names this process takes next; concurrent tests can
        // only move the counter past them.
        let leftovers: Vec<String> = (next..next + 3)
            .map(|n| format!(".tmp-{}-{n}", std::process::id()))
            .collect();
        for name in &leftovers {
            fs::write(dir.join(name), b"stale")?;
        }
        store.replace(
            &atlas,
            SecretKind::SessionToken,
            &Secret::new("fresh".to_owned()),
        )?;
        assert_eq!(fs::read(dir.join("session"))?, b"fresh");
        for name in &leftovers {
            assert_eq!(fs::read(dir.join(name))?, b"stale");
        }
        Ok(())
    }

    #[test]
    fn session_tokens_are_replaced_and_removed() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = AgentName::new("atlas")?;
        assert_eq!(store.read(&atlas, SecretKind::SessionToken)?, None);
        store.remove(&atlas, SecretKind::SessionToken)?;
        store.replace(
            &atlas,
            SecretKind::SessionToken,
            &Secret::new("one".to_owned()),
        )?;
        store.replace(
            &atlas,
            SecretKind::SessionToken,
            &Secret::new("two".to_owned()),
        )?;
        let read = store.read(&atlas, SecretKind::SessionToken)?;
        assert_eq!(read.as_ref().map(Secret::expose), Some("two"));
        store.remove(&atlas, SecretKind::SessionToken)?;
        assert_eq!(store.read(&atlas, SecretKind::SessionToken)?, None);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn secrets_are_private_and_a_readable_one_is_refused() -> anyhow::Result<()> {
        use std::os::unix::fs::PermissionsExt as _;

        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = AgentName::new("atlas")?;
        store.create(
            &atlas,
            SecretKind::SigningKey,
            &Secret::new("key".to_owned()),
        )?;
        let path = home.path().join("agents/atlas/key");
        assert_eq!(fs::metadata(&path)?.permissions().mode() & 0o777, 0o600);
        let dir = home.path().join("agents/atlas");
        assert_eq!(fs::metadata(&dir)?.permissions().mode() & 0o777, 0o700);

        fs::set_permissions(&path, fs::Permissions::from_mode(0o644))?;
        let error = store.read(&atlas, SecretKind::SigningKey).err();
        assert!(matches!(error, Some(Error::InsecurePermissions(_))));
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_secret_is_refused() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = AgentName::new("atlas")?;
        store.replace(
            &atlas,
            SecretKind::SessionToken,
            &Secret::new("one".to_owned()),
        )?;
        let path = home.path().join("agents/atlas/key");
        std::os::unix::fs::symlink(home.path().join("agents/atlas/session"), &path)?;
        let error = store.read(&atlas, SecretKind::SigningKey).err();
        assert!(matches!(error, Some(Error::Damaged(_))));
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn a_path_swapped_for_a_link_after_the_check_is_refused() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = AgentName::new("atlas")?;
        let key = Secret::new("key".to_owned());
        store.create(&atlas, SecretKind::SigningKey, &key)?;
        store.replace(&atlas, SecretKind::SessionToken, &key)?;
        let path = home.path().join("agents/atlas/key");
        let checked = fs::symlink_metadata(&path)?;
        fs::remove_file(&path)?;
        std::os::unix::fs::symlink(home.path().join("agents/atlas/session"), &path)?;
        let opened = File::open(&path)?;
        let error = check_opened(&path, &checked, &opened).err();
        assert!(matches!(error, Some(Error::Damaged(_))));

        let unchanged = home.path().join("agents/atlas/session");
        let checked = fs::symlink_metadata(&unchanged)?;
        check_opened(&unchanged, &checked, &File::open(&unchanged)?)?;
        Ok(())
    }

    #[test]
    fn a_failed_key_write_leaves_no_key_and_a_retry_succeeds() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = AgentName::new("atlas")?;
        let dir = home.path().join("agents/atlas");

        // A write that runs out of space halfway through.
        let failed = store.create_with(&atlas, SecretKind::SigningKey, |file| {
            file.write_all(b"half a k")?;
            Err(io::Error::other("no space left on device"))
        });
        assert!(matches!(failed, Err(Error::Io { .. })));
        assert_eq!(store.read(&atlas, SecretKind::SigningKey)?, None);
        assert_eq!(atlas_files(home.path())?, Vec::<String>::new());

        // A process killed mid-write leaves only a temporary file, which is never read as the key.
        fs::write(dir.join(".tmp-999999-0"), b"half a k")?;
        assert_eq!(store.read(&atlas, SecretKind::SigningKey)?, None);

        let key = Secret::new("whole key".to_owned());
        store.create(&atlas, SecretKind::SigningKey, &key)?;
        assert_eq!(store.read(&atlas, SecretKind::SigningKey)?, Some(key));
        assert_eq!(atlas_files(home.path())?, [".tmp-999999-0", "key"]);
        Ok(())
    }

    #[test]
    fn a_failed_key_publication_leaves_no_key_and_a_retry_succeeds() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = AgentName::new("atlas")?;
        let dir = home.path().join("agents/atlas");

        let staged = store.stage(&atlas, b"whole key")?;
        let failed = staged.publish_new(&dir.join("missing/key"));
        assert!(matches!(failed, Err(Error::Io { .. })));
        assert_eq!(store.read(&atlas, SecretKind::SigningKey)?, None);
        assert_eq!(atlas_files(home.path())?, Vec::<String>::new());

        let key = Secret::new("whole key".to_owned());
        store.replace(&atlas, SecretKind::SigningKey, &key)?;
        assert_eq!(store.read(&atlas, SecretKind::SigningKey)?, Some(key));
        Ok(())
    }

    #[test]
    fn a_refused_key_leaves_the_existing_one_and_no_temporary_file() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = AgentName::new("atlas")?;
        let first = Secret::new("first key".to_owned());
        store.create(&atlas, SecretKind::SigningKey, &first)?;
        let refused = store.create(
            &atlas,
            SecretKind::SigningKey,
            &Secret::new("second key, longer".to_owned()),
        );
        assert!(matches!(refused, Err(Error::AlreadyExists(_))));
        assert_eq!(store.read(&atlas, SecretKind::SigningKey)?, Some(first));
        assert_eq!(atlas_files(home.path())?, ["key"]);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn an_existing_agent_directory_open_to_others_is_refused() -> anyhow::Result<()> {
        use std::os::unix::fs::PermissionsExt as _;

        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = AgentName::new("atlas")?;
        let dir = home.path().join("agents/atlas");
        create_private_dir(&dir)?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o777))?;

        let key = Secret::new("key".to_owned());
        let created = store.create(&atlas, SecretKind::SigningKey, &key);
        assert!(matches!(created, Err(Error::InsecurePermissions(path)) if path == dir));
        let saved = store.save_identity(&identity("atlas", "agt_atlas01")?);
        assert!(matches!(saved, Err(Error::InsecurePermissions(_))));
        assert_eq!(atlas_files(home.path())?, Vec::<String>::new());

        // A record planted while the directory was open is not selected.
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
        store.save_identity(&identity("atlas", "agt_atlas01")?)?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o730))?;
        let found = store.find(&"atlas".parse()?).err();
        assert!(matches!(found, Some(Error::InsecurePermissions(_))));
        let listed = store.list().err();
        assert!(matches!(listed, Some(Error::InsecurePermissions(_))));
        let read = store.read(&atlas, SecretKind::SessionToken).err();
        assert!(matches!(read, Some(Error::InsecurePermissions(_))));
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn a_root_others_can_read_is_accepted_but_one_they_can_write_is_refused() -> anyhow::Result<()>
    {
        use std::os::unix::fs::PermissionsExt as _;

        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = identity("atlas", "agt_atlas01")?;
        fs::set_permissions(home.path(), fs::Permissions::from_mode(0o755))?;
        store.save_identity(&atlas)?;
        assert_eq!(store.list()?, vec![atlas]);

        fs::set_permissions(home.path(), fs::Permissions::from_mode(0o775))?;
        let listed = store.list().err();
        assert!(matches!(listed, Some(Error::InsecurePermissions(path)) if path == home.path()));
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_store_directory_is_refused() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let elsewhere = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = AgentName::new("atlas")?;
        std::os::unix::fs::symlink(elsewhere.path(), home.path().join("agents"))?;

        let key = Secret::new("key".to_owned());
        let created = store.create(&atlas, SecretKind::SigningKey, &key);
        assert!(matches!(created, Err(Error::Damaged(_))));
        // The link is refused before anything is created through it.
        assert_eq!(fs::read_dir(elsewhere.path())?.count(), 0);
        assert!(matches!(store.list(), Err(Error::Damaged(_))));
        assert!(matches!(
            store.read(&atlas, SecretKind::SigningKey),
            Err(Error::Damaged(_))
        ));
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn a_store_another_user_owns_is_refused() {
        // `/` belongs to root and others cannot write it, so only its owner can fail the check.
        let store = FileStore::new("/");
        let listed = store.list();
        if rustix::process::geteuid().is_root() {
            assert!(listed.is_ok());
        } else {
            assert!(matches!(listed, Err(Error::NotOwned(path)) if path == Path::new("/")));
        }
    }

    /// Creates `dir` as the store does, recording every directory it syncs.
    fn create_recording_syncs(dir: &Path) -> (Result<()>, Vec<PathBuf>) {
        let mut synced = Vec::new();
        let created = create_private_dir_with(dir, |parent| {
            synced.push(parent.to_owned());
            sync_dir(parent)
        });
        (created, synced)
    }

    #[test]
    fn a_new_store_syncs_every_parent_that_gained_a_directory() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let root = home.path().join("railhead");
        let dir = root.join("agents/atlas");
        let (created, synced) = create_recording_syncs(&dir);
        created?;
        let outer = home.path().parent().map(Path::to_owned);
        let expected: Vec<PathBuf> = outer
            .into_iter()
            .chain([home.path().to_owned(), root.clone(), root.join("agents")])
            .collect();
        assert_eq!(synced, expected);
        assert!(dir.is_dir());

        // The store's first secret write goes through the same creation.
        let store = FileStore::new(home.path().join("fresh"));
        let key = Secret::new("key".to_owned());
        store.create(&AgentName::new("atlas")?, SecretKind::SigningKey, &key)?;
        assert_eq!(
            fs::read(home.path().join("fresh/agents/atlas/key"))?,
            b"key"
        );
        Ok(())
    }

    #[test]
    fn an_existing_directory_has_only_its_own_entry_synced_again() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        create_private_dir(&home.path().join("agents/atlas"))?;
        let (created, synced) = create_recording_syncs(&home.path().join("agents/boreas"));
        created?;
        assert_eq!(synced, [home.path().to_owned(), home.path().join("agents")]);

        let (created, synced) = create_recording_syncs(&home.path().join("agents/boreas"));
        created?;
        assert_eq!(synced, [home.path().join("agents")]);
        Ok(())
    }

    #[test]
    fn a_retry_after_a_failed_parent_sync_syncs_that_parent_before_going_on() -> anyhow::Result<()>
    {
        let home = tempfile::tempdir()?;
        let root = home.path().join("railhead");
        let dir = root.join("agents/atlas");
        // The first attempt creates the root, then fails to make its name durable.
        let failed = create_private_dir_with(&dir, |parent| {
            if parent == home.path() {
                Err(io_error("syncing", parent, io::ErrorKind::Other.into()))
            } else {
                Ok(())
            }
        });
        assert!(
            matches!(failed, Err(Error::Io { action: "syncing", path, .. }) if path == home.path())
        );
        assert!(root.is_dir() && !root.join("agents").exists());

        let (created, synced) = create_recording_syncs(&dir);
        created?;
        assert_eq!(
            synced,
            [home.path().to_owned(), root.clone(), root.join("agents")]
        );

        // A retry whose repeated sync fails again reports it and creates nothing beneath.
        let fresh = home.path().join("fresh");
        create_private_dir_with(&fresh, |_| Ok(()))?;
        let refused = create_private_dir_with(&fresh.join("agents"), |parent| {
            Err(io_error("syncing", parent, io::ErrorKind::Other.into()))
        });
        assert!(
            matches!(refused, Err(Error::Io { action: "syncing", path, .. }) if path == home.path())
        );
        assert!(!fresh.join("agents").exists());
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn a_store_left_by_an_interrupted_attempt_is_checked_then_reused() -> anyhow::Result<()> {
        use std::os::unix::fs::PermissionsExt as _;

        let home = tempfile::tempdir()?;
        let root = home.path().join("railhead");
        let store = FileStore::new(&root);
        let atlas = AgentName::new("atlas")?;
        let key = Secret::new("key".to_owned());

        // The attempt stopped after creating the root and `agents/`.
        create_private_dir(&root.join("agents"))?;
        store.create(&atlas, SecretKind::SigningKey, &key)?;
        assert_eq!(fs::read(root.join("agents/atlas/key"))?, b"key");

        // A leftover directory that others can open is refused before anything is made in it.
        let boreas = AgentName::new("boreas")?;
        fs::set_permissions(root.join("agents"), fs::Permissions::from_mode(0o777))?;
        let refused = store.create(&boreas, SecretKind::SigningKey, &key);
        assert!(
            matches!(refused, Err(Error::InsecurePermissions(path)) if path == root.join("agents"))
        );
        assert!(!root.join("agents/boreas").exists());

        // Restored to private, the same directory is reused.
        fs::set_permissions(root.join("agents"), fs::Permissions::from_mode(0o700))?;
        store.create(&boreas, SecretKind::SigningKey, &key)?;
        assert_eq!(fs::read(root.join("agents/boreas/key"))?, b"key");
        Ok(())
    }

    #[test]
    fn a_platform_without_unix_checks_is_refused() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        assert!(check_platform(home.path(), true).is_ok());
        let refused = check_platform(home.path(), false);
        assert!(matches!(refused, Err(Error::Unsupported(path)) if path == home.path()));
        Ok(())
    }

    #[cfg(not(unix))]
    #[test]
    fn the_store_refuses_every_operation_off_unix() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = AgentName::new("atlas")?;
        let key = Secret::new("key".to_owned());
        let created = store.create(&atlas, SecretKind::SigningKey, &key);
        assert!(matches!(created, Err(Error::Unsupported(_))));
        assert!(matches!(store.list(), Err(Error::Unsupported(_))));
        assert!(matches!(
            store.read(&atlas, SecretKind::SigningKey),
            Err(Error::Unsupported(_))
        ));
        assert_eq!(fs::read_dir(home.path())?.count(), 0);
        Ok(())
    }

    #[test]
    fn a_failed_parent_sync_stops_creation_and_is_reported() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let root = home.path().join("railhead");
        let mut calls = 0;
        let created = create_private_dir_with(&root.join("agents/atlas"), |parent| {
            calls += 1;
            if parent == home.path() {
                Err(io_error("syncing", parent, io::ErrorKind::Other.into()))
            } else {
                Ok(())
            }
        });
        assert!(
            matches!(created, Err(Error::Io { action: "syncing", path, .. }) if path == home.path())
        );
        // The temporary directory's own entry, then the root's, which fails.
        assert_eq!(calls, 2);
        assert!(root.is_dir() && !root.join("agents").exists());

        // The last directory's sync failing is reported too, not taken as durable.
        let mut later_calls = 0;
        let failed = create_private_dir_with(&root.join("agents/atlas"), |parent| {
            later_calls += 1;
            if parent == root.join("agents") {
                Err(io_error("syncing", parent, io::ErrorKind::Other.into()))
            } else {
                Ok(())
            }
        });
        assert!(
            matches!(failed, Err(Error::Io { action: "syncing", path, .. }) if path == root.join("agents"))
        );
        // The root's entry again, then the new `agents/`, then `atlas`, which fails.
        assert_eq!(later_calls, 3);
        Ok(())
    }

    #[test]
    fn a_directory_that_cannot_be_created_is_reported() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        fs::write(home.path().join("agents"), b"not a directory")?;
        let (created, synced) = create_recording_syncs(&home.path().join("agents/atlas"));
        assert!(matches!(
            created,
            Err(Error::Io {
                action: "reading",
                ..
            })
        ));
        assert_eq!(synced, Vec::<PathBuf>::new());
        Ok(())
    }

    #[test]
    fn secrets_never_reach_debug_output() {
        let secret = Secret::new(TOKEN.to_owned());
        assert_eq!(format!("{secret:?}"), "Secret(<redacted>)");
    }
}
