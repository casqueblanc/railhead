//! Each agent's progress through its plan, kept on disk so a stopped run can be run again.
//!
//! The record names the run it belongs to (the scenario file's SHA-256 and seed), the planned
//! task the agent is on and the claim that task holds. A rerun of the same scenario starts at
//! that task, and when `rh work` hands back a claim an earlier run already pinned, the record says
//! which planned task it carries. The record is written before the claim is pinned and removed
//! once every planned task landed, so a finished run leaves nothing to resume.
//!
//! A record that cannot be read, is damaged, belongs to another scenario or names an invalid
//! claim stops the run before any agent acts: it is the only map from a live claim to its planned
//! task, so it is never dropped silently. `--discard-progress` removes it on purpose.
//!
//! One run at a time may use an agent's home: [`HomeLock`] holds a lock file beside the record
//! for the length of the run.

use std::fmt::Write as _;
use std::io::{self, Read as _, Write as _};
use std::path::{Path, PathBuf};

use railhead_protocol::{IdKind, is_id};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

/// Largest record read, in bytes. A record is far smaller.
const MAX_RECORD_BYTES: u64 = 4 * 1024;

/// The run a record belongs to: the scenario file's SHA-256, in hex, and its seed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunKey {
    /// The scenario seed.
    pub seed: u64,
    /// The SHA-256 of the scenario file's bytes, in lowercase hex.
    pub scenario: String,
}

impl RunKey {
    /// The key of a run of the scenario file `bytes` with `seed`.
    #[must_use]
    pub fn new(seed: u64, bytes: &[u8]) -> Self {
        let digest = Sha256::digest(bytes);
        let scenario = digest
            .iter()
            .fold(String::with_capacity(64), |mut hex, byte| {
                // Writing to a String cannot fail.
                let _ = write!(hex, "{byte:02x}");
                hex
            });
        Self { seed, scenario }
    }
}

/// Where one agent is in its plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Progress {
    /// The scenario seed the plan came from.
    pub seed: u64,
    /// The SHA-256 of the scenario file the plan came from.
    pub scenario: String,
    /// The planned task, as an index into the agent's edits. Every earlier one landed.
    pub round: u32,
    /// Whether the claim delivers the scaffold that `round` needs first.
    pub scaffold: bool,
    /// The claim the task holds, once `rh work` returned one.
    pub claim_id: Option<String>,
}

/// Why a progress record was refused.
#[derive(Debug, thiserror::Error)]
pub enum ProgressError {
    /// The file exists but could not be read.
    #[error("reading the progress record {}: {source}", path.display())]
    Read {
        /// The record.
        path: PathBuf,
        /// What the file system said.
        source: io::Error,
    },
    /// The file is not a record this driver wrote.
    #[error("the progress record {} is damaged", .0.display())]
    Damaged(PathBuf),
    /// The record belongs to another scenario file or seed.
    #[error("the progress record {} belongs to another scenario or seed", .0.display())]
    Foreign(PathBuf),
    /// The record names a claim id that is not one.
    #[error("the progress record {} names an invalid claim", .0.display())]
    InvalidClaim(PathBuf),
}

/// One agent's progress file.
#[derive(Debug, Clone)]
pub struct ProgressFile(PathBuf);

impl ProgressFile {
    /// The progress file of agent `name` in `dir`.
    #[must_use]
    pub fn new(dir: &Path, name: &str) -> Self {
        Self(dir.join(format!("{name}.json")))
    }

