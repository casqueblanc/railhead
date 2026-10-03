//! Encoding rules and validation edges the fixtures do not cover one by one.

use railhead_protocol::Error;
use railhead_protocol::{
    Actor, AgentErrorCode, AgentResponse, AskRequest, EventPayload, InboxResult, JoinRequest,
    MAX_SAFE_INTEGER, QuestionOption, ReadyRequest, SafeInteger, StatusResult, decode_event,
    decode_response,
};
use serde_json::{Value, json};

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn opened() -> Value {
    json!({
        "v": 1, "seq": 5, "at": 1_790_000_000_005_u64, "repo": "rep_demo0001",
        "actor": {"kind": "agent", "id": "agt_atlas01"},
        "type": "claim.opened",
        "data": {
            "claimId": "clm_42abcd", "issueId": "iss_upload1", "agentId": "agt_atlas01",
            "generation": 1, "base": "a".repeat(40),
        },
    })
}

fn decode(value: &Value) -> railhead_protocol::Result<railhead_protocol::Event> {
    decode_event(&value.to_string())
}

fn set(value: &mut Value, pointer: &str, new: Value) -> Result<(), String> {
    *value
        .pointer_mut(pointer)
        .ok_or_else(|| format!("no {pointer}"))? = new;
    Ok(())
}

// =======================================================================================
// Events: version, tags, integers, null and absence

#[test]
fn refuses_another_version_before_reading_the_rest() {
    let newer = json!({"v": 2, "type": "claim.moved", "data": {}});
    assert!(matches!(decode(&newer), Err(Error::UnsupportedVersion(2))));
    let older = json!({"v": 0});
    assert!(matches!(decode(&older), Err(Error::UnsupportedVersion(0))));
    assert!(matches!(
        decode(&json!({"v": "1"})),
        Err(Error::Json { .. })
    ));
    assert!(matches!(decode(&json!({})), Err(Error::Json { .. })));
}

#[test]
fn refuses_unknown_tags_and_enum_values() -> TestResult {
    for (pointer, value) in [
        ("/type", json!("claim.deleted")),
        ("/actor/kind", json!("bot")),
    ] {
        let mut event = opened();
        set(&mut event, pointer, value)?;
        assert!(
            matches!(decode(&event), Err(Error::Json { .. })),
            "{pointer}"
        );
    }
    let refused = json!({
        "v": 1, "seq": 1, "at": 1, "repo": "rep_demo0001",
        "actor": {"kind": "system", "id": "sys_train"},
        "type": "claim.refused",
        "data": {"claimId": "clm_42abcd", "generation": 1, "reason": "too_slow"},
    });
    assert!(matches!(decode(&refused), Err(Error::Json { .. })));
    Ok(())
}

#[test]
fn accepts_the_largest_safe_integer_and_refuses_the_next() -> TestResult {
    let mut event = opened();
    set(&mut event, "/data/generation", json!(MAX_SAFE_INTEGER))?;
    set(&mut event, "/at", json!(MAX_SAFE_INTEGER))?;
    let decoded = decode(&event)?;
    assert_eq!(decoded.at.get(), MAX_SAFE_INTEGER);
    for pointer in ["/seq", "/at", "/data/generation"] {
        let mut event = opened();
        set(&mut event, pointer, json!(MAX_SAFE_INTEGER + 1))?;
        assert!(
            matches!(decode(&event), Err(Error::Json { .. })),
            "{pointer}"
        );
    }
    Ok(())
}

#[test]
fn refuses_zero_negative_and_fractional_integers() -> TestResult {
    for (pointer, field) in [
        ("/seq", "seq"),
        ("/at", "at"),
        ("/data/generation", "generation"),
    ] {
        let mut event = opened();
        set(&mut event, pointer, json!(0))?;
        assert!(
            matches!(decode(&event), Err(Error::NotPositive { field: f }) if f == field),
            "{pointer}"
        );
    }
    for bad in [json!(-1), json!(1.5), json!(1.0)] {
        let mut event = opened();
        set(&mut event, "/seq", bad)?;
        assert!(matches!(decode(&event), Err(Error::Json { .. })));
    }
    Ok(())
}

