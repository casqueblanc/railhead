//! `rh join`: Register this machine's agent key with an invite and wait for the owner to confirm it.
//!
//! Joining is safe to repeat. The key is made once, stored before the first request and never
//! replaced, so a second run with the same invite resumes the same enrollment instead of
//! registering another key. While the owner has not confirmed, the command shows the code to match
//! on the board and asks again, within `--wait`. Once confirmed it logs in by signing a challenge
//! and stores the session; until then the identity holds no session and every other command
//! refuses to act for it.
//!
//! One join enrolls a name at a time: it holds the name's enrollment lock from reading the stored
//! identity to storing the session, and a second join for the name stops before sending anything.
//! Before its first request a join for a name without an identity also stores the enrollment's
//! scope, the origin, repository, invite and key, and removes it only once it logs in or the
//! backend refuses that first request; a refused resume keeps it. Until then
//! a join with any other invite under the name stops before sending anything, so a response lost
//! to a crash or a dropped connection leaves an enrollment the same invite resumes.
//!
//! Every command that acts as an agent gets its session from [`session`], which logs in again with
//! the agent's key when the stored session is missing or about to expire.

pub mod invite;
pub mod key;

use std::fmt::Write as _;
use std::io::{self, Write};
use std::time::Duration;

use railhead_protocol::{
    AgentErrorCode, ChallengeRequest, ChallengeResult, EnrollmentState, InboxDigest, JoinRequest,
    JoinResult, NextCommand, SessionRequest, SessionResult,
};
use serde::Serialize;
use sha2::{Digest as _, Sha256};
use tokio::time::Instant;

use crate::http::{self, Endpoint};
use crate::identity::{
    self, AgentId, AgentName, AgentSelector, FileStore, Identity, LockKind, PendingEnrollment,
    SecretKind, SecretStore as _, Session, SessionToken,
};
use crate::output::{LocalCode, Output, Render, inert};
use crate::{Agent, Error, Invocation, Result};

use invite::{INVITE_ENV, Invite, InviteArg};
use key::{KeyOrigin, SigningKey};

/// Longest `--wait`, in seconds.
const MAX_WAIT_SECONDS: u64 = 3600;

/// Shortest and longest pause between two asks while the owner has not confirmed.
const MIN_POLL: Duration = Duration::from_millis(200);
const MAX_POLL: Duration = Duration::from_secs(10);

/// Arguments of `rh join`.
#[derive(Debug, Clone, clap::Args)]
pub struct Args {
    /// The invite URL, `<origin>/join/<org>/<repo>/<invite>#<secret>`. Read from
    /// `RAILHEAD_INVITE` when omitted, which keeps its secret off the command line.
    #[arg(value_name = "INVITE_URL")]
    pub invite: Option<InviteArg>,

    /// The local name to store the agent under. Defaults to one derived from the invite.
    #[arg(long, value_name = "NAME", value_parser = parse_name)]
    pub name: Option<AgentName>,

    /// How long to wait for the owner to confirm, in seconds; 0 asks once.
    #[arg(long, value_name = "SECONDS", default_value_t = 600,
        value_parser = clap::value_parser!(u64).range(0..=MAX_WAIT_SECONDS))]
    pub wait: u64,
}

fn parse_name(value: &str) -> std::result::Result<AgentName, String> {
    AgentName::new(value).map_err(|_| {
        "not an agent name: a lowercase letter, then lowercase letters, digits and dashes"
            .to_owned()
    })
}

