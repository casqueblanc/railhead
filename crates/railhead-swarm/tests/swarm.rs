//! `railhead-swarm` end to end: the built driver runs real `rh` processes against a fake backend
//! that speaks the agent wire, with real bare Git repositories for main and every claim's fork.
//!
//! The fake's train lands claims in waves: it hands out claims until a wave is full, then lands
//! the wave once every claim in it is ready, in the order they were pinned, with `git merge-tree`.
//! A clean merge moves main; a conflict reopens the claim at the next generation and routes a
//! `conflict` inbox item to its agent. By default the agent's status keeps showing its last claim
//! once it merged, the positive evidence the driver needs to count a landing; the real backend
//! does not show it yet (#237), and [`Status::HidesClosed`] reproduces that: the driver reports
//! such a task as unverified. Git reaches the fake's repositories through a `url.<dir>.insteadOf` rewrite of
//! the origin's `/git/` URLs, so every remote keeps the address the backend named.
//!
//! The agents and the backend are both simulated; nothing here measures Railhead itself.

use std::fmt::Write as _;
use std::fs;
use std::io::{BufRead as _, BufReader, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock, PoisonError};

use railhead_protocol::AgentErrorCode;
use serde_json::{Value, json};
use wiremock::{MockServer, Request, Respond, ResponseTemplate};

const PREFIX: &str = "/agent/v1/casqueblanc/demo";
const SCAFFOLD_SHARED_HEADER: &str = "# Railhead swarm demo (simulated agents)";
/// How late the fake answers a request whose answer is lost: past every command timeout the
/// tests that use it set.
const LATE: std::time::Duration = std::time::Duration::from_secs(12);

/// The `rh` binary beside the driver. A workspace test run builds it; a run of this package
/// alone builds it here, into a target directory of its own so the outer build's lock is not
/// needed.
fn rh_binary() -> anyhow::Result<PathBuf> {
    static RH: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    RH.get_or_init(|| {
        let driver = Path::new(env!("CARGO_BIN_EXE_railhead-swarm"));
        let name = format!("rh{}", std::env::consts::EXE_SUFFIX);
        let beside = driver.with_file_name(&name);
        if beside.is_file() {
            return Ok(beside);
        }
        let profile_dir = driver.parent().ok_or("no target directory")?;
        let target = profile_dir
            .parent()
            .ok_or("no target directory")?
            .join("railhead-swarm-rh");
        let mut build = Command::new(option_env!("CARGO").unwrap_or("cargo"));
        build
            .args([
                "build", "--quiet", "--locked", "-p", "railhead", "--bin", "rh",
            ])
            .arg("--target-dir")
            .arg(&target);
        if profile_dir.ends_with("release") {
            build.arg("--release");
        }
        let status = build.status().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("building rh failed".to_owned());
        }
        Ok(target
            .join(profile_dir.file_name().ok_or("no profile")?)
            .join(name))
    })
    .clone()
    .map_err(anyhow::Error::msg)
}

fn git(dir: &Path, args: &[&str]) -> anyhow::Result<String> {
    let output = git_command(dir, args).output()?;
    anyhow::ensure!(output.status.success(), "git {args:?} failed");
    Ok(String::from_utf8(output.stdout)?.trim_end().to_owned())
}

fn git_command(dir: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "train")
        .env("GIT_AUTHOR_EMAIL", "train@example.invalid")
        .env("GIT_COMMITTER_NAME", "train")
        .env("GIT_COMMITTER_EMAIL", "train@example.invalid")
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    command
}

fn json_response(status: u16, body: &Value) -> ResponseTemplate {
    ResponseTemplate::new(status).set_body_raw(body.to_string(), "application/json")
}

fn failure(code: AgentErrorCode, retry_after_ms: Option<u64>) -> ResponseTemplate {
    let spec = code.spec();
    let next = spec
        .next
        .map(|next| serde_json::to_value(next).unwrap_or(Value::Null));
    json_response(
        spec.status,
        &json!({"ok": false, "error": {"code": code, "message": "Refused by the fake.",
            "retryable": spec.retryable, "retryAfterMs": retry_after_ms, "next": next}}),
    )
}

fn success(data: &Value, inbox: &Value) -> ResponseTemplate {
    json_response(
        200,
        &json!({"ok": true, "data": data, "inbox": inbox, "next": null}),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClaimState {
    Working,
    Ready,
    Merged,
    Expired,
}

/// What the fake's `status` shows once a claim closes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status {
    /// The agent's last claim, merged included.
    ShowsMerged,
    /// Only an active claim, as the real backend does today.
    HidesClosed,
    /// The last claim, but a ready claim expires on the poll after the first that saw it ready.
    ExpiresReady,
}

#[derive(Debug)]
struct Claim {
    id: String,
    issue: String,
    agent: usize,
    generation: u64,
    state: ClaimState,
    base: String,
    ready_commit: Option<String>,
    ready_seq: u64,
}

/// How the fake loses the answer to a request it carried out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lost {
    /// It arrives after the command timeout.
    Late,
    /// A retryable `busy` replaces it, as from a proxy that gave up on the backend.
    Busy,
}

/// What an inbox item asks of its agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Conflict,
    Decision,
    Rework,
}

#[derive(Debug)]
struct Item {
    number: u64,
    agent: usize,
    claim_id: String,
    kind: Kind,
    other: String,
    path: String,
    plan: Option<String>,
}

#[derive(Debug, Default)]
struct State {
    claims: Vec<Claim>,
    items: Vec<Item>,
    /// Indexes of the claims in the current wave.
    wave: Vec<usize>,
    /// The claim that landed last.
    last_landed: Option<String>,
    seq: u64,
    readies: u64,
    /// Whether the train holds every pinned claim.
    paused: bool,
    /// Status requests that pass before the train moves on one.
    held_polls: u64,
    /// Polls that saw a ready claim, for [`Status::ExpiresReady`].
    ready_polls: u64,
    /// Whether `ready` answers nothing in time and records nothing.
    stall_ready: bool,
    /// How the answer to the next `ready`, which is recorded, is lost.
    lose_ready: Option<Lost>,
    /// An owner's item the next `ready` routes to its claim and refuses on.
    decide_on_ready: Option<Kind>,
}

/// The fake backend.
struct Fake {
    uri: String,
    root: PathBuf,
    wave_size: usize,
    status: Status,
    state: Mutex<State>,
}

impl Fake {
    fn main_repo(&self) -> PathBuf {
        self.root.join("git/casqueblanc/demo.git")
    }

    fn fork(&self, claim_id: &str) -> PathBuf {
        self.root
            .join(format!("git/casqueblanc/demo/claims/{claim_id}.git"))
    }

    fn view(&self, claim: &Claim) -> Value {
        let state = match claim.state {
            ClaimState::Working => "working",
            ClaimState::Ready => "ready",
            ClaimState::Merged => "merged",
            ClaimState::Expired => "expired",
        };
        json!({"claimId": claim.id, "issueId": claim.issue, "generation": claim.generation,
            "base": claim.base, "state": state, "readyCommit": claim.ready_commit,
            "originUrl": format!("{}/git/casqueblanc/demo/claims/{}.git", self.uri, claim.id),
            "upstreamUrl": format!("{}/git/casqueblanc/demo.git", self.uri),
            "task": {"title": "Simulated task", "body": "Edit as the scenario plans."}})
    }

