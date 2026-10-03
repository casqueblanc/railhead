//! Decodes and round-trips every file in `fixtures/protocol/wire/`, the corpus the TypeScript
//! contract test in `packages/railhead-backend/__tests__/wireContract.test.ts` reads too.

use std::collections::HashSet;

use railhead_protocol::{
    AckRequest, AckResult, AgentResponse, AgentRoute, AskRequest, ChallengeRequest,
    ChallengeResult, ClaimRequest, ClaimResult, Error, InboxResult, JoinRequest, JoinResult,
    MAX_SAFE_INTEGER, Method, PinResult, QuestionResult, ReadyRequest, ReadyResult, SessionRequest,
    SessionResult, StatusResult, decode_event,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

type TestResult = Result<(), Box<dyn std::error::Error>>;

const EVENTS: &str = include_str!("../../../fixtures/protocol/wire/events.json");

const ROUTES: [(AgentRoute, &str); 12] = [
    (
        AgentRoute::Join,
        include_str!("../../../fixtures/protocol/wire/agent/join.json"),
    ),
    (
        AgentRoute::Challenge,
        include_str!("../../../fixtures/protocol/wire/agent/challenge.json"),
    ),
    (
        AgentRoute::Session,
        include_str!("../../../fixtures/protocol/wire/agent/session.json"),
    ),
    (
        AgentRoute::Status,
        include_str!("../../../fixtures/protocol/wire/agent/status.json"),
    ),
    (
        AgentRoute::Work,
        include_str!("../../../fixtures/protocol/wire/agent/work.json"),
    ),
    (
        AgentRoute::Claim,
        include_str!("../../../fixtures/protocol/wire/agent/claim.json"),
    ),
    (
        AgentRoute::Ready,
        include_str!("../../../fixtures/protocol/wire/agent/ready.json"),
    ),
    (
        AgentRoute::Pin,
        include_str!("../../../fixtures/protocol/wire/agent/pin.json"),
    ),
    (
        AgentRoute::Inbox,
        include_str!("../../../fixtures/protocol/wire/agent/inbox.json"),
    ),
    (
        AgentRoute::Ack,
        include_str!("../../../fixtures/protocol/wire/agent/ack.json"),
    ),
    (
        AgentRoute::Ask,
        include_str!("../../../fixtures/protocol/wire/agent/ask.json"),
    ),
    (
        AgentRoute::Question,
        include_str!("../../../fixtures/protocol/wire/agent/question.json"),
    ),
];

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a Value, String> {
    value
        .get(name)
        .ok_or_else(|| format!("fixture has no `{name}`"))
}

fn list<'a>(value: &'a Value, name: &str) -> Result<&'a Vec<Value>, String> {
    field(value, name)?
        .as_array()
        .ok_or_else(|| format!("fixture `{name}` is not a list"))
}

fn text<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    field(value, name)?
        .as_str()
        .ok_or_else(|| format!("fixture `{name}` is not a string"))
}

/// True when `value` holds a number above [`MAX_SAFE_INTEGER`] anywhere.
fn holds_unsafe_integer(value: &Value) -> bool {
    match value {
        Value::Number(n) => n.as_u64().is_some_and(|n| n > MAX_SAFE_INTEGER),
        Value::Array(items) => items.iter().any(holds_unsafe_integer),
        Value::Object(fields) => fields.values().any(holds_unsafe_integer),
        Value::Null | Value::Bool(_) | Value::String(_) => false,
    }
}

// =======================================================================================
// Events

#[test]
fn decodes_and_round_trips_one_event_of_every_type() -> TestResult {
    let fixture: Value = serde_json::from_str(EVENTS)?;
    let mut types = HashSet::new();
    for value in list(&fixture, "valid")? {
        let event = decode_event(&value.to_string())?;
        assert_eq!(
            &serde_json::to_value(&event)?,
            value,
            "{}",
            event.payload.type_name()
        );
        assert_eq!(text(value, "type")?, event.payload.type_name());
        types.insert(event.payload.type_name());
    }
    assert_eq!(types.len(), 24, "every event type has one fixture");
    Ok(())
}

