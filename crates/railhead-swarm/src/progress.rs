//! Each agent's progress through its plan, kept on disk so a stopped run can be run again.
//!
//! The record names the scenario seed, the planned task the agent is on and the claim that task
//! holds. A rerun with the same seed starts at that task, and when `rh work` hands back a claim an
//! earlier run already pinned, the record says which planned task it carries. The record is
//! written before the claim is pinned and removed once every planned task landed, so a finished
//! run leaves nothing to resume.

use std::io::{self, Read as _};
use std::path::{Path, PathBuf};

use railhead_protocol::{IdKind, is_id};
use serde::{Deserialize, Serialize};

/// Largest record read, in bytes. A record is far smaller.
const MAX_RECORD_BYTES: u64 = 4 * 1024;

/// Where one agent is in its plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Progress {
    /// The scenario seed the plan came from.
    pub seed: u64,
    /// The planned task, as an index into the agent's edits. Every earlier one landed.
    pub round: u32,
    /// Whether the claim delivers the scaffold that `round` needs first.
    pub scaffold: bool,
    /// The claim the task holds, once `rh work` returned one.
    pub claim_id: Option<String>,
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

    /// The record for a run of `seed`, or `None` when there is none, it is for another seed, or
    /// it is not a record this driver wrote.
    ///
    /// # Errors
    ///
    /// When the file exists but cannot be read.
    pub fn load(&self, seed: u64) -> io::Result<Option<Progress>> {
        let file = match std::fs::File::open(&self.0) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let mut text = String::new();
        file.take(MAX_RECORD_BYTES).read_to_string(&mut text)?;
        Ok(serde_json::from_str::<Progress>(&text)
            .ok()
            .filter(|progress| progress.seed == seed)
            .filter(|progress| {
                progress
                    .claim_id
                    .as_deref()
                    .is_none_or(|id| is_id(IdKind::Claim, id))
            }))
    }

    /// Replaces the record, through a temporary file so a crash leaves the old or the new one.
    ///
    /// # Errors
    ///
    /// When the directory or file cannot be written.
    pub fn save(&self, progress: &Progress) -> io::Result<()> {
        if let Some(dir) = self.0.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let temporary = self.0.with_extension("json.tmp");
        std::fs::write(&temporary, serde_json::to_vec(progress)?)?;
        std::fs::rename(&temporary, &self.0)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn record(claim_id: Option<&str>) -> Progress {
        Progress {
            seed: 211,
            round: 2,
            scaffold: false,
            claim_id: claim_id.map(str::to_owned),
        }
    }

    #[test]
    fn a_saved_record_loads_back_for_its_seed_only() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let file = ProgressFile::new(&dir.path().join("progress"), "swarm-00");
        assert_eq!(file.load(211)?, None);
        file.save(&record(Some("clm_abcdef")))?;
        assert_eq!(file.load(211)?, Some(record(Some("clm_abcdef"))));
        assert_eq!(file.load(212)?, None);
        file.save(&record(None))?;
        assert_eq!(file.load(211)?, Some(record(None)));
        file.clear()?;
        assert_eq!(file.load(211)?, None);
        // Clearing what is not there is not an error.
        file.clear()?;
        Ok(())
    }

    #[test]
    fn a_damaged_or_foreign_record_is_ignored() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let file = ProgressFile::new(dir.path(), "swarm-00");
        let path = dir.path().join("swarm-00.json");
        for text in [
            "not json",
            r#"{"seed":211,"round":0,"scaffold":false,"claimId":"../../etc"}"#,
            r#"{"seed":211,"round":0,"scaffold":false,"claimId":null,"extra":1}"#,
        ] {
            std::fs::write(&path, text)?;
            assert_eq!(file.load(211)?, None, "{text}");
        }
        std::fs::write(&path, " ".repeat(8 * 1024))?;
        assert_eq!(file.load(211)?, None);
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
        Ok(())
    }
}
