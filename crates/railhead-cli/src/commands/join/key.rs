//! An agent's signing key and the texts it signs.
//!
//! The key is an Ed25519 OpenSSH key made on this machine. It is written once through the
//! [`SecretStore`] and never replaced, so joining again resumes with the key the backend already
//! knows. Every signature is an SSHSIG in the [`SIGNING_NAMESPACE`], over a message `rh` builds
//! itself; a message the backend proposes is signed only when it is byte for byte the one `rh`
//! built.

use std::fmt::Write as _;

use sha2::{Digest as _, Sha256};
use ssh_key::{Algorithm, HashAlg, LineEnding, PrivateKey, rand_core::OsRng};

use crate::context::{Origin, RepoRef};
use crate::identity::{self, AgentId, AgentName, Secret, SecretKind, SecretStore};
use crate::output::LocalCode;
use crate::{Error, Result};

/// The SSHSIG namespace of every signature an agent makes for Railhead. Git signing uses `git`.
pub const SIGNING_NAMESPACE: &str = "railhead-auth";

/// The domain the confirmation code hashes under.
const CONFIRM_DOMAIN: &str = "railhead-confirm-v1";

/// An agent's private key. It has no `Debug` that could print it.
pub struct SigningKey(PrivateKey);

impl std::fmt::Debug for SigningKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SigningKey(<redacted>)")
    }
}

/// Whether [`SigningKey::load_or_create`] made the key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyOrigin {
    /// The store already held it.
    Stored,
    /// This run made and stored it.
    Created,
}

impl SigningKey {
    /// The agent's stored key, or a new one written to the store when it has none. A stored key
    /// is never replaced, even when another run writes one first.
    ///
    /// # Errors
    ///
    /// When the store fails or holds something that is not an Ed25519 OpenSSH key.
    pub fn load_or_create(
        store: &impl SecretStore,
        agent: &AgentName,
    ) -> Result<(Self, KeyOrigin)> {
        if let Some(key) = Self::load(store, agent)? {
            return Ok((key, KeyOrigin::Stored));
        }
        let key = PrivateKey::random(&mut OsRng, Algorithm::Ed25519)
            .map_err(|_| local("generating a signing key failed"))?;
        let pem = key
            .to_openssh(LineEnding::LF)
            .map_err(|_| local("encoding the new signing key failed"))?;
        match store.create(agent, SecretKind::SigningKey, &Secret::new(pem.to_string())) {
            Ok(()) => Ok((Self(key), KeyOrigin::Created)),
            // Another run stored a key first: that one is the agent's.
            Err(identity::Error::AlreadyExists(_)) => Self::load(store, agent)?
                .map(|key| (key, KeyOrigin::Stored))
                .ok_or_else(|| local("the signing key vanished while it was being stored")),
            Err(error) => Err(error.into()),
        }
    }

    /// The agent's stored key, or `None` when it has none.
    ///
    /// # Errors
    ///
    /// When the store fails or holds something that is not an Ed25519 OpenSSH key.
    pub fn load(store: &impl SecretStore, agent: &AgentName) -> Result<Option<Self>> {
        let Some(secret) = store.read(agent, SecretKind::SigningKey)? else {
            return Ok(None);
        };
        let damaged = || {
            local(&format!(
                "the signing key of {agent} is not an Ed25519 OpenSSH key; it is never replaced, so join under another name"
            ))
        };
        let key = PrivateKey::from_openssh(secret.expose()).map_err(|_| damaged())?;
        if key.algorithm() != Algorithm::Ed25519 || key.is_encrypted() {
            return Err(damaged());
        }
        Ok(Some(Self(key)))
    }

    /// `ssh-ed25519 <base64 blob>`, with no comment.
    ///
    /// # Errors
    ///
    /// When the key cannot be encoded.
    pub fn public_key(&self) -> Result<String> {
        let mut public = self.0.public_key().clone();
        public.set_comment("");
        let line = public
            .to_openssh()
            .map_err(|_| local("encoding the public key failed"))?;
        Ok(line.trim_end().to_owned())
    }

    /// The six-digit code the owner matches on the board for this key and `invite_id`.
    ///
    /// # Errors
    ///
    /// When the key cannot be encoded.
    pub fn confirmation_code(&self, invite_id: &str) -> Result<String> {
        let blob = self
            .0
            .public_key()
            .to_bytes()
            .map_err(|_| local("encoding the public key failed"))?;
        confirmation_code(&blob, invite_id)
    }

