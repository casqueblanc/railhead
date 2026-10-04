//! The agent wire over HTTP: one request, one bounded response, one closed set of failures.
//!
//! Requests are validated by the protocol rules before anything is sent. Responses are read up to
//! [`MAX_AGENT_RESPONSE_BYTES`] and decoded strictly; a body that is not an agent response is
//! [`Error::Malformed`], never partially trusted. Redirects are not followed, so a session token
//! only ever reaches the configured origin. Errors name the route and the HTTP status, never a
//! token, a request body or response text.

use std::time::Duration;

use railhead_protocol::{
    AGENT_PATH_PREFIX, AGENT_REQUEST_CONTENT_TYPE, AGENT_REQUEST_TIMEOUT_MS, AckRequest,
    AgentError, AgentResponse, AgentRoute, AgentSuccess, AskRequest, ChallengeRequest,
    ClaimRequest, IdKind, JoinRequest, MAX_AGENT_REQUEST_BYTES, MAX_AGENT_RESPONSE_BYTES,
    MAX_INBOX_PAGE, MAX_LONG_POLL_MS, Method, ReadyRequest, ReleaseRequest, SafeInteger,
    SessionRequest, decode_response, is_id,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use url::Url;

use crate::context::{Origin, RepoRef};
use crate::identity::SessionToken;

/// A transport failure. None carries a token, a body or text from the response.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The request breaks a protocol rule; nothing was sent.
    #[error("{route} request is invalid: {source}")]
    InvalidRequest {
        /// The route.
        route: AgentRoute,
        /// The rule it breaks.
        #[source]
        source: railhead_protocol::Error,
    },
    /// A path or query value is out of range; nothing was sent.
    #[error("{route} request is invalid: {field} is not {expected}")]
    InvalidTarget {
        /// The route.
        route: AgentRoute,
        /// The path or query field.
        field: &'static str,
        /// What it must be.
        expected: &'static str,
    },
    /// The serialized body is larger than the backend reads; nothing was sent.
    #[error("{0} request is larger than {MAX_AGENT_REQUEST_BYTES} bytes")]
    RequestTooLarge(AgentRoute),
    /// The response did not arrive in time.
    #[error("{0} timed out; the request may or may not have taken effect")]
    Timeout(AgentRoute),
    /// The origin could not be reached.
    #[error("{0} could not reach the Railhead origin")]
    Unreachable(AgentRoute),
    /// The connection failed after it was made.
    #[error("{0} failed in transit; the request may or may not have taken effect")]
    Transport(AgentRoute),
    /// The response is larger than the CLI reads.
    #[error("{0} response is larger than {MAX_AGENT_RESPONSE_BYTES} bytes")]
    ResponseTooLarge(AgentRoute),
    /// The response is not an agent response of the expected shape.
    #[error("{route} returned a malformed response (HTTP {status})")]
    Malformed {
        /// The route.
        route: AgentRoute,
        /// The HTTP status received.
        status: u16,
    },
    /// The backend refused the request. The message is untrusted and kept out of `Display`.
    #[error("{route} was refused (HTTP {status})")]
    Rejected {
        /// The route.
        route: AgentRoute,
        /// The HTTP status received.
        status: u16,
        /// The backend's error. Its message is untrusted text.
        error: AgentError,
    },
}

/// Result of one agent call.
pub type Result<T> = std::result::Result<T, Error>;

/// A request body the agent wire accepts, checked by its protocol rules before sending.
pub trait WireRequest: Serialize {
    /// Applies the request's protocol rules.
    ///
    /// # Errors
    ///
    /// The first rule the request breaks.
    fn check(&self) -> railhead_protocol::Result<()>;
}

macro_rules! wire_requests {
    ($($request:ty),* $(,)?) => {$(
        impl WireRequest for $request {
            fn check(&self) -> railhead_protocol::Result<()> {
                self.validate()
            }
        }
    )*};
}

wire_requests!(
    JoinRequest,
    ChallengeRequest,
    SessionRequest,
    ClaimRequest,
    ReadyRequest,
    ReleaseRequest,
    AckRequest,
    AskRequest,
);

