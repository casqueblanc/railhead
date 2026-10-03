//! Local agent identities and the store that keeps their keys and session tokens.
//!
//! Each identity lives under `<home>/agents/<name>/`: `identity.json` names the agent and the
//! repository it joined, `key` holds its OpenSSH private key and `session` its current session
//! record. While `rh join` has an enrollment it has not finished, `enrollment.json` holds its
//! scope. The two secrets go through [`SecretStore`], so a system keychain can replace the file
//! store without touching the commands. Secrets never reach `Debug`, `Display` or an error.
//!
//! The session is stored with the identity it was issued to and its expiry, so a session is never
//! used for another identity or after it lapses. Processes that act on one agent at once take a
//! [`StoreLock`]: one `rh join` enrolls a name at a time, and a session is compared, renewed and
//! replaced or removed under one lock.

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

/// The file that holds an agent's unfinished enrollment.
const ENROLLMENT_FILE: &str = "enrollment.json";

/// Distinguishes the temporary files of writes made by this process.
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

/// How long before its expiry a stored session stops being used, in milliseconds, so a request
/// made with it does not reach the backend after it lapsed.
pub const SESSION_EXPIRY_SKEW_MS: u64 = 30_000;

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

/// Milliseconds since the Unix epoch. A clock before the epoch reads as the end of time, so no
/// stored session counts as current.
#[must_use]
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok())
        .unwrap_or(u64::MAX)
}

/// A session as stored: the token, the identity it was issued to and when it expires.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    /// The agent the token authenticates.
    pub agent_id: AgentId,
    /// The origin that issued it.
    pub origin: Origin,
    /// The repository it is bound to.
    pub repo: RepoRef,
    /// The token.
    pub token: SessionToken,
    /// When it expires, in milliseconds since the Unix epoch.
    pub expires_at_ms: u64,
}

/// The stored form of a [`Session`].
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionRecord {
    agent_id: AgentId,
    origin: Origin,
    repo: RepoRef,
    token: String,
    expires_at: u64,
}

impl Session {
    /// A session issued to `identity`, expiring at `expires_at_ms`.
    #[must_use]
    pub fn new(identity: &Identity, token: SessionToken, expires_at_ms: u64) -> Self {
        Self {
            agent_id: identity.agent_id.clone(),
            origin: identity.origin.clone(),
            repo: identity.repo.clone(),
            token,
            expires_at_ms,
        }
    }

    /// True when the session was issued to `identity`: its agent, origin and repository.
    #[must_use]
    pub fn issued_to(&self, identity: &Identity) -> bool {
        self.agent_id == identity.agent_id
            && self.origin == identity.origin
            && self.repo == identity.repo
    }

    /// True when the session was issued to `identity` and is still valid at `now_ms`, with
    /// [`SESSION_EXPIRY_SKEW_MS`] to spare.
    #[must_use]
    pub fn usable_for(&self, identity: &Identity, now_ms: u64) -> bool {
        self.issued_to(identity)
            && now_ms.saturating_add(SESSION_EXPIRY_SKEW_MS) < self.expires_at_ms
    }

    fn to_secret(&self) -> Option<Secret> {
        serde_json::to_string(&SessionRecord {
            agent_id: self.agent_id.clone(),
            origin: self.origin.clone(),
            repo: self.repo.clone(),
            token: self.token.expose().to_owned(),
            expires_at: self.expires_at_ms,
        })
        .ok()
        .map(Secret::new)
    }

    /// The session a stored secret holds, or `None` when it is not a session record.
    fn from_secret(secret: &Secret) -> Option<Self> {
        let record: SessionRecord = serde_json::from_str(secret.expose()).ok()?;
        Some(Self {
            agent_id: record.agent_id,
            origin: record.origin,
            repo: record.repo,
            token: SessionToken::new(record.token)?,
            expires_at_ms: record.expires_at,
        })
    }
}

/// The scope of an enrollment `rh join` has started and not finished: stored before its first
/// request and removed once it logs in or the backend refuses it, so a name enrolls one invite
/// at a time even across a lost response or a killed process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingEnrollment {
    /// The Railhead origin the invite names.
    pub origin: Origin,
    /// The repository the invite names.
    pub repo: RepoRef,
    /// The invite.
    pub invite_id: String,
    /// The OpenSSH public key the join registers.
    pub public_key: String,
}