    /// An armored SSHSIG over `message` in the [`SIGNING_NAMESPACE`].
    ///
    /// # Errors
    ///
    /// When signing fails.
    pub fn sign(&self, message: &str) -> Result<String> {
        self.0
            .sign(SIGNING_NAMESPACE, HashAlg::Sha512, message.as_bytes())
            .and_then(|signature| signature.to_pem(LineEnding::LF))
            .map_err(|_| local("signing failed"))
    }
}

/// The code for an SSH public key blob and an invite: the first eight bytes of
/// `SHA-256(string(domain) || string(blob) || string(invite))`, big-endian, modulo one million.
fn confirmation_code(blob: &[u8], invite_id: &str) -> Result<String> {
    let mut hash = Sha256::new();
    for part in [CONFIRM_DOMAIN.as_bytes(), blob, invite_id.as_bytes()] {
        let length = u32::try_from(part.len()).map_err(|_| local("the key is too long"))?;
        hash.update(length.to_be_bytes());
        hash.update(part);
    }
    let digest = hash.finalize();
    let first: [u8; 8] = digest
        .get(..8)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| local("hashing the confirmation code failed"))?;
    Ok(format!("{:06}", u64::from_be_bytes(first) % 1_000_000))
}

/// The text a joining agent signs to prove it holds the key it registers.
#[must_use]
pub fn join_message(origin: &Origin, repo: &RepoRef, invite_id: &str, public_key: &str) -> String {
    let mut message = String::from("railhead-join-v1\n");
    // Writing to a String cannot fail.
    let _ = write!(
        message,
        "origin={}\nrepo={repo}\ninvite={invite_id}\nkey={public_key}\n",
        origin.as_str()
    );
    message
}

/// The text an agent signs to redeem a login challenge.
#[must_use]
pub fn login_message(
    origin: &Origin,
    repo: &RepoRef,
    agent: &AgentId,
    challenge_id: &str,
    expires_at: u64,
) -> String {
    let mut message = String::from("railhead-login-v1\n");
    let _ = write!(
        message,
        "origin={}\nrepo={repo}\nagent={agent}\nchallenge={challenge_id}\nexpires={expires_at}\n",
        origin.as_str()
    );
    message
}