/// One agent route with its path and query values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Endpoint<'a> {
    /// `POST /join`.
    Join,
    /// `POST /session/challenge`.
    Challenge,
    /// `POST /session`.
    Session,
    /// `GET /status`.
    Status,
    /// `POST /work`.
    Work,
    /// `POST /claims`.
    Claim,
    /// `POST /claims/{claimId}/ready`.
    Ready {
        /// The claim.
        claim_id: &'a str,
    },
    /// `POST /claims/{claimId}/release`.
    Release {
        /// The claim.
        claim_id: &'a str,
    },
    /// `GET /inbox`, with an optional page size.
    Inbox {
        /// Items per page, from 1 to [`MAX_INBOX_PAGE`].
        limit: Option<u64>,
    },
    /// `POST /inbox/{item}/ack`.
    Ack {
        /// The inbox item.
        item: SafeInteger,
    },
    /// `POST /claims/{claimId}/questions`.
    Ask {
        /// The claim.
        claim_id: &'a str,
    },
    /// `GET /questions/{questionId}`, with an optional long-poll wait.
    Question {
        /// The question.
        question_id: &'a str,
        /// How long the backend may hold the request, up to [`MAX_LONG_POLL_MS`].
        wait_ms: Option<u64>,
    },
}

impl Endpoint<'_> {
    /// The route this endpoint calls.
    #[must_use]
    pub const fn route(&self) -> AgentRoute {
        match self {
            Self::Join => AgentRoute::Join,
            Self::Challenge => AgentRoute::Challenge,
            Self::Session => AgentRoute::Session,
            Self::Status => AgentRoute::Status,
            Self::Work => AgentRoute::Work,
            Self::Claim => AgentRoute::Claim,
            Self::Ready { .. } => AgentRoute::Ready,
            Self::Release { .. } => AgentRoute::Release,
            Self::Inbox { .. } => AgentRoute::Inbox,
            Self::Ack { .. } => AgentRoute::Ack,
            Self::Ask { .. } => AgentRoute::Ask,
            Self::Question { .. } => AgentRoute::Question,
        }
    }

    /// The path below `/agent/v1/{org}/{repo}` and the query, after checking every value.
    fn target(&self) -> Result<(String, Option<(&'static str, u64)>)> {
        let route = self.route();
        let invalid = |field, expected| Error::InvalidTarget {
            route,
            field,
            expected,
        };
        let id = |kind, value: &str, field| {
            if is_id(kind, value) {
                Ok(value.to_owned())
            } else {
                Err(invalid(field, "a valid identifier"))
            }
        };
        let path = route.path();
        Ok(match self {
            Self::Join
            | Self::Challenge
            | Self::Session
            | Self::Status
            | Self::Work
            | Self::Claim => (path.to_owned(), None),
            Self::Ready { claim_id } | Self::Release { claim_id } | Self::Ask { claim_id } => (
                path.replace("{claimId}", &id(IdKind::Claim, claim_id, "claimId")?),
                None,
            ),
            Self::Inbox { limit } => {
                if limit.is_some_and(|limit| !(1..=MAX_INBOX_PAGE).contains(&limit)) {
                    return Err(invalid("limit", "a page size from 1 to 64"));
                }
                (path.to_owned(), limit.map(|limit| ("limit", limit)))
            }
            Self::Ack { item } => {
                if item.get() == 0 {
                    return Err(invalid("item", "a positive item number"));
                }
                (path.replace("{item}", &item.get().to_string()), None)
            }
            Self::Question {
                question_id,
                wait_ms,
            } => {
                if wait_ms.is_some_and(|wait| wait > MAX_LONG_POLL_MS) {
                    return Err(invalid("waitMs", "a wait of at most 25000 ms"));
                }
                (
                    path.replace(
                        "{questionId}",
                        &id(IdKind::Question, question_id, "questionId")?,
                    ),
                    wait_ms.map(|wait| ("waitMs", wait)),
                )
            }
        })
    }
}

/// An agent API client for one repository on one origin.
#[derive(Debug, Clone)]
pub struct Client {
    http: reqwest::Client,
    base: Url,
}

impl Client {
    /// A client for `repo` on `origin`, with the protocol's request timeout.
    ///
    /// # Errors
    ///
    /// [`Error::Unreachable`] when the HTTP client cannot be built.
    pub fn new(origin: &Origin, repo: &RepoRef) -> Result<Self> {
        Self::with_timeout(
            origin,
            repo,
            Duration::from_millis(AGENT_REQUEST_TIMEOUT_MS),
        )
    }