#[test]
fn accepts_the_largest_safe_sequence_number() -> TestResult {
    let fixture: Value = serde_json::from_str(EVENTS)?;
    let event = decode_event(&field(&fixture, "largestSafeSeq")?.to_string())?;
    assert_eq!(event.seq.get(), MAX_SAFE_INTEGER);
    Ok(())
}

#[test]
fn refuses_every_event_typescript_refuses_by_shape() -> TestResult {
    let fixture: Value = serde_json::from_str(EVENTS)?;
    for case in list(&fixture, "rejectedShape")? {
        let result = decode_event(&field(case, "value")?.to_string());
        assert!(
            matches!(result, Err(Error::Json { .. })),
            "{}: {result:?}",
            text(case, "name")?
        );
    }
    Ok(())
}

#[test]
fn refuses_every_event_typescript_refuses_by_invariant() -> TestResult {
    let fixture: Value = serde_json::from_str(EVENTS)?;
    for case in list(&fixture, "rejectedInvariant")? {
        let name = text(case, "name")?;
        let value = field(case, "value")?;
        let result = decode_event(&value.to_string());
        // An unsafe integer is a shape error here: no Rust integer type may hold it.
        if holds_unsafe_integer(value) {
            assert!(
                matches!(result, Err(Error::Json { .. })),
                "{name}: {result:?}"
            );
        } else {
            assert!(
                matches!(&result, Err(error) if !matches!(error, Error::Json { .. })),
                "{name}: {result:?}"
            );
        }
    }
    Ok(())
}

// =======================================================================================
// Agent routes

/// True when `path` is `/agent/v1/{org}/{repo}` followed by the route's path, each placeholder
/// filled with a non-empty segment.
fn path_matches(route: AgentRoute, path: &str) -> bool {
    let template = format!("/agent/v1/{{org}}/{{repo}}{}", route.path());
    let template: Vec<&str> = template.split('/').collect();
    let actual: Vec<&str> = path.split('/').collect();
    template.len() == actual.len()
        && template
            .iter()
            .zip(&actual)
            .all(|(want, got)| want == got || (want.starts_with('{') && !got.is_empty()))
}

/// Decodes a request body as `T`, checks it, and returns its re-encoding.
fn request<T: DeserializeOwned + Serialize>(
    body: &Value,
    validate: fn(&T) -> railhead_protocol::Result<()>,
) -> Result<Value, Box<dyn std::error::Error>> {
    let request: T = serde_json::from_value(body.clone())?;
    validate(&request)?;
    Ok(serde_json::to_value(&request)?)
}

/// Decodes and checks a request body as the route's type and returns its re-encoding, or `null`
/// for a route without a body.
fn decode_request(route: AgentRoute, body: &Value) -> Result<Value, Box<dyn std::error::Error>> {
    match route {
        AgentRoute::Join => request(body, JoinRequest::validate),
        AgentRoute::Challenge => request(body, ChallengeRequest::validate),
        AgentRoute::Session => request(body, SessionRequest::validate),
        AgentRoute::Claim => request(body, ClaimRequest::validate),
        AgentRoute::Ready => request(body, ReadyRequest::validate),
        AgentRoute::Ack => request(body, AckRequest::validate),
        AgentRoute::Ask => request(body, AskRequest::validate),
        AgentRoute::Status
        | AgentRoute::Work
        | AgentRoute::Pin
        | AgentRoute::Inbox
        | AgentRoute::Question => {
            if body.is_null() {
                Ok(Value::Null)
            } else {
                Err("this route takes no body".into())
            }
        }
    }
}

/// Decodes a response body as `AgentResponse<T>` and returns its re-encoding.
fn response<T: DeserializeOwned + Serialize>(
    body: &Value,
) -> Result<Value, Box<dyn std::error::Error>> {
    let response: AgentResponse<T> = serde_json::from_value(body.clone())?;
    Ok(serde_json::to_value(&response)?)
}

