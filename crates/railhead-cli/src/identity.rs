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

use railhead_protocol::{IdKind, MAX_AGENT_NAME_LENGTH, MAX_SESSION_TOKEN_LENGTH, is_id};
use serde::{Deserialize, Serialize};

use crate::context::{Origin, RepoRef};

/// Largest file the store reads, in bytes. Every record and secret is far smaller.
const MAX_STORED_BYTES: u64 = 64 * 1024;

/// Most identities the store looks through when finding one by agent id.
const MAX_IDENTITIES: usize = 256;

/// A store or identity failure. No variant carries a secret or file contents.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A name given on the command line or in `RAILHEAD_AGENT` is not an agent name or id.
    #[error("`{0}` is not an agent name or an agent id")]
    InvalidSelector(String),
    /// A stored file is not what the store wrote.
    #[error("{} is damaged; remove it and join again", .0.display())]
    Damaged(PathBuf),
    /// A secret file can be read by other users.
    #[error("{} can be read by other users; restrict it to mode 600", .0.display())]
    InsecurePermissions(PathBuf),
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

    /// Stores a secret, replacing any earlier value atomically.
    ///
    /// # Errors
    ///
    /// When it cannot be written.
    fn replace(&self, agent: &AgentName, kind: SecretKind, secret: &Secret) -> Result<()>;

    /// Removes a secret. Removing one that does not exist succeeds.
    ///
    /// # Errors
    ///
    /// When it exists and cannot be removed.
    fn remove(&self, agent: &AgentName, kind: SecretKind) -> Result<()>;
}

/// The file store: one directory per agent, mode 700, and files of mode 600.
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

    fn ensure_agent_dir(&self, agent: &AgentName) -> Result<PathBuf> {
        let dir = self.agent_dir(agent);
        create_private_dir(&dir)?;
        Ok(dir)
    }

    fn write_atomic(&self, agent: &AgentName, path: &Path, bytes: &[u8]) -> Result<()> {
        let dir = self.ensure_agent_dir(agent)?;
        let temp = dir.join(".tmp-write");
        // A leftover from an interrupted write is ours to discard.
        remove_if_present(&temp)?;
        let mut file = create_private_file(&temp)?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|source| io_error("writing", &temp, source))?;
        fs::rename(&temp, path).map_err(|source| io_error("replacing", path, source))
    }
}

impl SecretStore for FileStore {
    fn read(&self, agent: &AgentName, kind: SecretKind) -> Result<Option<Secret>> {
        let path = self.agent_dir(agent).join(kind.file_name());
        let Some(bytes) = read_private(&path)? else {
            return Ok(None);
        };
        String::from_utf8(bytes)
            .map(|text| Some(Secret::new(text)))
            .map_err(|_| Error::Damaged(path))
    }

    fn create(&self, agent: &AgentName, kind: SecretKind, secret: &Secret) -> Result<()> {
        let path = self.ensure_agent_dir(agent)?.join(kind.file_name());
        let mut file = create_private_file(&path)?;
        file.write_all(secret.expose().as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|source| io_error("writing", &path, source))
    }

    fn replace(&self, agent: &AgentName, kind: SecretKind, secret: &Secret) -> Result<()> {
        let path = self.agent_dir(agent).join(kind.file_name());
        self.write_atomic(agent, &path, secret.expose().as_bytes())
    }

    fn remove(&self, agent: &AgentName, kind: SecretKind) -> Result<()> {
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
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder
        .create(dir)
        .map_err(|source| io_error("creating", dir, source))
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

/// Reads a store file, refusing a link, an oversized file and one other users can read.
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

/// Checks the file a handle actually opened: the one checked at `path`, regular, small and private.
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
    #[cfg(unix)]
    if std::os::unix::fs::PermissionsExt::mode(&opened.permissions()) & 0o077 != 0 {
        return Err(Error::InsecurePermissions(path.to_owned()));
    }
    Ok(())
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
    fn secrets_never_reach_debug_output() {
        let secret = Secret::new(TOKEN.to_owned());
        assert_eq!(format!("{secret:?}"), "Secret(<redacted>)");
    }
}