impl PendingEnrollment {
    /// True when this is the enrollment of `invite_id` for `repo` on `origin`.
    #[must_use]
    pub fn is_for(&self, origin: &Origin, repo: &RepoRef, invite_id: &str) -> bool {
        &self.origin == origin && &self.repo == repo && self.invite_id == invite_id
    }
}

/// What a [`StoreLock`] serializes for one agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockKind {
    /// An enrollment: held by `rh join` from reading the identity to storing the session.
    Enrollment,
    /// The session: held while a session is compared, replaced or removed, and across the login
    /// that renews it.
    Session,
}

impl LockKind {
    const fn file_name(self) -> &'static str {
        match self {
            Self::Enrollment => ".enrollment.lock",
            Self::Session => ".session.lock",
        }
    }
}

/// A lock on one agent in the store, held until it is dropped. Locks are advisory: they
/// serialize the `rh` processes that take them.
#[must_use]
#[derive(Debug)]
pub struct StoreLock {
    _file: File,
}

/// The session lock on one agent, with the reads and writes made while it is held.
#[must_use]
#[derive(Debug)]
pub struct SessionLock<'a> {
    store: &'a FileStore,
    agent: AgentName,
    _lock: StoreLock,
}

impl SessionLock<'_> {
    /// The stored session, as [`FileStore::load_session`] reads it.
    ///
    /// # Errors
    ///
    /// When it exists and cannot be read safely.
    pub fn load(&self) -> Result<Option<Session>> {
        self.store.load_session(&self.agent)
    }

    /// Stores `session`, replacing any earlier one.
    ///
    /// # Errors
    ///
    /// When it cannot be written.
    pub fn save(&self, session: &Session) -> Result<()> {
        let path = self
            .store
            .agent_dir(&self.agent)
            .join(SecretKind::SessionToken.file_name());
        let secret = session.to_secret().ok_or(Error::Damaged(path))?;
        self.store
            .replace(&self.agent, SecretKind::SessionToken, &secret)
    }
}