fn local(message: &str) -> Error {
    Error::Local {
        code: LocalCode::Store,
        message: message.to_owned(),
        retryable: false,
        next: None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use ssh_key::private::{Ed25519Keypair, KeypairData};
    use ssh_key::{PublicKey, SshSig};

    use super::*;
    use crate::identity::FileStore;

    /// The RFC 8032 section 7.1 test 1 secret key, whose public half the fixtures name.
    const TEST1_SEED: &str = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";

    fn auth() -> anyhow::Result<Value> {
        let path = format!(
            "{}/../../fixtures/protocol/wire/auth.json",
            env!("CARGO_MANIFEST_DIR")
        );
        Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?)
    }

    fn field<'a>(value: &'a Value, pointer: &str) -> anyhow::Result<&'a str> {
        value
            .pointer(pointer)
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("fixture has no {pointer}"))
    }

    fn test1() -> anyhow::Result<SigningKey> {
        let mut seed = [0_u8; 32];
        for (index, byte) in seed.iter_mut().enumerate() {
            let pair = TEST1_SEED
                .get(index * 2..index * 2 + 2)
                .ok_or_else(|| anyhow::anyhow!("short seed"))?;
            *byte = u8::from_str_radix(pair, 16)?;
        }
        let data = KeypairData::Ed25519(Ed25519Keypair::from_seed(&seed));
        Ok(SigningKey(PrivateKey::new(data, "")?))
    }

    #[test]
    fn the_join_and_login_messages_and_signatures_match_the_fixtures() -> anyhow::Result<()> {
        let auth = auth()?;
        assert_eq!(field(&auth, "/signingNamespace")?, SIGNING_NAMESPACE);
        assert_eq!(field(&auth, "/confirmDomain")?, CONFIRM_DOMAIN);
        let key = test1()?;
        assert_eq!(
            key.public_key()?,
            field(&auth, "/keys/rfc8032-test1/publicKey")?
        );

        let origin: Origin = field(&auth, "/join/fields/origin")?.parse()?;
        let repo: RepoRef = "casqueblanc/demo".parse()?;
        let join = join_message(
            &origin,
            &repo,
            field(&auth, "/join/fields/inviteId")?,
            &key.public_key()?,
        );
        assert_eq!(join, field(&auth, "/join/message")?);
        // Ed25519 is deterministic, so the same key over the same bytes gives ssh-keygen's bytes.
        assert_eq!(key.sign(&join)?, field(&auth, "/join/signature")?);

        let login = login_message(
            &origin,
            &repo,
            &AgentId::new("agt_atlas01")?,
            "chl_3q27HkVb0nZ8pXa1",
            1_790_000_060_000,
        );
        assert_eq!(login, field(&auth, "/login/message")?);
        assert_eq!(key.sign(&login)?, field(&auth, "/login/signature")?);
        Ok(())
    }

    #[test]
    fn a_signature_verifies_only_in_the_railhead_namespace() -> anyhow::Result<()> {
        let key = test1()?;
        let signature: SshSig = key.sign("railhead-login-v1\n")?.parse()?;
        let public = PublicKey::from_openssh(&key.public_key()?)?;
        assert!(
            public
                .verify(SIGNING_NAMESPACE, b"railhead-login-v1\n", &signature)
                .is_ok()
        );
        assert!(
            public
                .verify("git", b"railhead-login-v1\n", &signature)
                .is_err()
        );
        assert!(
            public
                .verify(SIGNING_NAMESPACE, b"railhead-login-v2\n", &signature)
                .is_err()
        );
        Ok(())
    }

    #[test]
    fn confirmation_codes_match_both_vector_sets() -> anyhow::Result<()> {
        let auth = auth()?;
        let codes = auth
            .pointer("/confirmationCodes")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow::anyhow!("no codes"))?;
        assert_eq!(codes.len(), 4);
        for case in codes {
            let name = field(case, "/key")?;
            let public =
                PublicKey::from_openssh(field(&auth, &format!("/keys/{name}/publicKey"))?)?;
            assert_eq!(
                confirmation_code(&public.to_bytes()?, field(case, "/inviteId")?)?,
                field(case, "/code")?,
                "{case}"
            );
        }

        let path = format!(
            "{}/../../fixtures/auth/confirmation-code.txt",
            env!("CARGO_MANIFEST_DIR")
        );
        let text = std::fs::read_to_string(path)?;
        let lines: Vec<&str> = text.lines().filter(|line| !line.starts_with('#')).collect();
        assert_eq!(lines.len(), 4);
        for line in lines {
            let parts: Vec<&str> = line.split(' ').collect();
            let [code, invite, kind, blob, _name] = parts.as_slice() else {
                anyhow::bail!("unexpected line {line}");
            };
            let public = PublicKey::from_openssh(&format!("{kind} {blob}"))?;
            assert_eq!(confirmation_code(&public.to_bytes()?, invite)?, *code);
        }
        // Another key or another invite gives another code.
        let key = test1()?;
        assert_eq!(key.confirmation_code("inv_abc123")?, "915893");
        assert_ne!(key.confirmation_code("inv_abc124")?, "915893");
        Ok(())
    }

    #[test]
    fn a_stored_key_is_reused_and_never_replaced() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = AgentName::new("atlas")?;
        let (first, made) = SigningKey::load_or_create(&store, &atlas)?;
        assert_eq!(made, KeyOrigin::Created);
        let (again, kept) = SigningKey::load_or_create(&store, &atlas)?;
        assert_eq!(kept, KeyOrigin::Stored);
        assert_eq!(first.public_key()?, again.public_key()?);
        assert!(first.public_key()?.starts_with("ssh-ed25519 "));
        assert!(!format!("{first:?}").contains("PRIVATE"));
        Ok(())
    }

    #[test]
    fn a_key_that_is_not_ed25519_openssh_is_refused_and_kept() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let store = FileStore::new(home.path());
        let atlas = AgentName::new("atlas")?;
        let junk = Secret::new("not a key".to_owned());
        store.create(&atlas, SecretKind::SigningKey, &junk)?;
        let error = SigningKey::load_or_create(&store, &atlas).err();
        assert!(
            matches!(
                error,
                Some(Error::Local {
                    code: LocalCode::Store,
                    ..
                })
            ),
            "{error:?}"
        );
        assert_eq!(store.read(&atlas, SecretKind::SigningKey)?, Some(junk));
        Ok(())
    }
}
