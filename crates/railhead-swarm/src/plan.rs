//! The edit plan: what each simulated agent changes in each round, drawn from the scenario's
//! seed, and how an edit is written into a working copy.
//!
//! The plan depends only on the seed, the agent count, the round count and the mix, so the same
//! scenario always plans the same edits. The generator is `SplitMix64`, written out here so the
//! sequence cannot change with a dependency upgrade.
//!
//! Every edit writes a line only the driver composes: an agent name, a round and a token. Edits of
//! the two shared classes need the scaffold files on main first; an agent whose clone lacks them
//! lands the scaffold as a task of its own. The scaffold is the same bytes for every agent, so two
//! agents adding it at once merge cleanly.

use std::fmt::{self, Write as _};

use serde::Serialize;

use crate::scenario::{MAX_AGENTS, Mix};

/// The shared file whose slot lines agents rewrite, one slot per agent.
pub const SHARED_PATH: &str = "swarm/shared.txt";
/// The shared file whose one line every overlapping edit rewrites.
pub const CONTESTED_PATH: &str = "swarm/contested.txt";

/// Unchanged lines between two slots, so Git merges edits of neighbouring slots.
const SLOT_GAP: &str = "--\n--\n";

/// The kind of change an edit makes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EditClass {
    /// A file of the agent's own: merges with no conflict.
    Disjoint,
    /// The agent's own slot line of [`SHARED_PATH`]: Git merges it with other slots.
    SameFileHunks,
    /// The one contested line of [`CONTESTED_PATH`]: conflicts with every concurrent edit of it.
    Overlapping,
}

impl fmt::Display for EditClass {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Disjoint => "disjoint",
            Self::SameFileHunks => "sameFileHunks",
            Self::Overlapping => "overlapping",
        })
    }
}

/// One planned edit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Edit {
    /// The round, from 0.
    pub round: u32,
    /// What it changes.
    pub class: EditClass,
    /// A seeded value that makes the written line unique.
    pub token: u64,
}

impl Edit {
    /// The repository path the edit writes.
    #[must_use]
    pub fn path(&self, agent: &str) -> String {
        match self.class {
            EditClass::Disjoint => format!("swarm/agents/{agent}/round-{:03}.txt", self.round),
            EditClass::SameFileHunks => SHARED_PATH.to_owned(),
            EditClass::Overlapping => CONTESTED_PATH.to_owned(),
        }
    }

    /// Whether the edit rewrites a scaffold file.
    #[must_use]
    pub const fn needs_scaffold(&self) -> bool {
        match self.class {
            EditClass::Disjoint => false,
            EditClass::SameFileHunks | EditClass::Overlapping => true,
        }
    }

    /// The line the edit writes.
    fn line(&self, agent: &str) -> String {
        format!("{agent} round {} {:016x}", self.round, self.token)
    }

    /// The new contents of the edit's path, given its current contents.
    ///
    /// # Errors
    ///
    /// [`ApplyError::NoScaffold`] when a shared file is missing, [`ApplyError::Unrecognised`] when
    /// it exists but has no line for the edit, which the driver never overwrites.
    pub fn apply(
        &self,
        slot: u32,
        agent: &str,
        current: Option<&str>,
    ) -> Result<String, ApplyError> {
        let line = self.line(agent);
        let (current, prefix) = match self.class {
            EditClass::Disjoint => return Ok(format!("{line}\n")),
            EditClass::SameFileHunks => (current, format!("slot {slot:02}: ")),
            EditClass::Overlapping => (current, "contested: ".to_owned()),
        };
        let current = current.ok_or(ApplyError::NoScaffold)?;
        let mut replaced = false;
        let mut written = String::with_capacity(current.len().saturating_add(line.len()));
        for existing in current.lines() {
            if !replaced && existing.starts_with(&prefix) {
                replaced = true;
                written.push_str(&prefix);
                written.push_str(&line);
            } else {
                written.push_str(existing);
            }
            written.push('\n');
        }
        if replaced {
            Ok(written)
        } else {
            Err(ApplyError::Unrecognised)
        }
    }
}

