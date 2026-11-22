# hidden-spec-cli-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/L200150013/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/L200150013/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies AI-written edits in four formats — unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON text-editor tool calls — to a tree of text files, to one written specification. It finds the lines an edit names at the first of three whitespace-tolerant matching tiers, and changes every file or none.

## Run it

```sh
node main.ts edit.patch
```

`node main.ts [--format=NAME] [--check] [--strict] [PATCH]` — PATCH is a patch file, or `-`/absent to read the patch from standard input. `--check` reports what would change without writing anything; `--strict` matches lines exactly. Exit 0 prints what changed, exit 1 lists the edits that failed (and writes nothing), exit 2 reports a usage, missing-patch, format, or parse error. Node 22 standard library only; no install step.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
