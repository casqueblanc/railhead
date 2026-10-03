//! `rh credential`: Answer Git's credential requests for a claim's clone.
//!
//! Git runs `rh credential <operation>` with the request on stdin. Stdout carries only the Git
//! credential protocol; every notice goes to stderr.
//!
//! The helper answers only inside a claim's clone, and only for the clone's two remotes on its
//! agent's origin: the claim's fork and the main repository, which `credential.useHttpPath` lets
//! it tell apart. Any other protocol, host, path or user is refused with nothing on stdout. The
//! answer is `username=<agentId>` and `password=<session token>`: the Railhead session, and
//! nothing else, since the CLI never holds an Artifacts token. When the agent has no current
//! session, or it is about to expire, the helper logs in with its key first.

use std::convert::Infallible;
use std::io::{self, Read};
use std::str::FromStr;

use crate::commands::join::{self, key::SigningKey};
use crate::context::CloneBinding;
use crate::identity::{Identity, SessionToken};
use crate::output::{LocalCode, Output};
use crate::{Agent, Error, Result};

/// Largest request the helper reads from Git, in bytes. Git's requests are a few hundred.
const MAX_REQUEST_BYTES: u64 = 16 * 1024;

/// Arguments of `rh credential`.
#[derive(Debug, Clone, clap::Args)]
pub struct Args {
    /// The operation Git asks for: `get`, `store` or `erase`.
    pub operation: Operation,
}

/// A credential helper operation. Git may add operations; a helper ignores those it does not know.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    /// Git wants a credential.
    Get,
    /// Git reports that a credential worked.
    Store,
    /// Git reports that a credential was refused.
    Erase,
    /// An operation this helper does not know.
    Other,
}

impl FromStr for Operation {
    type Err = Infallible;

    fn from_str(value: &str) -> std::result::Result<Self, Infallible> {
        Ok(match value {
            "get" => Self::Get,
            "store" => Self::Store,
            "erase" => Self::Erase,
            _ => Self::Other,
        })
    }
}

/// Runs `rh credential` with Git's request on stdin.
///
/// # Errors
///
/// When the command does not run in a claim's clone, the request is malformed or names anything
/// but the clone's remotes, or no session can be had. Nothing reaches stdout then.
pub fn run(agent: &Agent<'_>, args: &Args, out: &mut Output<'_>) -> Result<()> {
    answer(agent, args.operation, &mut io::stdin().lock(), out)
}

/// Answers one request read from `input`.
fn answer(
    agent: &Agent<'_>,
    operation: Operation,
    input: &mut dyn Read,
    out: &mut Output<'_>,
) -> Result<()> {
    let request = Request::read(input)?;
    match operation {
        // Git reports outcomes it does not need answered; an unknown operation is ignored.
        Operation::Store | Operation::Other => Ok(()),
        Operation::Get => {
            let binding = clone_of(agent)?;
            request.check(&agent.identity, binding)?;
            let token = session(agent)?;
            out.credential(&[
                ("username", agent.identity.agent_id.as_str()),
                ("password", token.expose()),
            ])?;
            Ok(())
        }
        Operation::Erase => {
            let binding = clone_of(agent)?;
            request.check(&agent.identity, binding)?;
            // Only the token Git was refused is dropped, compared and removed under the session
            // lock, so neither a stale erase nor one racing a login can drop a fresh token.
            if let Some(refused) = request.password.as_deref() {
                agent
                    .invocation
                    .context
                    .store()
                    .remove_session_if(&agent.identity.name, refused)?;
            }
            Ok(())
        }
    }
}

fn clone_of<'a>(agent: &'a Agent<'_>) -> Result<&'a CloneBinding> {
    agent
        .invocation
        .context
        .clone_binding()
        .ok_or_else(|| Error::Local {
            code: LocalCode::NoClone,
            message: "rh credential answers Git only inside a claim's clone".to_owned(),
            retryable: false,
            next: None,
        })
}

