//! Reads and writes inside a clone that never follow a symbolic link.
//!
//! A clone's files come from the repository, so a committed symbolic link could point a scripted
//! edit at any file the operator can write. Every component of a path is checked with
//! `symlink_metadata` and a link refuses the access; the file itself is opened without following
//! one, and its parent must still resolve inside the clone.

use std::fs::{File, OpenOptions};
use std::io::{self, Read as _, Write as _};
use std::path::{Path, PathBuf};

/// Largest file read from a clone, in bytes. Every file the driver edits is far smaller.
const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// Why a clone file could not be read or written.
#[derive(Debug, thiserror::Error)]
pub enum ConfineError {
    /// The path is not relative segments without `.` or `..`.
    #[error("{0} is not a plain relative path")]
    BadPath(String),
    /// A component of the path is a symbolic link.
    #[error("{} is a symbolic link", .0.display())]
    Symlink(PathBuf),
    /// A component is not the kind of file the path needs there.
    #[error("{} is not a regular file or directory where one is needed", .0.display())]
    WrongKind(PathBuf),
    /// The file's parent resolves outside the clone.
    #[error("{} resolves outside the clone", .0.display())]
    Outside(PathBuf),
    /// A file that must be new is already there.
    #[error("{} already exists", .0.display())]
    Exists(PathBuf),
    /// The file is larger than [`MAX_FILE_BYTES`].
    #[error("{} is larger than {MAX_FILE_BYTES} bytes", .0.display())]
    TooLarge(PathBuf),
    /// The file system refused.
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl ConfineError {
    /// The failure code a stopped agent reports.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::BadPath(_) | Self::Symlink(_) | Self::WrongKind(_) | Self::Outside(_) => {
                "unsafe_path"
            }
            Self::Exists(_) => "path_exists",
            Self::TooLarge(_) => "file_too_large",
            Self::Io(_) => "write",
        }
    }
}

/// The kind of `path`, without following a link; `None` when nothing is there.
fn kind(path: &Path) -> Result<Option<std::fs::FileType>, ConfineError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(ConfineError::Symlink(path.to_owned()))
        }
        Ok(metadata) => Ok(Some(metadata.file_type())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Walks `relative`'s directories under `root`, refusing any link, and returns the file's path;
/// `None` when a directory is missing and `create` is false.
fn walk(root: &Path, relative: &str, create: bool) -> Result<Option<PathBuf>, ConfineError> {
    let segments: Vec<&str> = relative.split('/').collect();
    let Some((file, directories)) = segments.split_last() else {
        return Err(ConfineError::BadPath(relative.to_owned()));
    };
    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return Err(ConfineError::BadPath(relative.to_owned()));
    }
    let mut path = root.to_owned();
    for directory in directories {
        path.push(directory);
        match kind(&path)? {
            Some(found) if found.is_dir() => {}
            Some(_) => return Err(ConfineError::WrongKind(path)),
            None if create => std::fs::create_dir(&path)?,
            None => return Ok(None),
        }
    }
    path.push(file);
    Ok(Some(path))
}

/// Refuses `path` unless its parent resolves inside `root`.
fn check_inside(root: &Path, path: &Path) -> Result<(), ConfineError> {
    let parent = path.parent().unwrap_or(root).canonicalize()?;
    if parent.starts_with(root.canonicalize()?) {
        Ok(())
    } else {
        Err(ConfineError::Outside(path.to_owned()))
    }
}

/// Options that refuse to open a symbolic link as the file itself.
fn no_follow(options: &mut OpenOptions) -> &mut OpenOptions {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(rustix::fs::OFlags::NOFOLLOW.bits().cast_signed());
    }
    options
}

/// Whether `relative` is a regular file under `root`, reached through no link.
#[must_use]
pub fn is_file(root: &Path, relative: &str) -> bool {
    walk(root, relative, false)
        .ok()
        .flatten()
        .and_then(|path| kind(&path).ok().flatten())
        .is_some_and(|found| found.is_file())
}

/// Reads `relative` under `root`; `None` when it is not there.
///
/// # Errors
///
/// When a component is a link or the wrong kind, the file is too large, or it cannot be read.
pub fn read(root: &Path, relative: &str) -> Result<Option<String>, ConfineError> {
    let Some(path) = walk(root, relative, false)? else {
        return Ok(None);
    };
    match kind(&path)? {
        None => return Ok(None),
        Some(found) if found.is_file() => {}
        Some(_) => return Err(ConfineError::WrongKind(path)),
    }
    check_inside(root, &path)?;
    let file: File = no_follow(OpenOptions::new().read(true)).open(&path)?;
    let mut text = String::new();
    file.take(MAX_FILE_BYTES.saturating_add(1))
        .read_to_string(&mut text)?;
    if u64::try_from(text.len()).unwrap_or(u64::MAX) > MAX_FILE_BYTES {
        return Err(ConfineError::TooLarge(path));
    }
    Ok(Some(text))
}

/// Writes `contents` to `relative` under `root`, making its directories.
///
/// # Errors
///
/// When a component is a link or the wrong kind, the parent resolves outside `root`, or the file
/// cannot be written.
pub fn write(root: &Path, relative: &str, contents: &str) -> Result<(), ConfineError> {
    let Some(path) = walk(root, relative, true)? else {
        return Err(ConfineError::BadPath(relative.to_owned()));
    };
    match kind(&path)? {
        None => {}
        Some(found) if found.is_file() => {}
        Some(_) => return Err(ConfineError::WrongKind(path)),
    }
    check_inside(root, &path)?;
    let mut file =
        no_follow(OpenOptions::new().write(true).create(true).truncate(true)).open(&path)?;
    file.write_all(contents.as_bytes())?;
    Ok(())
}