    /// A client whose every request, body included, must finish within `timeout`.
    ///
    /// # Errors
    ///
    /// [`Error::Unreachable`] when the HTTP client cannot be built.
    pub fn with_timeout(origin: &Origin, repo: &RepoRef, timeout: Duration) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("rh/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| Error::Unreachable(AgentRoute::Status))?;
        let base = origin.join_path(&format!(
            "{AGENT_PATH_PREFIX}/{}/{}",
            repo.org.as_str(),
            repo.repo.as_str()
        ));
        Ok(Self { http, base })
    }

    /// Calls a route that takes a JSON body.
    ///
    /// # Errors
    ///
    /// See [`Error`]. A request that breaks a rule is refused before anything is sent.
    pub async fn send<B: WireRequest, T: DeserializeOwned>(
        &self,
        endpoint: &Endpoint<'_>,
        session: Option<&SessionToken>,
        body: &B,
    ) -> Result<AgentSuccess<T>> {
        let route = endpoint.route();
        body.check()
            .map_err(|source| Error::InvalidRequest { route, source })?;
        let json = serde_json::to_vec(body).map_err(|_| Error::RequestTooLarge(route))?;
        if json.len() > MAX_AGENT_REQUEST_BYTES {
            return Err(Error::RequestTooLarge(route));
        }
        self.call(endpoint, session, Some(json)).await
    }

    /// Calls a route that takes no body.
    ///
    /// # Errors
    ///
    /// See [`Error`].
    pub async fn get<T: DeserializeOwned>(
        &self,
        endpoint: &Endpoint<'_>,
        session: Option<&SessionToken>,
    ) -> Result<AgentSuccess<T>> {
        self.call(endpoint, session, None).await
    }

    async fn call<T: DeserializeOwned>(
        &self,
        endpoint: &Endpoint<'_>,
        session: Option<&SessionToken>,
        body: Option<Vec<u8>>,
    ) -> Result<AgentSuccess<T>> {
        let route = endpoint.route();
        let misuse = |field, expected| Error::InvalidTarget {
            route,
            field,
            expected,
        };
        if route.has_body() != body.is_some() {
            return Err(misuse("body", "what the route takes"));
        }
        // A session route without a token would only be refused; a token on any other route
        // would be sent where it is not needed.
        let token = match (route.needs_session(), session) {
            (true, Some(token)) => Some(token),
            (true, None) => return Err(misuse("session", "a session token")),
            (false, _) => None,
        };
        let (path, query) = endpoint.target()?;
        let mut url = self.base.clone();
        url.set_path(&format!("{}{path}", self.base.path()));
        if let Some((key, value)) = query {
            url.query_pairs_mut().append_pair(key, &value.to_string());
        }

        let method = match route.method() {
            Method::Get => reqwest::Method::GET,
            Method::Post => reqwest::Method::POST,
        };
        let mut request = self
            .http
            .request(method, url)
            .header(reqwest::header::ACCEPT, AGENT_REQUEST_CONTENT_TYPE);
        if let Some(token) = token {
            request = request.bearer_auth(token.expose());
        }
        if let Some(body) = body {
            request = request
                .header(reqwest::header::CONTENT_TYPE, AGENT_REQUEST_CONTENT_TYPE)
                .body(body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| transport_error(route, &error))?;
        let status = response.status().as_u16();
        let malformed = Error::Malformed { route, status };
        if !is_json(response.headers()) {
            return Err(malformed);
        }
        let bytes = read_bounded(route, response).await?;
        let text = std::str::from_utf8(&bytes).map_err(|_| Error::Malformed { route, status })?;
        match decode_response::<T>(text) {
            Ok(AgentResponse::Success(success)) if (200..300).contains(&status) => Ok(success),
            Ok(AgentResponse::Failure(error)) if status >= 400 => Err(Error::Rejected {
                route,
                status,
                error,
            }),
            Ok(AgentResponse::Success(_) | AgentResponse::Failure(_)) | Err(_) => Err(malformed),
        }
    }
}

fn transport_error(route: AgentRoute, error: &reqwest::Error) -> Error {
    if error.is_timeout() {
        Error::Timeout(route)
    } else if error.is_connect() {
        Error::Unreachable(route)
    } else {
        Error::Transport(route)
    }
}

fn is_json(headers: &reqwest::header::HeaderMap) -> bool {
    headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|essence| {
            essence
                .trim()
                .eq_ignore_ascii_case(AGENT_REQUEST_CONTENT_TYPE)
        })
}