/// The agent's stored session while it is current, or a new one from a login with its key, stored
/// for the next request.
fn session(agent: &Agent<'_>) -> Result<SessionToken> {
    if let Some(token) = agent.stored_session()? {
        return Ok(token);
    }
    let store = agent.invocation.context.store();
    let key = SigningKey::load(store, &agent.identity.name)?.ok_or_else(|| Error::Local {
        code: LocalCode::NoSession,
        message: format!("{} has no key to log in with", agent.identity.name),
        retryable: false,
        next: Some(railhead_protocol::NextCommand::Join),
    })?;
    let client = agent.client()?;
    let session = agent
        .invocation
        .runtime
        .block_on(join::login(&client, &agent.identity, &key))?;
    store.save_session(&agent.identity.name, &session)?;
    Ok(session.token)
}

/// The fields of a Git credential request this helper reads.
#[derive(Default)]
struct Request {
    protocol: Option<String>,
    host: Option<String>,
    path: Option<String>,
    username: Option<String>,
    password: Option<String>,
}

impl Request {
    /// Reads `key=value` lines up to a blank line or the end, refusing an oversized request.
    fn read(input: &mut dyn Read) -> Result<Self> {
        let mut bytes = Vec::new();
        input
            .take(MAX_REQUEST_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| refused("Git's request could not be read"))?;
        if u64::try_from(bytes.len()).map_or(true, |length| length > MAX_REQUEST_BYTES) {
            return Err(refused("Git's request is too large"));
        }
        let text = String::from_utf8(bytes).map_err(|_| refused("Git's request is not UTF-8"))?;
        let mut request = Self::default();
        for line in text.split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if line.is_empty() {
                break;
            }
            let (key, value) = line
                .split_once('=')
                .ok_or_else(|| refused("Git's request has a line without `=`"))?;
            let slot = match key {
                "protocol" => &mut request.protocol,
                "host" => &mut request.host,
                "path" => &mut request.path,
                "username" => &mut request.username,
                "password" => &mut request.password,
                // Git sends more, such as `capability[]` and `wwwauth[]`; none of it changes
                // what the helper may answer.
                _ => continue,
            };
            *slot = Some(value.to_owned());
        }
        Ok(request)
    }

    /// Accepts only the clone's fork or main remote on the agent's own origin.
    fn check(&self, identity: &Identity, binding: &CloneBinding) -> Result<()> {
        let origin = identity.origin.join_path("/");
        let host = match origin.port() {
            Some(port) => format!("{}:{port}", origin.host_str().unwrap_or_default()),
            None => origin.host_str().unwrap_or_default().to_owned(),
        };
        let (org, repo) = (identity.repo.org.as_str(), identity.repo.repo.as_str());
        let fork = format!("git/{org}/{repo}/claims/{}.git", binding.claim_id);
        let upstream = format!("git/{org}/{repo}.git");
        let untrusted = |what: &str| Error::Local {
            code: LocalCode::UntrustedRemote,
            message: format!(
                "Git asked for {what}; rh answers only for this clone's remotes on {}",
                identity.origin.as_str()
            ),
            retryable: false,
            next: None,
        };
        if self.protocol.as_deref() != Some(origin.scheme()) {
            return Err(untrusted("another protocol"));
        }
        if self.host.as_deref() != Some(host.as_str()) {
            return Err(untrusted("another host"));
        }
        match self.path.as_deref() {
            Some(path) if path == fork || path == upstream => {}
            Some(_) => return Err(untrusted("another path")),
            None => return Err(untrusted("no path; set credential.useHttpPath")),
        }
        match self.username.as_deref() {
            None => Ok(()),
            Some(user) if user == identity.agent_id.as_str() => Ok(()),
            Some(_) => Err(untrusted("another user")),
        }
    }
}

