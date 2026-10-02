# TypeSafe development workflow

Use this guide when building or evaluating a TypeSafe development integration.
It defines pilot acceptance and the boundaries for continued use; it does not
enable API calls. The skill alone cannot demonstrate token savings.

## Choose a repeated decision

| Candidate | Input and result | Evidence required |
| --- | --- | --- |
| CI failure routing: start here | Parse job status and tool diagnostics locally; ask Choice only for unresolved failure excerpts, returning build, test, dependency, infrastructure, or unknown | Compare with engineer labels; keep every failure visible and preserve original logs |
| Code and documentation ranking | Use paths, symbols, and search to shortlist excerpts; ask Score for relevance, then pass source text and locations to the coding agent | Measure relevant-source recall and resulting task success; keep mandatory instructions and caller/guard evidence available |
| Review triage | Rank or group comments to order investigation | Do not suppress comments or treat duplicates as resolved without reading the evidence |
| Buddy evaluation | Judge narrow semantic properties against expected evidence alongside deterministic assertions | Calibrate against labeled regressions; model scores cannot establish equipment identity or electrical safety |
| Skill suggestion in a custom runner | Suggest an optional domain skill from the available roster, with a no-match result | Preserve explicit skill requests and mandatory working/safety skills; measure unnecessary loads and missed relevant skills |

The [skill suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion)
uses a custom agent harness. It is not an installable hook for our current agents.
Only add such a hook where the runner exposes a supported integration point.
Start with CI routing because its labels and existing fallback are easier to
measure than correctness of omitted code context.

## Implement a bounded pilot

1. Collect approved, sanitized historical failure excerpts with engineer labels.
   Keep held-out examples separate from prompt and threshold tuning. Include
   ordinary failures, mixed causes, incomplete logs, and unfamiliar failures.
2. Implement a local parser baseline. Only send unresolved cases to TypeSafe.
   Use the [API contract](https://docs.typesafe.ai/api) and
   [Choice guidance](https://docs.typesafe.ai/primitives/choice); include unknown
   as a real outcome. Keep questions, criteria, and thresholds versioned with
   the consuming tool, rather than embedding them in each agent prompt.
3. Produce an advisory category and source references. Preserve the complete
   log for investigation. Do not automatically rerun jobs, change code, or post
   comments based on the category.
4. Run alongside the current process before changing agent inputs. Evaluate
   accuracy per class, confidently wrong routes, unknown/fallback rate, latency,
   and task completion. Choose acceptance thresholds before evaluating held-out
   cases; do not copy cookbook confidence thresholds as evidence.
5. Enable the helper only when total cost improves and investigation quality
   meets the chosen thresholds. Re-evaluate when model, questions, candidate
   selection, or source format changes. Keep a switch back to the baseline.

Use the consuming repository's existing language and boundary validation.
API keys stay in the environment or secret store. Before sending private code
or CI logs, establish that the selected data is approved for this external
service and remove credentials and personal data. Installation authorizes no
blanket upload of repositories. Review current
[data handling terms](https://docs.typesafe.ai/legal); do not assume all accounts
have zero retention.

Set request size, question count, timeout, retry, and spend limits in the caller.
Validate response kinds, allowed options, required answers, and numeric ranges.
Unknown, low-confidence, malformed, missing, timed-out, or exhausted-retry results
fall back to the existing investigation. Test those paths without network access;
keep any paid evaluation separate from `pnpm check`. Never turn an API outage
into a passed check or a skipped review.

## Measure actual savings

Record TypeSafe input/output usage, resolved model ID, question version, elapsed
time, fallback and retry counts, and downstream agent usage for the same tasks.
Keep raw private payloads out of general telemetry. Compare:

`baseline agent cost - (TypeSafe cost + remaining agent cost + fallback cost)`

Count cached and uncached agent input separately where pricing differs. Track
agent-token reduction and total dollars separately: a cheaper model can reduce
cost while increasing combined token use. If agent usage is unavailable, report
that the savings are unmeasured. Do not infer savings from short JSON outputs.

Batch independent questions over shared state when needed, but do not add unused
speculative questions solely to fill a batch. Cache only where useful, keyed by
input content, candidate set, question/schema version, and pinned model version;
changed evidence or model versions invalidate prior judgments. Avoid moving
model aliases in calibrated pilots. Check current
[models and pricing](https://docs.typesafe.ai/models) before estimating cost.

For ranking, compare with the [retrieval cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe).
A reranker cannot recover evidence absent from its shortlist. Ranking should
order inspection; expanding context must remain possible when evidence is weak.