    fn item_view(item: &Item) -> Value {
        let kind = match item.kind {
            Kind::Conflict => {
                return json!({"item": item.number, "claimId": item.claim_id, "queuedAt": 1,
                    "entry": {"kind": "conflict", "otherClaimId": item.other, "path": item.path},
                    "decision": null});
            }
            Kind::Decision => "decision",
            Kind::Rework => "rework",
        };
        // The owner chose an edit other than the one the agent's script writes.
        json!({"item": item.number, "claimId": item.claim_id, "queuedAt": 1,
            "entry": {"kind": kind, "decision": {"decisionId": "dec_swarm1", "version": 2}},
            "decision": {"decisionId": "dec_swarm1", "version": 2, "supersedes": 1,
                "questionId": "qst_swarm1", "question": "Which file should the edit change?",
                "option": {"key": "other", "label": "Another file"},
                "previous": {"key": "planned", "label": "The planned file"},
                "scope": [item.path], "decidedBy": "usr_lemarier", "decidedAt": 1}})
    }

    fn digest(state: &State, agent: usize) -> Value {
        let pending: Vec<Value> = state
            .items
            .iter()
            .filter(|item| item.agent == agent && item.plan.is_none())
            .map(Self::item_view)
            .collect();
        json!({"pending": pending.len(), "items": pending.into_iter().take(8).collect::<Vec<_>>()})
    }

    fn active(state: &State, agent: usize) -> Option<usize> {
        state.claims.iter().position(|claim| {
            claim.agent == agent && matches!(claim.state, ClaimState::Working | ClaimState::Ready)
        })
    }

    /// The claim `status` shows the agent.
    fn shown(&self, state: &mut State, agent: usize) -> Option<usize> {
        let last = state.claims.iter().rposition(|claim| claim.agent == agent);
        match self.status {
            Status::ShowsMerged => last,
            Status::HidesClosed => Self::active(state, agent),
            Status::ExpiresReady => {
                let claim = last.and_then(|index| state.claims.get_mut(index))?;
                if claim.state == ClaimState::Ready {
                    state.ready_polls += 1;
                    if state.ready_polls > 1 {
                        claim.state = ClaimState::Expired;
                    }
                }
                // Like the real backend, an expired claim leaves the status.
                Self::active(state, agent)
            }
        }
    }

    fn agent_view(agent: usize) -> Value {
        json!({"agentId": format!("agt_swarm{agent:02}"), "name": format!("swarm-{agent:02}"),
            "ownerId": "usr_lemarier", "state": "confirmed"})
    }

    fn work(&self, state: &mut State, agent: usize) -> anyhow::Result<ResponseTemplate> {
        if let Some(index) = Self::active(state, agent) {
            let claim = state.claims.get(index).map(|claim| self.view(claim));
            return Ok(success(
                &json!({"claim": claim, "resumed": true}),
                &Self::digest(state, agent),
            ));
        }
        if state.wave.len() >= self.wave_size {
            return Ok(failure(AgentErrorCode::NoWork, Some(50)));
        }
        let number = state.claims.len();
        let id = format!("clm_swarm{number:04}");
        let main = self.main_repo();
        let base = git(&main, &["rev-parse", "refs/heads/main"])?;
        let fork = self.fork(&id);
        git(
            &self.root,
            &[
                "clone",
                "--quiet",
                "--bare",
                &main.display().to_string(),
                &fork.display().to_string(),
            ],
        )?;
        state.claims.push(Claim {
            id,
            issue: format!("iss_swarm{number:04}"),
            agent,
            generation: 1,
            state: ClaimState::Working,
            base,
            ready_commit: None,
            ready_seq: 0,
        });
        state.wave.push(number);
        let claim = state.claims.last().map(|claim| self.view(claim));
        Ok(success(
            &json!({"claim": claim, "resumed": false}),
            &Self::digest(state, agent),
        ))
    }

    fn ready(
        &self,
        state: &mut State,
        agent: usize,
        claim_id: &str,
        body: &Value,
    ) -> anyhow::Result<ResponseTemplate> {
        let Some(index) = state
            .claims
            .iter()
            .position(|claim| claim.id == claim_id && claim.agent == agent)
        else {
            return Ok(failure(AgentErrorCode::NotFound, None));
        };
        let generation = body.get("generation").and_then(Value::as_u64);
        let commit = body
            .get("commit")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let Some(claim) = state.claims.get(index) else {
            return Ok(failure(AgentErrorCode::NotFound, None));
        };
        if claim.state != ClaimState::Working || generation != Some(claim.generation) {
            return Ok(failure(AgentErrorCode::StaleGeneration, None));
        }
        let pushed = git(&self.fork(claim_id), &["rev-parse", "refs/heads/main"])?;
        if pushed != commit {
            return Ok(failure(AgentErrorCode::CommitNotFound, None));
        }
        if let Some(kind) = state.decide_on_ready.take() {
            let number = u64::try_from(state.items.len())? + 1;
            state.items.push(Item {
                number,
                agent,
                claim_id: claim_id.to_owned(),
                kind,
                other: String::new(),
                path: "swarm".to_owned(),
                plan: None,
            });
        }
        if state
            .items
            .iter()
            .any(|item| item.claim_id == claim_id && item.plan.is_none())
        {
            return Ok(failure(AgentErrorCode::UnackedDecision, None));
        }
        state.seq += 1;
        state.readies += 1;
        let seq = state.seq;
        if let Some(claim) = state.claims.get_mut(index) {
            claim.state = ClaimState::Ready;
            claim.ready_commit = Some(commit);
            claim.ready_seq = seq;
        }
        self.land(state)?;
        let claim = state.claims.get(index).map(|claim| self.view(claim));
        Ok(success(
            &json!({"claim": claim, "repeated": false}),
            &Self::digest(state, agent),
        ))
    }

    /// Lands the wave once it is full and every claim in it is ready, unless the train is paused.
    fn land(&self, state: &mut State) -> anyhow::Result<()> {
        if state.paused {
            return Ok(());
        }
        let waiting: Vec<usize> = state
            .wave
            .iter()
            .copied()
            .filter(|&i| {
                state
                    .claims
                    .get(i)
                    .is_some_and(|c| c.state != ClaimState::Merged)
            })
            .collect();
        let all_ready = waiting.iter().all(|&i| {
            state
                .claims
                .get(i)
                .is_some_and(|c| c.state == ClaimState::Ready)
        });
        if state.wave.len() < self.wave_size || !all_ready {
            return Ok(());
        }
        let mut order = waiting;
        order.sort_by_key(|&i| state.claims.get(i).map_or(0, |c| c.ready_seq));
        for index in order {
            self.merge(state, index)?;
        }
        let done = state.wave.iter().all(|&i| {
            state
                .claims
                .get(i)
                .is_some_and(|c| c.state == ClaimState::Merged)
        });
        if done {
            state.wave.clear();
        }
        Ok(())
    }

    /// Merges one pinned claim into main, or reopens it and routes the conflict to its agent.
    fn merge(&self, state: &mut State, index: usize) -> anyhow::Result<()> {
        let main = self.main_repo();
        let Some(claim) = state.claims.get(index) else {
            return Ok(());
        };
        let id = claim.id.clone();
        let pin = format!("refs/swarm/{id}");
        git(
            &main,
            &[
                "fetch",
                "--quiet",
                &self.fork(&id).display().to_string(),
                &format!("+refs/heads/main:{pin}"),
            ],
        )?;
        let merge = git_command(
            &main,
            &[
                "merge-tree",
                "--write-tree",
                "--name-only",
                "--no-messages",
                "refs/heads/main",
                &pin,
            ],
        )
        .output()?;
        let printed = String::from_utf8(merge.stdout)?;
        let mut lines = printed.lines();
        let tree = lines.next().unwrap_or_default().to_owned();
        if merge.status.success() {
            let head = git(&main, &["rev-parse", "refs/heads/main"])?;
            let fast_forward = git_command(&main, &["merge-base", "--is-ancestor", &head, &pin])
                .status()?
                .success();
            let landed = if fast_forward {
                git(&main, &["rev-parse", &pin])?
            } else {
                git(
                    &main,
                    &[
                        "commit-tree",
                        &tree,
                        "-p",
                        &head,
                        "-p",
                        &pin,
                        "-m",
                        &format!("Land {id}"),
                    ],
                )?
            };
            git(&main, &["update-ref", "refs/heads/main", &landed])?;
            if let Some(claim) = state.claims.get_mut(index) {
                claim.state = ClaimState::Merged;
            }
            state.last_landed = Some(id);
        } else {
            let path = lines.next().unwrap_or("unknown").to_owned();
            let other = state.last_landed.clone().unwrap_or_default();
            let mut agent = 0;
            if let Some(claim) = state.claims.get_mut(index) {
                claim.generation += 1;
                claim.state = ClaimState::Working;
                claim.ready_commit = None;
                agent = claim.agent;
            }
            let number = u64::try_from(state.items.len())? + 1;
            state.items.push(Item {
                number,
                agent,
                claim_id: id,
                kind: Kind::Conflict,
                other,
                path,
                plan: None,
            });
        }
        Ok(())
    }