fn refused(message: &str) -> Error {
    Error::Local {
        code: LocalCode::InvalidInput,
        message: message.to_owned(),
        retryable: false,
        next: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{AgentId, AgentName};

    fn identity(origin: &str) -> anyhow::Result<Identity> {
        Ok(Identity {
            name: AgentName::new("atlas")?,
            agent_id: AgentId::new("agt_atlas01")?,
            origin: origin.parse()?,
            repo: "casqueblanc/demo".parse()?,
        })
    }

    fn binding(identity: &Identity) -> CloneBinding {
        CloneBinding {
            dir: std::path::PathBuf::from("/tmp/demo"),
            identity: identity.agent_id.clone(),
            origin: identity.origin.clone(),
            repo: identity.repo.clone(),
            claim_id: "clm_42abcd".to_owned(),
        }
    }

    fn read(text: &str) -> Result<Request> {
        Request::read(&mut text.as_bytes())
    }

    const FORK: &str = "git/casqueblanc/demo/claims/clm_42abcd.git";

    #[test]
    fn the_clone_remotes_on_the_agent_origin_are_answered() -> anyhow::Result<()> {
        let atlas = identity("https://railhead.dev")?;
        for request in [
            format!("protocol=https\nhost=railhead.dev\npath={FORK}\n\n"),
            "protocol=https\r\nhost=railhead.dev\r\npath=git/casqueblanc/demo.git\r\n".to_owned(),
            format!(
                "capability[]=authtype\nprotocol=https\nhost=railhead.dev\npath={FORK}\nusername=agt_atlas01\nwwwauth[]=Basic realm=x\n\nhost=evil.example\n"
            ),
        ] {
            read(&request)?.check(&atlas, &binding(&atlas))?;
        }
        let local = identity("http://127.0.0.1:8787")?;
        read(&format!(
            "protocol=http\nhost=127.0.0.1:8787\npath={FORK}\n"
        ))?
        .check(&local, &binding(&local))?;
        Ok(())
    }

    #[test]
    fn any_other_destination_is_refused() -> anyhow::Result<()> {
        let atlas = identity("https://railhead.dev")?;
        for request in [
            format!("protocol=http\nhost=railhead.dev\npath={FORK}\n"),
            format!("protocol=https\nhost=evil.example\npath={FORK}\n"),
            format!("protocol=https\nhost=railhead.dev:443\npath={FORK}\n"),
            format!("protocol=https\nhost=railhead.dev.evil.example\npath={FORK}\n"),
            "protocol=https\nhost=railhead.dev\n".to_owned(),
            "protocol=https\nhost=railhead.dev\npath=git/casqueblanc/demo/claims/clm_other1.git\n"
                .to_owned(),
            "protocol=https\nhost=railhead.dev\npath=git/casqueblanc/other.git\n".to_owned(),
            format!("protocol=https\nhost=railhead.dev\npath={FORK}/../../x.git\n"),
            format!("protocol=https\nhost=railhead.dev\npath={FORK}\nusername=agt_boreas01\n"),
            format!("host=railhead.dev\npath={FORK}\n"),
            // A blank line ends the request: what follows it is not read.
            format!("protocol=https\n\nhost=railhead.dev\npath={FORK}\n"),
        ] {
            let error = read(&request)?.check(&atlas, &binding(&atlas)).err();
            assert!(
                matches!(
                    error,
                    Some(Error::Local {
                        code: LocalCode::UntrustedRemote,
                        ..
                    })
                ),
                "{request:?}: {error:?}"
            );
        }
        Ok(())
    }

    #[test]
    fn a_malformed_or_oversized_request_is_refused() -> anyhow::Result<()> {
        assert!(read("protocol https\n").is_err());
        assert!(Request::read(&mut [0xff_u8, b'\n'].as_slice()).is_err());
        let limit = usize::try_from(MAX_REQUEST_BYTES)?;
        let at_limit = format!("x={}\n", "a".repeat(limit - 3));
        assert_eq!(at_limit.len(), limit);
        assert!(read(&at_limit).is_ok());
        assert!(read(&format!("{at_limit}y")).is_err());
        let empty = read("")?;
        assert!(empty.protocol.is_none() && empty.password.is_none());
        Ok(())
    }
}
