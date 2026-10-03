//! `rh sync`: Read unacknowledged inbox items and the decisions they carry.
//!
//! One bounded page per run, oldest first. Nothing is acknowledged here: each item stays pending
//! until the agent runs `rh ack` with its own plan for it.
//!
//! Decisions print in a fixed format: every line starts with a label `rh` writes, and every value
//! from the backend is quoted as a JSON string, so a question, label or path cannot break out of
//! its line or pass for an instruction from `rh`.

use std::collections::BTreeSet;
use std::io::{self, Write};

use railhead_protocol::{
    DEFAULT_INBOX_PAGE, DecisionView, InboxEntry, InboxItem, InboxResult, MAX_INBOX_PAGE,
    NextCommand, QuestionOption,
};
use serde::Serialize;

use crate::commands::claim::session;
use crate::http::Endpoint;
use crate::output::{LocalCode, Output, Render, inert};
use crate::{Agent, Error, Result};

/// Arguments of `rh sync`.
#[derive(Debug, Clone, clap::Args)]
pub struct Args {
    /// Most items to read, from 1 to 64. The backend's default page applies when omitted.
    #[arg(long, value_name = "N", value_parser = clap::value_parser!(u64).range(1..=MAX_INBOX_PAGE))]
    pub limit: Option<u64>,
}

/// Runs `rh sync`.
///
/// # Errors
///
/// When the agent has no session, the backend refuses, or the page is inconsistent: a repeated or
/// out-of-order item, a decision item whose decision does not match its entry, more items than
/// were asked for or are pending, or no items while some are pending.
pub fn run(agent: &Agent<'_>, args: &Args, out: &mut Output<'_>) -> Result<()> {
    let session = session(agent)?;
    let client = agent.client()?;
    let response = agent.invocation.runtime.block_on(
        client.get::<InboxResult>(&Endpoint::Inbox { limit: args.limit }, Some(&session)),
    )?;
    let synced = Synced::new(response.data, args.limit.unwrap_or(DEFAULT_INBOX_PAGE))?;
    let next = if synced.items.is_empty() {
        response.next
    } else {
        Some(NextCommand::Ack)
    };
    out.success(&synced, response.inbox.as_ref(), next)
        .map_err(Error::Output)
}

/// The result of `rh sync`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Synced {
    /// The page, oldest first.
    items: Vec<Pending>,
    /// How many items are unacknowledged in all, this page included.
    pending: u64,
}

/// One unacknowledged item and the command that acknowledges it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    #[serde(flatten)]
    item: InboxItem,
    /// `rh ack <item> --plan <plan>`, with `<plan>` for the agent to fill in.
    ack: String,
}

impl Synced {
    /// Checks the page before anything of it is printed. Delivery is at least once, but one page
    /// never repeats an item: a repeat, like an item out of order, means the page is not the
    /// inbox's, and printing it could show a decision twice or under the wrong number.
    ///
    /// The page holds at most `limit` items. It may hold fewer than are pending, since the backend
    /// also bounds a page by size, but it always holds the oldest one: an empty page while items
    /// are pending would tell the agent its inbox is clear when it is not.
    fn new(page: InboxResult, limit: u64) -> Result<Self> {
        if u64::try_from(page.items.len()).map_or(true, |shown| shown > limit) {
            return Err(inconsistent(&format!(
                "the inbox returned more items than its page of {limit}"
            )));
        }
        let mut seen = BTreeSet::new();
        let mut last = 0;
        let mut items = Vec::with_capacity(page.items.len());
        for item in page.items {
            let number = item.item.get();
            if number == 0 || number <= last || !seen.insert(number) {
                return Err(inconsistent(&format!(
                    "inbox item {number} is repeated or out of order"
                )));
            }
            last = number;
            check_entry(&item)?;
            items.push(Pending {
                ack: format!("rh ack {number} --plan <plan>"),
                item,
            });
        }
        let pending = page.pending.get();
        if u64::try_from(items.len()).map_or(true, |shown| shown > pending) {
            return Err(inconsistent(
                "the inbox returned more items than it says are pending",
            ));
        }
        if items.is_empty() && pending > 0 {
            return Err(inconsistent(&format!(
                "the inbox returned no items but says {pending} are pending"
            )));
        }
        Ok(Self { items, pending })
    }
}

