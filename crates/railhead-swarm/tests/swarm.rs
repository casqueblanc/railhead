//! `railhead-swarm` end to end: the built driver runs real `rh` processes against a fake backend
//! that speaks the agent wire, with real bare Git repositories for main and every claim's fork.
//!
//! The fake's train lands claims in waves: it hands out claims until a wave is full, then lands
//! the wave once every claim in it is ready, in the order they were pinned, with `git merge-tree`.
//! A clean merge moves main; a conflict reopens the claim at the next generation and routes a
//! `conflict` inbox item to its agent. Like the real backend, a claim that landed leaves its
//! agent's status. Git reaches the fake's repositories through a `url.<dir>.insteadOf` rewrite of
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

#[derive(Debug)]
struct Item {
    number: u64,
    agent: usize,
    claim_id: String,
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
}

/// The fake backend.
struct Fake {
    uri: String,
    root: PathBuf,
    wave_size: usize,
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
        };
        json!({"claimId": claim.id, "issueId": claim.issue, "generation": claim.generation,
            "base": claim.base, "state": state, "readyCommit": claim.ready_commit,
            "originUrl": format!("{}/git/casqueblanc/demo/claims/{}.git", self.uri, claim.id),
            "upstreamUrl": format!("{}/git/casqueblanc/demo.git", self.uri),
            "task": {"title": "Simulated task", "body": "Edit as the scenario plans."}})
    }

    fn item_view(item: &Item) -> Value {
        json!({"item": item.number, "claimId": item.claim_id, "queuedAt": 1,
            "entry": {"kind": "conflict", "otherClaimId": item.other, "path": item.path},
            "decision": null})
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
        state
            .claims
            .iter()
            .position(|claim| claim.agent == agent && claim.state != ClaimState::Merged)
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

    /// Lands the wave once it is full and every claim in it is ready.
    fn land(&self, state: &mut State) -> anyhow::Result<()> {
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
                let claim = Self::active(&state, agent)
                    .and_then(|index| state.claims.get(index))
                    .map(|claim| self.view(claim));
                Ok(success(
                    &json!({"agent": Self::agent_view(agent), "claim": claim}),
                    &Self::digest(&state, agent),
                ))
            }
            ("POST", ["work"]) => self.work(&mut state, agent),
            ("POST", ["claims", claim_id, "ready"]) => {
                let body: Value = serde_json::from_slice(&request.body)?;
                self.ready(&mut state, agent, claim_id, &body)
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
        let path = self.dir.path().join("scenario.json");
        let scenario = json!({"seed": 211, "origin": self.server.uri(), "repository": repository,
            "agents": agents, "rounds": 1, "mix": mix, "bounds": bounds});
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
            world
                .main_file(&format!("swarm/agents/{agent}/round-000.txt"))?
                .split(' ')
                .next(),
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
    assert!(world.work_is_empty()?, "the run left clones behind");
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
async fn a_claim_of_another_repository_is_never_touched() -> anyhow::Result<()> {
    let world = world(1, 1, false).await?;
    // The agent is joined to casqueblanc/demo; the scenario names another repository.
    let scenario = world.scenario(1, "casqueblanc/other", &mix(1, 0, 0), &fast_bounds())?;
    let run = run(&mut world.driver(&scenario)?)?;
    assert_eq!(run.code, Some(0));
    let failed = run.of_type("failed");
    assert_eq!(failed.len(), 1);
    assert_eq!(
        failed.first().and_then(|e| e.get("code")),
        Some(&json!("foreign_claim"))
    );
    assert_eq!(run.of_type("pushed").len(), 0);
    let state = world
        .fake
        .state
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    assert_eq!(state.readies, 0);
    Ok(())
}

#[tokio::test]
async fn a_claim_that_never_lands_stalls_its_agent() -> anyhow::Result<()> {
    // A wave of 2 with one agent never fills, so the train never lands.
    let world = world(1, 2, false).await?;
    let bounds = json!({"landTimeoutSecs": 1, "runTimeoutSecs": 60, "pollMs": 50});
    let scenario = world.scenario(1, "casqueblanc/demo", &mix(1, 0, 0), &bounds)?;
    let run = run(&mut world.driver(&scenario)?)?;
    assert_eq!(run.code, Some(0));
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