/// Decodes a response body as the route's result type and returns its re-encoding.
fn decode_response(route: AgentRoute, body: &Value) -> Result<Value, Box<dyn std::error::Error>> {
    match route {
        AgentRoute::Join => response::<JoinResult>(body),
        AgentRoute::Challenge => response::<ChallengeResult>(body),
        AgentRoute::Session => response::<SessionResult>(body),
        AgentRoute::Status => response::<StatusResult>(body),
        AgentRoute::Work | AgentRoute::Claim => response::<ClaimResult>(body),
        AgentRoute::Ready => response::<ReadyResult>(body),
        AgentRoute::Pin => response::<PinResult>(body),
        AgentRoute::Inbox => response::<InboxResult>(body),
        AgentRoute::Ack => response::<AckResult>(body),
        AgentRoute::Ask | AgentRoute::Question => response::<QuestionResult>(body),
    }
}

#[test]
fn every_route_has_a_fixture_with_its_method_and_path() -> TestResult {
    assert_eq!(ROUTES.map(|(route, _)| route), AgentRoute::ALL);
    for (route, json) in ROUTES {
        let fixture: Value = serde_json::from_str(json)?;
        assert_eq!(text(&fixture, "route")?, route.name());
        assert_eq!(text(&fixture, "method")?, route.method().as_str());
        assert!(path_matches(route, text(&fixture, "path")?), "{route}");
        assert_eq!(
            route.has_body(),
            route.method() == Method::Post && route != AgentRoute::Work
        );
    }
    Ok(())
}

#[test]
fn round_trips_every_exchange_and_fixes_each_error_status() -> TestResult {
    for (route, json) in ROUTES {
        let fixture: Value = serde_json::from_str(json)?;
        for exchange in list(&fixture, "exchanges")? {
            let name = format!("{route}: {}", text(exchange, "name")?);
            let request_part = field(exchange, "request")?;
            let response_part = field(exchange, "response")?;

            // Headers: a body is JSON, and only session routes send the bearer token.
            let headers = field(request_part, "headers")?;
            let body = field(request_part, "body")?;
            assert_eq!(
                headers.get("content-type").is_some(),
                route.has_body(),
                "{name}"
            );
            assert_eq!(
                headers.get("authorization").is_some(),
                route.needs_session(),
                "{name}"
            );

            assert_eq!(&decode_request(route, body)?, body, "{name}");
            let response_body = field(response_part, "body")?;
            assert_eq!(
                &decode_response(route, response_body)?,
                response_body,
                "{name}"
            );

            // The envelope, read without the route's type.
            let status = field(response_part, "status")?.as_u64();
            match serde_json::from_value::<AgentResponse<Value>>(response_body.clone())? {
                AgentResponse::Success(success) => {
                    assert_eq!(status, Some(200), "{name}");
                    assert_eq!(success.inbox.is_some(), route.needs_session(), "{name}");
                }
                AgentResponse::Failure(error) => {
                    let spec = error.code.spec();
                    assert_eq!(status, Some(u64::from(spec.status)), "{name}");
                    assert_eq!(error.retryable, spec.retryable, "{name}");
                    assert_eq!(error.next, spec.next, "{name}");
                }
            }
        }
    }
    Ok(())
}

#[test]
fn refuses_every_request_typescript_refuses() -> TestResult {
    let mut cases = 0;
    for (route, json) in ROUTES {
        let fixture: Value = serde_json::from_str(json)?;
        for case in list(&fixture, "rejectedRequests")? {
            let name = format!("{route}: {}", text(case, "name")?);
            let body = field(case, "body")?;
            let result = decode_request(route, body);
            assert!(result.is_err(), "{name} was accepted");
            let refused_by_shape = result
                .err()
                .is_some_and(|error| error.downcast_ref::<serde_json::Error>().is_some());
            match text(case, "stage")? {
                // A route without a body refuses one before any type is read.
                "shape" => assert!(refused_by_shape || !route.has_body(), "{name}"),
                // An unsafe integer is a shape error here: no Rust integer type may hold it.
                "invariant" => assert!(!refused_by_shape || holds_unsafe_integer(body), "{name}"),
                other => return Err(format!("{name}: unknown stage {other}").into()),
            }
            cases += 1;
        }
    }
    assert!(cases > 0);
    Ok(())
}