    /// The record for a run of `key`, or `None` when there is none.
    ///
    /// # Errors
    ///
    /// When the file exists but cannot be read, is not a record, belongs to another run or names
    /// an invalid claim.
    pub fn load(&self, key: &RunKey) -> Result<Option<Progress>, ProgressError> {
        let read = |source| ProgressError::Read {
            path: self.0.clone(),
            source,
        };
        let file = match std::fs::File::open(&self.0) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(read(error)),
        };
        let mut text = String::new();
        file.take(MAX_RECORD_BYTES)
            .read_to_string(&mut text)
            .map_err(read)?;
        let progress = serde_json::from_str::<Progress>(&text)
            .map_err(|_| ProgressError::Damaged(self.0.clone()))?;
        if progress.seed != key.seed || progress.scenario != key.scenario {
            return Err(ProgressError::Foreign(self.0.clone()));
        }
        if progress
            .claim_id
            .as_deref()
            .is_some_and(|id| !is_id(IdKind::Claim, id))
        {
            return Err(ProgressError::InvalidClaim(self.0.clone()));
        }
        Ok(Some(progress))
    }

    /// Replaces the record, through a temporary file of its own so a crash leaves the old or the
    /// new one.
    ///
    /// # Errors
    ///
    /// When the directory or file cannot be written.
    pub fn save(&self, progress: &Progress) -> io::Result<()> {
        let dir = self.0.parent().unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(dir)?;
        let mut temporary = tempfile::Builder::new()
            .prefix(".progress-")
            .suffix(".tmp")
            .tempfile_in(dir)?;
        temporary.write_all(&serde_json::to_vec(progress)?)?;
        temporary.persist(&self.0).map_err(|error| error.error)?;
        Ok(())
    }

    /// Removes the record.
    ///
    /// # Errors
    ///
    /// When it exists and cannot be removed.
    pub fn clear(&self) -> io::Result<()> {
        match std::fs::remove_file(&self.0) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            Ok(()) | Err(_) => Ok(()),
        }
    }
}

/// Why an agent's home could not be locked.
#[derive(Debug, thiserror::Error)]
pub enum LockError {
    /// Another run holds it, or a stopped one left its lock file.
    #[error(
        "another run is using agent {name} (lock file {}, {holder}); remove the file if no run is",
        path.display()
    )]
    Held {
        /// The agent.
        name: String,
        /// The lock file.
        path: PathBuf,
        /// Who holds it, as the file says.
        holder: String,
    },
    /// The lock file could not be made.
    #[error("locking agent {name} with {}: {source}", path.display())]
    Io {
        /// The agent.
        name: String,
        /// The lock file.
        path: PathBuf,
        /// What the file system said.
        source: io::Error,
    },
}

/// The exclusive use of one agent's home for one run, released when dropped.
#[derive(Debug)]
pub struct HomeLock(PathBuf);

impl HomeLock {
    /// Locks agent `name`'s home with a lock file in `dir` that holds this process's id.
    ///
    /// # Errors
    ///
    /// When another run holds the lock or the file cannot be made.
    pub fn acquire(dir: &Path, name: &str) -> Result<Self, LockError> {
        let path = dir.join(format!("{name}.lock"));
        let failed = |source| LockError::Io {
            name: name.to_owned(),
            path: path.clone(),
            source,
        };
        std::fs::create_dir_all(dir).map_err(failed)?;
        let mut file = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let holder = std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|text| text.trim().parse::<u32>().ok())
                    .map_or_else(|| "holder unknown".to_owned(), |pid| format!("pid {pid}"));
                return Err(LockError::Held {
                    name: name.to_owned(),
                    path,
                    holder,
                });
            }
            Err(error) => return Err(failed(error)),
        };
        let lock = Self(path.clone());
        writeln!(file, "{}", std::process::id()).map_err(failed)?;
        Ok(lock)
    }
}

