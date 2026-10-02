# Agent wire fixtures, version 1

Request and response bodies for every agent route, every event variant, and the login and join
signing vectors. The TypeScript contract is `@railhead/shared/agent-api` and
`@railhead/shared/events`; `packages/railhead-backend/__tests__/wireContract.test.ts` checks every
file here against it inside workerd, and the Rust protocol crate decodes the same files.

`generate.py` writes the JSON. Edit the script, run `python3 fixtures/protocol/wire/generate.py`
then `pnpm lint:fix`, which formats the output, and commit both. A change to a fixture is a contract
change: it updates both consumers' tests in the same change.

## Encoding

- Field names are camelCase. Every field is present; absence is `null`, never an omitted key.
- Integers are written without a fraction or exponent and lie between 0 and 2^53 − 1. Readers
  reject larger values, because TypeScript cannot represent them exactly. Times are milliseconds
  since the Unix epoch.
- Agent unions are tagged by `kind`. Events are tagged by `type` with their payload under `data`,
  and carry the schema version in `v`; a reader that meets another version stops.
- Readers ignore unknown fields and never store or forward them.
- Every response is `{"ok": true, "data", "inbox", "next"}` or `{"ok": false, "error"}`. The
  error's HTTP status, `retryable` and `next` are fixed per code by `AGENT_ERRORS`.
- Command results carry up to eight unacknowledged inbox items in `inbox`, so every command shows
  them first. Returning an item records it as delivered, never as acknowledged.

## Files

- `agent/<route>.json`: `method`, a concrete `path`, then `exchanges` (a request with headers,
  query and body, and the response status and body) and `rejectedRequests`, each refused at the
  `shape` stage (capnweb-validate) or the `invariant` stage (`validateAgentRequest`).
- `events.json`: one valid event per type, the largest safe `seq`, and events refused by shape or
  by `validateEvent`, with the error each must name.
- `auth.json`: the signing namespace, the confirmation-code vectors, and real SSHSIG signatures over
  a join and a login message, made by `ssh-keygen` with the RFC 8032 section 7.1 test keys. The
  rejected signatures use the `git` namespace, another key, or another challenge.

## Endpoint coverage

Paths follow `/agent/v1/{org}/{repo}`. "Session" means `Authorization: Bearer <token>`. Every route
can also return `invalid_request`, `unsupported_media_type`, `payload_too_large`, `not_found`,
`rate_limited`, `unavailable` and `internal`; session routes add `unauthenticated`,
`identity_pending` and `identity_revoked`.

| Route       | Method and path                       | Auth    | Repeats are safe because          | Fixture cases                                                                               |
| ----------- | ------------------------------------- | ------- | --------------------------------- | ------------------------------------------------------------------------------------------- |
| `join`      | `POST /join`                          | invite  | same invite and key resume        | pending, resumed confirmed, `join_refused`                                                  |
| `challenge` | `POST /session/challenge`             | none    | nothing changes                   | issued, `rate_limited`                                                                      |
| `session`   | `POST /session`                       | key     | a challenge redeems once          | token, `challenge_invalid`, `identity_pending`                                              |
| `status`    | `GET /status`                         | session | read only                         | with claim, without claim, `identity_revoked`                                               |
| `work`      | `POST /work`                          | session | the active claim is returned      | claimed, resumed, `no_work`, `busy`                                                         |
| `claim`     | `POST /claims`                        | session | the active claim is returned      | claimed, `claim_exists`, `issue_unavailable`                                                |
| `ready`     | `POST /claims/{claimId}/ready`        | session | same claim, generation and commit | pinned, repeated, `unacked_decision`, `stale_generation`, `after_ready`, `commit_not_found` |
| `inbox`     | `GET /inbox?limit=`                   | session | same unacknowledged items         | items, empty, `unauthenticated`                                                             |
| `ack`       | `POST /inbox/{item}/ack`              | session | the first acknowledgement is kept | acknowledged, repeated, `not_found`                                                         |
| `ask`       | `POST /claims/{claimId}/questions`    | session | same `requestId`                  | asked, `idempotency_mismatch`, `stale_generation`                                           |
| `question`  | `GET /questions/{questionId}?waitMs=` | session | read only                         | open after timeout, answered, `not_found`, `unavailable`                                    |

## What these fixtures cannot prove

They fix the bytes both sides exchange. They are not evidence of a live enrollment, a working
session, network interoperability or Artifacts behaviour; the session token in them is a
placeholder with a valid form and an invalid signature.
