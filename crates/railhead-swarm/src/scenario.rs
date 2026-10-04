//! The scenario file: which repository the swarm works on, how many agents, how long, the edit
//! mix and the bounds. It is JSON, read whole and validated before any agent starts; an unknown
//! field is refused, so a misspelt bound cannot silently fall back to its default.

use std::fmt;
use std::time::Duration;

use serde::Deserialize;
use url::Url;

/// Agents a scenario runs when it names no count.
pub const DEFAULT_AGENTS: u32 = 8;
/// Most agents a scenario may run.
pub const MAX_AGENTS: u32 = 64;
/// Most tasks one agent may land in a run.
pub const MAX_ROUNDS: u32 = 100;
/// Largest weight one edit class may take in the mix.
pub const MAX_WEIGHT: u32 = 1000;
/// Largest scenario file read, in bytes.
pub const MAX_SCENARIO_BYTES: usize = 64 * 1024;

/// Why a scenario was refused. The messages name the field and the accepted range.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The file is larger than [`MAX_SCENARIO_BYTES`].
    #[error("the scenario is larger than {MAX_SCENARIO_BYTES} bytes")]
    TooLarge,
    /// The file is not a scenario object.
    #[error("the scenario is not valid JSON of the expected shape: {0}")]
    Json(#[from] serde_json::Error),
    /// A field is outside its range.
    #[error("{field} must be {expected}")]
    Invalid {
        /// The field, as the file names it.
        field: &'static str,
        /// What it may be.
        expected: &'static str,
    },
}

/// The scenario as the file writes it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScenarioFile {
    seed: u64,
    origin: String,
    repository: String,
    #[serde(default = "default_agents")]
    agents: u32,
    rounds: u32,
    mix: Mix,
    #[serde(default)]
    bounds: BoundsFile,
}

const fn default_agents() -> u32 {
    DEFAULT_AGENTS
}

/// The bounds as the file writes them; each defaults when omitted.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BoundsFile {
    concurrency: Option<u32>,
    retries: Option<u32>,
    command_timeout_secs: Option<u64>,
    land_timeout_secs: Option<u64>,
    run_timeout_secs: Option<u64>,
    poll_ms: Option<u64>,
}

/// The relative weight of each edit class. A class of weight 0 is never planned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mix {
    /// Edits to a file no other agent touches; they merge with no conflict.
    pub disjoint: u32,
    /// Edits to one shared file in hunks of their own, which Git merges.
    pub same_file_hunks: u32,
    /// Edits to the same line of one shared file: true conflicts.
    pub overlapping: u32,
}

impl Mix {
    /// The sum of the weights; validation keeps it between 1 and `3 * MAX_WEIGHT`.
    #[must_use]
    pub const fn total(&self) -> u32 {
        self.disjoint
            .saturating_add(self.same_file_hunks)
            .saturating_add(self.overlapping)
    }
}

/// How far the run may go: processes at once, retries, and how long each wait may last.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bounds {
    /// Most `rh` and Git processes running at once, across every agent.
    pub concurrency: u32,
    /// How many times a retryable step is repeated before the agent gives the task up.
    pub retries: u32,
    /// How long one `rh` or Git process may run.
    pub command_timeout: Duration,
    /// How long a ready claim may wait to land before its agent stops.
    pub land_timeout: Duration,
    /// How long the whole run may last.
    pub run_timeout: Duration,
    /// How often a waiting agent asks for its claim's state.
    pub poll: Duration,
}

/// A Railhead origin: `https`, or `http` on a loopback host, with no path, user or query. `rh`
/// refuses any other, so the driver refuses it first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin(Url);

impl Origin {
    /// Parses and checks an origin.
    ///
    /// # Errors
    ///
    /// [`Error::Invalid`] for anything `rh` would refuse.
    pub fn new(value: &str) -> Result<Self, Error> {
        let url = Url::parse(value).map_err(|_| invalid_origin())?;
        let loopback = match url.host() {
            Some(url::Host::Domain(domain)) => domain == "localhost",
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            None => false,
        };
        let secure = url.scheme() == "https" || (url.scheme() == "http" && loopback);
        let bare = url.username().is_empty()
            && url.password().is_none()
            && url.host().is_some()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none();
        if secure && bare {
            Ok(Self(url))
        } else {
            Err(invalid_origin())
        }
    }

    /// The origin without its trailing slash, as `rh` writes it into remote URLs.
    #[must_use]
    pub fn as_str(&self) -> &str {
        self.0.as_str().trim_end_matches('/')
    }
}