    fn handle(&self, request: &Request) -> anyhow::Result<ResponseTemplate> {
        let token = request
            .headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer swarm.a"))
            .and_then(|rest| rest.strip_suffix(".sig"))
            .and_then(|index| index.parse::<usize>().ok());
        let Some(agent) = token else {
            return Ok(failure(AgentErrorCode::Unauthenticated, None));
        };
        let path = request.url.path().to_owned();
        let Some(route) = path.strip_prefix(PREFIX) else {
            return Ok(failure(AgentErrorCode::NotFound, None));
        };
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let segments: Vec<&str> = route.split('/').skip(1).collect();
        let method = request.method.as_str();
        match (method, segments.as_slice()) {
            ("GET", ["status"]) => {
                // The train also moves between pins, as a real one does.
                if state.held_polls > 0 {
                    state.held_polls -= 1;
                } else {
                    self.land(&mut state)?;
                }
                let claim = self
                    .shown(&mut state, agent)
                    .and_then(|index| state.claims.get(index))
                    .map(|claim| self.view(claim));
                Ok(success(
                    &json!({"agent": Self::agent_view(agent), "claim": claim}),
                    &Self::digest(&state, agent),
                ))
            }
            ("POST", ["work"]) => self.work(&mut state, agent),
            ("POST", ["claims", claim_id, "ready"]) => {
                if state.stall_ready {
                    return Ok(failure(AgentErrorCode::Busy, None).set_delay(LATE));
                }
                let body: Value = serde_json::from_slice(&request.body)?;
                let answer = self.ready(&mut state, agent, claim_id, &body)?;
                Ok(match state.lose_ready.take() {
                    Some(Lost::Late) => answer.set_delay(LATE),
                    Some(Lost::Busy) => failure(AgentErrorCode::Busy, Some(0)),
                    None => answer,
                })
            }
            ("GET", ["inbox"]) => {
                let digest = Self::digest(&state, agent);
                Ok(success(&digest, &digest))
            }
            ("POST", ["inbox", number, "ack"]) => {
                let body: Value = serde_json::from_slice(&request.body)?;
                let plan = body.get("plan").and_then(Value::as_str).unwrap_or_default();
                let number: u64 = number.parse()?;
                let Some(item) = state
                    .items
                    .iter_mut()
                    .find(|item| item.number == number && item.agent == agent)
                else {
                    return Ok(failure(AgentErrorCode::NotFound, None));
                };
                let repeated = item.plan.is_some();
                let plan = item.plan.get_or_insert_with(|| plan.to_owned()).clone();
                let digest = Self::digest(&state, agent);
                Ok(success(
                    &json!({"item": number, "plan": plan, "ackedAt": 2, "repeated": repeated}),
                    &digest,
                ))
            }
            _ => Ok(failure(AgentErrorCode::NotFound, None)),
        }
    }
}

struct Responder(std::sync::Arc<Fake>);

impl Respond for Responder {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        self.0
            .handle(request)
            .unwrap_or_else(|_| failure(AgentErrorCode::Internal, None))
    }
}

/// A fake backend, its repositories, the agents' homes and a working directory for the run.
struct World {
    server: MockServer,
    fake: std::sync::Arc<Fake>,
    dir: tempfile::TempDir,
}

fn write_private(path: &Path, contents: &str) -> anyhow::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)?.write_all(contents.as_bytes())?;
    Ok(())
}

fn private_dir(path: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
    Ok(())
}

/// A world with `agents` joined agents and a main holding a README, plus the scaffold when
/// `scaffolded`.
async fn world(agents: usize, wave_size: usize, scaffolded: bool) -> anyhow::Result<World> {
    world_with(agents, wave_size, scaffolded, Status::ShowsMerged).await
}

async fn world_with(
    agents: usize,
    wave_size: usize,
    scaffolded: bool,
    status: Status,
) -> anyhow::Result<World> {
    let server = MockServer::builder().start().await;
    let dir = tempfile::tempdir()?;
    let root = dir.path().join("backend");
    let uri = server.uri();

    for agent in 0..agents {
        let name = format!("swarm-{agent:02}");
        let home = dir.path().join("homes").join(&name);
        private_dir(&home.join("agents").join(&name))?;
        private_dir(&home.join("agents"))?;
        let identity = json!({"name": name, "agentId": format!("agt_swarm{agent:02}"),
            "origin": uri, "repo": "casqueblanc/demo"});
        write_private(
            &home.join("agents").join(&name).join("identity.json"),
            &identity.to_string(),
        )?;
        let session = json!({"agentId": format!("agt_swarm{agent:02}"), "origin": uri,
            "repo": "casqueblanc/demo", "token": format!("swarm.a{agent:02}.sig"),
            "expiresAt": 4_102_444_800_000_u64});
        write_private(
            &home.join("agents").join(&name).join("session"),
            &session.to_string(),
        )?;
    }

    let seed = dir.path().join("seed");
    fs::create_dir_all(&seed)?;
    git(&seed, &["init", "--quiet", "--initial-branch", "main"])?;
    fs::write(seed.join("README.md"), "demo\n")?;
    if scaffolded {
        fs::create_dir_all(seed.join("swarm"))?;
        let mut shared = format!("{SCAFFOLD_SHARED_HEADER}: each agent rewrites only its slot.\n");
        for slot in 0..64 {
            write!(shared, "slot {slot:02}: open\n--\n--\n")?;
        }
        fs::write(seed.join("swarm/shared.txt"), shared)?;
        fs::write(
            seed.join("swarm/contested.txt"),
            format!(
                "{SCAFFOLD_SHARED_HEADER}: every overlapping edit rewrites the next line.\ncontested: open\n"
            ),
        )?;
    }
    git(&seed, &["add", "--all"])?;
    git(&seed, &["commit", "--quiet", "-m", "base"])?;
    let main = root.join("git/casqueblanc/demo.git");
    fs::create_dir_all(root.join("git/casqueblanc/demo/claims"))?;
    git(
        dir.path(),
        &[
            "init",
            "--quiet",
            "--bare",
            "--initial-branch",
            "main",
            &main.display().to_string(),
        ],
    )?;
    git(
        &seed,
        &["push", "--quiet", &main.display().to_string(), "main"],
    )?;

    fs::write(
        dir.path().join("gitconfig"),
        format!(
            "[url \"file://{}/git/\"]\n\tinsteadOf = {uri}/git/\n",
            root.display()
        ),
    )?;
    fs::create_dir_all(dir.path().join("work"))?;

    let fake = std::sync::Arc::new(Fake {
        uri,
        root,
        wave_size,
        status,
        state: Mutex::new(State::default()),
    });
    wiremock::Mock::given(wiremock::matchers::any())
        .respond_with(Responder(std::sync::Arc::clone(&fake)))
        .mount(&server)
        .await;
    Ok(World { server, fake, dir })
}

impl World {
    fn scenario(
        &self,
        agents: usize,
        repository: &str,
        mix: &Value,
        bounds: &Value,
    ) -> anyhow::Result<PathBuf> {
        self.scenario_of(agents, 1, repository, mix, bounds)
    }

