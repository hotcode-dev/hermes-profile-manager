---
type: quickstart
title: Quickstart & Task Routing
description: Minimal install/build/test commands for hermes-profile-manager and a task-routing map from common change types to the wiki page that explains the affected subsystem.
tags: [quickstart, routing, setup, workflow]
verified:
  - by: openwiki/0.6.0
    at: 2026-10-01T18:53:53.575Z
sources:
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-d2f650c01f560a60ae9115b9
    resource: repo://src/cli.ts
  - id: openwiki-source-6129bccdb8a11c1ab5894891
    resource: repo://src/core/config.ts
  - id: openwiki-source-61f9f213cc2d8f34f0a15da9
    resource: repo://src/core/jobs.ts
  - id: openwiki-source-d653fde9e61e342fdb6f424d
    resource: repo://src/core/links.ts
  - id: openwiki-source-e06cf0d004cc3743efc60904
    resource: repo://src/core/soul.ts
  - id: openwiki-source-1ba755ffe0d6f2e4c24455b5
    resource: repo://src/core/sync.ts
  - id: openwiki-source-8cb706141f12d4745e22d5bf
    resource: repo://src/utils/profile-name.ts
  - id: openwiki-source-b3cafcabce85647298e596b4
    resource: repo://src/utils/root-finder.ts
generated: { by: 'hermes', at: '2026-10-01T18:53:53.575Z' }
---

# Quickstart & Task Routing

`hermes-profile-manager` (`hpm`) manages a Hermes multi-profile workspace: it
merges per-profile _custom_ sources onto a shared _common_ base and symlinks
shared skills/plugins into profiles and the global Hermes home. This page is the
entry point — read it, then jump to the page your task touches.

## Minimal commands

```bash
npm install          # devDependencies (tsx, tsup, typescript) + runtime (commander, yaml)
npm test             # node --import tsx --test over test/**/*.test.ts
npm run build        # tsup → dist/ (dual ESM+CJS + .d.ts)

# One-minute workflow on a real workspace (a dir containing profiles/common/):
hpm init [targetDir] # scaffold profiles/common/* + profiles/<name>/*, then sync
hpm sync             # all merges (config/jobs/soul) + skill/plugin links
hpm sync --include-hermes-link   # additionally link profiles/ → ~/.hermes/profiles
hpm -d sync          # dry run: preview only, zero side effects
```

Install the CLI globally (`npm install -g hermes-profile-manager`) or run
`npx hermes-profile-manager sync`. The workspace root is auto-detected by
walking up to the directory containing `profiles/common/`; override with
`-r/--root <path>`.

## Task routing

| You are…                                                                                      | Read                                                                             |
| :-------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------- |
| Changing module layout, the public API, error carriers, or path-safety                        | [/openwiki/architecture.md](/openwiki/architecture.md)                           |
| Changing a merge step (config, jobs, soul), merge semantics, or the per-profile loop          | [/openwiki/subsystems/merge-pipeline.md](/openwiki/subsystems/merge-pipeline.md) |
| Changing a link step (skills, plugins, hermes), symlinks, or global `~/.hermes` writes        | [/openwiki/subsystems/linking.md](/openwiki/subsystems/linking.md)               |
| Changing the CLI, commands/aliases, options, exit codes, dry-run wording, packaging, or tests | [/openwiki/operations.md](/openwiki/operations.md)                               |
| Just getting started / running the tool                                                       | this page                                                                        |

## Hard invariants (do not break)

- **`common` is reserved.** `profiles/common/` is the shared base, never a
  per-profile directory. Discovery and name validation both reject it.
- **Compiled outputs are derived.** `config.yaml`, `SOUL.md`, and
  `cron/jobs.json` are rewritten on every merge run; only the `*.custom.*`
  sources and `common/` are user-owned. Never hand-edit a compiled output —
  re-run `hpm sync`.
- **The jobs output is its own base.** `cron/jobs.json` is fed back as the base
  on the next run; the merge dedupes id-less jobs by content, so re-runs are
  idempotent and the list never grows.
- **Aggregates never throw.** `syncAll`/`mergeAll`/`linkAll` return; failures
  travel in `stepErrors`, per-profile `status:'error'` entries, and
  `linkErrors`, and the CLI is the single place that turns them into stderr +
  a non-zero exit.
- **Writes stay inside the workspace.** Profile names and Hermes-home
  destinations are validated/asserted to stay within their boundaries
  (traversal defense).
- **`-p/--profiles` scopes everything.** A non-empty explicit profile list
  restricts the run to those profiles and skips all global `~/.hermes` writes.