/// A kind of secret the store keeps per agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretKind {
    /// The agent's OpenSSH private key. Written once and never replaced.
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

    /// Takes the `kind` lock on `agent`, or returns `None` when another process holds it.
    ///
    /// # Errors
    ///
    /// When the lock file cannot be opened or locked.
    pub fn try_lock(&self, agent: &AgentName, kind: LockKind) -> Result<Option<StoreLock>> {
        let (path, file) = self.lock_file(agent, kind)?;
        match file.try_lock() {
            Ok(()) => Ok(Some(StoreLock { _file: file })),
            Err(fs::TryLockError::WouldBlock) => Ok(None),
            Err(fs::TryLockError::Error(source)) => Err(io_error("locking", &path, source)),
        }
    }

    /// Takes the `kind` lock on `agent`, waiting for another process to release it. Only for
    /// locks whose holders bound any network work by the request timeout, so the wait stays short.
    fn lock(&self, agent: &AgentName, kind: LockKind) -> Result<StoreLock> {
        let (path, file) = self.lock_file(agent, kind)?;
        file.lock()
            .map_err(|source| io_error("locking", &path, source))?;
        Ok(StoreLock { _file: file })
    }

    fn lock_file(&self, agent: &AgentName, kind: LockKind) -> Result<(PathBuf, File)> {
        let path = self.ensure_agent_dir(agent)?.join(kind.file_name());
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let file = options
            .open(&path)
            .map_err(|source| io_error("opening", &path, source))?;
        Ok((path, file))
    }

    /// The session stored for `agent`, or `None` when there is none or it is not a session record.
    ///
    /// # Errors
    ///
    /// When it exists and cannot be read safely.
    pub fn load_session(&self, agent: &AgentName) -> Result<Option<Session>> {
        Ok(self
            .read(agent, SecretKind::SessionToken)?
            .as_ref()
            .and_then(Session::from_secret))
    }

    /// Stores `session` for `agent`, replacing any earlier one, under the session lock.
    ///
    /// # Errors
    ///
    /// When it cannot be written.
    pub fn save_session(&self, agent: &AgentName, session: &Session) -> Result<()> {
        self.lock_session(agent)?.save(session)
    }

    /// Takes the session lock on `agent`, waiting while another process compares, replaces or
    /// renews the session.
    ///
    /// # Errors
    ///
    /// When the lock file cannot be opened or locked.
    pub fn lock_session(&self, agent: &AgentName) -> Result<SessionLock<'_>> {
        Ok(SessionLock {
            store: self,
            agent: agent.clone(),
            _lock: self.lock(agent, LockKind::Session)?,
        })
    }

    /// The enrollment `rh join` started for `agent` and has not finished, if any.
    ///
    /// # Errors
    ///
    /// When it exists and cannot be read safely or is not an enrollment record.
    pub fn load_enrollment(&self, agent: &AgentName) -> Result<Option<PendingEnrollment>> {
        if !self.check_dirs(Some(agent))? {
            return Ok(None);
        }
        let path = self.agent_dir(agent).join(ENROLLMENT_FILE);
        let Some(bytes) = read_private(&path)? else {
            return Ok(None);
        };
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| Error::Damaged(path))
    }

    /// Stores the enrollment `rh join` is about to start for `agent`, replacing any earlier one.
    ///
    /// # Errors
    ///
    /// When it cannot be written.
    pub fn save_enrollment(&self, agent: &AgentName, enrollment: &PendingEnrollment) -> Result<()> {
        let path = self.agent_dir(agent).join(ENROLLMENT_FILE);
        let json =
            serde_json::to_string_pretty(enrollment).map_err(|_| Error::Damaged(path.clone()))?;
        self.write_atomic(agent, &path, json.as_bytes())
    }

    /// Removes the enrollment stored for `agent`. Removing none succeeds.
    ///
    /// # Errors
    ///
    /// When it exists and cannot be removed.
    pub fn remove_enrollment(&self, agent: &AgentName) -> Result<()> {
        if !self.check_dirs(Some(agent))? {
            return Ok(());
        }
        remove_if_present(&self.agent_dir(agent).join(ENROLLMENT_FILE))
    }

    /// Removes the session stored for `agent` only when its token is `token`, comparing and
    /// removing under the session lock so a session stored meanwhile is kept. Returns whether it
    /// removed one.
    ///
    /// # Errors
    ///
    /// When the session cannot be read or removed.
    pub fn remove_session_if(&self, agent: &AgentName, token: &str) -> Result<bool> {
        let lock = self.lock_session(agent)?;
        let stored = lock.load()?;
        if stored.is_some_and(|session| session.token.expose() == token) {
            self.remove(agent, SecretKind::SessionToken)?;
            Ok(true)
        } else {
            Ok(false)
        }
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
            settled: false,
        };
        write(&mut file)
            .and_then(|()| file.sync_all())
            .map_err(|source| io_error("writing", &staged.temp, source))?;
        Ok(staged)
    }

    /// Removes `kind`'s file, then passes the agent's directory to `sync` so the removal survives
    /// a crash. The directory is synced when the file is already gone too: an earlier attempt may
    /// have removed it and stopped before its sync.
    fn remove_with(
        &self,
        agent: &AgentName,
        kind: SecretKind,
        sync: impl FnOnce(&Path) -> Result<()>,
    ) -> Result<()> {
        if !self.check_dirs(Some(agent))? {
            return Ok(());
        }
        let dir = self.agent_dir(agent);
        remove_if_present(&dir.join(kind.file_name()))?;
        sync(&dir)
    }
}

/// A complete file written under a name only its own write uses, not yet at its destination.
/// Dropping it unsettled removes it.
#[derive(Debug)]
struct Staged {
    dir: PathBuf,
    temp: PathBuf,
    /// Whether the temporary name is gone, renamed to its destination or removed.
    settled: bool,
}

impl Staged {
    /// Renames the file over `path`, which then holds exactly the staged bytes.
    fn publish(mut self, path: &Path) -> Result<()> {
        fs::rename(&self.temp, path).map_err(|source| io_error("replacing", path, source))?;
        self.settled = true;
        sync_dir(&self.dir)
    }

    /// Links the file at `path` only if nothing is there, so `path` then holds exactly the staged
    /// bytes and an existing file is never touched.
    fn publish_new(self, path: &Path) -> Result<()> {
        self.publish_new_with(path, sync_dir)
    }

    /// Publishes as [`Staged::publish_new`] does, removing the temporary name before passing the
    /// directory to `sync`, so one sync makes both the new name and that removal durable.
    fn publish_new_with(
        mut self,
        path: &Path,
        sync: impl FnOnce(&Path) -> Result<()>,
    ) -> Result<()> {
        fs::hard_link(&self.temp, path).map_err(|source| {
            if source.kind() == io::ErrorKind::AlreadyExists {
                Error::AlreadyExists(path.to_owned())
            } else {
                io_error("creating", path, source)
            }
        })?;
        self.discard();
        sync(&self.dir)
    }

