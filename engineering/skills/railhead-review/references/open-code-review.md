# Local Open Code Review

[Open Code Review](https://open-codereview.ai) (OCR) is an optional extra review
pass before a PR. Use it only when `ocr` is installed and the developer has
already configured a provider; never configure a provider, add an API key, or
install OCR as part of a task. OCR sends the reviewed code to that provider.

If `ocr` came from npm, set `OCR_NO_UPDATE=1` on every run; otherwise its
wrapper starts a background `npm i -g` of the latest release. Homebrew and
release binaries do not self-update.

## Run it

After focused checks, review the committed branch against its verified base:

```bash
ocr review --from BASE --to HEAD --format json --audience agent \
  --max-tokens-budget 1000000 --timeout 10 --output "$SCRATCH/ocr.json"
```

Use `ocr review` without `--from`/`--to` for uncommitted workspace changes. Keep
the output outside the checkout. Bound the whole command with a process timeout;
`--timeout` applies to each subtask. If OCR is missing, unconfigured, or fails,
complete the normal review and say that OCR did not run. A `status` other than
`complete`, or entries under `manifest.coverage.failed`, means partial coverage.

## Use the results

Treat every finding as unverified input. Check the trigger, callers, and existing
guards under `railhead-review` before fixing or reporting it; OCR's severity is
not evidence; expect false positives.

OCR excludes test files such as `*.test.ts` and `tests/**` by default and skips
unsupported types, including Markdown and linker scripts. Run
`ocr review --preview` to list them, and review them yourself. An OCR pass does
not replace your own review, CI, the PR reviewers, or hardware evidence.

A repository may commit `.opencodereview/rule.json` to adjust file selection,
such as `"include": ["**/*.test.ts", "tests/**"]`. Use `"merge_system_rule": true`
on path rules so OCR keeps its language rules. Keep review policy in `AGENTS.md`
and the shared skills.