/// Runs `rh join`.
///
/// # Errors
///
/// When the invite is malformed, the name is taken by another identity or an unfinished enrollment
/// of another invite, or another join is enrolling it, the store fails, the backend refuses or answers for another key, the owner does
/// not confirm within `--wait`, or the login fails.
pub fn run(invocation: &Invocation<'_>, args: &Args, out: &mut Output<'_>) -> Result<()> {
    let invite = Invite::parse(&invite_arg(args)?)?;
    let name = match &args.name {
        Some(name) => name.clone(),
        None => default_name(&invite.id)?,
    };
    let store = invocation.context.store();
    // Held until the command ends, so no other join reads, records or cleans up this name meanwhile.
    let _enrolling = store
        .try_lock(&name, LockKind::Enrollment)?
        .ok_or_else(|| Error::Local {
            code: LocalCode::Store,
            message: format!(
                "another rh join is enrolling {name}; run rh join again once it finishes"
            ),
            retryable: true,
            next: Some(NextCommand::Join),
        })?;
    let started = unfinished(store, &name, &invite)?;
    let existing = existing_identity(store, &name, &invite)?;
    let client = http::Client::new(&invite.origin, &invite.repo)?;
    let (key, made) = SigningKey::load_or_create(store, &name)?;
    let public_key = key.public_key()?;
    reserve(
        store,
        &name,
        &invite,
        started.as_ref(),
        existing.is_some(),
        &public_key,
        made,
    )?;
    let message = key::join_message(&invite.origin, &invite.repo, &invite.id, &public_key);
    let request = JoinRequest {
        invite_id: invite.id.clone(),
        invite_secret: invite.secret.expose().to_owned(),
        signature: key.sign(&message)?,
        public_key,
    };
    let enrollment = Enrollment {
        store,
        name: &name,
        invite: &invite,
        code: key.confirmation_code(&invite.id)?,
    };

    invocation.runtime.block_on(async {
        let deadline = Instant::now() + Duration::from_secs(args.wait);
        let mut answer = match client
            .send::<_, JoinResult>(&Endpoint::Join, None, &request)
            .await
        {
            Ok(success) => success,
            Err(error) => {
                // A refused first request registered nothing: the enrollment this run reserved
                // is over, and a key made for it is not anyone's yet. A refused resume proves only
                // that this request registered nothing, so an earlier one may have: its
                // reservation and key stay. Any other failure may have registered it, so both stay.
                if is_refusal(&error) && started.is_none() {
                    store.remove_enrollment(&name)?;
                    if made == KeyOrigin::Created {
                        store.remove(&name, SecretKind::SigningKey)?;
                    }
                }
                return Err(error.into());
            }
        };
        let identity = enrollment.record(existing, &answer.data)?;
        if answer.data.agent.state == EnrollmentState::Pending {
            out.notice(&enrollment.waiting(&identity, args.wait))
                .map_err(Error::Output)?;
        }
        // The first ask is always sent, even with `--wait 0`; every later one starts and ends
        // within the wait, and an answer it would bring after the deadline is not waited for.
        while answer.data.agent.state == EnrollmentState::Pending {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(enrollment.still_pending(&identity));
            }
            let asked = Duration::from_millis(answer.data.poll_after_ms.get());
            tokio::time::sleep(asked.clamp(MIN_POLL, MAX_POLL).min(left)).await;
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(enrollment.still_pending(&identity));
            }
            let ask = client.send::<_, JoinResult>(&Endpoint::Join, None, &request);
            answer = match tokio::time::timeout(left, ask).await {
                Ok(answer) => answer?,
                Err(_elapsed) => return Err(enrollment.still_pending(&identity)),
            };
            enrollment.check(&identity, &answer.data)?;
        }
        let login = login(&client, &identity, &key).await?;
        store.save_session(&name, &login.session)?;
        store.remove_enrollment(&name)?;
        let joined = Joined {
            name: name.to_string(),
            agent_id: identity.agent_id.to_string(),
            display_name: answer.data.agent.name,
            origin: invite.origin.as_str(),
            repo: invite.repo.to_string(),
            state: answer.data.agent.state,
            code: enrollment.code.clone(),
        };
        // The login is the latest answer, so its inbox and hint win over the join's.
        let inbox = login.inbox.or(answer.inbox);
        let next = login.next.or(answer.next).unwrap_or(NextCommand::Work);
        out.success(&joined, inbox.as_ref(), Some(next))
            .map_err(Error::Output)
    })
}

/// The invite URL on the command line, or else in `RAILHEAD_INVITE`.
fn invite_arg(args: &Args) -> Result<InviteArg> {
    match &args.invite {
        Some(arg) => Ok(arg.clone()),
        None => std::env::var(INVITE_ENV)
            .ok()
            .filter(|value| !value.is_empty())
            .map(InviteArg::new)
            .ok_or_else(|| Error::Local {
                code: LocalCode::InvalidInput,
                message: format!("name the invite URL, or set {INVITE_ENV}"),
                retryable: false,
                next: None,
            }),
    }
}

/// A login's session, with the pending inbox and next command its response carried.
#[derive(Debug)]
pub struct Login {
    /// The session, bound to the identity that logged in.
    pub session: Session,
    /// Unacknowledged inbox items the backend reported with the session.
    pub inbox: Option<InboxDigest>,
    /// The command the backend asks the agent to run next.
    pub next: Option<NextCommand>,
}