    /// Removes the temporary name. A file left behind when that fails is never read, so the
    /// failure does not fail the write.
    fn discard(&mut self) {
        if !self.settled {
            self.settled = true;
            let _ = fs::remove_file(&self.temp);
        }
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        if !self.settled {
            // The write already failed or was abandoned. The sync is best effort: a removal it
            // fails to make durable leaves only a file that is never read.
            self.discard();
            let _ = sync_dir(&self.dir);
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
        self.remove_with(agent, kind, sync_dir)
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

/// Makes a rename, link or removal in `dir` survive a crash.
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

    /// Removes `kind` as the store does, recording each synced directory and the files it held
    /// at that moment.
    fn remove_recording_syncs(
        store: &FileStore,
        home: &Path,
        agent: &AgentName,
        kind: SecretKind,
    ) -> (Result<()>, Vec<(PathBuf, Vec<String>)>) {
        let mut synced = Vec::new();
        let removed = store.remove_with(agent, kind, |dir| {
            synced.push((dir.to_owned(), atlas_files(home).unwrap_or_default()));
            sync_dir(dir)
        });
        (removed, synced)
    }

    #[test]
    fn a_removal_is_synced_after_the_file_is_gone() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = AgentName::new("atlas")?;
        let key = Secret::new("key".to_owned());
        store.create(&atlas, SecretKind::SigningKey, &key)?;
        store.replace(&atlas, SecretKind::SessionToken, &key)?;
        let dir = home.path().join("agents/atlas");

        let (removed, synced) =
            remove_recording_syncs(&store, home.path(), &atlas, SecretKind::SessionToken);
        removed?;
        assert_eq!(synced, [(dir, vec!["key".to_owned()])]);
        assert_eq!(store.read(&atlas, SecretKind::SigningKey)?, Some(key));
        Ok(())
    }

    #[test]
    fn a_repeated_removal_syncs_again() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = AgentName::new("atlas")?;
        store.replace(
            &atlas,
            SecretKind::SessionToken,
            &Secret::new("one".to_owned()),
        )?;
        let dir = home.path().join("agents/atlas");

        // An attempt that unlinked the token and stopped before its sync.
        fs::remove_file(dir.join("session"))?;
        let (removed, synced) =
            remove_recording_syncs(&store, home.path(), &atlas, SecretKind::SessionToken);
        removed?;
        assert_eq!(synced, [(dir, Vec::new())]);
        Ok(())
    }