/// Why an edit could not be written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ApplyError {
    /// The shared file is missing: the scaffold has not landed.
    #[error("the scaffold has not landed")]
    NoScaffold,
    /// The shared file holds no line the edit may rewrite.
    #[error("the shared file was changed by something other than the swarm")]
    Unrecognised,
}

/// The scaffold files with their contents, the same bytes for every agent and every run.
#[must_use]
pub fn scaffold() -> [(&'static str, String); 2] {
    let mut shared = String::from(
        "# Railhead swarm demo (simulated agents): each agent rewrites only its slot.\n",
    );
    for slot in 0..MAX_AGENTS {
        // Writing to a `String` cannot fail.
        let _ = write!(shared, "slot {slot:02}: open\n{SLOT_GAP}");
    }
    let contested = String::from(
        "# Railhead swarm demo (simulated agents): every overlapping edit rewrites the next line.\n\
         contested: open\n",
    );
    [(SHARED_PATH, shared), (CONTESTED_PATH, contested)]
}

/// Every agent's edits, round by round.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    agents: Vec<Vec<Edit>>,
}

impl Plan {
    /// Draws the plan from `seed`: for each agent in order, for each round in order, a class by
    /// weight and a token.
    #[must_use]
    pub fn new(seed: u64, agents: u32, rounds: u32, mix: Mix) -> Self {
        let mut rng = SplitMix64(seed);
        let total = u64::from(mix.total().max(1));
        let agents = (0..agents)
            .map(|_| {
                (0..rounds)
                    .map(|round| {
                        let pick = rng.next() % total;
                        let class = if pick < u64::from(mix.disjoint) {
                            EditClass::Disjoint
                        } else if pick < u64::from(mix.disjoint) + u64::from(mix.same_file_hunks) {
                            EditClass::SameFileHunks
                        } else {
                            EditClass::Overlapping
                        };
                        Edit {
                            round,
                            class,
                            token: rng.next(),
                        }
                    })
                    .collect()
            })
            .collect();
        Self { agents }
    }

    /// The edits of the agent at `index`, or none for an agent outside the plan.
    #[must_use]
    pub fn agent(&self, index: usize) -> &[Edit] {
        self.agents.get(index).map_or(&[], Vec::as_slice)
    }
}

/// `SplitMix64`, as Steele, Lea and Flood define it.
struct SplitMix64(u64);

impl SplitMix64 {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EVEN: Mix = Mix {
        disjoint: 1,
        same_file_hunks: 1,
        overlapping: 1,
    };

    #[test]
    fn splitmix_matches_its_reference_sequence() {
        // The first outputs for seed 1234567 from the reference implementation.
        let mut rng = SplitMix64(1_234_567);
        assert_eq!(rng.next(), 6_457_827_717_110_365_317);
        assert_eq!(rng.next(), 3_203_168_211_198_807_973);
        assert_eq!(rng.next(), 9_817_491_932_198_370_423);
    }

    #[test]
    fn the_same_seed_gives_the_same_plan() {
        let first = Plan::new(42, 8, 5, EVEN);
        assert_eq!(first, Plan::new(42, 8, 5, EVEN));
        assert_ne!(first, Plan::new(43, 8, 5, EVEN));
        assert_eq!(first.agent(7).len(), 5);
        assert_eq!(
            first.agent(3).iter().map(|e| e.round).collect::<Vec<_>>(),
            [0, 1, 2, 3, 4]
        );
    }

