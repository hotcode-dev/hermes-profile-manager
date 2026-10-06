---
type: architecture
title: Architecture
description: Module layout, profiles/ workspace invariants, the never-throw error-carrier design, and the path-safety validation stack of hermes-profile-manager.
tags: [architecture, layout, error-handling, security, public-api]
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
  - id: openwiki-source-4be155310a10fc0e141d35bb
    resource: repo://src/core/init.ts
  - id: openwiki-source-61f9f213cc2d8f34f0a15da9
    resource: repo://src/core/jobs.ts
  - id: openwiki-source-d653fde9e61e342fdb6f424d
    resource: repo://src/core/links.ts
  - id: openwiki-source-1ba755ffe0d6f2e4c24455b5
    resource: repo://src/core/sync.ts
  - id: openwiki-source-d1fbef09192ffbab6eff0bc2
    resource: repo://src/index.ts
  - id: openwiki-source-65bc5eeaf42617f36fb29a38
    resource: repo://src/utils/fs-helpers.ts
  - id: openwiki-source-22788d55fa24e14df86d2fe5
    resource: repo://src/utils/merge-results.ts
  - id: openwiki-source-8cb706141f12d4745e22d5bf
    resource: repo://src/utils/profile-name.ts
  - id: openwiki-source-ae9ea22813ff9ea472c92c8b
    resource: repo://src/utils/profile-targets.ts
  - id: openwiki-source-b3cafcabce85647298e596b4
    resource: repo://src/utils/root-finder.ts
generated: { by: 'hermes', at: '2026-10-01T18:53:53.575Z' }
---

# Architecture

`hermes-profile-manager` is a pure Node.js + TypeScript library and CLI (no system
binaries like `yq`/`jq`). It manages a standard Hermes multi-profile workspace by
merging per-profile _custom_ sources onto a shared _common_ base and by symlinking
shared skills/plugins into profile directories and the global Hermes home.

## Module layout

Two layers under `src/`, both re-exported through the public API:

- `src/core/` — the six concern modules:
  - `config.ts` (`mergeConfig`), `jobs.ts` (`mergeJobs`, `mergeJobsDocuments`),
    `soul.ts` (`mergeSoul`) — the three merge steps;
  - `links.ts` (`linkSkills`, `linkPlugins`, `linkHermes`) — the three link steps;
  - `sync.ts` (`mergeAll`, `linkAll`, `syncAll`) — aggregate orchestration;
  - `init.ts` (`initWorkspace`, `InitFilesystemError`) — workspace scaffolding.
- `src/utils/` — shared primitives: `deep-merge.ts` (pure YAML-object merge),
  `fs-helpers.ts` (atomic writes, symlink management, profile discovery),
  `profile-name.ts` (name validation + boundary assertions),
  `profile-targets.ts` (per-profile orchestration), `merge-results.ts`
  (result shape + error collection), `root-finder.ts` (root discovery).
- `src/index.ts` is the public API surface: a flat re-export of every core and
  utils module, so one import gives access to the whole library.
- `src/cli.ts` is the executable bundle (`hpm` / `hermes-profile-manager` /
  `hpm` aliases via the `bin` field) built from commander; it is the only place
  that turns internal error carriers into stderr output and a non-zero exit code.

See [Quickstart & Task Routing](/openwiki/quickstart.md) for build/test commands.

## Workspace layout and invariants

The workspace root is the directory containing `profiles/common/`. Layout:

```
profiles/
├── common/                      # shared BASE sources (read-only for the tool)
│   ├── config.yaml              # base YAML config
│   ├── SOUL.md                  # shared system prompt
│   ├── skills/<skill>/          # shared skills (symlinked into profiles)
│   └── plugins/<plugin>/        # shared plugins (symlinked into profiles + ~/.hermes)
└── <profile>/                   # one directory per agent profile
    ├── config.custom.yaml       # per-profile overrides (SOURCE)
    ├── config.yaml              # compiled base+custom merge (OUTPUT)
    ├── SOUL.custom.md           # per-profile prompt (SOURCE)
    ├── SOUL.md                  # compiled: custom first, common appended (OUTPUT)
    └── cron/
        ├── jobs.custom.json     # per-profile cron jobs (SOURCE)
        └── jobs.json            # compiled merge (OUTPUT)
```

Invariants every step enforces:

- **`common` is reserved.** `profiles/common/` is the shared base, not a profile.
  Profile discovery (`getProfileNames`) excludes it, and
  `validateProfileName` rejects it as an explicit name — accepting it would make a
  step self-merge the base onto itself and self-symlink shared resources.
- **Compiled outputs are derived.** `config.yaml`, `SOUL.md`, `cron/jobs.json`
  are rewritten on every merge run; the `*.custom.*` files (and `common/`
  sources) are the user-owned inputs. `jobs.json` is special: it is fed back in
  as the _base_ on the next run, so the jobs merge is idempotent (see
  [Merge Pipeline](/openwiki/subsystems/merge-pipeline.md)).
