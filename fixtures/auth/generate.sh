#!/usr/bin/env bash
# Regenerates the SSHSIG vectors in this directory and checks interop with ssh-keygen.
#
# Usage: RUST_SIGNER=<path> fixtures/auth/generate.sh
#
# RUST_SIGNER is a binary with the `keygen <out>` and `sign <key> <message>` commands of the SSH
# signature spike (#8), built with the `railhead-auth` namespace. Private keys live in a temporary
# directory outside the repository and are deleted on exit; only public keys and signatures are
# written here.
set -euo pipefail
cd "$(dirname "$0")"
: "${RUST_SIGNER:?set RUST_SIGNER to the spike signer binary}"
keys=$(mktemp -d)
trap 'rm -rf "$keys"' EXIT

"$RUST_SIGNER" keygen "$keys/agent"
"$RUST_SIGNER" keygen "$keys/other"
cut -d' ' -f1,2 "$keys/agent.pub" > agent.pub
cut -d' ' -f1,2 "$keys/other.pub" > other.pub
printf 'railhead-login-v1\nchallenge=3q2-7Hk_Vb0nZ8pX\nexpires=2026-10-02T17:00:00Z\n' > challenge.txt

# The Rust signature (sha512), then ssh-keygen signatures over the same key and message.
"$RUST_SIGNER" sign "$keys/agent" challenge.txt > rust.sig
ssh-keygen -q -Y sign -f "$keys/agent" -n railhead-auth < challenge.txt > ssh-keygen.sig
ssh-keygen -q -Y sign -f "$keys/agent" -n railhead-auth -O hashalg=sha256 < challenge.txt \
  > ssh-keygen-sha256.sig
ssh-keygen -q -Y sign -f "$keys/agent" -n git < challenge.txt > wrong-namespace.sig
ssh-keygen -q -Y sign -f "$keys/other" -n railhead-auth < challenge.txt > other-key.sig

# Interop: ssh-keygen accepts the Rust signature and refuses the wrong namespace.
printf 'agent@fixture %s\n' "$(cat agent.pub)" > "$keys/allowed_signers"
ssh-keygen -Y verify -f "$keys/allowed_signers" -I agent@fixture -n railhead-auth \
  -s rust.sig < challenge.txt
if ssh-keygen -Y verify -f "$keys/allowed_signers" -I agent@fixture -n railhead-auth \
  -s wrong-namespace.sig < challenge.txt 2>/dev/null; then
  echo "unexpected: wrong namespace verified" >&2
  exit 1
fi
echo "interop ok"