#[test]
fn requires_null_and_refuses_an_omitted_nullable_field() -> TestResult {
    let pushed = json!({
        "v": 1, "seq": 6, "at": 6, "repo": "rep_demo0001",
        "actor": {"kind": "agent", "id": "agt_atlas01"},
        "type": "claim.pushed",
        "data": {
            "claimId": "clm_42abcd", "generation": 1, "ref": "refs/heads/main",
            "from": null, "to": "b".repeat(40),
        },
    });
    let event = decode(&pushed)?;
    let EventPayload::ClaimPushed(data) = &event.payload else {
        return Err("not a push".into());
    };
    assert_eq!(data.from, None);
    assert_eq!(
        serde_json::to_value(&event)?,
        pushed,
        "null is written back, not omitted"
    );

    let mut omitted = pushed.clone();
    omitted
        .pointer_mut("/data")
        .and_then(Value::as_object_mut)
        .and_then(|data| data.remove("from"))
        .ok_or("no from")?;
    assert!(matches!(decode(&omitted), Err(Error::Json { .. })));

    // `null` where the type allows none is refused too.
    let mut null_to = pushed;
    set(&mut null_to, "/data/to", Value::Null)?;
    assert!(matches!(decode(&null_to), Err(Error::Json { .. })));
    Ok(())
}

#[test]
fn ignores_and_drops_unknown_fields() -> TestResult {
    let mut event = opened();
    event
        .pointer_mut("/data")
        .and_then(Value::as_object_mut)
        .ok_or("no data")?
        .insert("extra".to_owned(), json!("x"));
    event
        .as_object_mut()
        .ok_or("not an object")?
        .insert("trace".to_owned(), json!({"id": 1}));
    let decoded = decode(&event)?;
    assert_eq!(serde_json::to_value(&decoded)?, opened());
    Ok(())
}

// =======================================================================================
// Events: who may record what

#[test]
fn refuses_an_event_recorded_by_the_wrong_kind_of_actor() -> TestResult {
    let mut revoked = opened();
    set(&mut revoked, "/type", json!("agent.revoked"))?;
    set(&mut revoked, "/data", json!({"agentId": "agt_atlas01"}))?;
    assert!(matches!(
        decode(&revoked),
        Err(Error::WrongActor {
            event_type: "agent.revoked",
            required: "a person"
        })
    ));
    set(
        &mut revoked,
        "/actor",
        json!({"kind": "human", "id": "usr_lemarier"}),
    )?;
    assert_eq!(
        decode(&revoked)?.actor,
        Actor::Human {
            id: "usr_lemarier".to_owned()
        }
    );

    let mut expired = opened();
    set(&mut expired, "/type", json!("claim.expired"))?;
    set(
        &mut expired,
        "/data",
        json!({"claimId": "clm_42abcd", "generation": 1}),
    )?;
    assert!(matches!(
        decode(&expired),
        Err(Error::WrongActor {
            required: "the system",
            ..
        })
    ));

    let mut reopened = opened();
    set(&mut reopened, "/type", json!("claim.reopened"))?;
    set(
        &mut reopened,
        "/data",
        json!({
            "claimId": "clm_42abcd", "generation": 1,
            "decisions": [{"decisionId": "dec_upload1", "version": 2}],
        }),
    )?;
    assert!(matches!(
        decode(&reopened),
        Err(Error::WrongActor {
            event_type: "claim.reopened",
            required: "the system"
        })
    ));
    set(
        &mut reopened,
        "/actor",
        json!({"kind": "human", "id": "usr_lemarier"}),
    )?;
    assert!(matches!(
        decode(&reopened),
        Err(Error::WrongActor {
            event_type: "claim.reopened",
            required: "the system"
        })
    ));
    set(
        &mut reopened,
        "/actor",
        json!({"kind": "system", "id": "sys_claims"}),
    )?;
    assert!(matches!(
        decode(&reopened)?.payload,
        EventPayload::ClaimReopened(_)
    ));

    Ok(())
}