/// Creates `relative` under `root` with `contents`, making its directories; refuses when anything
/// is already at that path, a regular file included.
///
/// # Errors
///
/// [`ConfineError::Exists`] when the path is taken; otherwise as [`write`].
pub fn create(root: &Path, relative: &str, contents: &str) -> Result<(), ConfineError> {
    let Some(path) = walk(root, relative, true)? else {
        return Err(ConfineError::BadPath(relative.to_owned()));
    };
    if kind(&path)?.is_some() {
        return Err(ConfineError::Exists(path));
    }
    check_inside(root, &path)?;
    // `create_new` also refuses a file, or a link, that appeared since the check.
    let mut file = match no_follow(OpenOptions::new().write(true).create_new(true)).open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return Err(ConfineError::Exists(path));
        }
        Err(error) => return Err(error.into()),
    };
    file.write_all(contents.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_is_written_and_read_back_with_its_directories() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        assert_eq!(read(dir.path(), "swarm/agents/a.txt")?, None);
        assert!(!is_file(dir.path(), "swarm/agents/a.txt"));
        write(dir.path(), "swarm/agents/a.txt", "one\n")?;
        write(dir.path(), "swarm/agents/a.txt", "two\n")?;
        assert_eq!(
            read(dir.path(), "swarm/agents/a.txt")?.as_deref(),
            Some("two\n")
        );
        assert!(is_file(dir.path(), "swarm/agents/a.txt"));
        Ok(())
    }

    #[test]
    fn create_writes_a_new_file_and_never_replaces_one() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        create(dir.path(), "swarm/agents/new.txt", "mine\n")?;
        assert_eq!(
            read(dir.path(), "swarm/agents/new.txt")?.as_deref(),
            Some("mine\n")
        );
        std::fs::write(dir.path().join("swarm/taken.txt"), "someone else's\n")?;
        let refused = create(dir.path(), "swarm/taken.txt", "mine\n");
        assert!(
            matches!(refused, Err(ConfineError::Exists(_))),
            "{refused:?}"
        );
        assert_eq!(
            refused.map_err(|error| error.code()).err(),
            Some("path_exists")
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("swarm/taken.txt"))?,
            "someone else's\n"
        );
        // Not a directory either, and not a plain-path violation.
        std::fs::create_dir(dir.path().join("swarm/d"))?;
        assert!(matches!(
            create(dir.path(), "swarm/d", "x"),
            Err(ConfineError::Exists(_))
        ));
        assert!(matches!(
            create(dir.path(), "../x", "x"),
            Err(ConfineError::BadPath(_))
        ));
        Ok(())
    }

    #[test]
    fn a_path_that_is_not_plain_is_refused() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        for path in ["", "../x", "a//b", "a/./b", "/etc/passwd"] {
            assert!(
                matches!(write(dir.path(), path, "x"), Err(ConfineError::BadPath(_))),
                "{path:?}"
            );
        }
        // A directory where the file goes is not overwritten.
        std::fs::create_dir(dir.path().join("d"))?;
        assert!(matches!(
            write(dir.path(), "d", "x"),
            Err(ConfineError::WrongKind(_))
        ));
        Ok(())
    }

    #[test]
    fn an_oversized_file_is_not_read() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let size = usize::try_from(MAX_FILE_BYTES)?.saturating_add(1);
        std::fs::write(dir.path().join("big"), " ".repeat(size))?;
        assert!(matches!(
            read(dir.path(), "big"),
            Err(ConfineError::TooLarge(_))
        ));
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_a_file_outside_the_clone_is_never_followed() -> anyhow::Result<()> {
        let outside = tempfile::tempdir()?;
        let sentinel = outside.path().join("sentinel");
        std::fs::write(&sentinel, "untouched\n")?;
        let clone = tempfile::tempdir()?;
        std::fs::create_dir(clone.path().join("swarm"))?;
        std::os::unix::fs::symlink(&sentinel, clone.path().join("swarm/round.txt"))?;
        assert!(matches!(
            write(clone.path(), "swarm/round.txt", "edit\n"),
            Err(ConfineError::Symlink(_))
        ));
        assert!(matches!(
            read(clone.path(), "swarm/round.txt"),
            Err(ConfineError::Symlink(_))
        ));
        assert!(matches!(
            create(clone.path(), "swarm/round.txt", "edit\n"),
            Err(ConfineError::Symlink(_))
        ));
        assert!(!is_file(clone.path(), "swarm/round.txt"));
        assert_eq!(std::fs::read_to_string(&sentinel)?, "untouched\n");
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_directory_is_never_entered() -> anyhow::Result<()> {
        let outside = tempfile::tempdir()?;
        let clone = tempfile::tempdir()?;
        std::os::unix::fs::symlink(outside.path(), clone.path().join("swarm"))?;
        assert!(matches!(
            write(clone.path(), "swarm/agents/a.txt", "edit\n"),
            Err(ConfineError::Symlink(_))
        ));
        assert_eq!(std::fs::read_dir(outside.path())?.count(), 0);
        Ok(())
    }
}
