"""Independent reference for the confirmation code; writes confirmation-code.txt beside it.

Keys are the RFC 8032 section 7.1 Ed25519 test public keys, so the vectors never change.
"""
import base64, hashlib, struct, pathlib

def string(b: bytes) -> bytes:
    return struct.pack(">I", len(b)) + b

def blob(raw_hex: str) -> bytes:
    return string(b"ssh-ed25519") + string(bytes.fromhex(raw_hex))

def code(key_blob: bytes, invite: str) -> str:
    d = hashlib.sha256(string(b"railhead-confirm-v1") + string(key_blob) + string(invite.encode())).digest()
    return f"{int.from_bytes(d[:8], 'big') % 1_000_000:06d}"

KEYS = {
    "rfc8032-test1": "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    "rfc8032-test2": "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
}
CASES = [("rfc8032-test1", "inv_fixture_0001"), ("rfc8032-test1", "inv_fixture_0002"),
         ("rfc8032-test2", "inv_fixture_0001"), ("rfc8032-test2", "x")]
lines = ["# code invite-id public-key-line (computed by confirmation-code.py)"]
for name, invite in CASES:
    b = blob(KEYS[name])
    lines.append(f"{code(b, invite)} {invite} ssh-ed25519 {base64.b64encode(b).decode()} {name}")
pathlib.Path(__file__).with_name("confirmation-code.txt").write_text("\n".join(lines) + "\n")