#[test]
fn decodes_an_adaptation_only_from_the_system() -> TestResult {
    let mut adapted = opened();
    set(&mut adapted, "/type", json!("claim.adapted"))?;
    set(
        &mut adapted,
        "/data",
        json!({
            "claimId": "clm_42abcd", "intentId": "int_merge01",
            "decision": {"decisionId": "dec_upload1", "version": 1},
        }),
    )?;
    assert!(matches!(
        decode(&adapted),
        Err(Error::WrongActor {
            event_type: "claim.adapted",
            required: "the system"
        })
    ));
    set(
        &mut adapted,
        "/actor",
        json!({"kind": "system", "id": "sys_adaptation"}),
    )?;
    assert!(matches!(
        decode(&adapted)?.payload,
        EventPayload::ClaimAdapted(_)
    ));
    set(&mut adapted, "/data/intentId", json!("clm_42abcd"))?;
    assert!(
        decode(&adapted).is_err(),
        "a claim id cannot stand in for the intent"
    );
    Ok(())
}

#[test]
fn lets_an_agent_open_a_claim_only_for_itself() -> TestResult {
    let mut event = opened();
    set(&mut event, "/data/agentId", json!("agt_ember01"))?;
    assert!(matches!(
        decode(&event),
        Err(Error::ActorNotSubject {
            event_type: "claim.opened"
        })
    ));
    // A person may open a claim for an agent.
    set(
        &mut event,
        "/actor",
        json!({"kind": "human", "id": "usr_lemarier"}),
    )?;
    assert!(decode(&event).is_ok());
    Ok(())
}

#[test]
fn checks_identifier_kinds_and_length_bounds() -> TestResult {
    let mut event = opened();
    set(
        &mut event,
        "/repo",
        json!(format!("rep_{}", "A1".repeat(32))),
    )?;
    assert!(decode(&event).is_ok());
    for (pointer, value, field, prefix) in [
        (
            "/repo",
            json!(format!("rep_{}", "a".repeat(65))),
            "repo",
            "rep_",
        ),
        ("/repo", json!("rep_abc12"), "repo", "rep_"),
        ("/actor/id", json!("usr_atlas01"), "actor.id", "agt_"),
        ("/data/issueId", json!("clm_42abcd"), "issueId", "iss_"),
    ] {
        let mut event = opened();
        set(&mut event, pointer, value)?;
        assert!(
            matches!(decode(&event), Err(Error::InvalidId { field: f, prefix: p }) if f == field && p == prefix),
            "{pointer}"
        );
    }
    Ok(())
}

#[test]
fn checks_decision_versions_and_conflict_bounds() {
    let recorded = |version: u64, supersedes: Value| {
        json!({
            "v": 1, "seq": 1, "at": 1, "repo": "rep_demo0001",
            "actor": {"kind": "human", "id": "usr_lemarier"},
            "type": "decision.recorded",
            "data": {
                "decisionId": "dec_upload1", "version": version, "questionId": "qst_upload1",
                "option": "chunk", "supersedes": supersedes, "scope": ["src/upload.ts"],
            },
        })
    };
    assert!(decode(&recorded(1, Value::Null)).is_ok());
    assert!(decode(&recorded(2, json!(1))).is_ok());
    for (version, supersedes) in [(1, json!(1)), (2, Value::Null), (3, json!(1))] {
        assert!(
            matches!(
                decode(&recorded(version, supersedes)),
                Err(Error::Invalid {
                    field: "supersedes",
                    ..
                })
            ),
            "version {version}"
        );
    }

    let conflict = |claims: Value, probability: Value| {
        json!({
            "v": 1, "seq": 1, "at": 1, "repo": "rep_demo0001",
            "actor": {"kind": "system", "id": "sys_train"},
            "type": "train.conflict",
            "data": {
                "claims": claims, "path": "src/upload.ts", "class": "compatible",
                "probability": probability, "route": "redo",
            },
        })
    };
    let pair = json!(["clm_42abcd", "clm_43abcd"]);
    assert!(decode(&conflict(pair.clone(), json!(0))).is_ok());
    assert!(decode(&conflict(pair.clone(), json!(1))).is_ok());
    assert!(matches!(
        decode(&conflict(pair.clone(), json!(1.01))),
        Err(Error::Invalid {
            field: "probability",
            ..
        })
    ));
    assert!(matches!(
        decode(&conflict(json!(["clm_42abcd", "clm_42abcd"]), json!(0.5))),
        Err(Error::Invalid {
            field: "claims",
            ..
        })
    ));
    assert!(matches!(
        decode(&conflict(json!(["clm_42abcd"]), json!(0.5))),
        Err(Error::Json { .. })
    ));
}