/// A session to act as an agent with, and the login that made it when there was one.
#[derive(Debug)]
pub enum Authenticated {
    /// The stored session, still current.
    Stored(SessionToken),
    /// A new session from a login with the agent's key, already stored.
    LoggedIn(Box<Login>),
}

impl Authenticated {
    /// The session token.
    #[must_use]
    pub fn into_token(self) -> SessionToken {
        match self {
            Self::Stored(token) => token,
            Self::LoggedIn(login) => login.session.token,
        }
    }
}

/// A session for `agent`: the stored one while it is current, otherwise a new one from a login
/// with the agent's key, stored for the next command. The lapsed token is never sent.
///
/// The login runs under the session lock, and the stored session is read again once the lock is
/// held, so processes that find it lapsed together log in once. The agent has no session, and
/// nothing is sent, when its stored session was issued to another identity or it has no key. When
/// the backend reports it unconfirmed or revoked, the one login attempt stops with no session too.
///
/// # Errors
///
/// [`LocalCode::NoSession`] in those cases; otherwise when the store fails or the login fails.
pub fn session(agent: &Agent<'_>) -> Result<Authenticated> {
    if let Some(token) = agent.stored_session()? {
        return Ok(Authenticated::Stored(token));
    }
    let identity = &agent.identity;
    let store = agent.invocation.context.store();
    let lock = store.lock_session(&identity.name)?;
    match lock.load()? {
        Some(stored) if !stored.issued_to(identity) => {
            return Err(no_session(
                identity,
                "its stored session was issued to another agent; run rh join to replace it",
            ));
        }
        Some(stored) if stored.usable_for(identity, identity::now_ms()) => {
            return Ok(Authenticated::Stored(stored.token));
        }
        Some(_) | None => {}
    }
    let key = SigningKey::load(store, &identity.name)?
        .ok_or_else(|| no_session(identity, "it has no key to log in with"))?;
    let client = agent.client()?;
    let login = agent
        .invocation
        .runtime
        .block_on(login(&client, identity, &key))
        .map_err(|error| match error {
            Error::Http(http::Error::Rejected { error, .. })
                if error.code == AgentErrorCode::IdentityPending =>
            {
                no_session(
                    identity,
                    "the owner has not confirmed it yet; run rh join to wait",
                )
            }
            Error::Http(http::Error::Rejected { error, .. })
                if error.code == AgentErrorCode::IdentityRevoked =>
            {
                no_session(
                    identity,
                    "the owner revoked it; join again with a new invite",
                )
            }
            other => other,
        })?;
    lock.save(&login.session)?;
    Ok(Authenticated::LoggedIn(Box::new(login)))
}

fn no_session(identity: &Identity, why: &str) -> Error {
    Error::Local {
        code: LocalCode::NoSession,
        message: format!("{} has no session: {why}", identity.name),
        retryable: false,
        next: Some(NextCommand::Join),
    }
}

/// Logs in as `identity`: asks for a challenge, signs it when it is exactly the message `rh`
/// builds, and redeems it for a session bound to `identity` with the expiry the backend gave.
///
/// # Errors
///
/// When a request fails, or the backend proposes another message, names another agent or returns
/// a malformed token. Nothing is signed for a message `rh` did not build.
pub async fn login(client: &http::Client, identity: &Identity, key: &SigningKey) -> Result<Login> {
    let agent_id = identity.agent_id.to_string();
    let challenge = client
        .send::<_, ChallengeResult>(
            &Endpoint::Challenge,
            None,
            &ChallengeRequest {
                agent_id: agent_id.clone(),
            },
        )
        .await?
        .data;
    if !is_challenge_id(&challenge.challenge_id) {
        return Err(malformed(
            "the login challenge is malformed; nothing was signed",
        ));
    }
    let message = key::login_message(
        &identity.origin,
        &identity.repo,
        &identity.agent_id,
        &challenge.challenge_id,
        challenge.expires_at.get(),
    );
    if challenge.message != message {
        return Err(malformed(
            "the login challenge is not the message rh signs; nothing was signed",
        ));
    }
    let response = client
        .send::<_, SessionResult>(
            &Endpoint::Session,
            None,
            &SessionRequest {
                agent_id,
                challenge_id: challenge.challenge_id,
                signature: key.sign(&message)?,
            },
        )
        .await?;
    let session = response.data;
    if session.agent.agent_id != identity.agent_id.as_str() {
        return Err(malformed(
            "the session names another agent; it was not stored",
        ));
    }
    let token = SessionToken::new(session.token)
        .ok_or_else(|| malformed("the session token is malformed; it was not stored"))?;
    Ok(Login {
        session: Session::new(identity, token, session.expires_at.get()),
        inbox: response.inbox,
        next: response.next,
    })
}