impl Drop for HomeLock {
    fn drop(&mut self) {
        // Drop cannot report a failure; a lock file left behind makes the next run refuse and
        // name the file.
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> RunKey {
        RunKey::new(211, b"{\"seed\": 211}")
    }

    fn record(claim_id: Option<&str>) -> Progress {
        Progress {
            seed: 211,
            scenario: key().scenario,
            round: 2,
            scaffold: false,
            claim_id: claim_id.map(str::to_owned),
        }
    }

    #[test]
    fn a_run_key_is_the_scenario_digest_and_seed() {
        // The SHA-256 of the empty string.
        assert_eq!(
            RunKey::new(1, b"").scenario,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_ne!(RunKey::new(1, b"a"), RunKey::new(1, b"b"));
        assert_ne!(RunKey::new(1, b"a"), RunKey::new(2, b"a"));
    }

    #[test]
    fn a_saved_record_loads_back() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let progress = dir.path().join("progress");
        let file = ProgressFile::new(&progress, "swarm-00");
        assert_eq!(file.load(&key())?, None);
        file.save(&record(Some("clm_abcdef")))?;
        assert_eq!(file.load(&key())?, Some(record(Some("clm_abcdef"))));
        file.save(&record(None))?;
        assert_eq!(file.load(&key())?, Some(record(None)));
        // No temporary file is left beside the record.
        assert_eq!(std::fs::read_dir(&progress)?.count(), 1);
        file.clear()?;
        assert_eq!(file.load(&key())?, None);
        // Clearing what is not there is not an error.
        file.clear()?;
        Ok(())
    }

    #[test]
    fn a_damaged_record_is_refused() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let file = ProgressFile::new(dir.path(), "swarm-00");
        let path = dir.path().join("swarm-00.json");
        let scenario = key().scenario;
        for text in [
            "not json".to_owned(),
            format!(
                r#"{{"seed":211,"scenario":"{scenario}","round":0,"scaffold":false,"claimId":null,"extra":1}}"#
            ),
            // The old record, before it named the scenario.
            r#"{"seed":211,"round":0,"scaffold":false,"claimId":null}"#.to_owned(),
            " ".repeat(8 * 1024),
        ] {
            std::fs::write(&path, &text)?;
            assert!(
                matches!(file.load(&key()), Err(ProgressError::Damaged(_))),
                "{text}"
            );
        }
        Ok(())
    }

    #[test]
    fn a_record_of_another_scenario_or_seed_is_refused() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let file = ProgressFile::new(dir.path(), "swarm-00");
        file.save(&record(None))?;
        for other in [
            RunKey::new(211, b"{\"seed\": 211} "),
            RunKey::new(212, b"{\"seed\": 211}"),
        ] {
            assert!(matches!(file.load(&other), Err(ProgressError::Foreign(_))));
        }
        Ok(())
    }

    #[test]
    fn a_record_naming_an_invalid_claim_is_refused() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let file = ProgressFile::new(dir.path(), "swarm-00");
        file.save(&record(Some("../../etc")))?;
        assert!(matches!(
            file.load(&key()),
            Err(ProgressError::InvalidClaim(_))
        ));
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn an_unwritable_directory_is_an_error() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let blocked = dir.path().join("blocked");
        std::fs::write(&blocked, "a file, not a directory")?;
        let file = ProgressFile::new(&blocked, "swarm-00");
        assert!(file.save(&record(None)).is_err());
        assert!(HomeLock::acquire(&blocked, "swarm-00").is_err());
        Ok(())
    }

    #[test]
    fn a_home_is_locked_by_one_run_at_a_time() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let lock = HomeLock::acquire(dir.path(), "swarm-00")?;
        let path = dir.path().join("swarm-00.lock");
        assert_eq!(
            std::fs::read_to_string(&path)?,
            format!("{}\n", std::process::id())
        );
        let refused = HomeLock::acquire(dir.path(), "swarm-00").err();
        assert!(
            matches!(&refused, Some(LockError::Held { holder, .. }) if *holder == format!("pid {}", std::process::id())),
            "{refused:?}"
        );
        // Another agent's home is its own.
        let other = HomeLock::acquire(dir.path(), "swarm-01")?;
        drop(lock);
        assert!(!path.exists());
        let again = HomeLock::acquire(dir.path(), "swarm-00")?;
        drop((again, other));
        assert_eq!(std::fs::read_dir(dir.path())?.count(), 0);
        Ok(())
    }
}