    fn scenario_of(
        &self,
        agents: usize,
        rounds: u32,
        repository: &str,
        mix: &Value,
        bounds: &Value,
    ) -> anyhow::Result<PathBuf> {
        let path = self.dir.path().join("scenario.json");
        let scenario = json!({"seed": 211, "origin": self.server.uri(), "repository": repository,
            "agents": agents, "rounds": rounds, "mix": mix, "bounds": bounds});
        fs::write(&path, scenario.to_string())?;
        Ok(path)
    }

    fn driver(&self, scenario: &Path) -> anyhow::Result<Command> {
        let mut command = Command::new(env!("CARGO_BIN_EXE_railhead-swarm"));
        command
            .arg("--scenario")
            .arg(scenario)
            .arg("--homes")
            .arg(self.dir.path().join("homes"))
            .arg("--rh")
            .arg(rh_binary()?)
            .arg("--workdir")
            .arg(self.dir.path().join("work"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.dir.path().join("gitconfig"))
            .env_remove("RAILHEAD_AGENT")
            .env_remove("RAILHEAD_HOME")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        Ok(command)
    }

    fn main_file(&self, path: &str) -> anyhow::Result<String> {
        git(&self.fake.main_repo(), &["show", &format!("main:{path}")])
    }

    fn work_is_empty(&self) -> anyhow::Result<bool> {
        Ok(fs::read_dir(self.dir.path().join("work"))?.next().is_none())
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.fake
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn progress_file(&self, agent: &str) -> PathBuf {
        self.dir
            .path()
            .join("homes/progress")
            .join(format!("{agent}.json"))
    }
}

/// A finished run: its exit code and every line it printed.
struct Run {
    code: Option<i32>,
    events: Vec<Value>,
}

impl Run {
    fn of_type(&self, kind: &str) -> Vec<&Value> {
        self.events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some(kind))
            .collect()
    }

    fn summary(&self) -> anyhow::Result<&Value> {
        let last = self
            .events
            .last()
            .ok_or_else(|| anyhow::anyhow!("no events"))?;
        anyhow::ensure!(
            last.get("type") == Some(&json!("summary")),
            "the last line is not the summary"
        );
        Ok(last)
    }

    fn total(&self, field: &str) -> Option<u64> {
        self.summary().ok()?.get(field)?.as_u64()
    }

    /// The types of `agent`'s events, in order.
    fn steps_of(&self, agent: &str) -> Vec<String> {
        self.events
            .iter()
            .filter(|event| event.get("agent").and_then(Value::as_str) == Some(agent))
            .filter_map(|event| event.get("type").and_then(Value::as_str))
            .filter(|kind| *kind != "agentState")
            .map(str::to_owned)
            .collect()
    }
}

fn run(command: &mut Command) -> anyhow::Result<Run> {
    let output = command.output()?;
    let stdout = String::from_utf8(output.stdout)?;
    // Visible with `--nocapture`, so a run can be watched.
    println!("{stdout}");
    let events = stdout
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<Vec<Value>, _>>()?;
    for event in &events {
        anyhow::ensure!(
            event.get("simulated") == Some(&json!(true)),
            "unmarked event: {event}"
        );
    }
    Ok(Run {
        code: output.status.code(),
        events,
    })
}

/// The file a disjoint edit of the test scenario (seed 211) creates.
fn disjoint_path(agent: &str, round: u32) -> String {
    format!("swarm/agents/{agent}/seed-211-round-{round:03}.txt")
}

fn mix(disjoint: u32, hunks: u32, overlapping: u32) -> Value {
    json!({"disjoint": disjoint, "sameFileHunks": hunks, "overlapping": overlapping})
}

fn fast_bounds() -> Value {
    json!({"retries": 3, "commandTimeoutSecs": 60, "landTimeoutSecs": 60,
        "runTimeoutSecs": 120, "pollMs": 50})
}

#[tokio::test]
async fn disjoint_edits_land_without_conflict() -> anyhow::Result<()> {
    let world = world(2, 2, false).await?;
    let scenario = world.scenario(2, "casqueblanc/demo", &mix(1, 0, 0), &fast_bounds())?;
    let run = run(&mut world.driver(&scenario)?)?;
    assert_eq!(run.code, Some(0));
    for agent in ["swarm-00", "swarm-01"] {
        assert_eq!(
            run.steps_of(agent),
            ["claimed", "pushed", "ready", "landed"],
            "{agent}"
        );
        assert_eq!(
            world.main_file(&disjoint_path(agent, 0))?.split(' ').next(),
            Some(agent)
        );
    }
    for pushed in run.of_type("pushed") {
        assert_eq!(pushed.get("class"), Some(&json!("disjoint")));
    }
    let summary = run.summary()?;
    assert_eq!(
        summary.get("label"),
        Some(&json!("measured on a simulated run"))
    );
    assert_eq!(summary.get("stoppedBy"), Some(&json!("completed")));
    assert_eq!(
        (
            run.total("pushes"),
            run.total("landings"),
            run.total("autoMergedOverlaps"),
            run.total("routedConflicts")
        ),
        (Some(2), Some(2), Some(0), Some(0))
    );
    assert_eq!(summary.pointer("/readyToLanded/samples"), Some(&json!(2)));
    assert_eq!(run.total("agentsDone"), Some(2));
    assert!(world.work_is_empty()?, "the run left clones behind");
    // A finished run leaves nothing to resume.
    assert!(!world.progress_file("swarm-00").exists());
    Ok(())
}

#[tokio::test]
async fn same_file_hunks_land_the_scaffold_then_merge_automatically() -> anyhow::Result<()> {
    let world = world(2, 2, false).await?;
    let scenario = world.scenario(2, "casqueblanc/demo", &mix(0, 1, 0), &fast_bounds())?;
    let run = run(&mut world.driver(&scenario)?)?;
    assert_eq!(run.code, Some(0));
    for agent in ["swarm-00", "swarm-01"] {
        // The scaffold first, as a task of its own, then the planned edit.
        assert_eq!(
            run.steps_of(agent),
            [
                "claimed", "pushed", "ready", "landed", "claimed", "pushed", "ready", "landed"
            ],
            "{agent}"
        );
    }
    let classes: Vec<&Value> = run
        .of_type("pushed")
        .iter()
        .filter_map(|e| e.get("class"))
        .collect();
    assert_eq!(classes.iter().filter(|c| **c == "scaffold").count(), 2);
    assert_eq!(classes.iter().filter(|c| **c == "sameFileHunks").count(), 2);
    let merged = run.of_type("conflictAutoMerged");
    assert_eq!(merged.len(), 1);
    assert_eq!(
        merged.first().and_then(|e| e.get("path")),
        Some(&json!("swarm/shared.txt"))
    );
    // The pair is the two hunk edits, each written on a base without the other's line.
    let mut hunks: Vec<&Value> = run
        .of_type("pushed")
        .into_iter()
        .filter(|e| e.get("class") == Some(&json!("sameFileHunks")))
        .filter_map(|e| e.get("claimId"))
        .collect();
    hunks.sort_by_key(|id| id.as_str().map(str::to_owned));
    let mut paired: Vec<&Value> = merged
        .first()
        .and_then(|e| e.get("claims"))
        .and_then(Value::as_array)
        .map(|claims| claims.iter().collect())
        .unwrap_or_default();
    paired.sort_by_key(|id| id.as_str().map(str::to_owned));
    assert_eq!(paired, hunks);
    // Main holds both agents' slots: Git merged the two hunks.
    let shared = world.main_file("swarm/shared.txt")?;
    assert!(shared.contains("slot 00: swarm-00 round 0 "), "{shared}");
    assert!(shared.contains("slot 01: swarm-01 round 0 "), "{shared}");
    assert_eq!(
        (
            run.total("landings"),
            run.total("autoMergedOverlaps"),
            run.total("routedConflicts"),
            run.total("redos")
        ),
        (Some(4), Some(1), Some(0), Some(0))
    );
    Ok(())
}

#[tokio::test]
async fn overlapping_edits_are_routed_and_redone_until_they_land() -> anyhow::Result<()> {
    let world = world(3, 3, true).await?;
    let scenario = world.scenario(3, "casqueblanc/demo", &mix(0, 0, 1), &fast_bounds())?;
    let run = run(&mut world.driver(&scenario)?)?;
    assert_eq!(run.code, Some(0), "{:?}", run.of_type("failed"));
    // The first pin lands; each later one conflicts with the one before it, is redone on the new
    // main and lands: 2 conflicts in the first wave, 1 more between the two redos.
    assert_eq!(
        (
            run.total("landings"),
            run.total("routedConflicts"),
            run.total("redos"),
            run.total("autoMergedOverlaps")
        ),
        (Some(3), Some(3), Some(3), Some(0))
    );
    for routed in run.of_type("conflictRouted") {
        assert_eq!(routed.get("path"), Some(&json!("swarm/contested.txt")));
        assert!(
            routed
                .get("otherClaimId")
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with("clm_"))
        );
    }
    assert_eq!(run.of_type("acknowledged").len(), 3);
    for redo in run.of_type("redo") {
        assert!(
            redo.get("generation")
                .and_then(Value::as_u64)
                .is_some_and(|g| g >= 2)
        );
    }
    let landed_last = run
        .of_type("landed")
        .last()
        .and_then(|e| e.get("agent"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_default();
    let contested = world.main_file("swarm/contested.txt")?;
    assert!(
        contested.contains(&format!("contested: {landed_last} round 0 ")),
        "{contested}"
    );
    assert_eq!(contested.matches("contested: ").count(), 1);
    Ok(())
}

#[tokio::test]
async fn a_home_joined_to_another_repository_starts_nothing() -> anyhow::Result<()> {
    let world = world(1, 1, false).await?;
    // The agent is joined to casqueblanc/demo; the scenario names another repository.
    let scenario = world.scenario(1, "casqueblanc/other", &mix(1, 0, 0), &fast_bounds())?;
    let output = world.driver(&scenario)?.output()?;
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(output.stdout, b"");
    let stderr = String::from_utf8(output.stderr)?;
    assert!(
        stderr.contains("agent swarm-00 in ")
            && stderr.contains("joined another origin or repository"),
        "{stderr}"
    );
    // Not one request reached the backend the home is joined to: no claim, no fork.
    assert!(
        world
            .server
            .received_requests()
            .await
            .unwrap_or_default()
            .is_empty()
    );
    assert!(world.state().claims.is_empty());
    let forks = world.fake.root.join("git/casqueblanc/demo/claims");
    assert_eq!(fs::read_dir(forks)?.count(), 0);
    Ok(())
}

#[tokio::test]
async fn a_claim_that_closes_without_evidence_is_unverified_not_a_landing() -> anyhow::Result<()> {
    // The fake lands the claim but, like today's backend, drops it from the status.
    let world = world_with(1, 1, false, Status::HidesClosed).await?;
    let scenario = world.scenario_of(1, 2, "casqueblanc/demo", &mix(1, 0, 0), &fast_bounds())?;
    let run = run(&mut world.driver(&scenario)?)?;
    // Unverified is not a failure: the agent goes on with its plan and the run exits 0.
    assert_eq!(run.code, Some(0), "{:?}", run.of_type("failed"));
    assert_eq!(
        run.steps_of("swarm-00"),
        [
            "claimed",
            "pushed",
            "ready",
            "unverified",
            "claimed",
            "pushed",
            "ready",
            "unverified"
        ]
    );
    for unverified in run.of_type("unverified") {
        assert_eq!(
            unverified.get("needs"),
            Some(&json!("casqueblanc/railhead#237"))
        );
        assert_eq!(unverified.get("class"), Some(&json!("disjoint")));
    }
    assert_eq!(
        (
            run.total("landings"),
            run.total("unverified"),
            run.total("failures"),
            run.total("agentsDone")
        ),
        (Some(0), Some(2), Some(0), Some(1))
    );
    // The fake did land both, but the agent had no evidence of it, so neither counts.
    assert!(
        world
            .main_file(&disjoint_path("swarm-00", 1))?
            .starts_with("swarm-00 ")
    );
    assert_eq!(
        run.summary()?.pointer("/readyToLanded/samples"),
        Some(&json!(0))
    );
    Ok(())
}

#[tokio::test]
async fn a_ready_claim_that_expires_between_polls_is_not_a_landing() -> anyhow::Result<()> {
    // A wave of 2 with one agent never lands; the ready claim expires on the second poll and
    // leaves the status, which cannot say so until #237: it is unverified, never landed.
    let world = world_with(1, 2, false, Status::ExpiresReady).await?;
    let scenario = world.scenario(1, "casqueblanc/demo", &mix(1, 0, 0), &fast_bounds())?;
    let run = run(&mut world.driver(&scenario)?)?;
    assert_eq!(run.code, Some(0), "{:?}", run.of_type("failed"));
    assert_eq!(
        run.steps_of("swarm-00"),
        ["claimed", "pushed", "ready", "unverified"]
    );
    assert_eq!(
        (run.total("landings"), run.total("unverified")),
        (Some(0), Some(1))
    );
    assert_eq!(world.state().ready_polls, 2);
    assert!(
        world.main_file(&disjoint_path("swarm-00", 0)).is_err(),
        "main changed although nothing landed"
    );
    Ok(())
}

#[tokio::test]
async fn a_claim_that_never_lands_stalls_its_agent() -> anyhow::Result<()> {
    // A wave of 2 with one agent never fills, so the train never lands.
    let world = world(1, 2, false).await?;
    let bounds = json!({"landTimeoutSecs": 1, "runTimeoutSecs": 60, "pollMs": 50});
    let scenario = world.scenario(1, "casqueblanc/demo", &mix(1, 0, 0), &bounds)?;
    let run = run(&mut world.driver(&scenario)?)?;
    assert_eq!(run.code, Some(1));
    assert_eq!(
        run.steps_of("swarm-00"),
        ["claimed", "pushed", "ready", "stalled"]
    );
    assert_eq!(
        (run.total("stalls"), run.total("landings")),
        (Some(1), Some(0))
    );
    assert_eq!(
        run.summary()?.pointer("/readyToLanded/p50Ms"),
        Some(&Value::Null)
    );
    Ok(())
}

#[tokio::test]
async fn the_run_timeout_stops_every_agent() -> anyhow::Result<()> {
    let world = world(2, 3, false).await?;
    let bounds = json!({"landTimeoutSecs": 60, "runTimeoutSecs": 2, "pollMs": 50});
    let scenario = world.scenario(2, "casqueblanc/demo", &mix(1, 0, 0), &bounds)?;
    let run = run(&mut world.driver(&scenario)?)?;
    assert_eq!(run.code, Some(1));
    // The train never lands a wave of 3 with 2 agents, so only the timeout can end the run.
    assert_eq!(run.summary()?.get("stoppedBy"), Some(&json!("timedOut")));
    assert_eq!(run.total("landings"), Some(0));
    assert!(world.work_is_empty()?, "the run left clones behind");
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn ctrl_c_stops_the_run_and_removes_its_clones() -> anyhow::Result<()> {
    let world = world(2, 3, false).await?;
    let bounds = json!({"landTimeoutSecs": 60, "runTimeoutSecs": 60, "pollMs": 50});
    let scenario = world.scenario(2, "casqueblanc/demo", &mix(1, 0, 0), &bounds)?;
    let mut child = world.driver(&scenario)?.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("no stdout"))?;
    let mut lines = BufReader::new(stdout).lines();
    let mut events = Vec::new();
    let mut readies = 0;
    while readies < 2 {
        let line = lines
            .next()
            .ok_or_else(|| anyhow::anyhow!("the run ended early"))??;
        let event: Value = serde_json::from_str(&line)?;
        if event.get("type") == Some(&json!("ready")) {
            readies += 1;
        }
        events.push(event);
    }
    // Both agents now hold clones and poll `rh status`.
    assert!(!world.work_is_empty()?);
    let interrupted = Command::new("kill")
        .args(["-INT", &child.id().to_string()])
        .status()?;
    assert!(interrupted.success());
    for line in lines {
        events.push(serde_json::from_str(&line?)?);
    }
    let status = child.wait()?;
    assert_eq!(status.code(), Some(130));
    let summary = events.last().ok_or_else(|| anyhow::anyhow!("no summary"))?;
    assert_eq!(summary.get("type"), Some(&json!("summary")));
    assert_eq!(summary.get("stoppedBy"), Some(&json!("interrupted")));
    assert!(world.work_is_empty()?, "the run left clones behind");
    Ok(())
}

#[tokio::test]
async fn an_invalid_scenario_starts_nothing() -> anyhow::Result<()> {
    let world = world(1, 1, false).await?;
    let path = world.dir.path().join("scenario.json");
    fs::write(
        &path,
        json!({"seed": 1, "origin": world.server.uri(), "repository": "casqueblanc/demo",
            "agents": 65, "rounds": 1, "mix": mix(1, 0, 0)})
        .to_string(),
    )?;
    let output = world.driver(&path)?.output()?;
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(output.stdout, b"");
    assert_eq!(
        String::from_utf8(output.stderr)?,
        "railhead-swarm: agents must be from 1 to 64\n"
    );
    assert!(
        world
            .server
            .received_requests()
            .await
            .unwrap_or_default()
            .is_empty()
    );
    Ok(())
}

/// Runs a two-round scenario until its first claim is pinned, then interrupts it while the train
/// holds that pin. Returns the scenario and the pinned claim.
#[cfg(unix)]
fn interrupt_after_the_first_pin(world: &World) -> anyhow::Result<(PathBuf, String)> {
    let scenario = world.scenario_of(1, 2, "casqueblanc/demo", &mix(1, 0, 0), &fast_bounds())?;
    world.state().paused = true;
    let mut child = world.driver(&scenario)?.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("no stdout"))?;
    let mut lines = BufReader::new(stdout).lines();
    let pinned = loop {
        let line = lines
            .next()
            .ok_or_else(|| anyhow::anyhow!("the run ended early"))??;
        let event: Value = serde_json::from_str(&line)?;
        if event.get("type") == Some(&json!("ready"))
            && let Some(claim) = event.get("claimId").and_then(Value::as_str)
        {
            break claim.to_owned();
        }
    };
    let interrupted = Command::new("kill")
        .args(["-INT", &child.id().to_string()])
        .status()?;
    assert!(interrupted.success());
    for line in lines {
        line?;
    }
    assert_eq!(child.wait()?.code(), Some(130));
    let mut saved: Value =
        serde_json::from_str(&fs::read_to_string(world.progress_file("swarm-00"))?)?;
    let digest = saved
        .as_object_mut()
        .and_then(|record| record.remove("scenario"));
    assert!(
        digest
            .as_ref()
            .and_then(Value::as_str)
            .is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())),
        "{digest:?}"
    );
    assert_eq!(
        saved,
        json!({"seed": 211, "round": 0, "scaffold": false, "claimId": pinned})
    );
    Ok((scenario, pinned))
}