/// `chl_` and 16 to 64 letters or digits.
fn is_challenge_id(value: &str) -> bool {
    value.strip_prefix("chl_").is_some_and(|body| {
        (16..=64).contains(&body.len()) && body.bytes().all(|b| b.is_ascii_alphanumeric())
    })
}

/// True when the backend refused the join itself, so it recorded nothing for the key.
fn is_refusal(error: &http::Error) -> bool {
    matches!(error, http::Error::Rejected { error, .. } if error.code == AgentErrorCode::JoinRefused)
}

/// The local name for an invite when none is given: `inv-<invite>` when that is a valid name,
/// otherwise `inv-` and a hash of the invite.
fn default_name(invite_id: &str) -> Result<AgentName> {
    let body = invite_id.strip_prefix("inv_").unwrap_or(invite_id);
    if let Ok(name) = AgentName::new(&format!("inv-{body}")) {
        return Ok(name);
    }
    let digest = Sha256::digest(invite_id.as_bytes());
    let mut name = String::from("inv-");
    for byte in digest.iter().take(6) {
        let _ = write!(name, "{byte:02x}");
    }
    Ok(AgentName::new(&name)?)
}

/// The unfinished enrollment stored under `name`, which must be the invite's own: an enrollment of
/// another invite stops the join before anything is made or sent.
fn unfinished(
    store: &FileStore,
    name: &AgentName,
    invite: &Invite,
) -> Result<Option<PendingEnrollment>> {
    let started = store.load_enrollment(name)?;
    match &started {
        Some(started) if !started.is_for(&invite.origin, &invite.repo, &invite.id) => {
            Err(Error::Local {
                code: LocalCode::InvalidInput,
                message: format!(
                    "{name} is still enrolling with invite {} for {} on {}; finish that join, or join under another --name",
                    started.invite_id,
                    started.repo,
                    started.origin.as_str()
                ),
                retryable: false,
                next: None,
            })
        }
        Some(_) | None => Ok(started),
    }
}

/// Stores the enrollment's scope before its first request, so a lost answer still leaves it to
/// resume. A name that already holds its identity needs none: [`Enrollment::record`] checks every
/// answer against that identity. A resumed enrollment must still hold the key it registered.
fn reserve(
    store: &FileStore,
    name: &AgentName,
    invite: &Invite,
    started: Option<&PendingEnrollment>,
    identified: bool,
    public_key: &str,
    made: KeyOrigin,
) -> Result<()> {
    match started {
        Some(started) if started.public_key != public_key => {
            // The key the enrollment registered is gone, and a new one cannot resume it.
            if made == KeyOrigin::Created {
                store.remove(name, SecretKind::SigningKey)?;
            }
            Err(Error::Local {
                code: LocalCode::Store,
                message: format!(
                    "{name}'s unfinished enrollment registered a key that is no longer stored; join under another --name"
                ),
                retryable: false,
                next: None,
            })
        }
        Some(_) => Ok(()),
        None if identified => Ok(()),
        None => Ok(store.save_enrollment(
            name,
            &PendingEnrollment {
                origin: invite.origin.clone(),
                repo: invite.repo.clone(),
                invite_id: invite.id.clone(),
                public_key: public_key.to_owned(),
            },
        )?),
    }
}