/// A decision or rework item must carry the decision version its entry names; any other item
/// carries none.
fn check_entry(item: &InboxItem) -> Result<()> {
    let matches = match (&item.entry, &item.decision) {
        (
            InboxEntry::Decision { decision: named } | InboxEntry::Rework { decision: named },
            Some(decision),
        ) => named.decision_id == decision.decision_id && named.version == decision.version,
        (InboxEntry::Conflict { .. }, None) => true,
        (InboxEntry::Decision { .. } | InboxEntry::Rework { .. }, None)
        | (InboxEntry::Conflict { .. }, Some(_)) => false,
    };
    if matches {
        Ok(())
    } else {
        Err(inconsistent(&format!(
            "inbox item {} does not carry the decision it names",
            item.item
        )))
    }
}

fn inconsistent(what: &str) -> Error {
    Error::Local {
        code: LocalCode::MalformedResponse,
        message: format!("{what}; nothing was printed or acknowledged"),
        retryable: false,
        next: None,
    }
}

impl Render for Synced {
    fn render(&self, out: &mut dyn Write) -> io::Result<()> {
        let shown = self.items.len();
        if shown == 0 {
            return writeln!(out, "inbox: nothing to acknowledge");
        }
        let noun = if shown == 1 { "item" } else { "items" };
        writeln!(out, "{shown} unacknowledged {noun}, oldest first")?;
        for pending in &self.items {
            writeln!(out)?;
            render_item(out, &pending.item)?;
            writeln!(out, "     acknowledge: {}", pending.ack)?;
        }
        let rest = self
            .pending
            .saturating_sub(u64::try_from(shown).unwrap_or(u64::MAX));
        if rest > 0 {
            writeln!(out)?;
            writeln!(
                out,
                "{rest} more pending; acknowledge these, then run rh sync again"
            )?;
        }
        Ok(())
    }
}

fn render_item(out: &mut dyn Write, item: &InboxItem) -> io::Result<()> {
    let number = item.item;
    let claim = quoted(&item.claim_id);
    match (&item.entry, &item.decision) {
        (InboxEntry::Decision { .. }, Some(decision)) => {
            writeln!(out, "[{number}] decision for claim {claim}")?;
            render_decision(out, decision)?;
            writeln!(
                out,
                "     action: follow this decision in work it applies to"
            )
        }
        (InboxEntry::Rework { .. }, Some(decision)) => {
            writeln!(out, "[{number}] rework for claim {claim}")?;
            render_decision(out, decision)?;
            writeln!(
                out,
                "     action: rework required; redo work that relied on the earlier version"
            )
        }
        (
            InboxEntry::Conflict {
                other_claim_id,
                path,
            },
            _,
        ) => {
            writeln!(out, "[{number}] conflict for claim {claim}")?;
            writeln!(
                out,
                "     overlaps: claim {} on {}",
                quoted(other_claim_id),
                quoted(path)
            )?;
            writeln!(out, "     action: redo the change on the new base")
        }
        // `Synced::new` refused these.
        (InboxEntry::Decision { .. } | InboxEntry::Rework { .. }, None) => Ok(()),
    }
}

/// Writes a decision version in the fixed format `rh sync` and `rh ask` share. Every value from
/// the backend is [`quoted`].
///
/// # Errors
///
/// When writing fails.
pub fn render_decision(out: &mut dyn Write, decision: &DecisionView) -> io::Result<()> {
    let supersedes = decision
        .supersedes
        .map_or(String::new(), |version| format!(", supersedes v{version}"));
    writeln!(
        out,
        "     decision: {} v{}{supersedes}, recorded by {} through Railhead",
        quoted(&decision.decision_id),
        decision.version,
        quoted(&decision.decided_by)
    )?;
    writeln!(out, "     question: {}", quoted(&decision.question))?;
    writeln!(out, "     chosen: {}", option(&decision.option))?;
    if let Some(previous) = &decision.previous {
        writeln!(out, "     was: {}", option(previous))?;
    }
    let scope: Vec<_> = decision.scope.iter().map(|path| quoted(path)).collect();
    writeln!(out, "     scope: {}", scope.join(", "))
}