const fn invalid_origin() -> Error {
    Error::Invalid {
        field: "origin",
        expected: "an https URL, or http on localhost, with no path, user or query",
    }
}

/// A repository on the origin, `org/repo`: lowercase letters, digits and inner dashes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repository {
    org: String,
    repo: String,
}

impl Repository {
    /// Parses and checks `org/repo`.
    ///
    /// # Errors
    ///
    /// [`Error::Invalid`] when either part is not a repository name.
    pub fn new(value: &str) -> Result<Self, Error> {
        value
            .split_once('/')
            .filter(|(org, repo)| is_segment(org) && is_segment(repo))
            .map(|(org, repo)| Self {
                org: org.to_owned(),
                repo: repo.to_owned(),
            })
            .ok_or(Error::Invalid {
                field: "repository",
                expected: "org/repo, each 1 to 64 lowercase letters, digits and inner dashes",
            })
    }

    /// The URL prefix every claim fork of this repository has on `origin`.
    #[must_use]
    pub fn fork_prefix(&self, origin: &Origin) -> String {
        format!("{}/git/{}/{}/claims/", origin.as_str(), self.org, self.repo)
    }
}

impl fmt::Display for Repository {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.org, self.repo)
    }
}

fn is_segment(value: &str) -> bool {
    let bytes = value.as_bytes();
    let edge = |b: Option<&u8>| b.is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    (1..=64).contains(&bytes.len())
        && edge(bytes.first())
        && edge(bytes.last())
        && bytes
            .iter()
            .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A validated scenario.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scenario {
    /// The seed of the edit plan.
    pub seed: u64,
    /// The Railhead origin every agent joined.
    pub origin: Origin,
    /// The one repository the run may touch.
    pub repository: Repository,
    /// How many agents run, from 1 to [`MAX_AGENTS`].
    pub agents: u32,
    /// How many tasks each agent lands, from 1 to [`MAX_ROUNDS`].
    pub rounds: u32,
    /// The edit mix.
    pub mix: Mix,
    /// The run's bounds.
    pub bounds: Bounds,
}

impl Scenario {
    /// Whether an agent joined to `origin` and `repo`, as its identity records them, belongs to
    /// this scenario.
    #[must_use]
    pub fn admits(&self, origin: &str, repo: &str) -> bool {
        Origin::new(origin).is_ok_and(|origin| origin == self.origin)
            && Repository::new(repo).is_ok_and(|repo| repo == self.repository)
    }

    /// Reads a scenario from its JSON text.
    ///
    /// # Errors
    ///
    /// [`Error`] when the text is too large, not a scenario, or any field is out of range.
    pub fn parse(text: &str) -> Result<Self, Error> {
        if text.len() > MAX_SCENARIO_BYTES {
            return Err(Error::TooLarge);
        }
        let file: ScenarioFile = serde_json::from_str(text)?;
        let agents = within(file.agents, 1, MAX_AGENTS, "agents", "from 1 to 64")?;
        let rounds = within(file.rounds, 1, MAX_ROUNDS, "rounds", "from 1 to 100")?;
        let weights = [
            file.mix.disjoint,
            file.mix.same_file_hunks,
            file.mix.overlapping,
        ];
        if weights.iter().any(|&weight| weight > MAX_WEIGHT) || file.mix.total() == 0 {
            return Err(Error::Invalid {
                field: "mix",
                expected: "weights from 0 to 1000, at least one of them above 0",
            });
        }
        let bounds = file.bounds;
        let bounds = Bounds {
            concurrency: within(
                bounds.concurrency.unwrap_or(agents),
                1,
                MAX_AGENTS,
                "bounds.concurrency",
                "from 1 to 64",
            )?,
            retries: within(
                bounds.retries.unwrap_or(3),
                0,
                10,
                "bounds.retries",
                "from 0 to 10",
            )?,
            command_timeout: Duration::from_secs(within(
                bounds.command_timeout_secs.unwrap_or(60),
                1,
                600,
                "bounds.commandTimeoutSecs",
                "from 1 to 600",
            )?),
            land_timeout: Duration::from_secs(within(
                bounds.land_timeout_secs.unwrap_or(300),
                1,
                3600,
                "bounds.landTimeoutSecs",
                "from 1 to 3600",
            )?),
            run_timeout: Duration::from_secs(within(
                bounds.run_timeout_secs.unwrap_or(900),
                1,
                4 * 3600,
                "bounds.runTimeoutSecs",
                "from 1 to 14400",
            )?),
            poll: Duration::from_millis(within(
                bounds.poll_ms.unwrap_or(1000),
                50,
                60_000,
                "bounds.pollMs",
                "from 50 to 60000",
            )?),
        };
        Ok(Self {
            seed: file.seed,
            origin: Origin::new(&file.origin)?,
            repository: Repository::new(&file.repository)?,
            agents,
            rounds,
            mix: file.mix,
            bounds,
        })
    }
}

fn within<T: PartialOrd>(
    value: T,
    min: T,
    max: T,
    field: &'static str,
    expected: &'static str,
) -> Result<T, Error> {
    if (min..=max).contains(&value) {
        Ok(value)
    } else {
        Err(Error::Invalid { field, expected })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"{"seed": 7, "origin": "https://railhead.dev",
        "repository": "casqueblanc/demo", "rounds": 2,
        "mix": {"disjoint": 1, "sameFileHunks": 0, "overlapping": 0}}"#;

    fn field_of(text: &str) -> Option<&'static str> {
        match Scenario::parse(text) {
            Err(Error::Invalid { field, .. }) => Some(field),
            _ => None,
        }
    }

    fn with(key: &str, value: &str) -> String {
        let mut scenario: serde_json::Value = serde_json::from_str(MINIMAL).unwrap_or_default();
        if let Some(object) = scenario.as_object_mut() {
            object.insert(
                key.to_owned(),
                serde_json::from_str(value).unwrap_or_default(),
            );
        }
        scenario.to_string()
    }

    #[test]
    fn a_minimal_scenario_takes_the_defaults() -> anyhow::Result<()> {
        let scenario = Scenario::parse(MINIMAL)?;
        assert_eq!(scenario.seed, 7);
        assert_eq!(scenario.origin.as_str(), "https://railhead.dev");
        assert_eq!(scenario.repository.to_string(), "casqueblanc/demo");
        assert_eq!((scenario.agents, scenario.rounds), (DEFAULT_AGENTS, 2));
        assert_eq!(
            scenario.bounds,
            Bounds {
                concurrency: DEFAULT_AGENTS,
                retries: 3,
                command_timeout: Duration::from_secs(60),
                land_timeout: Duration::from_secs(300),
                run_timeout: Duration::from_mins(15),
                poll: Duration::from_secs(1),
            }
        );
        assert_eq!(
            scenario.repository.fork_prefix(&scenario.origin),
            "https://railhead.dev/git/casqueblanc/demo/claims/"
        );
        Ok(())
    }

    #[test]
    fn the_checked_in_scenario_is_valid() -> anyhow::Result<()> {
        let scenario = Scenario::parse(include_str!("../scenarios/local.json"))?;
        assert_eq!((scenario.agents, scenario.rounds), (8, 3));
        assert_eq!(scenario.origin.as_str(), "http://localhost:8787");
        Ok(())
    }

    #[test]
    fn every_bound_can_be_set() -> anyhow::Result<()> {
        let text = with(
            "bounds",
            r#"{"concurrency": 2, "retries": 0, "commandTimeoutSecs": 5,
                "landTimeoutSecs": 9, "runTimeoutSecs": 30, "pollMs": 50}"#,
        );
        let scenario = Scenario::parse(&text)?;
        assert_eq!(
            scenario.bounds,
            Bounds {
                concurrency: 2,
                retries: 0,
                command_timeout: Duration::from_secs(5),
                land_timeout: Duration::from_secs(9),
                run_timeout: Duration::from_secs(30),
                poll: Duration::from_millis(50),
            }
        );
        Ok(())
    }

    #[test]
    fn the_agent_count_is_bounded_at_64() -> anyhow::Result<()> {
        assert_eq!(Scenario::parse(&with("agents", "1"))?.agents, 1);
        assert_eq!(Scenario::parse(&with("agents", "64"))?.agents, 64);
        assert_eq!(field_of(&with("agents", "0")), Some("agents"));
        assert_eq!(field_of(&with("agents", "65")), Some("agents"));
        assert_eq!(Scenario::parse(&with("rounds", "100"))?.rounds, 100);
        assert_eq!(field_of(&with("rounds", "0")), Some("rounds"));
        assert_eq!(field_of(&with("rounds", "101")), Some("rounds"));
        Ok(())
    }

    #[test]
    fn concurrency_defaults_to_the_agent_count() -> anyhow::Result<()> {
        let scenario = Scenario::parse(&with("agents", "3"))?;
        assert_eq!(scenario.bounds.concurrency, 3);
        Ok(())
    }

    #[test]
    fn bounds_outside_their_range_are_refused() {
        for (bound, field) in [
            (r#"{"concurrency": 0}"#, "bounds.concurrency"),
            (r#"{"concurrency": 65}"#, "bounds.concurrency"),
            (r#"{"retries": 11}"#, "bounds.retries"),
            (r#"{"commandTimeoutSecs": 0}"#, "bounds.commandTimeoutSecs"),
            (r#"{"landTimeoutSecs": 3601}"#, "bounds.landTimeoutSecs"),
            (r#"{"runTimeoutSecs": 0}"#, "bounds.runTimeoutSecs"),
            (r#"{"pollMs": 49}"#, "bounds.pollMs"),
        ] {
            assert_eq!(field_of(&with("bounds", bound)), Some(field), "{bound}");
        }
    }

    #[test]
    fn a_mix_needs_a_positive_weight_and_no_huge_one() -> anyhow::Result<()> {
        let mix = |value| with("mix", value);
        assert_eq!(
            field_of(&mix(
                r#"{"disjoint": 0, "sameFileHunks": 0, "overlapping": 0}"#
            )),
            Some("mix")
        );
        assert_eq!(
            field_of(&mix(
                r#"{"disjoint": 1001, "sameFileHunks": 0, "overlapping": 0}"#
            )),
            Some("mix")
        );
        let scenario = Scenario::parse(&mix(
            r#"{"disjoint": 1000, "sameFileHunks": 1000, "overlapping": 1000}"#,
        ))?;
        assert_eq!(scenario.mix.total(), 3000);
        Ok(())
    }

    #[test]
    fn origins_and_repositories_are_the_ones_rh_accepts() -> anyhow::Result<()> {
        assert_eq!(
            Scenario::parse(&with("origin", r#""http://localhost:8787""#))?
                .origin
                .as_str(),
            "http://localhost:8787"
        );
        for origin in [
            r#""http://railhead.dev""#,
            r#""https://user@railhead.dev""#,
            r#""https://railhead.dev/api""#,
            r#""https://railhead.dev/?q=1""#,
            r#""ftp://railhead.dev""#,
            r#""not a url""#,
        ] {
            assert_eq!(
                field_of(&with("origin", origin)),
                Some("origin"),
                "{origin}"
            );
        }
        for repository in [
            r#""demo""#,
            r#""Casque/demo""#,
            r#""casque/-demo""#,
            r#""casque/demo/x""#,
            r#""/demo""#,
        ] {
            assert_eq!(
                field_of(&with("repository", repository)),
                Some("repository"),
                "{repository}"
            );
        }
        Ok(())
    }

    #[test]
    fn unknown_fields_missing_fields_and_huge_files_are_refused() {
        assert!(matches!(
            Scenario::parse(&with("agentz", "3")),
            Err(Error::Json(_))
        ));
        assert!(matches!(
            Scenario::parse(&with("bounds", r#"{"retry": 3}"#)),
            Err(Error::Json(_))
        ));
        assert!(matches!(
            Scenario::parse(r#"{"seed": 1}"#),
            Err(Error::Json(_))
        ));
        assert!(matches!(
            Scenario::parse(&with("seed", "-1")),
            Err(Error::Json(_))
        ));
        let huge = format!("{MINIMAL}{}", " ".repeat(MAX_SCENARIO_BYTES));
        assert!(matches!(Scenario::parse(&huge), Err(Error::TooLarge)));
    }

    #[test]
    fn an_agent_belongs_only_to_the_scenario_origin_and_repository() -> anyhow::Result<()> {
        let scenario = Scenario::parse(MINIMAL)?;
        assert!(scenario.admits("https://railhead.dev", "casqueblanc/demo"));
        // The same origin written with its trailing slash.
        assert!(scenario.admits("https://railhead.dev/", "casqueblanc/demo"));
        assert!(!scenario.admits("https://railhead.dev", "casqueblanc/other"));
        assert!(!scenario.admits("https://other.dev", "casqueblanc/demo"));
        assert!(!scenario.admits("https://railhead.dev:8443", "casqueblanc/demo"));
        assert!(!scenario.admits("not a url", "casqueblanc/demo"));
        assert!(!scenario.admits("https://railhead.dev", ""));
        Ok(())
    }
}
