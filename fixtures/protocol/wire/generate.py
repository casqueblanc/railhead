"""Writes the agent wire fixtures in this directory. Run: python3 fixtures/protocol/wire/generate.py

The JSON files are the contract; this script only keeps them consistent with each other. It needs
Python 3 and ssh-keygen. Signatures are real SSHSIG signatures made by ssh-keygen with the RFC 8032
section 7.1 test keys, whose secret halves are published in the RFC; Ed25519 is deterministic, so a
rerun reproduces every byte. No other private key is used or written outside a temporary directory.
"""

import base64
import hashlib
import json
import pathlib
import struct
import subprocess
import tempfile

HERE = pathlib.Path(__file__).parent

# RFC 8032 section 7.1, tests 1 and 2: (secret seed, public key).
KEYS = {
    "rfc8032-test1": (
        "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
        "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    ),
    "rfc8032-test2": (
        "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
        "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    ),
}

NAMESPACE = "railhead-auth"
CONFIRM_DOMAIN = "railhead-confirm-v1"
ORIGIN = "https://railhead.dev"
ORG, REPO = "casqueblanc", "demo"
REPO_ID = "rep_demo0001"
AGENT = "agt_atlas01"
OWNER = "usr_lemarier"
INVITE = "inv_abc123"
INVITE_SECRET = base64.urlsafe_b64encode(hashlib.sha256(b"fixture invite").digest()).decode().rstrip("=")
CHALLENGE = "chl_3q27HkVb0nZ8pXa1"
NOW = 1_790_000_000_000
CHALLENGE_EXPIRES = NOW + 60_000
TOKEN = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJ2IjoxLCJzdWIiOiJhZ3RfYXRsYXMwMSJ9.c2lnbmF0dXJlLW5vdC1yZWFs"
SHA_BASE = "a" * 40
SHA_HEAD = "b" * 40
SHA_OTHER = "c" * 40


def ssh_string(b: bytes) -> bytes:
    return struct.pack(">I", len(b)) + b


def key_blob(public_hex: str) -> bytes:
    return ssh_string(b"ssh-ed25519") + ssh_string(bytes.fromhex(public_hex))


def public_line(name: str) -> str:
    return "ssh-ed25519 " + base64.b64encode(key_blob(KEYS[name][1])).decode()


def fingerprint(name: str) -> str:
    digest = hashlib.sha256(key_blob(KEYS[name][1])).digest()
    return "SHA256:" + base64.b64encode(digest).decode().rstrip("=")


def private_key_file(name: str) -> str:
    seed, public = (bytes.fromhex(x) for x in KEYS[name])
    blob = key_blob(KEYS[name][1])
    check = struct.pack(">I", 0x52484431)
    private = check + check + ssh_string(b"ssh-ed25519") + ssh_string(public)
    private += ssh_string(seed + public) + ssh_string(name.encode())
    pad = 1
    while len(private) % 8:
        private += bytes([pad])
        pad += 1
    body = b"openssh-key-v1\0" + ssh_string(b"none") + ssh_string(b"none") + ssh_string(b"")
    body += struct.pack(">I", 1) + ssh_string(blob) + ssh_string(private)
    text = base64.b64encode(body).decode()
    lines = [text[i : i + 70] for i in range(0, len(text), 70)]
    return "-----BEGIN OPENSSH PRIVATE KEY-----\n" + "\n".join(lines) + "\n-----END OPENSSH PRIVATE KEY-----\n"


def sign(name: str, message: str, namespace: str = NAMESPACE) -> str:
    with tempfile.TemporaryDirectory() as tmp:
        key = pathlib.Path(tmp) / "key"
        key.write_text(private_key_file(name))
        key.chmod(0o600)
        out = subprocess.run(
            ["ssh-keygen", "-q", "-Y", "sign", "-f", str(key), "-n", namespace],
            input=message.encode(),
            capture_output=True,
            check=True,
        )
        return out.stdout.decode()


def confirmation_code(name: str, invite: str) -> str:
    data = ssh_string(CONFIRM_DOMAIN.encode()) + ssh_string(key_blob(KEYS[name][1]))
    data += ssh_string(invite.encode())
    digest = hashlib.sha256(data).digest()
    return f"{int.from_bytes(digest[:8], 'big') % 1_000_000:06d}"


def join_message(invite: str, key: str) -> str:
    return f"railhead-join-v1\norigin={ORIGIN}\nrepo={ORG}/{REPO}\ninvite={invite}\nkey={key}\n"


def login_message(agent: str, challenge: str, expires: int) -> str:
    return (
        f"railhead-login-v1\norigin={ORIGIN}\nrepo={ORG}/{REPO}\nagent={agent}\n"
        f"challenge={challenge}\nexpires={expires}\n"
    )


KEY = public_line("rfc8032-test1")
JOIN_MESSAGE = join_message(INVITE, KEY)
JOIN_SIGNATURE = sign("rfc8032-test1", JOIN_MESSAGE)
LOGIN_MESSAGE = login_message(AGENT, CHALLENGE, CHALLENGE_EXPIRES)
LOGIN_SIGNATURE = sign("rfc8032-test1", LOGIN_MESSAGE)
CODE = confirmation_code("rfc8032-test1", INVITE)


def auth_fixture() -> dict:
    cases = [
        ("rfc8032-test1", INVITE),
        ("rfc8032-test1", "inv_def456"),
        ("rfc8032-test2", INVITE),
        ("rfc8032-test2", "x"),
    ]
    return {
        "signingNamespace": NAMESPACE,
        "confirmDomain": CONFIRM_DOMAIN,
        "keys": {
            name: {"publicKey": public_line(name), "fingerprint": fingerprint(name)} for name in KEYS
        },
        "confirmationCodes": [
            {"key": name, "inviteId": invite, "code": confirmation_code(name, invite)}
            for name, invite in cases
        ],
        "join": {
            "fields": {"origin": ORIGIN, "org": ORG, "repo": REPO, "inviteId": INVITE, "publicKey": KEY},
            "message": JOIN_MESSAGE,
            "signature": JOIN_SIGNATURE,
        },
        "login": {
            "fields": {
                "origin": ORIGIN,
                "org": ORG,
                "repo": REPO,
                "agentId": AGENT,
                "challengeId": CHALLENGE,
                "expiresAt": CHALLENGE_EXPIRES,
            },
            "message": LOGIN_MESSAGE,
            "signature": LOGIN_SIGNATURE,
        },
        "rejectedSignatures": [
            {
                "name": "signed in the git namespace",
                "message": LOGIN_MESSAGE,
                "signature": sign("rfc8032-test1", LOGIN_MESSAGE, "git"),
            },
            {
                "name": "signed by another key",
                "message": LOGIN_MESSAGE,
                "signature": sign("rfc8032-test2", LOGIN_MESSAGE),
            },
            {
                "name": "signature over another challenge",
                "message": LOGIN_MESSAGE,
                "signature": sign("rfc8032-test1", login_message(AGENT, "chl_0000000000000000", CHALLENGE_EXPIRES)),
            },
        ],
    }


# Shared response pieces -----------------------------------------------------------------------

AGENT_VIEW = {"agentId": AGENT, "name": "atlas", "ownerId": OWNER, "state": "confirmed"}
PENDING_AGENT = {**AGENT_VIEW, "state": "pending"}
DECISION_V2 = {
    "decisionId": "dec_upload1",
    "version": 2,
    "supersedes": 1,
    "questionId": "qst_upload1",
    "question": "Should uploads above 10 MB be rejected or chunked?",
    "option": {"key": "chunk", "label": "Upload them in chunks"},
    "previous": {"key": "reject", "label": "Reject them"},
    "scope": ["src/upload.ts"],
    "decidedBy": OWNER,
    "decidedAt": NOW - 5_000,
}
DECISION_V1 = {**DECISION_V2, "version": 1, "supersedes": None, "option": {"key": "reject", "label": "Reject them"}, "previous": None}
REWORK_ITEM = {
    "item": 17,
    "claimId": "clm_42abcd",
    "queuedAt": NOW - 4_000,
    "entry": {"kind": "rework", "decision": {"decisionId": "dec_upload1", "version": 2}},
    "decision": DECISION_V2,
}
CONFLICT_ITEM = {
    "item": 18,
    "claimId": "clm_42abcd",
    "queuedAt": NOW - 3_000,
    "entry": {"kind": "conflict", "otherClaimId": "clm_43abcd", "path": "src/upload.ts"},
    "decision": None,
}
DIGEST = {"items": [REWORK_ITEM], "pending": 1}
EMPTY_DIGEST = {"items": [], "pending": 0}


def claim_view(state: str = "working", ready: str | None = None, generation: int = 1) -> dict:
    return {
        "claimId": "clm_42abcd",
        "issueId": "iss_upload1",
        "generation": generation,
        "base": SHA_BASE,
        "state": state,
        "readyCommit": ready,
        "originUrl": f"{ORIGIN}/git/{ORG}/{REPO}/claims/clm_42abcd.git",
        "upstreamUrl": f"{ORIGIN}/git/{ORG}/{REPO}.git",
        "task": {"title": "Handle large uploads", "body": "Uploads above 10 MB fail. Follow the decision."},
    }


SPECS = {
    "invalid_request": (400, False, None),
    "not_found": (404, False, "status"),
    "rate_limited": (429, True, None),
    "join_refused": (403, False, None),
    "challenge_invalid": (401, False, None),
    "unauthenticated": (401, False, None),
    "identity_pending": (403, True, "join"),
    "identity_revoked": (403, False, None),
    "no_work": (409, True, "work"),
    "claim_exists": (409, False, "status"),
    "issue_unavailable": (409, False, "work"),
    "stale_generation": (409, False, "status"),
    "after_ready": (409, False, "status"),
    "unacked_decision": (409, False, "sync"),
    "commit_not_found": (422, False, None),
    "idempotency_mismatch": (409, False, None),
    "busy": (503, True, None),
    "unavailable": (503, False, None),
}


def success(data: dict, inbox: dict | None, next_command: str | None, status: int = 200) -> dict:
    return {"status": status, "body": {"ok": True, "data": data, "inbox": inbox, "next": next_command}}


def failure(code: str, message: str, retry_after: int | None = None) -> dict:
    status, retryable, next_command = SPECS[code]
    error = {"code": code, "message": message, "retryable": retryable, "retryAfterMs": retry_after, "next": next_command}
    return {"status": status, "body": {"ok": False, "error": error}}


def request(body, auth: bool, query: dict | None = None) -> dict:
    headers = {}
    if body is not None:
        headers["content-type"] = "application/json"
    if auth:
        headers["authorization"] = f"Bearer {TOKEN}"
    return {"headers": headers, "query": query or {}, "body": body}


def exchange(name: str, req: dict, res: dict) -> dict:
    return {"name": name, "request": req, "response": res}


def rejected(name: str, body, stage: str) -> dict:
    return {"name": name, "body": body, "stage": stage}


BASE = f"/agent/v1/{ORG}/{REPO}"
JOIN_BODY = {"inviteId": INVITE, "inviteSecret": INVITE_SECRET, "publicKey": KEY, "signature": JOIN_SIGNATURE}
SESSION_BODY = {"agentId": AGENT, "challengeId": CHALLENGE, "signature": LOGIN_SIGNATURE}
READY_BODY = {"generation": 1, "commit": SHA_HEAD}
ASK_BODY = {
    "generation": 1,
    "requestId": "req_upload0000000001",
    "text": "Should uploads above 10 MB be rejected or chunked?",
    "options": [{"key": "reject", "label": "Reject them"}, {"key": "chunk", "label": "Upload them in chunks"}],
    "scope": ["src/upload.ts"],
}
QUESTION_OPEN = {"questionId": "qst_upload1", "decisionId": "dec_upload1", "state": "open", "decision": None}
MAX_SCOPE_BYTES = 8192


def scope_bytes(scope: list) -> int:
    return len(json.dumps(scope, ensure_ascii=False, separators=(",", ":")).encode())


def full_scope(swap: str | None = None) -> list:
    """Paths that take exactly MAX_SCOPE_BYTES as a JSON array, one holding a quote and a backslash.
    `swap` replaces one ASCII letter, adding a byte when it is multibyte or escaped."""
    paths = [f"src/{i}/" + "a" * 1016 for i in range(7)] + ['src/q"b\\c']
    paths[-1] += "a" * (MAX_SCOPE_BYTES - scope_bytes(paths))
    assert scope_bytes(paths) == MAX_SCOPE_BYTES and all(len(p) <= 1024 for p in paths)
    if swap is not None:
        paths[0] = paths[0].replace("a", swap, 1)
    return paths


def agent_fixtures() -> dict:
    return {
        "join": {
            "method": "POST",
            "path": f"{BASE}/join",
            "exchanges": [
                exchange(
                    "registers the key and returns the code to match",
                    request(JOIN_BODY, False),
                    success({"agent": PENDING_AGENT, "code": CODE, "pollAfterMs": 2000}, None, "join"),
                ),
                exchange(
                    "a repeat with the same key resumes the confirmed enrollment",
                    request(JOIN_BODY, False),
                    success({"agent": AGENT_VIEW, "code": CODE, "pollAfterMs": 2000}, None, "work"),
                ),
                exchange(
                    "refuses an invite used by another key, saying nothing more",
                    request({**JOIN_BODY, "publicKey": public_line("rfc8032-test2")}, False),
                    failure("join_refused", "This invite cannot be used. Ask the owner for a new one."),
                ),
            ],
            "rejectedRequests": [
                rejected("signature missing", {k: v for k, v in JOIN_BODY.items() if k != "signature"}, "shape"),
                rejected("public key is a number", {**JOIN_BODY, "publicKey": 42}, "shape"),
                rejected("RSA key", {**JOIN_BODY, "publicKey": "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ"}, "invariant"),
                rejected("public key with a comment", {**JOIN_BODY, "publicKey": KEY + " atlas@laptop"}, "invariant"),
                rejected("short invite secret", {**JOIN_BODY, "inviteSecret": "abc"}, "invariant"),
                rejected("claim id as invite id", {**JOIN_BODY, "inviteId": "clm_42abcd"}, "invariant"),
                rejected("signature not armored", {**JOIN_BODY, "signature": "c2lnbmF0dXJl"}, "invariant"),
            ],
        },
        "challenge": {
            "method": "POST",
            "path": f"{BASE}/session/challenge",
            "exchanges": [
                exchange(
                    "issues a single-use challenge and the exact message to sign",
                    request({"agentId": AGENT}, False),
                    success({"challengeId": CHALLENGE, "expiresAt": CHALLENGE_EXPIRES, "message": LOGIN_MESSAGE}, None, None),
                ),
                exchange(
                    "limits the rate of challenges",
                    request({"agentId": AGENT}, False),
                    failure("rate_limited", "Too many login attempts. Wait and try again.", 10_000),
                ),
            ],
            "rejectedRequests": [
                rejected("person id as agent id", {"agentId": OWNER}, "invariant"),
                rejected("agent id missing", {}, "shape"),
            ],
        },
        "session": {
            "method": "POST",
            "path": f"{BASE}/session",
            "exchanges": [
                exchange(
                    "redeems the signed challenge for a session token",
                    request(SESSION_BODY, False),
                    success({"token": TOKEN, "expiresAt": NOW + 600_000, "agent": AGENT_VIEW, "repoId": REPO_ID}, None, None),
                ),
                exchange(
                    "refuses a challenge that was already redeemed",
                    request(SESSION_BODY, False),
                    failure("challenge_invalid", "The challenge expired or was used. Request a new one."),
                ),
                exchange(
                    "refuses an agent the owner has not confirmed",
                    request(SESSION_BODY, False),
                    failure("identity_pending", "The owner has not confirmed this agent yet.", 2_000),
                ),
            ],
            "rejectedRequests": [
                rejected("challenge id of the wrong form", {**SESSION_BODY, "challengeId": "chl_short"}, "invariant"),
                rejected("oversized signature", {**SESSION_BODY, "signature": "-----BEGIN SSH SIGNATURE-----\n" + ("A" * 76 + "\n") * 60 + "-----END SSH SIGNATURE-----\n"}, "invariant"),
                rejected("signature is null", {**SESSION_BODY, "signature": None}, "shape"),
            ],
        },
        "status": {
            "method": "GET",
            "path": f"{BASE}/status",
            "exchanges": [
                exchange(
                    "shows the agent, its claim and its inbox first",
                    request(None, True),
                    success({"agent": AGENT_VIEW, "claim": claim_view()}, DIGEST, "sync"),
                ),
                exchange(
                    "an agent without a claim",
                    request(None, True),
                    success({"agent": AGENT_VIEW, "claim": None}, EMPTY_DIGEST, "work"),
                ),
                exchange(
                    "refuses a revoked agent at its next call",
                    request(None, True),
                    failure("identity_revoked", "This agent was revoked by its owner."),
                ),
            ],
            "rejectedRequests": [rejected("a body on a route without one", {"agentId": AGENT}, "shape")],
        },
        "work": {
            "method": "POST",
            "path": f"{BASE}/work",
            "exchanges": [
                exchange(
                    "claims the next ready issue",
                    request(None, True),
                    success({"claim": claim_view(), "resumed": False}, EMPTY_DIGEST, None),
                ),
                exchange(
                    "a repeat returns the claim the agent already holds",
                    request(None, True),
                    success({"claim": claim_view(), "resumed": True}, EMPTY_DIGEST, None),
                ),
                exchange(
                    "no issue is ready",
                    request(None, True),
                    failure("no_work", "No issue is ready. Try again later.", 30_000),
                ),
                exchange(
                    "the fork is still being created",
                    request(None, True),
                    failure("busy", "The claim's fork is being created. Repeat the request.", 2_000),
                ),
            ],
            "rejectedRequests": [rejected("a body on a route without one", {"issueId": "iss_upload1"}, "shape")],
        },
        "claim": {
            "method": "POST",
            "path": f"{BASE}/claims",
            "exchanges": [
                exchange(
                    "claims the named issue",
                    request({"issueId": "iss_upload1"}, True),
                    success({"claim": claim_view(), "resumed": False}, EMPTY_DIGEST, None),
                ),
                exchange(
                    "refuses a second claim while one is active",
                    request({"issueId": "iss_other01"}, True),
                    failure("claim_exists", "This agent already holds claim clm_42abcd."),
                ),
                exchange(
                    "refuses an issue that is claimed or closed",
                    request({"issueId": "iss_other01"}, True),
                    failure("issue_unavailable", "This issue is not open for a claim."),
                ),
            ],
            "rejectedRequests": [
                rejected("claim id as issue id", {"issueId": "clm_42abcd"}, "invariant"),
                rejected("issue id missing", {}, "shape"),
            ],
        },
        "ready": {
            "method": "POST",
            "path": f"{BASE}/claims/clm_42abcd/ready",
            "exchanges": [
                exchange(
                    "pins the commit",
                    request(READY_BODY, True),
                    success({"claim": claim_view("ready", SHA_HEAD), "repeated": False}, EMPTY_DIGEST, None),
                ),
                exchange(
                    "a repeat after a lost response returns the same pin",
                    request(READY_BODY, True),
                    success({"claim": claim_view("ready", SHA_HEAD), "repeated": True}, EMPTY_DIGEST, None),
                ),
                exchange(
                    "refuses while a decision is unacknowledged",
                    request(READY_BODY, True),
                    failure("unacked_decision", "Item 17 is not acknowledged. Run rh sync, then rh ack."),
                ),
                exchange(
                    "refuses a stale generation",
                    request(READY_BODY, True),
                    failure("stale_generation", "This claim moved to generation 2."),
                ),
                exchange(
                    "refuses another commit after ready",
                    request({**READY_BODY, "commit": SHA_OTHER}, True),
                    failure("after_ready", "This claim is already ready at another commit."),
                ),
                exchange(
                    "refuses a commit the fork does not have",
                    request({**READY_BODY, "commit": SHA_OTHER}, True),
                    failure("commit_not_found", "The fork has no such commit. Push it first."),
                ),
            ],
            "rejectedRequests": [
                rejected("uppercase commit", {**READY_BODY, "commit": SHA_HEAD.upper()}, "invariant"),
                rejected("generation 0", {**READY_BODY, "generation": 0}, "invariant"),
                rejected("generation beyond the safe integer range", {**READY_BODY, "generation": 9007199254740992}, "invariant"),
                rejected("generation as a string", {**READY_BODY, "generation": "1"}, "shape"),
                rejected("commit missing", {"generation": 1}, "shape"),
            ],
        },
        "inbox": {
            "method": "GET",
            "path": f"{BASE}/inbox",
            "exchanges": [
                exchange(
                    "returns unacknowledged items oldest first",
                    request(None, True, {"limit": "16"}),
                    success({"items": [REWORK_ITEM, CONFLICT_ITEM], "pending": 2}, {"items": [REWORK_ITEM, CONFLICT_ITEM], "pending": 2}, "ack"),
                ),
                exchange(
                    "an empty inbox",
                    request(None, True),
                    success({"items": [], "pending": 0}, EMPTY_DIGEST, None),
                ),
                exchange(
                    "refuses an expired session",
                    request(None, True),
                    failure("unauthenticated", "The session expired. Log in again."),
                ),
            ],
            "rejectedRequests": [],
        },
        "ack": {
            "method": "POST",
            "path": f"{BASE}/inbox/17/ack",
            "exchanges": [
                exchange(
                    "acknowledges the item with a plan",
                    request({"plan": "Switch the handler to chunks"}, True),
                    success({"item": 17, "plan": "Switch the handler to chunks", "ackedAt": NOW, "repeated": False}, EMPTY_DIGEST, "ready"),
                ),
                exchange(
                    "a repeat returns the first acknowledgement",
                    request({"plan": "Something else"}, True),
                    success({"item": 17, "plan": "Switch the handler to chunks", "ackedAt": NOW, "repeated": True}, EMPTY_DIGEST, "ready"),
                ),
                exchange(
                    "refuses an item that is not this agent's",
                    request({"plan": "Switch the handler to chunks"}, True),
                    failure("not_found", "This agent has no inbox item 17."),
                ),
            ],
            "rejectedRequests": [
                rejected("blank plan", {"plan": "   "}, "invariant"),
                rejected("plan over the limit", {"plan": "p" * 4001}, "invariant"),
                rejected("plan missing", {}, "shape"),
            ],
        },
        "ask": {
            "method": "POST",
            "path": f"{BASE}/claims/clm_42abcd/questions",
            "exchanges": [
                exchange(
                    "asks the owner and returns at once",
                    request(ASK_BODY, True),
                    success(QUESTION_OPEN, EMPTY_DIGEST, None),
                ),
                exchange(
                    "accepts a scope of exactly the byte limit",
                    request({**ASK_BODY, "requestId": "req_upload0000000002", "scope": full_scope()}, True),
                    success(QUESTION_OPEN, EMPTY_DIGEST, None),
                ),
                exchange(
                    "refuses a reused request id with a different question",
                    request({**ASK_BODY, "text": "Another question?"}, True),
                    failure("idempotency_mismatch", "This request id was used for another question."),
                ),
                exchange(
                    "refuses a stale generation",
                    request(ASK_BODY, True),
                    failure("stale_generation", "This claim moved to generation 2."),
                ),
            ],
            "rejectedRequests": [
                rejected("a single option", {**ASK_BODY, "options": ASK_BODY["options"][:1]}, "invariant"),
                rejected("duplicate option keys", {**ASK_BODY, "options": [ASK_BODY["options"][0], ASK_BODY["options"][0]]}, "invariant"),
                rejected("option key with capitals", {**ASK_BODY, "options": [{"key": "Reject", "label": "Reject"}, ASK_BODY["options"][1]]}, "invariant"),
                rejected("blank text", {**ASK_BODY, "text": ""}, "invariant"),
                rejected("bad request id", {**ASK_BODY, "requestId": "upload"}, "invariant"),
                rejected("options missing", {k: v for k, v in ASK_BODY.items() if k != "options"}, "shape"),
                rejected("empty scope", {**ASK_BODY, "scope": []}, "invariant"),
                rejected("scope over the limit", {**ASK_BODY, "scope": [f"src/file{i}.ts" for i in range(65)]}, "invariant"),
                rejected("absolute scope path", {**ASK_BODY, "scope": ["/src/upload.ts"]}, "invariant"),
                rejected("scope path with a dot-dot segment", {**ASK_BODY, "scope": ["src/../upload.ts"]}, "invariant"),
                rejected("blank scope path", {**ASK_BODY, "scope": [" "]}, "invariant"),
                rejected("scope path with a C0 control", {**ASK_BODY, "scope": ["src/\u0007.ts"]}, "invariant"),
                rejected("scope path with DEL", {**ASK_BODY, "scope": ["src/\u007f.ts"]}, "invariant"),
                rejected("scope path with a C1 control", {**ASK_BODY, "scope": ["src/\u0085.ts"]}, "invariant"),
                rejected("scope a UTF-8 byte over the limit", {**ASK_BODY, "scope": full_scope("\u00e9")}, "invariant"),
                rejected("scope an escaped byte over the limit", {**ASK_BODY, "scope": full_scope('"')}, "invariant"),
                rejected("scope missing", {k: v for k, v in ASK_BODY.items() if k != "scope"}, "shape"),
            ],
        },
        "question": {
            "method": "GET",
            "path": f"{BASE}/questions/qst_upload1",
            "exchanges": [
                exchange(
                    "a long poll that times out is still open",
                    request(None, True, {"waitMs": "25000"}),
                    success(QUESTION_OPEN, EMPTY_DIGEST, None),
                ),
                exchange(
                    "an answered question carries the decision",
                    request(None, True, {"waitMs": "25000"}),
                    success({**QUESTION_OPEN, "state": "answered", "decision": DECISION_V1}, EMPTY_DIGEST, "sync"),
                ),
                exchange(
                    "refuses a question the agent did not ask",
                    request(None, True),
                    failure("not_found", "This agent has no question qst_upload1."),
                ),
                exchange(
                    "the decisions module is not installed",
                    request(None, True),
                    failure("unavailable", "The decisions module is not available."),
                ),
            ],
            "rejectedRequests": [],
        },
    }


def event(seq: int, type_: str, actor: dict, data: dict) -> dict:
    return {"v": 1, "seq": seq, "at": NOW + seq, "repo": REPO_ID, "actor": actor, "type": type_, "data": data}


HUMAN = {"kind": "human", "id": OWNER}
AGENT_ACTOR = {"kind": "agent", "id": AGENT}
SYSTEM = {"kind": "system", "id": "sys_train"}


def events_fixture() -> dict:
    valid = [
        ("agent.invited", HUMAN, {"inviteId": INVITE, "name": "atlas"}),
        ("agent.joined", SYSTEM, {"agentId": AGENT, "inviteId": INVITE, "name": "atlas", "keyFingerprint": fingerprint("rfc8032-test1")}),
        ("agent.confirmed", HUMAN, {"agentId": AGENT}),
        ("issue.filed", HUMAN, {"issueId": "iss_upload1", "title": "Handle large uploads", "body": ""}),
        ("claim.opened", AGENT_ACTOR, {"claimId": "clm_42abcd", "issueId": "iss_upload1", "agentId": AGENT, "generation": 1, "base": SHA_BASE}),
        ("claim.pushed", AGENT_ACTOR, {"claimId": "clm_42abcd", "generation": 1, "ref": "refs/heads/main", "from": None, "to": SHA_HEAD}),
        ("question.asked", AGENT_ACTOR, {"questionId": "qst_upload1", "claimId": "clm_42abcd", "decisionId": "dec_upload1", "text": ASK_BODY["text"], "options": ASK_BODY["options"]}),
        ("decision.recorded", HUMAN, {"decisionId": "dec_upload1", "version": 1, "questionId": "qst_upload1", "option": "reject", "supersedes": None, "scope": ["src/upload.ts"]}),
        ("inbox.queued", SYSTEM, {"agentId": AGENT, "claimId": "clm_42abcd", "item": 16, "entry": {"kind": "decision", "decision": {"decisionId": "dec_upload1", "version": 1}}}),
        ("inbox.delivered", SYSTEM, {"agentId": AGENT, "claimId": "clm_42abcd", "item": 16}),
        ("inbox.acked", AGENT_ACTOR, {"agentId": AGENT, "claimId": "clm_42abcd", "item": 16, "plan": "Reject above 10 MB"}),
        ("claim.ready", AGENT_ACTOR, {"claimId": "clm_42abcd", "generation": 1, "commit": SHA_HEAD, "decisions": [{"decisionId": "dec_upload1", "version": 1}]}),
        ("train.check", SYSTEM, {"checkRunId": "chk_run0001", "candidate": SHA_OTHER, "check": "acceptance:reject", "result": "pass", "acceptance": {"decision": {"decisionId": "dec_upload1", "version": 1}, "option": "reject"}}),
        ("train.intent", SYSTEM, {"intentId": "int_merge01", "expectedMain": SHA_BASE, "candidate": SHA_OTHER, "claims": ["clm_42abcd"], "decisions": [{"decisionId": "dec_upload1", "version": 1}], "checkRunId": "chk_run0001"}),
        ("train.main", SYSTEM, {"intentId": "int_merge01", "outcome": "updated", "main": SHA_OTHER}),
        ("train.conflict", SYSTEM, {"claims": ["clm_42abcd", "clm_43abcd"], "path": "src/upload.ts", "class": "contradictory", "probability": 0.97, "route": "question"}),
        ("claim.refused", SYSTEM, {"claimId": "clm_42abcd", "generation": 1, "reason": "unacked_decision"}),
        ("claim.expired", SYSTEM, {"claimId": "clm_42abcd", "generation": 1}),
        ("claim.reassigned", SYSTEM, {"claimId": "clm_42abcd", "from": AGENT, "to": "agt_ember01", "generation": 2}),
        ("agent.revoked", HUMAN, {"agentId": AGENT}),
    ]
    events = [event(i + 1, t, a, d) for i, (t, a, d) in enumerate(valid)]
    pushed = events[5]
    opened = events[4]
    shape = [
        ("unknown event type", {**opened, "type": "claim.deleted"}),
        ("data missing", {k: v for k, v in opened.items() if k != "data"}),
        ("null written as an omitted field", {**pushed, "data": {k: v for k, v in pushed["data"].items() if k != "from"}}),
        ("seq as a string", {**opened, "seq": "5"}),
        ("unknown actor kind", {**opened, "actor": {"kind": "robot", "id": AGENT}}),
        ("tag and data of different types", {**opened, "type": "claim.expired", "data": {"claimId": "clm_42abcd"}}),
    ]
    invariant = [
        ("unsupported schema version", {**opened, "v": 2}, "schema version"),
        ("seq beyond the safe integer range", {**opened, "seq": 9007199254740992}, "seq"),
        ("seq of zero", {**opened, "seq": 0}, "seq"),
        ("claim id used as a decision id", {**events[11], "data": {**events[11]["data"], "decisions": [{"decisionId": "clm_42abcd", "version": 1}]}}, "decisionId"),
        ("acknowledgement recorded by the system", {**events[10], "actor": SYSTEM}, "by the agent itself"),
        ("agent acknowledging another agent's item", {**events[10], "actor": {"kind": "agent", "id": "agt_ember01"}}, "its own inbox items"),
        ("decision recorded by an agent", {**events[7], "actor": AGENT_ACTOR}, "by a person"),
    ]
    return {
        "valid": events,
        "largestSafeSeq": {**opened, "seq": 9007199254740991},
        "rejectedShape": [{"name": n, "value": v} for n, v in shape],
        "rejectedInvariant": [{"name": n, "value": v, "error": e} for n, v, e in invariant],
    }


def write(path: pathlib.Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def main() -> None:
    write(HERE / "auth.json", auth_fixture())
    write(HERE / "events.json", events_fixture())
    for route, fixture in agent_fixtures().items():
        write(HERE / "agent" / f"{route}.json", {"route": route, **fixture})


if __name__ == "__main__":
    main()