- **Writes stay inside the workspace.** See the path-safety stack below.

## Public API

`src/index.ts` re-exports every module. The main entrypoints: `initWorkspace`,
`syncAll`, `mergeAll`, `linkAll`, `mergeConfig`, `mergeJobs`,
`mergeJobsDocuments`, `mergeSoul`, `linkSkills`, `linkPlugins`, `linkHermes`,
`findProjectRoot`, `deepMerge`, plus the option/result types. Packaging:
`tsup` builds dual ESM + CJS with `.d.ts` from two entries (`index`, `cli`);
`package.json` declares three `bin` names all pointing at `dist/cli.js`, and the
package version is the single source of truth — the CLI reads it from
`package.json` at runtime instead of hardcoding it.

## Error-carrier design (never-throw)

The core contract is that aggregates never throw; all failures travel in returned
data so the CLI can report _everything_ in one pass:

- **Per-profile merge failures** are recorded as `MergeStatusResult` entries
  (`status: 'merged' | 'skipped' | 'error'`) inside the arrays returned by
  `mergeConfig`/`mergeJobs`/`mergeSoul`. `skipped` (a profile without a custom
  source) is an intended no-op, not an error; `collectMergeErrors` selects the
  `error` entries.
- **Top-level (pre-profile) merge failures** — e.g. `mergeConfig` throwing
  because `profiles/common/config.yaml` is missing or not a YAML object — are
  captured per step into `stepErrors: { config?, jobs?, soul? }` by `mergeAll`
  (each sub-merge in its own try/catch), so one failing step cannot suppress the
  others. `syncAll` mirrors this for links via `linkErrors: string[]` (and keeps
  the deprecated `syncError` string for backward compatibility).
- Consequently `syncAll`/`mergeAll`/`linkAll` always return; the CLI's success
  banner and exit code are gated on exactly three carriers: `stepErrors`,
  per-profile `status: 'error'` entries, and `linkErrors`. `initWorkspace` is
  the exception: it _does_ throw — a plain `Error` (`Invalid profile name:`
  prefix) for bad names, or the typed `InitFilesystemError` (carrying
  `targetPath` + `operation`) for filesystem collisions — and the CLI branches on
  that type to label the failure correctly.

## Path-safety validation stack

Profile names come from user input (`-p/--profiles`, `init --profile`) and flow
into `path.join(profilesDir, name, ...)`, a classic traversal vector. Defense is
layered:

1. **`validateProfileName`** — allowlist `^[a-zA-Z0-9._-]+$`, explicit `.`/`..`
   guard, and the reserved-name rejection. Returns the name unchanged when valid.
2. **`validateExplicitProfiles`** — runs `validateProfileName` over the explicit
   `-p` list BEFORE any filesystem access or write. Discovered names (from
   `readdirSync`) need no validation.
3. **`assertProfilePathInWorkspace`** — defense in depth: the resolved per-profile
   path must stay strictly under `profilesDir/` and must not target the reserved
   `common` directory, catching any future path-construction change that bypasses
   the allowlist.
4. **`assertPathInBase`** — the generic counterpart for the Hermes-home half of
   the link steps: `~/.hermes/plugins` and `~/.hermes/profiles` destinations must
   stay under the configured Hermes home (`--hermes-dir` / `$HERMES_HOME`).

## Shared filesystem primitives

- **`atomicWriteFileSync`** — write to a same-directory temp file, then rename, so
  an interrupt never leaves a half-written config.
- **`ensureSymlinkSync`** — idempotent symlink creation: no-op when already
  pointing at the target, replace when pointing elsewhere; a _real directory_
  occupying the slot is never deleted — it is moved aside to a
  `<path>.hpm-backup.<timestamp>` sibling with a warning — while a plain file
  collision is removed and logged.
- **`pruneStaleSymlinks`** — removes only dangling symlinks (deleted/renamed
  common resources); real directories and files are never touched, and a missing
  directory is a clean no-op. Honors dry-run.
- **`getProfileNames`** — discovers profile dirs (excludes `common` and dotdirs),
  sorted.
- **`findProjectRoot`** — walks upward from the start dir to the first directory
  containing `profiles/common`; falls back to the start dir. An explicit
  `--root` is authoritative in the CLI and skips this search entirely (passing a
  user root into the upward search used to silently redirect to an ancestor).

## Dry-run contract

Every step honors `dryRun`: no file writes, no symlink changes; log lines are
phrased as previews (`Would merge …`, `Would link …`, `Would remove stale
symlink …`). The CLI prefixes success banners with `Would ` under `--dry-run`
(`dryRunBanner`), so output never asserts a side effect that did not happen.
`init --dry-run` also skips the initial sync, because the sources it would read
were not written. See [CLI & Operations](/openwiki/operations.md).