// =======================================================================================
// Agent wire

fn status_response() -> Value {
    json!({
        "ok": true,
        "data": {
            "agent": {"agentId": "agt_atlas01", "name": "atlas", "ownerId": "usr_lemarier", "state": "confirmed"},
            "claim": null,
        },
        "inbox": {"items": [], "pending": 0},
        "next": null,
    })
}

#[test]
fn decodes_a_success_and_writes_it_back() -> TestResult {
    let response: AgentResponse<StatusResult> = serde_json::from_value(status_response())?;
    let AgentResponse::Success(success) = &response else {
        return Err("not a success".into());
    };
    assert_eq!(success.data.claim, None);
    assert_eq!(
        success.inbox.as_ref().map(|inbox| inbox.pending),
        Some(SafeInteger::ZERO)
    );
    assert_eq!(serde_json::to_value(&response)?, status_response());
    Ok(())
}

#[test]
fn refuses_a_response_without_a_boolean_ok_or_with_omitted_nulls() -> TestResult {
    for pointer in ["/ok", "/inbox", "/next", "/data/claim"] {
        let mut body = status_response();
        let (parent, key) = pointer.rsplit_once('/').ok_or("no slash")?;
        let parent = if parent.is_empty() {
            &mut body
        } else {
            body.pointer_mut(parent).ok_or("no parent")?
        };
        parent
            .as_object_mut()
            .and_then(|object| object.remove(key))
            .ok_or("no key")?;
        assert!(
            serde_json::from_value::<AgentResponse<StatusResult>>(body).is_err(),
            "accepted without {pointer}"
        );
    }
    let mut body = status_response();
    set(&mut body, "/ok", json!("true"))?;
    assert!(serde_json::from_value::<AgentResponse<StatusResult>>(body).is_err());
    Ok(())
}

#[test]
fn refuses_unknown_error_codes_tags_and_unsafe_integers() -> TestResult {
    let error = |code: &str, retry_after: Value| {
        json!({"ok": false, "error": {
            "code": code, "message": "m", "retryable": false,
            "retryAfterMs": retry_after, "next": null,
        }})
    };
    let response: AgentResponse<StatusResult> =
        serde_json::from_value(error("busy", json!(MAX_SAFE_INTEGER)))?;
    assert!(matches!(response, AgentResponse::Failure(e) if e.code == AgentErrorCode::Busy));
    assert!(
        serde_json::from_value::<AgentResponse<StatusResult>>(error("teapot", Value::Null))
            .is_err()
    );
    assert!(
        serde_json::from_value::<AgentResponse<StatusResult>>(error(
            "busy",
            json!(MAX_SAFE_INTEGER + 1)
        ))
        .is_err()
    );

    let inbox = |entry: Value, pending: Value| {
        json!({"ok": true, "inbox": null, "next": null, "data": {"pending": pending, "items": [
            {"item": 1, "claimId": "clm_42abcd", "queuedAt": 1, "entry": entry, "decision": null},
        ]}})
    };
    let conflict = json!({"kind": "conflict", "otherClaimId": "clm_43abcd", "path": "a"});
    assert!(
        serde_json::from_value::<AgentResponse<InboxResult>>(inbox(conflict.clone(), json!(1)))
            .is_ok()
    );
    assert!(
        serde_json::from_value::<AgentResponse<InboxResult>>(inbox(
            json!({"kind": "merge"}),
            json!(1)
        ))
        .is_err()
    );
    assert!(
        serde_json::from_value::<AgentResponse<InboxResult>>(inbox(
            conflict,
            json!(MAX_SAFE_INTEGER + 1)
        ))
        .is_err()
    );
    Ok(())
}

#[test]
fn every_error_code_has_its_fixed_status() {
    assert_eq!(AgentErrorCode::NotFound.spec().status, 404);
    assert!(AgentErrorCode::Internal.spec().retryable);
    assert!(!AgentErrorCode::Unavailable.spec().retryable);
    assert_eq!(AgentErrorCode::CommitNotFound.spec().status, 422);
}