/// Checks a rerun that recorded `pinned` as round 0's landing, then delivered round 1 only.
fn assert_resumed(world: &World, rerun: &Run, pinned: &str) -> anyhow::Result<()> {
    assert_eq!(rerun.code, Some(0), "{:?}", rerun.of_type("failed"));
    let adopted = rerun.of_type("adopted");
    assert_eq!(
        adopted.first().map(|e| (e.get("claimId"), e.get("round"))),
        Some((Some(&json!(pinned)), Some(&json!(0))))
    );
    let landed = rerun.of_type("landed");
    assert_eq!(
        landed
            .first()
            .map(|e| (e.get("claimId"), e.get("class"), e.get("readyToLandedMs"))),
        Some((
            Some(&json!(pinned)),
            Some(&json!("disjoint")),
            Some(&Value::Null)
        ))
    );
    assert_eq!(
        (
            rerun.total("landings"),
            rerun.total("pushes"),
            rerun.total("agentsDone")
        ),
        (Some(2), Some(1), Some(1))
    );
    // Round 0 was not delivered twice: two claims in all, both merged.
    let states: Vec<ClaimState> = world.state().claims.iter().map(|c| c.state).collect();
    assert_eq!(states, [ClaimState::Merged, ClaimState::Merged]);
    for round in [0, 1] {
        assert!(
            world
                .main_file(&disjoint_path("swarm-00", round))?
                .starts_with("swarm-00 ")
        );
    }
    assert!(!world.progress_file("swarm-00").exists());
    assert!(world.work_is_empty()?, "the run left clones behind");
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn an_interrupted_run_adopts_its_pinned_claim_when_run_again() -> anyhow::Result<()> {
    let world = world(1, 1, false).await?;
    let (scenario, pinned) = interrupt_after_the_first_pin(&world)?;
    // The train lands the pin only after the rerun's first status, so `rh work` returns it ready.
    {
        let mut state = world.state();
        state.paused = false;
        state.held_polls = 1;
    }
    let rerun = run(&mut world.driver(&scenario)?)?;
    // The pinned claim is adopted and its outcome recorded before any new edit.
    assert_eq!(
        rerun.steps_of("swarm-00"),
        [
            "claimed", "adopted", "landed", "claimed", "pushed", "ready", "landed"
        ]
    );
    assert_eq!(
        rerun
            .of_type("claimed")
            .first()
            .and_then(|e| e.get("resumed")),
        Some(&json!(true))
    );
    assert_resumed(&world, &rerun, &pinned)
}

#[cfg(unix)]
#[tokio::test]
async fn a_pin_that_merged_between_runs_is_recorded_not_redone() -> anyhow::Result<()> {
    let world = world(1, 1, false).await?;
    let (scenario, pinned) = interrupt_after_the_first_pin(&world)?;
    world.state().paused = false;
    let rerun = run(&mut world.driver(&scenario)?)?;
    assert_eq!(
        rerun.steps_of("swarm-00"),
        ["adopted", "landed", "claimed", "pushed", "ready", "landed"]
    );
    assert_resumed(&world, &rerun, &pinned)
}

#[cfg(unix)]
#[tokio::test]
async fn a_pin_that_closed_between_runs_without_evidence_is_unverified_not_redone()
-> anyhow::Result<()> {
    let world = world_with(1, 1, false, Status::HidesClosed).await?;
    let (scenario, pinned) = interrupt_after_the_first_pin(&world)?;
    world.state().paused = false;
    let rerun = run(&mut world.driver(&scenario)?)?;
    assert_eq!(rerun.code, Some(0), "{:?}", rerun.of_type("failed"));
    assert_eq!(
        rerun.steps_of("swarm-00"),
        [
            "adopted",
            "unverified",
            "claimed",
            "pushed",
            "ready",
            "unverified"
        ]
    );
    assert_eq!(
        rerun
            .of_type("unverified")
            .first()
            .and_then(|e| e.get("claimId")),
        Some(&json!(pinned))
    );
    // Round 0 was not delivered again: one new claim, for round 1.
    assert_eq!(world.state().claims.len(), 2);
    assert_eq!(
        (
            rerun.total("pushes"),
            rerun.total("landings"),
            rerun.total("unverified")
        ),
        (Some(1), Some(0), Some(2))
    );
    Ok(())
}

/// Runs the driver expecting it to refuse to start, and returns what it printed on stderr.
async fn refused(world: &World, command: &mut Command) -> anyhow::Result<String> {
    let requests = world
        .server
        .received_requests()
        .await
        .unwrap_or_default()
        .len();
    let output = command.output()?;
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(output.stdout, b"");
    // Not one more request reached the backend.
    assert_eq!(
        world
            .server
            .received_requests()
            .await
            .unwrap_or_default()
            .len(),
        requests
    );
    Ok(String::from_utf8(output.stderr)?)
}

#[cfg(unix)]
#[tokio::test]
async fn a_rerun_of_a_changed_scenario_refuses_the_old_progress() -> anyhow::Result<()> {
    let world = world(1, 1, false).await?;
    let (_, _) = interrupt_after_the_first_pin(&world)?;
    let record = fs::read_to_string(world.progress_file("swarm-00"))?;
    world.state().paused = false;
    // The same seed, another mix: the pinned claim is not this plan's round 0.
    let changed = world.scenario_of(1, 2, "casqueblanc/demo", &mix(0, 1, 0), &fast_bounds())?;
    let stderr = refused(&world, &mut world.driver(&changed)?).await?;
    assert!(
        stderr.contains("belongs to another scenario or seed")
            && stderr.contains("--discard-progress"),
        "{stderr}"
    );
    assert_eq!(world.state().claims.len(), 1);
    assert_eq!(fs::read_to_string(world.progress_file("swarm-00"))?, record);

    // Discarding the record starts the changed scenario over.
    let rerun = run(world.driver(&changed)?.arg("--discard-progress"))?;
    assert_eq!(rerun.code, Some(0), "{:?}", rerun.of_type("failed"));
    assert!(!world.progress_file("swarm-00").exists());
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn damaged_progress_stops_the_rerun_before_any_request() -> anyhow::Result<()> {
    let world = world(1, 1, false).await?;
    let (scenario, pinned) = interrupt_after_the_first_pin(&world)?;
    world.state().paused = false;
    let path = world.progress_file("swarm-00");
    let record = fs::read_to_string(&path)?;
    for (text, message) in [
        ("not json".to_owned(), "is damaged"),
        (
            record.replace(&pinned, "../../etc"),
            "names an invalid claim",
        ),
    ] {
        fs::write(&path, &text)?;
        let stderr = refused(&world, &mut world.driver(&scenario)?).await?;
        assert!(
            stderr.contains(message) && stderr.contains("--discard-progress"),
            "{stderr}"
        );
        assert_eq!(fs::read_to_string(&path)?, text);
    }
    assert_eq!(world.state().claims.len(), 1);
    Ok(())
}

#[tokio::test]
async fn a_second_run_on_the_same_homes_refuses_to_start() -> anyhow::Result<()> {
    let world = world(1, 1, false).await?;
    let scenario = world.scenario(1, "casqueblanc/demo", &mix(1, 0, 0), &fast_bounds())?;
    let lock = world.dir.path().join("homes/progress/swarm-00.lock");
    private_dir(&world.dir.path().join("homes/progress"))?;
    fs::write(&lock, "4242\n")?;
    let stderr = refused(&world, &mut world.driver(&scenario)?).await?;
    assert!(
        stderr.contains("another run is using agent swarm-00") && stderr.contains("pid 4242"),
        "{stderr}"
    );
    // The other run's lock and state are left alone.
    assert_eq!(fs::read_to_string(&lock)?, "4242\n");
    assert!(!world.progress_file("swarm-00").exists());
    assert!(world.state().claims.is_empty());
    assert!(world.work_is_empty()?);

    // Once it is gone the run goes ahead, and releases the lock when it ends.
    fs::remove_file(&lock)?;
    let run = run(&mut world.driver(&scenario)?)?;
    assert_eq!(run.code, Some(0));
    assert!(!lock.exists());
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn a_planted_symlink_never_redirects_an_edit_outside_the_clone() -> anyhow::Result<()> {
    let world = world(1, 1, false).await?;
    let sentinel = world.dir.path().join("sentinel.txt");
    fs::write(&sentinel, "untouched\n")?;
    // Repository content links the agent's first planned file to a file outside any clone.
    let seed = world.dir.path().join("seed");
    fs::create_dir_all(seed.join("swarm/agents/swarm-00"))?;
    std::os::unix::fs::symlink(&sentinel, seed.join(disjoint_path("swarm-00", 0)))?;
    git(&seed, &["add", "--all"])?;
    git(&seed, &["commit", "--quiet", "-m", "plant a link"])?;
    let main = world.fake.main_repo();
    git(
        &seed,
        &["push", "--quiet", &main.display().to_string(), "main"],
    )?;

    let scenario = world.scenario(1, "casqueblanc/demo", &mix(1, 0, 0), &fast_bounds())?;
    let run = run(&mut world.driver(&scenario)?)?;
    assert_eq!(run.code, Some(1));
    assert_eq!(run.steps_of("swarm-00"), ["claimed", "failed"]);
    assert_eq!(
        run.of_type("failed").first().and_then(|e| e.get("code")),
        Some(&json!("unsafe_path"))
    );
    assert_eq!(fs::read_to_string(&sentinel)?, "untouched\n");
    assert_eq!(run.total("pushes"), Some(0));
    assert!(world.work_is_empty()?, "the run left clones behind");
    Ok(())
}

#[tokio::test]
async fn a_disjoint_edit_never_replaces_a_file_already_on_main() -> anyhow::Result<()> {
    let world = world(1, 1, false).await?;
    // Someone else's file already sits where the agent's first disjoint edit would go.
    let taken = disjoint_path("swarm-00", 0);
    let seed = world.dir.path().join("seed");
    fs::create_dir_all(seed.join("swarm/agents/swarm-00"))?;
    fs::write(seed.join(&taken), "someone else's notes\n")?;
    git(&seed, &["add", "--all"])?;
    git(&seed, &["commit", "--quiet", "-m", "an unrelated file"])?;
    let main = world.fake.main_repo();
    git(
        &seed,
        &["push", "--quiet", &main.display().to_string(), "main"],
    )?;
    let before = git(&main, &["rev-parse", "refs/heads/main"])?;

    let scenario = world.scenario(1, "casqueblanc/demo", &mix(1, 0, 0), &fast_bounds())?;
    let run = run(&mut world.driver(&scenario)?)?;
    assert_eq!(run.code, Some(1));
    assert_eq!(run.steps_of("swarm-00"), ["claimed", "failed"]);
    let failed = run.of_type("failed");
    assert_eq!(
        failed.first().map(|e| (e.get("step"), e.get("code"))),
        Some((Some(&json!("edit")), Some(&json!("path_exists"))))
    );
    // Nothing was pushed, and the file and main are as they were.
    assert_eq!(run.total("pushes"), Some(0));
    let claim = world.state().claims.first().map(|claim| claim.id.clone());
    let fork = world.fake.fork(&claim.unwrap_or_default());
    assert_eq!(git(&fork, &["rev-parse", "refs/heads/main"])?, before);
    assert_eq!(world.main_file(&taken)?, "someone else's notes");
    assert_eq!(git(&main, &["rev-parse", "refs/heads/main"])?, before);
    Ok(())
}

#[tokio::test]
async fn sequential_same_file_edits_are_not_counted_as_auto_merged() -> anyhow::Result<()> {
    // A wave of 1 hands out the next claim only after the last one landed, so each agent's base
    // already holds the edit before it: nothing for Git to merge, whatever order the agents see
    // their landings in.
    let world = world(2, 1, true).await?;
    let bounds = json!({"retries": 10, "commandTimeoutSecs": 60, "landTimeoutSecs": 60,
        "runTimeoutSecs": 120, "pollMs": 50});
    let scenario = world.scenario(2, "casqueblanc/demo", &mix(0, 1, 0), &bounds)?;
    let run = run(&mut world.driver(&scenario)?)?;
    assert_eq!(run.code, Some(0), "{:?}", run.of_type("failed"));
    let shared = world.main_file("swarm/shared.txt")?;
    assert!(shared.contains("slot 00: swarm-00 round 0 "), "{shared}");
    assert!(shared.contains("slot 01: swarm-01 round 0 "), "{shared}");
    assert_eq!(
        (
            run.total("landings"),
            run.total("autoMergedOverlaps"),
            run.total("routedConflicts")
        ),
        (Some(2), Some(0), Some(0))
    );
    assert_eq!(run.of_type("conflictAutoMerged").len(), 0);
    Ok(())
}

/// Bounds whose command timeout gives up on a late answer well before [`LATE`].
fn short_command_bounds() -> Value {
    json!({"retries": 3, "commandTimeoutSecs": 10, "landTimeoutSecs": 60,
        "runTimeoutSecs": 120, "pollMs": 50})
}

#[tokio::test]
async fn a_ready_whose_answer_was_lost_is_read_back_not_repeated() -> anyhow::Result<()> {
    for (lost, status, outcome) in [
        (Lost::Late, Status::ShowsMerged, "landed"),
        (Lost::Busy, Status::ShowsMerged, "landed"),
        (Lost::Busy, Status::HidesClosed, "unverified"),
    ] {
        // The fake records the pin and lands it, but `rh ready` times out or reads a retryable
        // refusal instead of its answer.
        let world = world_with(1, 1, false, status).await?;
        world.state().lose_ready = Some(lost);
        let scenario = world.scenario(
            1,
            "casqueblanc/demo",
            &mix(1, 0, 0),
            &short_command_bounds(),
        )?;
        let run = run(&mut world.driver(&scenario)?)?;
        assert_eq!(
            run.code,
            Some(0),
            "{lost:?} {status:?}: {:?}",
            run.of_type("failed")
        );
        assert_eq!(
            run.steps_of("swarm-00"),
            ["claimed", "pushed", "ready", outcome],
            "{lost:?} {status:?}"
        );
        // One pin; a repeated `rh ready` would have been refused as stale.
        let state = world.state();
        assert_eq!(state.readies, 1, "{lost:?} {status:?}");
        assert_eq!(state.claims.len(), 1, "{lost:?} {status:?}");
        assert_eq!(
            state.claims.first().map(|claim| claim.state),
            Some(ClaimState::Merged)
        );
    }
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn a_run_stopped_between_push_and_ready_finishes_the_pushed_edit() -> anyhow::Result<()> {
    let world = world(1, 1, false).await?;
    let scenario = world.scenario(1, "casqueblanc/demo", &mix(1, 0, 0), &fast_bounds())?;
    // `rh ready` never takes effect, so the run is stopped with the edit pushed and unpinned.
    world.state().stall_ready = true;
    let mut child = world.driver(&scenario)?.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("no stdout"))?;
    let mut lines = BufReader::new(stdout).lines();
    let claim = loop {
        let line = lines
            .next()
            .ok_or_else(|| anyhow::anyhow!("the run ended early"))??;
        let event: Value = serde_json::from_str(&line)?;
        if event.get("type") == Some(&json!("pushed"))
            && let Some(claim) = event.get("claimId").and_then(Value::as_str)
        {
            break claim.to_owned();
        }
    };
    let interrupted = Command::new("kill")
        .args(["-INT", &child.id().to_string()])
        .status()?;
    assert!(interrupted.success());
    for line in lines {
        line?;
    }
    assert_eq!(child.wait()?.code(), Some(130));
    let path = disjoint_path("swarm-00", 0);
    // The fork holds the edit; the claim is still working.
    let pushed = git(&world.fake.fork(&claim), &["show", &format!("main:{path}")])?;
    assert!(pushed.starts_with("swarm-00 round 0 "), "{pushed}");
    assert_eq!(world.state().readies, 0);

    world.state().stall_ready = false;
    let rerun = run(&mut world.driver(&scenario)?)?;
    assert_eq!(rerun.code, Some(0), "{:?}", rerun.of_type("failed"));
    assert_eq!(
        rerun.steps_of("swarm-00"),
        ["claimed", "pushed", "ready", "landed"]
    );
    assert_eq!(
        rerun
            .of_type("claimed")
            .first()
            .map(|e| (e.get("claimId"), e.get("resumed"))),
        Some((Some(&json!(claim)), Some(&json!(true))))
    );
    // One claim, one pin and the edit written once.
    let state = world.state();
    assert_eq!(state.claims.len(), 1);
    assert_eq!(state.readies, 1);
    drop(state);
    assert_eq!(world.main_file(&path)?, pushed);
    assert!(!world.progress_file("swarm-00").exists());
    assert!(world.work_is_empty()?, "the run left clones behind");
    Ok(())
}

#[tokio::test]
async fn an_owner_decision_stops_the_agent_unacknowledged() -> anyhow::Result<()> {
    for (kind, code) in [
        (Kind::Decision, "decision_needs_operator"),
        (Kind::Rework, "rework_needs_operator"),
    ] {
        // The owner decides on another edit than the scripted one before the agent pins.
        let world = world(1, 1, false).await?;
        world.state().decide_on_ready = Some(kind);
        let scenario = world.scenario(1, "casqueblanc/demo", &mix(1, 0, 0), &fast_bounds())?;
        let run = run(&mut world.driver(&scenario)?)?;
        assert_eq!(run.code, Some(1), "{kind:?}");
        assert_eq!(
            run.steps_of("swarm-00"),
            ["claimed", "pushed", "failed"],
            "{kind:?}"
        );
        assert_eq!(
            run.of_type("failed")
                .first()
                .map(|e| (e.get("step"), e.get("code"))),
            Some((Some(&json!("inbox")), Some(&json!(code))))
        );
        assert_eq!(run.of_type("acknowledged").len(), 0);
        // The item is left for the operator and the unchanged edit was never pinned.
        let state = world.state();
        assert_eq!(
            state
                .items
                .iter()
                .map(|item| item.plan.clone())
                .collect::<Vec<_>>(),
            [None]
        );
        assert_eq!(state.readies, 0);
        assert_eq!(
            state.claims.first().map(|claim| claim.state),
            Some(ClaimState::Working)
        );
        drop(state);
        assert!(world.main_file(&disjoint_path("swarm-00", 0)).is_err());
    }
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn a_progress_record_outside_the_plan_stops_the_rerun_before_any_request()
-> anyhow::Result<()> {
    let world = world(1, 1, false).await?;
    let (scenario, pinned) = interrupt_after_the_first_pin(&world)?;
    world.state().paused = false;
    let path = world.progress_file("swarm-00");
    let mut record: Value = serde_json::from_str(&fs::read_to_string(&path)?)?;
    // A two-round plan has no round 5, and a scaffold stage before a disjoint edit is not one it
    // writes.
    for (field, value) in [("round", json!(5)), ("scaffold", json!(true))] {
        let mut changed = record.clone();
        if let Some(object) = changed.as_object_mut() {
            object.insert(field.to_owned(), value);
            object.insert("claimId".to_owned(), Value::Null);
        }
        let text = changed.to_string();
        fs::write(&path, &text)?;
        let stderr = refused(&world, &mut world.driver(&scenario)?).await?;
        assert!(
            stderr.contains("does not fit the scenario's plan")
                && stderr.contains("--discard-progress"),
            "{stderr}"
        );
        // The record is kept and no claim was made or adopted.
        assert_eq!(fs::read_to_string(&path)?, text);
        assert_eq!(world.state().claims.len(), 1);
    }
    // The genuine record still resumes.
    if let Some(object) = record.as_object_mut() {
        object.insert("claimId".to_owned(), json!(pinned));
    }
    fs::write(&path, record.to_string())?;
    let rerun = run(&mut world.driver(&scenario)?)?;
    assert_eq!(rerun.code, Some(0), "{:?}", rerun.of_type("failed"));
    Ok(())
}
