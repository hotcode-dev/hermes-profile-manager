---
type: operations
title: CLI & Operations
description: Command reference for the hpm CLI, global options, the dry-run and one-line error/exit-code contracts, root discovery, packaging, and test layout.
tags: [cli, operations, packaging, testing, error-contract]
verified:
  - by: openwiki/0.6.0
    at: 2026-10-01T18:53:53.575Z
sources:
  - id: openwiki-source-9ab161c6e9774cf771b19ced
    resource: repo://.zerofactory/precommit.sh
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-d2f650c01f560a60ae9115b9
    resource: repo://src/cli.ts
  - id: openwiki-source-4be155310a10fc0e141d35bb
    resource: repo://src/core/init.ts
  - id: openwiki-source-74c6b0267a12bbfb67847a09
    resource: repo://tsup.config.ts
generated: { by: "hermes", at: "2026-10-01T18:53:53.575Z" }
---

# CLI & Operations

The CLI is built on commander, exposed as `hpm`, `hermes-pm`, and
`hermes-profile-manager` (three `bin` aliases, all `dist/cli.js`). Global
options apply to every command; they are resolved in `getOptions` and threaded
into the core functions.

## Global options

| Flag | Meaning | Default |
| :--- | :--- | :--- |
| `-r, --root <path>` | Workspace root. Authoritative: resolved to an absolute path and used as-is. | Auto-detected via `findProjectRoot` from cwd |
| `--hermes-dir <path>` | Hermes home directory for the link steps. | `~/.hermes` or `$HERMES_HOME` |
| `-p, --profiles <names...>` | Target only the named profiles. **Scope gate**: also skips all global `~/.hermes` writes (e.g. `~/.hermes/plugins` linking). | All discovered profiles |
| `-d, --dry-run` | Preview only: no file writes, no symlink changes. | `false` |
| `-q, --quiet` | Suppress normal (stdout) logging; error reports on stderr are always shown. | `false` |

Root auto-discovery: with no `--root`, `findProjectRoot` walks upward from the
current directory to the first directory containing `profiles/common/`. An
explicit `--root` is authoritative and the upward search is skipped entirely —
passing a user root into the search used to silently redirect to an ancestor
workspace that carried the marker.

## Command reference

| Command | Alias | Effect |
| :--- | :--- | :--- |
| `hpm init [targetDir]` | — | Scaffold a workspace (`profiles/common/{config.yaml,SOUL.md,skills/,plugins/}` + `profiles/<name>/{config.custom.yaml,SOUL.custom.md,cron/jobs.custom.json}`), then run the initial sync. Options: `-p/--profile <name>` (default `main`), `-f/--force` (overwrite), `--no-sync`. |
| `hpm sync` | `all`, `merge-all`* | Full aggregate: all three merges + skill/plugin links. `sync` additionally takes `--include-hermes-link` to also link `profiles/` → `~/.hermes/profiles`. |
| `hpm merge [target]` | — | `all` (default), `config`, `jobs`, `soul`. |
| `hpm link [target]` | — | `all` (default), `skills`, `plugins`, `hermes`. |
| `hpm config-merge` | — | Alias for `merge config`. |
| `hpm jobs-merge` | — | Alias for `merge jobs`. |
| `hpm soul-merge` | — | Alias for `merge soul`. |
| `hpm skills-link` | — | Alias for `link skills`. |
| `hpm plugins-link` | — | Alias for `link plugins`. |
| `hpm hermes-link` | — | Alias for `link hermes`. |

\* `merge-all` is described in the CLI as the "Alias for sync"; it runs the same
aggregate path (`syncAll`) — merges plus links — and reports through the same
shared reporting contract, though it does not take `--include-hermes-link`.

Per-command behavior detail lives in the subsystem pages:
[Merge Pipeline](/openwiki/subsystems/merge-pipeline.md) and
[Linking](/openwiki/subsystems/linking.md).

## Error and exit-code contract