#[test]
fn validates_requests_before_they_are_sent() -> TestResult {
    let commit = "b".repeat(40);
    let ready = |generation: u64, commit: &str| ReadyRequest {
        generation: SafeInteger::new(generation).unwrap_or(SafeInteger::ZERO),
        commit: commit.to_owned(),
    };
    ready(1, &commit).validate()?;
    assert!(matches!(
        ready(0, &commit).validate(),
        Err(Error::NotPositive {
            field: "generation"
        })
    ));
    assert!(ready(1, &commit.to_uppercase()).validate().is_err());

    let option = |key: &str| QuestionOption {
        key: key.to_owned(),
        label: "L".to_owned(),
    };
    let ask_in = |options: Vec<QuestionOption>, text: &str, scope: Vec<String>| AskRequest {
        generation: SafeInteger::new(1).unwrap_or(SafeInteger::ZERO),
        request_id: format!("req_{}", "a".repeat(16)),
        text: text.to_owned(),
        options,
        scope,
    };
    let ask = |options: Vec<QuestionOption>, text: &str| {
        ask_in(options, text, vec!["src/upload.ts".to_owned()])
    };
    ask(vec![option("a"), option("b")], "Which?").validate()?;
    let eight: Vec<_> = ["a", "b", "c", "d", "e", "f", "g", "h"].map(option).into();
    ask(eight.clone(), &"x".repeat(2000)).validate()?;
    let sixty_four: Vec<String> = (0..64).map(|i| format!("src/f{i}.ts")).collect();
    ask_in(vec![option("a"), option("b")], "Which?", sixty_four).validate()?;
    // Whitespace inside a path is a valid Git filename; only a blank path is refused.
    ask_in(
        vec![option("a"), option("b")],
        "Which?",
        vec!["docs/ notes.md".to_owned()],
    )
    .validate()?;
    let mut nine = eight;
    nine.push(option("i"));
    for request in [
        ask(nine, "Which?"),
        ask(vec![option("a")], "Which?"),
        ask(vec![option("a"), option("a")], "Which?"),
        ask(vec![option("a"), option("b")], "   "),
        ask(vec![option("a"), option("b")], &"x".repeat(2001)),
        ask_in(vec![option("a"), option("b")], "Which?", vec![]),
        ask_in(
            vec![option("a"), option("b")],
            "Which?",
            vec!["/src".to_owned()],
        ),
        ask_in(
            vec![option("a"), option("b")],
            "Which?",
            vec!["\u{feff}".to_owned()],
        ),
        ask_in(
            vec![option("a"), option("b")],
            "Which?",
            (0..65).map(|i| format!("src/f{i}.ts")).collect(),
        ),
    ] {
        assert!(request.validate().is_err(), "accepted {request:?}");
    }
    Ok(())
}

#[test]
fn never_echoes_wire_text_or_secrets() -> TestResult {
    let marker = "\u{1b}[31mFORGED";
    let mut event = opened();
    set(&mut event, "/type", json!(marker))?;
    let error = decode(&event).err().ok_or("accepted")?;
    assert!(matches!(error, Error::Json { line: 1, .. }));
    assert!(!error.to_string().contains("FORGED"), "{error}");

    let body = json!({"ok": false, "error": {"code": marker, "message": "m",
        "retryable": false, "retryAfterMs": null, "next": null}});
    let error = decode_response::<StatusResult>(&body.to_string())
        .err()
        .ok_or("accepted")?;
    assert!(!error.to_string().contains("FORGED"), "{error}");
    let response = decode_response::<StatusResult>(&status_response().to_string())?;
    assert!(matches!(response, AgentResponse::Success(_)));

    let secret = "Xb1wU76LGAGoVdSeZlIi2Z01AeN9-MuIrwGfAO2-1ZE";
    let join = JoinRequest {
        invite_id: "inv_abc123".to_owned(),
        invite_secret: secret.to_owned(),
        public_key: "ssh-ed25519 AAAA".to_owned(),
        signature: String::new(),
    };
    let debug = format!("{join:?}");
    assert!(
        !debug.contains(secret) && debug.contains("inv_abc123"),
        "{debug}"
    );
    assert!(
        serde_json::to_string(&join)?.contains(secret),
        "the wire body still carries it"
    );
    Ok(())
}