    #[test]
    fn a_removal_from_a_store_never_created_syncs_and_creates_nothing() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path().join("railhead"));
        let atlas = AgentName::new("atlas")?;
        let (removed, synced) =
            remove_recording_syncs(&store, home.path(), &atlas, SecretKind::SessionToken);
        removed?;
        assert_eq!(synced, Vec::new());
        assert_eq!(fs::read_dir(home.path())?.count(), 0);
        Ok(())
    }

    #[test]
    fn a_failed_removal_sync_is_reported() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = AgentName::new("atlas")?;
        store.replace(
            &atlas,
            SecretKind::SessionToken,
            &Secret::new("one".to_owned()),
        )?;
        let dir = home.path().join("agents/atlas");
        let failed = store.remove_with(&atlas, SecretKind::SessionToken, |dir| {
            Err(io_error("syncing", dir, io::ErrorKind::Other.into()))
        });
        assert!(matches!(failed, Err(Error::Io { action: "syncing", path, .. }) if path == dir));
        assert_eq!(store.read(&atlas, SecretKind::SessionToken)?, None);

        // The retry finds the file gone and makes its removal durable.
        let (removed, synced) =
            remove_recording_syncs(&store, home.path(), &atlas, SecretKind::SessionToken);
        removed?;
        assert_eq!(synced, [(dir, Vec::new())]);
        Ok(())
    }

    #[test]
    fn a_new_key_drops_its_temporary_name_before_the_sync() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = AgentName::new("atlas")?;
        let dir = home.path().join("agents/atlas");

        let mut synced = Vec::new();
        store
            .stage(&atlas, b"key")?
            .publish_new_with(&dir.join("key"), |parent| {
                synced.push((
                    parent.to_owned(),
                    atlas_files(home.path()).unwrap_or_default(),
                ));
                sync_dir(parent)
            })?;
        assert_eq!(synced, [(dir.clone(), vec!["key".to_owned()])]);

        // A failed sync is reported; the key is linked and the temporary name is gone.
        let failed = store
            .stage(&atlas, b"identity")?
            .publish_new_with(&dir.join("identity.json"), |parent| {
                Err(io_error("syncing", parent, io::ErrorKind::Other.into()))
            });
        assert!(matches!(failed, Err(Error::Io { action: "syncing", path, .. }) if path == dir));
        assert_eq!(atlas_files(home.path())?, ["identity.json", "key"]);
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

    fn session(identity: &Identity, token: &str, expires_at_ms: u64) -> anyhow::Result<Session> {
        let token =
            SessionToken::new(token.to_owned()).ok_or_else(|| anyhow::anyhow!("token refused"))?;
        Ok(Session::new(identity, token, expires_at_ms))
    }

    #[test]
    fn a_session_is_used_only_for_its_identity_until_shortly_before_it_expires()
    -> anyhow::Result<()> {
        let atlas = identity("atlas", "agt_atlas01")?;
        let expires = 1_800_000_000_000;
        let current = session(&atlas, TOKEN, expires)?;
        assert!(current.usable_for(&atlas, expires - SESSION_EXPIRY_SKEW_MS - 1));
        // From the skew before expiry on, the session is not used.
        assert!(!current.usable_for(&atlas, expires - SESSION_EXPIRY_SKEW_MS));
        assert!(!current.usable_for(&atlas, expires + 1));
        assert!(!current.usable_for(&atlas, u64::MAX));

        let mut elsewhere = atlas.clone();
        elsewhere.origin = "https://evil.example".parse()?;
        let mut other_repo = atlas.clone();
        other_repo.repo = "casqueblanc/other".parse()?;
        for other in [identity("atlas", "agt_boreas01")?, elsewhere, other_repo] {
            assert!(!current.usable_for(&other, 0), "{other:?}");
        }
        Ok(())
    }

    #[test]
    fn sessions_round_trip_and_anything_else_reads_as_none() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = identity("atlas", "agt_atlas01")?;
        assert_eq!(store.load_session(&atlas.name)?, None);
        let stored = session(&atlas, TOKEN, 1_800_000_000_000)?;
        store.save_session(&atlas.name, &stored)?;
        assert_eq!(store.load_session(&atlas.name)?, Some(stored));
        let raw = fs::read_to_string(home.path().join("agents/atlas/session"))?;
        let record: serde_json::Value = serde_json::from_str(&raw)?;
        assert_eq!(
            record,
            serde_json::json!({"agentId": "agt_atlas01", "origin": "https://railhead.dev",
                "repo": "casqueblanc/demo", "token": TOKEN, "expiresAt": 1_800_000_000_000_u64})
        );

        // A bare token, a record with a malformed token, and an unknown field are not sessions.
        for bad in [
            TOKEN.to_owned(),
            raw.replace(TOKEN, "a.b"),
            raw.replace("\"token\"", "\"extra\": 1, \"token\""),
        ] {
            store.replace(&atlas.name, SecretKind::SessionToken, &Secret::new(bad))?;
            assert_eq!(store.load_session(&atlas.name)?, None);
        }
        Ok(())
    }

    #[test]
    fn a_session_is_removed_only_while_it_holds_the_refused_token() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = identity("atlas", "agt_atlas01")?;
        assert!(!store.remove_session_if(&atlas.name, TOKEN)?);
        store.save_session(&atlas.name, &session(&atlas, TOKEN, 1_800_000_000_000)?)?;
        assert!(!store.remove_session_if(&atlas.name, "a.b.c")?);
        assert!(store.load_session(&atlas.name)?.is_some());
        assert!(store.remove_session_if(&atlas.name, TOKEN)?);
        assert_eq!(store.load_session(&atlas.name)?, None);
        Ok(())
    }

    #[test]
    fn an_erase_waits_for_a_session_being_replaced_and_keeps_the_new_one() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = identity("atlas", "agt_atlas01")?;
        store.save_session(&atlas.name, &session(&atlas, TOKEN, 1_800_000_000_000)?)?;
        let fresh = session(&atlas, "fresh.session.token", 1_800_000_000_000)?;

        // A writer holds the session lock; an erase of the old token starts meanwhile.
        let writing = store.lock(&atlas.name, LockKind::Session)?;
        let erase = std::thread::spawn({
            let (store, name) = (store.clone(), atlas.name.clone());
            move || store.remove_session_if(&name, TOKEN)
        });
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!erase.is_finished(), "the erase did not wait for the lock");
        let secret = fresh
            .to_secret()
            .ok_or_else(|| anyhow::anyhow!("no record"))?;
        store.replace(&atlas.name, SecretKind::SessionToken, &secret)?;
        drop(writing);

        let removed = erase
            .join()
            .map_err(|_| anyhow::anyhow!("the erase panicked"))??;
        assert!(!removed);
        assert_eq!(store.load_session(&atlas.name)?, Some(fresh));
        Ok(())
    }

    #[test]
    fn an_unfinished_enrollment_is_stored_until_removed() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = AgentName::new("atlas")?;
        assert_eq!(store.load_enrollment(&atlas)?, None);
        store.remove_enrollment(&atlas)?;
        let origin: Origin = "https://railhead.dev".parse()?;
        let repo: RepoRef = "casqueblanc/demo".parse()?;
        let enrollment = PendingEnrollment {
            origin: origin.clone(),
            repo: repo.clone(),
            invite_id: "inv_abc123".to_owned(),
            public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAtlas".to_owned(),
        };
        store.save_enrollment(&atlas, &enrollment)?;
        assert_eq!(store.load_enrollment(&atlas)?, Some(enrollment.clone()));
        assert!(enrollment.is_for(&origin, &repo, "inv_abc123"));
        assert!(!enrollment.is_for(&origin, &repo, "inv_other1"));
        assert!(!enrollment.is_for(&"https://evil.example".parse()?, &repo, "inv_abc123"));
        assert!(!enrollment.is_for(&origin, &"casqueblanc/other".parse()?, "inv_abc123"));
        // An enrollment holds no identity.
        assert!(matches!(
            store.find(&AgentSelector::Name(atlas.clone())),
            Err(Error::NotFound(_))
        ));

        // A record the store did not write is refused, not read as no enrollment.
        let path = home.path().join("agents/atlas/enrollment.json");
        store.write_atomic(&atlas, &path, b"{\"inviteId\": \"inv_abc123\"}")?;
        assert!(matches!(
            store.load_enrollment(&atlas),
            Err(Error::Damaged(_))
        ));
        store.remove_enrollment(&atlas)?;
        assert_eq!(store.load_enrollment(&atlas)?, None);
        Ok(())
    }

    #[test]
    fn a_held_enrollment_lock_is_refused_until_it_is_released() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = AgentName::new("atlas")?;
        let held = store.try_lock(&atlas, LockKind::Enrollment)?;
        assert!(held.is_some());
        assert!(store.try_lock(&atlas, LockKind::Enrollment)?.is_none());
        // Another name and another kind of lock are independent.
        assert!(
            store
                .try_lock(&AgentName::new("boreas")?, LockKind::Enrollment)?
                .is_some()
        );
        assert!(store.try_lock(&atlas, LockKind::Session)?.is_some());
        drop(held);
        // A child another test forks in this process can share the lock's file until it execs, so
        // the release is awaited briefly rather than expected at once.
        let released = std::time::Instant::now();
        while store.try_lock(&atlas, LockKind::Enrollment)?.is_none() {
            assert!(
                released.elapsed() < std::time::Duration::from_secs(2),
                "the lock was not released"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        // A name with only lock files has no identity.
        assert!(matches!(
            store.find(&AgentSelector::Name(atlas)),
            Err(Error::NotFound(_))
        ));
        Ok(())
    }

    #[test]
    fn concurrent_writes_each_stage_their_own_file() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = identity("atlas", "agt_atlas01")?;
        let writers: Vec<_> = (0..8_u64)
            .map(|n| {
                let (store, atlas) = (store.clone(), atlas.clone());
                std::thread::spawn(move || -> anyhow::Result<()> {
                    for _ in 0..20 {
                        store.save_session(&atlas.name, &session(&atlas, TOKEN, n)?)?;
                        store.save_identity(&atlas)?;
                    }
                    Ok(())
                })
            })
            .collect();
        for writer in writers {
            writer
                .join()
                .map_err(|_| anyhow::anyhow!("a writer panicked"))??;
        }
        assert!(store.load_session(&atlas.name)?.is_some());
        assert_eq!(store.find(&"atlas".parse()?)?, atlas);
        let mut leftovers = Vec::new();
        for entry in fs::read_dir(home.path().join("agents/atlas"))? {
            let name = entry?.file_name();
            if name.to_string_lossy().starts_with(".tmp-") {
                leftovers.push(name);
            }
        }
        assert!(leftovers.is_empty(), "{leftovers:?}");
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