Core modules never throw (except `initWorkspace`, which the CLI wraps); failures
travel as data, and the CLI is the single place that converts them into visible
output and a non-zero exit. The helpers, all in `src/cli.ts`:

- **`finishWithErrors`** — reports per-profile merge `error` entries plus
  top-level `stepErrors`, exits 1 when any is present; otherwise prints the
  success banner (suppressed under `--quiet`).
- **`finishMerge`** — wraps a standalone merge step's operation thunk in
  try/catch so a *pre-profile* throw (e.g. `mergeConfig` failing on a missing or
  non-object `profiles/common/config.yaml`) becomes a one-line stderr error +
  `Failed: the merge run failed.` + exit 1 — never a raw stack trace, never a
  success banner.
- **`reportSyncErrors`** — the shared aggregate reporting path behind `sync` /
  `merge-all` / `init`: prints top-level step failures (one line per failing
  step, since `mergeAll` isolates each step), then per-profile merge errors,
  then link-step failures; exits 1 on any. Returns `true` only on a clean run.
- **`finishSync`** — `reportSyncErrors` + success banner.
- **`finishLinkErrors`** — reports `linkAll`'s captured `linkErrors` (it does
  not throw) and exits 1.
- **`safeLink`** — wraps a single throwing link function (`linkSkills` /
  `linkPlugins` / `linkHermes`) in try/catch for the same one-line + exit-1
  contract.

Because nothing on the aggregate path throws, the already-computed merge results
are *always* reported: a link or top-level failure can no longer preempt the
merge report. Error lines go to stderr with a `✗` prefix and always include the
offending path/file; the summary line (`Failed: … Fix the sources above and
re-run.`) aggregates the failure counts.

## Dry-run honest wording

`--dry-run` makes every step side-effect-free, and the output is phrased as a
preview: core log lines use `Would merge/link …`, `pruneStaleSymlinks` logs
`Would remove stale symlink …`, and the CLI `dryRunBanner` prefixes success
banners with `Would ` (`Would initialize …`, `Would create …`). `init --dry-run`
also skips the initial sync, since the scaffolding sources it would read were
not written. The success banner under dry-run never asserts that files were
created or profiles exist.

## Packaging & build

- **Build**: `npm run build` runs `tsup`, which compiles two entries —
  `index` (`src/index.ts`, the library API) and `cli` (`src/cli.ts`, the
  executable) — into dual **ESM + CJS** formats with `.d.ts` declarations and
  source maps, into a clean `dist/` (`files: ["dist", ...]` in `package.json`).
- **Runtime deps** are just `commander` and `yaml`; everything else (fs, path,
  structuredClone, os) is Node standard library. No system binaries.
- **Prepack**: `npm run prepack` runs the build, so `npm pack`/publish always
  ships a fresh `dist/`.
- The CLI resolves the package version from `package.json` at runtime via
  `createRequire` anchored at the module's own URL, so it works in both the repo
  layout and the installed `node_modules` layout.

## Testing & precommit

- **Test runner**: `npm test` runs the Node built-in test runner against
  `test/**/*.test.ts` via `tsx` (`node --import tsx --test`). There is a focused
  suite per module: `cli.test.ts`, `config.test.ts`, `jobs.test.ts`,
  `soul.test.ts`, `links.test.ts`, `sync.test.ts`, `init.test.ts`,
  `deep-merge.test.ts`, `fs-helpers.test.ts`, `profile-name.test.ts`,
  `root-finder.test.ts` — so the merge/link/CLI contracts (error carriers,
  dry-run wording, path-safety, idempotence) each have a dedicated test file.
- **Precommit** (`.zerofactory/precommit.sh`, linked as `pre-commit` via
  `install-hook`): formats **staged** `.ts/.json/.md/.yml/...` files with
  Prettier (`npx -y prettier`, style pinned by `.prettierrc.json`), typechecks
  with `tsc --noEmit` (installing deps first if needed), then runs `npm test`.
  `all` (default) runs format → build → test in that order.
