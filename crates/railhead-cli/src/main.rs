//! `rh`, the Railhead command line for coding agents.

use std::io::{self, Write};
use std::process::ExitCode;

use anyhow::Context as _;
use clap::{Parser, Subcommand};

/// Join a Railhead repository, claim work and answer its decisions.
#[derive(Debug, Parser)]
#[command(name = "rh", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Print the version of `rh` and the event schema it reads.
    Version,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(&cli, &mut io::stdout().lock()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            // `{:#}` prints the whole context chain on one line.
            let _ = writeln!(io::stderr(), "rh: {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: &Cli, out: &mut impl Write) -> anyhow::Result<()> {
    match cli.command {
        Command::Version => writeln!(
            out,
            "rh {} (event schema {})",
            env!("CARGO_PKG_VERSION"),
            railhead_protocol::EVENT_SCHEMA_VERSION
        )
        .context("writing the version"),
    }
}

#[cfg(test)]
mod tests {
    use std::io::{self, Write};

    use clap::error::ErrorKind;

    use super::{Cli, Parser as _, run};

    fn run_args(args: &[&str]) -> anyhow::Result<String> {
        let cli = Cli::try_parse_from(args)?;
        let mut out = Vec::new();
        run(&cli, &mut out)?;
        Ok(String::from_utf8(out)?)
    }

    #[test]
    fn version_prints_the_crate_and_schema_versions() -> anyhow::Result<()> {
        assert_eq!(run_args(&["rh", "version"])?, "rh 0.1.0 (event schema 1)\n");
        Ok(())
    }

    #[test]
    fn version_flag_is_handled_by_the_parser() {
        let error = Cli::try_parse_from(["rh", "--version"]).err();
        assert_eq!(error.map(|e| e.kind()), Some(ErrorKind::DisplayVersion));
    }

    #[test]
    fn a_missing_or_unknown_command_is_refused() {
        let missing = Cli::try_parse_from(["rh"]).err();
        assert_eq!(
            missing.map(|e| e.kind()),
            Some(ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand)
        );
        let unknown = Cli::try_parse_from(["rh", "deploy"]).err();
        assert_eq!(
            unknown.map(|e| e.kind()),
            Some(ErrorKind::InvalidSubcommand)
        );
        let extra = Cli::try_parse_from(["rh", "version", "--json"]).err();
        assert_eq!(extra.map(|e| e.kind()), Some(ErrorKind::UnknownArgument));
    }

    /// A writer that always fails, as stdout does when its pipe is closed.
    struct ClosedPipe;

    impl Write for ClosedPipe {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::ErrorKind::BrokenPipe.into())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_failed_write_is_reported_not_ignored() -> anyhow::Result<()> {
        let cli = Cli::try_parse_from(["rh", "version"])?;
        let error = run(&cli, &mut ClosedPipe).err();
        assert_eq!(
            error.map(|e| format!("{e:#}")),
            Some("writing the version: broken pipe".to_owned())
        );
        Ok(())
    }
}