/// Reads the body, refusing one larger than [`MAX_AGENT_RESPONSE_BYTES`] without buffering it.
async fn read_bounded(route: AgentRoute, mut response: reqwest::Response) -> Result<Vec<u8>> {
    let limit = MAX_AGENT_RESPONSE_BYTES;
    if response
        .content_length()
        .is_some_and(|length| usize::try_from(length).map_or(true, |length| length > limit))
    {
        return Err(Error::ResponseTooLarge(route));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| transport_error(route, &error))?
    {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(Error::ResponseTooLarge(route));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use railhead_protocol::{AgentErrorCode, ClaimResult, NextCommand, StatusResult};
    use serde_json::{Value, json};
    use wiremock::matchers::{body_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;

    const TOKEN: &str = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhZ3RfYXRsYXMwMSJ9.c2lnbmF0dXJl";
    const PREFIX: &str = "/agent/v1/casqueblanc/demo";

    /// The first exchange of a fixture in `fixtures/protocol/wire/agent`.
    fn fixture(file: &str) -> anyhow::Result<Value> {
        let path = format!(
            "{}/../../fixtures/protocol/wire/agent/{file}",
            env!("CARGO_MANIFEST_DIR")
        );
        let corpus: Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        corpus
            .pointer("/exchanges/0/response/body")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("{file} has no first exchange"))
    }

    fn token() -> anyhow::Result<SessionToken> {
        SessionToken::new(TOKEN.to_owned()).ok_or_else(|| anyhow::anyhow!("token refused"))
    }

    fn client(server: &MockServer, timeout: Duration) -> anyhow::Result<Client> {
        Ok(Client::with_timeout(
            &server.uri().parse()?,
            &"casqueblanc/demo".parse()?,
            timeout,
        )?)
    }

    fn json_response(status: u16, body: &Value) -> ResponseTemplate {
        ResponseTemplate::new(status).set_body_raw(body.to_string(), "application/json")
    }

    async fn requests(server: &MockServer) -> usize {
        server
            .received_requests()
            .await
            .map_or(0, |requests| requests.len())
    }

    #[tokio::test]
    async fn a_success_is_decoded_with_its_inbox_and_next_command() -> anyhow::Result<()> {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!("{PREFIX}/status")))
            .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
            .respond_with(json_response(200, &fixture("status.json")?))
            .expect(1)
            .mount(&server)
            .await;
        let client = client(&server, Duration::from_secs(5))?;
        let success: AgentSuccess<StatusResult> =
            client.get(&Endpoint::Status, Some(&token()?)).await?;
        assert_eq!(success.data.agent.agent_id, "agt_atlas01");
        assert!(success.inbox.is_some_and(|inbox| inbox.pending.get() > 0));
        assert_eq!(success.next, Some(NextCommand::Sync));
        Ok(())
    }

    #[tokio::test]
    async fn a_body_is_sent_as_json_without_a_token_on_open_routes() -> anyhow::Result<()> {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(format!("{PREFIX}/claims")))
            .and(header("content-type", "application/json"))
            .and(body_json(json!({"issueId": "iss_upload1"})))
            .respond_with(json_response(200, &fixture("claim.json")?))
            .expect(1)
            .mount(&server)
            .await;
        let client = client(&server, Duration::from_secs(5))?;
        let request = ClaimRequest {
            issue_id: "iss_upload1".to_owned(),
        };
        let success: AgentSuccess<ClaimResult> = client
            .send(&Endpoint::Claim, Some(&token()?), &request)
            .await?;
        assert_eq!(success.data.claim.claim_id, "clm_42abcd");

        // `challenge` needs no session, so the token stays home even when one is offered.
        Mock::given(method("POST"))
            .and(path(format!("{PREFIX}/session/challenge")))
            .respond_with(json_response(200, &fixture("challenge.json")?))
            .mount(&server)
            .await;
        let challenge = ChallengeRequest {
            agent_id: "agt_atlas01".to_owned(),
        };
        let _: AgentSuccess<railhead_protocol::ChallengeResult> = client
            .send(&Endpoint::Challenge, Some(&token()?), &challenge)
            .await?;
        let received = server.received_requests().await.unwrap_or_default();
        let last = received
            .last()
            .map(|request| request.headers.contains_key("authorization"));
        assert_eq!(last, Some(false));
        Ok(())
    }

    #[tokio::test]
    async fn path_and_query_values_are_encoded_after_checking() -> anyhow::Result<()> {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!("{PREFIX}/inbox")))
            .and(query_param("limit", "64"))
            .respond_with(json_response(200, &fixture("inbox.json")?))
            .expect(1)
            .mount(&server)
            .await;
        let client = client(&server, Duration::from_secs(5))?;
        let _: AgentSuccess<railhead_protocol::InboxResult> = client
            .get(
                &Endpoint::Inbox {
                    limit: Some(MAX_INBOX_PAGE),
                },
                Some(&token()?),
            )
            .await?;

        for endpoint in [
            Endpoint::Inbox { limit: Some(0) },
            Endpoint::Inbox {
                limit: Some(MAX_INBOX_PAGE + 1),
            },
            Endpoint::Question {
                question_id: "qst_q1abcd",
                wait_ms: Some(MAX_LONG_POLL_MS + 1),
            },
            Endpoint::Question {
                question_id: "../status",
                wait_ms: None,
            },
            Endpoint::Ack {
                item: SafeInteger::ZERO,
            },
        ] {
            let result = client.get::<Value>(&endpoint, Some(&token()?)).await;
            assert!(
                matches!(result, Err(Error::InvalidTarget { .. })),
                "{endpoint:?}"
            );
        }
        let request = ReadyRequest {
            generation: SafeInteger::new(1).ok_or_else(|| anyhow::anyhow!("range"))?,
            commit: "a".repeat(40),
        };
        let result = client
            .send::<_, Value>(
                &Endpoint::Ready {
                    claim_id: "clm_x/../y",
                },
                Some(&token()?),
                &request,
            )
            .await;
        assert!(matches!(
            result,
            Err(Error::InvalidTarget {
                field: "claimId",
                ..
            })
        ));
        assert_eq!(requests(&server).await, 1);
        Ok(())
    }

    #[tokio::test]
    async fn an_invalid_request_or_missing_session_sends_nothing() -> anyhow::Result<()> {
        let server = MockServer::start().await;
        let client = client(&server, Duration::from_secs(5))?;
        let bad = ClaimRequest {
            issue_id: "clm_notanissue".to_owned(),
        };
        let result = client
            .send::<_, Value>(&Endpoint::Claim, Some(&token()?), &bad)
            .await;
        assert!(matches!(
            result,
            Err(Error::InvalidRequest {
                route: AgentRoute::Claim,
                ..
            })
        ));
        let result = client.get::<Value>(&Endpoint::Status, None).await;
        assert!(matches!(
            result,
            Err(Error::InvalidTarget {
                field: "session",
                ..
            })
        ));
        let result = client.get::<Value>(&Endpoint::Claim, Some(&token()?)).await;
        assert!(matches!(
            result,
            Err(Error::InvalidTarget { field: "body", .. })
        ));
        let oversized = AckRequest {
            plan: "é".repeat(MAX_AGENT_REQUEST_BYTES),
        };
        let result = client
            .send::<_, Value>(
                &Endpoint::Ack {
                    item: SafeInteger::new(1).ok_or_else(|| anyhow::anyhow!("range"))?,
                },
                Some(&token()?),
                &oversized,
            )
            .await;
        assert!(matches!(result, Err(Error::InvalidRequest { .. })));
        assert_eq!(requests(&server).await, 0);
        Ok(())
    }

    #[tokio::test]
    async fn a_refusal_carries_the_code_but_not_the_token() -> anyhow::Result<()> {
        let server = MockServer::start().await;
        let body = json!({"ok": false, "error": {"code": "unacked_decision",
            "message": "Acknowledge item 17 first.", "retryable": false,
            "retryAfterMs": null, "next": "sync"}});
        Mock::given(method("GET"))
            .and(path(format!("{PREFIX}/status")))
            .respond_with(json_response(409, &body))
            .mount(&server)
            .await;
        let client = client(&server, Duration::from_secs(5))?;
        let error = client
            .get::<StatusResult>(&Endpoint::Status, Some(&token()?))
            .await
            .err()
            .ok_or_else(|| anyhow::anyhow!("a refusal was accepted"))?;
        let Error::Rejected {
            status,
            error: ref refusal,
            ..
        } = error
        else {
            anyhow::bail!("unexpected {error:?}");
        };
        assert_eq!(
            (status, refusal.code, refusal.next),
            (
                409,
                AgentErrorCode::UnackedDecision,
                Some(NextCommand::Sync)
            )
        );
        for text in [format!("{error}"), format!("{error:?}")] {
            assert!(!text.contains(TOKEN) && !text.contains("eyJ"), "{text}");
        }
        Ok(())
    }

    #[tokio::test]
    async fn malformed_responses_are_refused_without_echoing_them() -> anyhow::Result<()> {
        let secret_text = "SECRET-BODY-TEXT";
        let cases = [
            // Not JSON at all.
            ResponseTemplate::new(200)
                .set_body_raw(format!("<html>{secret_text}</html>"), "application/json"),
            // JSON, but not declared as JSON.
            ResponseTemplate::new(200)
                .set_body_raw(fixture("status.json")?.to_string(), "text/plain"),
            // A success missing a field.
            json_response(
                200,
                &json!({"ok": true, "data": {"agent": secret_text}, "inbox": null, "next": null}),
            ),
            // A success sent with an error status, and a refusal sent with a success status.
            json_response(500, &fixture("status.json")?),
            json_response(
                200,
                &json!({"ok": false, "error": {"code": "internal", "message": secret_text,
                "retryable": true, "retryAfterMs": null, "next": null}}),
            ),
            // An unknown error code.
            json_response(
                409,
                &json!({"ok": false, "error": {"code": "made_up", "message": secret_text,
                "retryable": true, "retryAfterMs": null, "next": null}}),
            ),
            // A redirect, which is not followed.
            ResponseTemplate::new(302).insert_header("location", "https://evil.example/steal"),
        ];
        for (index, response) in cases.into_iter().enumerate() {
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .respond_with(response)
                .mount(&server)
                .await;
            let client = client(&server, Duration::from_secs(5))?;
            let error = client
                .get::<StatusResult>(&Endpoint::Status, Some(&token()?))
                .await
                .err();
            assert!(
                matches!(
                    error,
                    Some(Error::Malformed {
                        route: AgentRoute::Status,
                        ..
                    })
                ),
                "case {index}: {error:?}"
            );
            let text = format!("{error:?}");
            assert!(!text.contains(secret_text), "case {index}: {text}");
        }
        Ok(())
    }

    #[tokio::test]
    async fn a_response_at_the_size_limit_is_read_and_one_byte_more_is_refused()
    -> anyhow::Result<()> {
        let template = |padding: usize| {
            let body = json!({"ok": true, "data": {"pad": "x".repeat(padding)}, "inbox": null, "next": null});
            body.to_string()
        };
        let overhead = template(0).len();
        for (extra, fits) in [(0, true), (1, false)] {
            let server = MockServer::start().await;
            let body = template(MAX_AGENT_RESPONSE_BYTES - overhead + extra);
            Mock::given(method("GET"))
                .respond_with(ResponseTemplate::new(200).set_body_raw(body, "application/json"))
                .mount(&server)
                .await;
            let client = client(&server, Duration::from_secs(5))?;
            let result = client
                .get::<Value>(&Endpoint::Status, Some(&token()?))
                .await;
            if fits {
                assert!(result.is_ok(), "{result:?}");
            } else {
                assert!(
                    matches!(result, Err(Error::ResponseTooLarge(_))),
                    "{result:?}"
                );
            }
        }
        Ok(())
    }

    #[tokio::test]
    async fn a_slow_response_times_out() -> anyhow::Result<()> {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                json_response(200, &fixture("work.json")?).set_delay(Duration::from_secs(5)),
            )
            .mount(&server)
            .await;
        let client = client(&server, Duration::from_millis(200))?;
        let result = client
            .get::<ClaimResult>(&Endpoint::Work, Some(&token()?))
            .await;
        assert!(
            matches!(result, Err(Error::Timeout(AgentRoute::Work))),
            "{result:?}"
        );
        Ok(())
    }

    #[tokio::test]
    async fn an_unreachable_origin_is_reported() -> anyhow::Result<()> {
        // The local port of an open connection: held by it for the whole test, so no server another
        // test starts concurrently can take it, and with nothing listening on it a connection to it
        // is refused. A port released before the request could be taken in between, and a socket
        // bound without listening makes macOS drop the connection attempt until the timeout.
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        let held = std::net::TcpStream::connect(listener.local_addr()?)?;
        let origin: Origin = format!("http://{}", held.local_addr()?).parse()?;
        let client = Client::with_timeout(
            &origin,
            &"casqueblanc/demo".parse()?,
            Duration::from_secs(5),
        )?;
        let result = client
            .get::<Value>(&Endpoint::Status, Some(&token()?))
            .await;
        assert!(
            matches!(result, Err(Error::Unreachable(AgentRoute::Status))),
            "{result:?}"
        );
        drop((held, listener));
        Ok(())
    }
}