fn option(option: &QuestionOption) -> String {
    format!("{} {}", quoted(&option.key), quoted(&option.label))
}

/// Untrusted text as one inert JSON string: quotes and escapes keep it on its own line, and
/// [`inert`] neutralises the characters JSON leaves as they are.
#[must_use]
pub fn quoted(text: &str) -> String {
    let json = serde_json::to_string(text).unwrap_or_else(|_| String::from("\"\""));
    inert(&json).into_owned()
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn decision(version: u64) -> Value {
        json!({"decisionId": "dec_upload1", "version": version, "supersedes": 1,
            "questionId": "qst_upload1", "question": "Reject or chunk?",
            "option": {"key": "chunk", "label": "Upload them in chunks"},
            "previous": {"key": "reject", "label": "Reject them"},
            "scope": ["src/upload.ts"], "decidedBy": "usr_lemarier", "decidedAt": 1})
    }

    fn rework(item: u64, version: u64) -> Value {
        json!({"item": item, "claimId": "clm_42abcd", "queuedAt": 1,
            "entry": {"kind": "rework", "decision": {"decisionId": "dec_upload1", "version": 2}},
            "decision": decision(version)})
    }

    fn conflict(item: u64) -> Value {
        json!({"item": item, "claimId": "clm_42abcd", "queuedAt": 1,
            "entry": {"kind": "conflict", "otherClaimId": "clm_43abcd", "path": "src/upload.ts"},
            "decision": null})
    }

    fn page(items: &[Value], pending: u64) -> anyhow::Result<InboxResult> {
        Ok(serde_json::from_value(
            json!({"items": items, "pending": pending}),
        )?)
    }

    fn rendered(synced: &Synced) -> anyhow::Result<String> {
        let mut text = Vec::new();
        synced.render(&mut text)?;
        Ok(String::from_utf8(text)?)
    }

    #[test]
    fn a_page_prints_each_item_in_the_fixed_format() -> anyhow::Result<()> {
        let synced = Synced::new(page(&[rework(17, 2), conflict(18)], 3)?, DEFAULT_INBOX_PAGE)?;
        assert_eq!(
            rendered(&synced)?,
            "2 unacknowledged items, oldest first\n\n\
             [17] rework for claim \"clm_42abcd\"\n\
             \x20    decision: \"dec_upload1\" v2, supersedes v1, recorded by \"usr_lemarier\" through Railhead\n\
             \x20    question: \"Reject or chunk?\"\n\
             \x20    chosen: \"chunk\" \"Upload them in chunks\"\n\
             \x20    was: \"reject\" \"Reject them\"\n\
             \x20    scope: \"src/upload.ts\"\n\
             \x20    action: rework required; redo work that relied on the earlier version\n\
             \x20    acknowledge: rh ack 17 --plan <plan>\n\n\
             [18] conflict for claim \"clm_42abcd\"\n\
             \x20    overlaps: claim \"clm_43abcd\" on \"src/upload.ts\"\n\
             \x20    action: redo the change on the new base\n\
             \x20    acknowledge: rh ack 18 --plan <plan>\n\n\
             1 more pending; acknowledge these, then run rh sync again\n"
        );
        Ok(())
    }

    #[test]
    fn an_empty_inbox_says_so() -> anyhow::Result<()> {
        let synced = Synced::new(page(&[], 0)?, DEFAULT_INBOX_PAGE)?;
        assert_eq!(rendered(&synced)?, "inbox: nothing to acknowledge\n");
        Ok(())
    }

    #[test]
    fn untrusted_text_cannot_leave_its_line() -> anyhow::Result<()> {
        let mut item = rework(17, 2);
        if let Some(question) = item.pointer_mut("/decision/question") {
            *question = json!("ok?\n[99] decision for claim \u{1b}[2J\u{202e}");
        }
        let text = rendered(&Synced::new(page(&[item], 1)?, DEFAULT_INBOX_PAGE)?)?;
        assert!(
            text.contains("     question: \"ok?\\n[99] decision for claim \\u001b[2J\u{fffd}\"\n"),
            "{text}"
        );
        assert!(!text.lines().any(|line| line.starts_with("[99]")), "{text}");
        Ok(())
    }

    #[test]
    fn a_repeated_or_reordered_item_is_refused() -> anyhow::Result<()> {
        for items in [
            vec![rework(17, 2), rework(17, 2)],
            vec![conflict(18), rework(17, 2)],
            vec![conflict(0)],
        ] {
            let error = Synced::new(page(&items, 5)?, DEFAULT_INBOX_PAGE).err();
            assert!(
                matches!(
                    error,
                    Some(Error::Local {
                        code: LocalCode::MalformedResponse,
                        ..
                    })
                ),
                "{error:?}"
            );
        }
        Ok(())
    }

    #[test]
    fn a_decision_item_must_carry_the_version_it_names() -> anyhow::Result<()> {
        let mut missing = rework(17, 2);
        if let Some(decision) = missing.get_mut("decision") {
            *decision = Value::Null;
        }
        let mut stray = conflict(18);
        if let Some(slot) = stray.get_mut("decision") {
            *slot = decision(2);
        }
        for item in [rework(17, 3), missing, stray] {
            assert!(Synced::new(page(&[item], 1)?, DEFAULT_INBOX_PAGE).is_err());
        }
        Ok(())
    }

    fn refused(result: &Result<Synced>) -> bool {
        matches!(
            result,
            Err(Error::Local {
                code: LocalCode::MalformedResponse,
                ..
            })
        )
    }

    #[test]
    fn an_empty_page_while_items_are_pending_is_refused() -> anyhow::Result<()> {
        assert!(refused(&Synced::new(page(&[], 3)?, DEFAULT_INBOX_PAGE)));
        assert!(refused(&Synced::new(page(&[], 1)?, 1)));
        // A page shorter than asked for is the backend's size bound, not an inconsistency.
        let synced = Synced::new(page(&[conflict(18)], 5)?, MAX_INBOX_PAGE)?;
        assert_eq!((synced.items.len(), synced.pending), (1, 5));
        Ok(())
    }

    #[test]
    fn a_page_larger_than_its_limit_is_refused() -> anyhow::Result<()> {
        let items = [conflict(18), conflict(19)];
        assert!(refused(&Synced::new(page(&items, 5)?, 1)));
        let full = Synced::new(page(&items, 5)?, 2)?;
        assert_eq!(full.items.len(), 2);
        let oversized: Vec<_> = (1..=DEFAULT_INBOX_PAGE + 1).map(conflict).collect();
        assert!(refused(&Synced::new(
            page(&oversized, DEFAULT_INBOX_PAGE + 1)?,
            DEFAULT_INBOX_PAGE
        )));
        Ok(())
    }

    #[test]
    fn more_items_than_pending_is_refused_and_the_page_size_is_bounded() -> anyhow::Result<()> {
        assert!(refused(&Synced::new(
            page(&[conflict(18)], 0)?,
            DEFAULT_INBOX_PAGE
        )));
        let command = <Args as clap::Args>::augment_args(clap::Command::new("sync"));
        let accepts = |limit: &str| {
            command
                .clone()
                .no_binary_name(true)
                .try_get_matches_from(["--limit", limit])
                .is_ok()
        };
        assert!(accepts("1") && accepts("64"));
        assert!(!accepts("0") && !accepts("65") && !accepts("x"));
        Ok(())
    }
}