/// The identity already stored under `name`, which must belong to the invite's repository.
fn existing_identity(
    store: &FileStore,
    name: &AgentName,
    invite: &Invite,
) -> Result<Option<Identity>> {
    match store.find(&AgentSelector::Name(name.clone())) {
        Ok(identity) if identity.origin == invite.origin && identity.repo == invite.repo => {
            Ok(Some(identity))
        }
        Ok(identity) => Err(Error::Local {
            code: LocalCode::InvalidInput,
            message: format!(
                "{name} already joined {} on {}; join under another --name",
                identity.repo,
                identity.origin.as_str()
            ),
            retryable: false,
            next: None,
        }),
        Err(identity::Error::NotFound(_)) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// One enrollment: where it is stored and the code this key and invite must produce.
struct Enrollment<'a> {
    store: &'a FileStore,
    name: &'a AgentName,
    invite: &'a Invite,
    code: String,
}

impl Enrollment<'_> {
    /// Checks the first answer and stores the identity it names, unless the name already holds it.
    fn record(&self, existing: Option<Identity>, result: &JoinResult) -> Result<Identity> {
        let agent_id = AgentId::new(&result.agent.agent_id).map_err(|_| {
            malformed("the backend returned a malformed agent id; nothing was saved")
        })?;
        self.check_code(result)?;
        if let Some(identity) = existing {
            if identity.agent_id != agent_id {
                return Err(Error::Local {
                    code: LocalCode::InvalidInput,
                    message: format!(
                        "{} is already {}, and this invite enrolled {agent_id}; join under another --name",
                        self.name, identity.agent_id
                    ),
                    retryable: false,
                    next: None,
                });
            }
            return Ok(identity);
        }
        let identity = Identity {
            name: self.name.clone(),
            agent_id,
            origin: self.invite.origin.clone(),
            repo: self.invite.repo.clone(),
        };
        self.store.save_identity(&identity)?;
        Ok(identity)
    }

    /// Checks a later answer against the stored identity.
    fn check(&self, identity: &Identity, result: &JoinResult) -> Result<()> {
        if result.agent.agent_id != identity.agent_id.as_str() {
            return Err(malformed("the backend answered for another agent"));
        }
        self.check_code(result)
    }

    /// The backend's code must be the one this key and invite give: otherwise it registered
    /// something else, and the owner would be matching the wrong code.
    fn check_code(&self, result: &JoinResult) -> Result<()> {
        if result.code == self.code {
            Ok(())
        } else {
            Err(malformed(
                "the backend's confirmation code is not this key's; do not confirm it on the board",
            ))
        }
    }

    fn waiting(&self, identity: &Identity, wait: u64) -> String {
        let then = if wait == 0 {
            "run rh join again once it is confirmed".to_owned()
        } else {
            format!("waiting up to {wait}s")
        };
        format!(
            "confirmation code {}: ask the owner to match it on the board for {}; {then}",
            self.code, identity.agent_id
        )
    }

    fn still_pending(&self, identity: &Identity) -> Error {
        Error::Local {
            code: LocalCode::Timeout,
            message: format!(
                "{} is still waiting for the owner to confirm code {}; run rh join again to keep waiting",
                identity.agent_id, self.code
            ),
            retryable: true,
            next: Some(NextCommand::Join),
        }
    }
}

fn malformed(message: &str) -> Error {
    Error::Local {
        code: LocalCode::MalformedResponse,
        message: message.to_owned(),
        retryable: false,
        next: None,
    }
}

/// The result of `rh join`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Joined {
    /// The local name.
    name: String,
    /// The agent id.
    agent_id: String,
    /// The display name the invite fixed. Untrusted text.
    display_name: String,
    /// The Railhead origin.
    origin: String,
    /// The repository.
    repo: String,
    /// Where the enrollment stands.
    state: EnrollmentState,
    /// The confirmation code.
    code: String,
}

impl Render for Joined {
    fn render(&self, out: &mut dyn Write) -> io::Result<()> {
        writeln!(
            out,
            "joined {} on {} as {} ({}, shown as {}); logged in",
            self.repo,
            self.origin,
            self.name,
            self.agent_id,
            inert(&self.display_name)
        )?;
        writeln!(
            out,
            "act as it with RAILHEAD_AGENT={} or inside its clones",
            self.name
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_default_name_is_derived_from_the_invite() -> anyhow::Result<()> {
        assert_eq!(default_name("inv_abc123")?.as_str(), "inv-abc123");
        // Upper case or a long invite would not make a name, so it is hashed.
        let mixed = default_name("inv_AbC123")?;
        assert!(mixed.as_str().starts_with("inv-") && mixed.as_str().len() == 16);
        assert_ne!(mixed, default_name("inv_abc123")?);
        assert_eq!(mixed, default_name("inv_AbC123")?);
        let long = default_name(&format!("inv_{}", "a".repeat(64)))?;
        assert_eq!(long.as_str().len(), 16);
        Ok(())
    }

    #[test]
    fn names_and_challenges_are_checked() {
        assert!(parse_name("atlas").is_ok());
        for bad in ["", "Atlas", "1atlas", "a b"] {
            assert!(parse_name(bad).is_err(), "{bad:?}");
        }
        assert!(is_challenge_id("chl_3q27HkVb0nZ8pXa1"));
        for bad in [
            "chl_short",
            "chl_3q27HkVb0nZ8pXa1\nagent=x",
            "3q27HkVb0nZ8pXa1abcd",
        ] {
            assert!(!is_challenge_id(bad), "{bad:?}");
        }
    }
}