    #[test]
    fn a_plan_follows_its_mix() {
        let only = |mix: Mix, class: EditClass| {
            let plan = Plan::new(9, 4, 25, mix);
            (0..4).all(|agent| plan.agent(agent).iter().all(|edit| edit.class == class))
        };
        let zero = Mix {
            disjoint: 0,
            same_file_hunks: 0,
            overlapping: 0,
        };
        assert!(only(
            Mix {
                disjoint: 1,
                ..zero
            },
            EditClass::Disjoint
        ));
        assert!(only(
            Mix {
                same_file_hunks: 5,
                ..zero
            },
            EditClass::SameFileHunks
        ));
        assert!(only(
            Mix {
                overlapping: 1000,
                ..zero
            },
            EditClass::Overlapping
        ));
        let mixed = Plan::new(9, 8, 25, EVEN);
        for class in [
            EditClass::Disjoint,
            EditClass::SameFileHunks,
            EditClass::Overlapping,
        ] {
            assert!(
                (0..8).any(|agent| mixed.agent(agent).iter().any(|e| e.class == class)),
                "{class} was never planned"
            );
        }
    }

    #[test]
    fn an_agent_outside_the_plan_has_no_edits() {
        assert_eq!(Plan::new(1, 2, 1, EVEN).agent(2), []);
    }

    fn edit(class: EditClass) -> Edit {
        Edit {
            round: 3,
            class,
            token: 0xabc,
        }
    }

    #[test]
    fn a_hunk_edit_rewrites_only_its_slot() -> anyhow::Result<()> {
        let [(path, shared), _] = scaffold();
        assert_eq!(path, SHARED_PATH);
        let edit = edit(EditClass::SameFileHunks);
        assert_eq!(edit.path("swarm-05"), SHARED_PATH);
        let written = edit.apply(5, "swarm-05", Some(&shared))?;
        let changed: Vec<(&str, &str)> = shared
            .lines()
            .zip(written.lines())
            .filter(|(before, after)| before != after)
            .collect();
        assert_eq!(
            changed,
            [(
                "slot 05: open",
                "slot 05: swarm-05 round 3 0000000000000abc"
            )]
        );
        assert_eq!(shared.lines().count(), written.lines().count());
        Ok(())
    }

    #[test]
    fn an_overlapping_edit_rewrites_the_contested_line() -> anyhow::Result<()> {
        let [_, (path, contested)] = scaffold();
        assert_eq!(path, CONTESTED_PATH);
        let written = edit(EditClass::Overlapping).apply(0, "swarm-01", Some(&contested))?;
        assert!(written.ends_with("\ncontested: swarm-01 round 3 0000000000000abc\n"));
        // Applying it again to its own result keeps one contested line.
        let again = edit(EditClass::Overlapping).apply(0, "swarm-02", Some(&written))?;
        assert_eq!(again.matches("contested: ").count(), 1);
        Ok(())
    }

    #[test]
    fn a_disjoint_edit_writes_a_file_of_its_own() -> anyhow::Result<()> {
        let edit = edit(EditClass::Disjoint);
        assert!(!edit.needs_scaffold());
        assert_eq!(edit.path("swarm-00"), "swarm/agents/swarm-00/round-003.txt");
        assert_eq!(
            edit.apply(0, "swarm-00", None)?,
            "swarm-00 round 3 0000000000000abc\n"
        );
        Ok(())
    }

    #[test]
    fn a_shared_edit_needs_the_scaffold_and_never_rewrites_foreign_text() {
        for class in [EditClass::SameFileHunks, EditClass::Overlapping] {
            assert!(edit(class).needs_scaffold());
            assert_eq!(
                edit(class).apply(0, "swarm-00", None),
                Err(ApplyError::NoScaffold)
            );
            assert_eq!(
                edit(class).apply(0, "swarm-00", Some("someone else's file\n")),
                Err(ApplyError::Unrecognised)
            );
        }
    }

    #[test]
    fn the_scaffold_has_a_slot_for_every_agent() {
        let [(_, shared), _] = scaffold();
        assert!(shared.contains("slot 00: open\n--\n--\nslot 01: open\n"));
        assert!(shared.contains(&format!("slot {:02}: open\n", MAX_AGENTS - 1)));
        assert!(!shared.contains(&format!("slot {MAX_AGENTS:02}:")));
        assert_eq!(scaffold(), scaffold());
    }
}
