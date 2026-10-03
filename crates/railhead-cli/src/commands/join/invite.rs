//! An invite URL: `<origin>/join/<org>/<repo>/<inviteId>#<inviteSecret>`.
//!
//! The secret is the fragment, so a browser never sends it to a server. Nothing here prints it:
//! the argument's `Debug` is redacted, and every refusal names the part that is wrong without
//! echoing the URL.

use std::convert::Infallible;
use std::fmt;
use std::str::FromStr;

use railhead_protocol::{IdKind, is_id};
use url::Url;

use crate::context::{Origin, RepoRef};
use crate::identity::Secret;
use crate::output::LocalCode;
use crate::{Error, Result};

/// The environment variable that carries the invite URL, so its secret stays off the command line.
pub const INVITE_ENV: &str = "RAILHEAD_INVITE";

/// The invite URL as given on the command line, unchecked. Parsing never fails, so the parser
/// never echoes the secret in an error; [`Invite::parse`] checks it.
#[derive(Clone)]
pub struct InviteArg(String);

impl InviteArg {
    /// Wraps an invite URL from the command line or the environment.
    #[must_use]
    pub fn new(value: String) -> Self {
        Self(value)
    }
}

impl FromStr for InviteArg {
    type Err = Infallible;

    fn from_str(value: &str) -> std::result::Result<Self, Infallible> {
        Ok(Self(value.to_owned()))
    }
}

impl fmt::Debug for InviteArg {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("InviteArg(<redacted>)")
    }
}

/// A checked invite.
#[derive(Debug, Clone)]
pub struct Invite {
    /// The Railhead origin that issued it.
    pub origin: Origin,
    /// The repository it joins.
    pub repo: RepoRef,
    /// The `inv_` invite.
    pub id: String,
    /// The invite's secret, 43 base64url characters.
    pub secret: Secret,
}

impl Invite {
    /// Checks an invite URL.
    ///
    /// # Errors
    ///
    /// [`LocalCode::InvalidInput`] naming the part that is wrong; the URL itself is not repeated.
    pub fn parse(arg: &InviteArg) -> Result<Self> {
        let url = Url::parse(&arg.0).map_err(|_| invalid("it is not a URL"))?;
        if !url.username().is_empty() || url.password().is_some() || url.query().is_some() {
            return Err(invalid("it carries a user name, a password or a query"));
        }
        let origin: Origin = url
            .origin()
            .ascii_serialization()
            .parse()
            .map_err(|_| invalid("its origin is not https, or http on localhost"))?;
        let mut segments = url
            .path_segments()
            .ok_or_else(|| invalid("its path is not /join/<org>/<repo>/<invite>"))?;
        let (Some("join"), Some(org), Some(repo), Some(invite_id), None) = (
            segments.next(),
            segments.next(),
            segments.next(),
            segments.next(),
            segments.next(),
        ) else {
            return Err(invalid("its path is not /join/<org>/<repo>/<invite>"));
        };
        let repo: RepoRef = format!("{org}/{repo}")
            .parse()
            .map_err(|_| invalid("its repository is not org/repo in lowercase"))?;
        if !is_id(IdKind::Invite, invite_id) {
            return Err(invalid("its invite is not an invite id"));
        }
        let secret = url
            .fragment()
            .filter(|secret| {
                secret.len() == 43
                    && secret
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
            .ok_or_else(|| invalid("its #secret is missing or malformed"))?;
        Ok(Self {
            origin,
            repo,
            id: invite_id.to_owned(),
            secret: Secret::new(secret.to_owned()),
        })
    }
}

fn invalid(reason: &str) -> Error {
    Error::Local {
        code: LocalCode::InvalidInput,
        message: format!("the invite is not a Railhead invite URL: {reason}"),
        retryable: false,
        next: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "Xb1wU76LGAGoVdSeZlIi2Z01AeN9-MuIrwGfAO2-1ZE";

    fn parse(value: &str) -> Result<Invite> {
        Invite::parse(&InviteArg::new(value.to_owned()))
    }

    #[test]
    fn an_invite_url_yields_its_origin_repository_id_and_secret() -> anyhow::Result<()> {
        let invite = parse(&format!(
            "https://railhead.dev/join/casqueblanc/demo/inv_abc123#{SECRET}"
        ))?;
        assert_eq!(invite.origin.as_str(), "https://railhead.dev");
        assert_eq!(invite.repo.to_string(), "casqueblanc/demo");
        assert_eq!(invite.id, "inv_abc123");
        assert_eq!(invite.secret.expose(), SECRET);
        let local = parse(&format!(
            "http://127.0.0.1:8787/join/casqueblanc/demo/inv_abc123#{SECRET}"
        ))?;
        assert_eq!(local.origin.as_str(), "http://127.0.0.1:8787");
        Ok(())
    }

    #[test]
    fn a_hostile_or_malformed_invite_is_refused_without_echoing_it() -> anyhow::Result<()> {
        let short = &SECRET[..42];
        for bad in [
            String::new(),
            "not a url".to_owned(),
            format!("http://railhead.dev/join/casqueblanc/demo/inv_abc123#{SECRET}"),
            format!("ftp://railhead.dev/join/casqueblanc/demo/inv_abc123#{SECRET}"),
            format!("https://u:p@railhead.dev/join/casqueblanc/demo/inv_abc123#{SECRET}"),
            format!("https://railhead.dev/join/casqueblanc/demo/inv_abc123?x=1#{SECRET}"),
            format!("https://railhead.dev/join/casqueblanc/demo/inv_abc123/x#{SECRET}"),
            format!("https://railhead.dev/join/casqueblanc/inv_abc123#{SECRET}"),
            format!("https://railhead.dev/invite/casqueblanc/demo/inv_abc123#{SECRET}"),
            format!("https://railhead.dev/join/Casque/demo/inv_abc123#{SECRET}"),
            format!("https://railhead.dev/join/casqueblanc/demo/clm_abc123#{SECRET}"),
            format!("https://railhead.dev/join/casqueblanc/../inv_abc123#{SECRET}"),
            "https://railhead.dev/join/casqueblanc/demo/inv_abc123".to_owned(),
            format!("https://railhead.dev/join/casqueblanc/demo/inv_abc123#{short}"),
            format!("https://railhead.dev/join/casqueblanc/demo/inv_abc123#{SECRET}x"),
            format!("https://railhead.dev/join/casqueblanc/demo/inv_abc123#{short}+"),
        ] {
            match parse(&bad) {
                Err(Error::Local { code, message, .. }) => {
                    assert_eq!(code, LocalCode::InvalidInput, "{bad}");
                    assert!(!message.contains(short), "{message}");
                }
                other => anyhow::bail!("{bad:?} gave {other:?}"),
            }
        }
        assert_eq!(
            format!("{:?}", InviteArg::new(SECRET.to_owned())),
            "InviteArg(<redacted>)"
        );
        Ok(())
    }
}
