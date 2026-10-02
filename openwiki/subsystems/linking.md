---
type: subsystem
title: Linking (skills, plugins, Hermes home)
description: How linkSkills, linkPlugins, and linkHermes create symlinks — relative vs absolute targets, collision handling, stale-link pruning, and the -p scope gate for global writes.
tags: [symlinks, linking, hermes-home, scope-gate, collision-handling]
verified:
  - by: openwiki/0.6.0
    at: 2026-10-01T18:53:53.575Z
sources:
  - id: openwiki-source-d2f650c01f560a60ae9115b9
    resource: repo://src/cli.ts
  - id: openwiki-source-d653fde9e61e342fdb6f424d
    resource: repo://src/core/links.ts
  - id: openwiki-source-1ba755ffe0d6f2e4c24455b5
    resource: repo://src/core/sync.ts
  - id: openwiki-source-65bc5eeaf42617f36fb29a38
    resource: repo://src/utils/fs-helpers.ts
  - id: openwiki-source-ae9ea22813ff9ea472c92c8b
    resource: repo://src/utils/profile-targets.ts
generated: { by: "hermes", at: "2026-10-01T18:53:53.575Z" }
---

# Linking (skills, plugins, Hermes home)

The link steps turn the shared `profiles/common/` resources into per-profile
(and, on default runs, global Hermes-home) symlinks. All three live in
`src/core/links.ts` and build on the symlink primitives in
`src/utils/fs-helpers.ts`. None of the three throws for a missing *per-profile*
directory; they throw when their required *source* is missing or a symlink
cannot be created, and the aggregate `linkAll` captures those into
`linkErrors` instead of propagating them.

## Symlink target strategy

- **`linkSkills`** — for each subdirectory of `profiles/common/skills/`
  (dotdirs excluded), creates a **relative** symlink
  `profiles/<profile>/skills/<skill> → ../../common/skills/<skill>`. Relative
  targets keep profiles portable across machines and mount points.
- **`linkPlugins`** — two passes over `profiles/common/plugins/`:
  1. per profile: **relative**
     `profiles/<profile>/plugins/<plugin> → ../../common/plugins/<plugin>`;
  2. global: **absolute** `<profileSource> → ~/.hermes/plugins/<plugin>` —
     the source is an absolute path because the destination lives outside the
     workspace.
- **`linkHermes`** — one **absolute** symlink
  `<rootDir>/profiles → ~/.hermes/profiles`, making the whole workspace the
  Hermes home's profile directory.

Hidden (dot) directories are never linked; only `isDirectory()` entries count.

## The `-p/--profiles` scope gate (global writes)

`-p/--profiles` is a **scope gate everywhere**: when a non-empty explicit
profile list is passed, the run is scoped to those profiles and **no global
`~/.hermes` write happens** — in particular `linkPlugins` skips pass 2
(`~/.hermes/plugins`) on explicitly targeted runs. A default (untargeted) run
keeps the historical behavior and links the global plugins dir. The gate is
`explicitlyTargeted = options.profiles && options.profiles.length > 0`. The
CLI's `pluginsLinkBanner` mirrors this: a targeted run reports "Linked common
plugins to the targeted profile(s) only" rather than claiming a global write.
`linkHermes` has no such gate — it is only ever invoked on request (the
`link hermes` command or `sync --include-hermes-link`).

`linkSkills`/`linkPlugins` deliberately have **no no-targets guard** (unlike the
merge steps): an empty workspace is a successful no-op there, returning an
empty result list.

## Hermes home resolution

`hermesDir = options.hermesDir || process.env.HERMES_HOME ||
path.join(os.homedir(), '.hermes')` — CLI `--hermes-dir` wins, then the
`$HERMES_HOME` env var, then `~/.hermes`. Both `linkPlugins` and `linkHermes`
apply `assertPathInBase(hermesDir, dest)` before writing, so a hostile base
value cannot redirect the write outside the intended Hermes home.

## Collision semantics (`ensureSymlinkSync`)

For each target path, `ensureSymlinkSync` (in `fs-helpers.ts`) decides:

- **already a symlink → same target**: no-op (idempotent re-runs).
- **symlink → different target**: replaced (unlinked, then relinked).
- **real (non-symlink) directory**: **never deleted**. It is renamed aside to
  a unique backup sibling `<path>.hpm-backup.<timestamp>` (numeric suffix on
  collision) and a `WARNING` is logged; the symlink is then created. This
  preserves user data that happens to occupy the slot.
- **plain file**: removed (low-risk single-file collision) and the removal
  logged.
- **absent**: created. Parent directories are `mkdir -p`'d first.

Under `--dry-run` none of these mutations happen; the step only logs
`Would link …` and returns the `LinkResult` list it would have produced.

## Stale-link pruning (`pruneStaleSymlinks`)

Before linking, each destination directory is swept with
`pruneStaleSymlinks`, which removes **only dangling symlinks** (entries whose
target no longer resolves — e.g. after a common skill or plugin was deleted or
renamed). Real directories and regular files are never touched (a real
directory occupying a slot is the user's data, per the `ensureSymlinkSync`
backup-sibling contract). A missing directory is a clean no-op (e.g.
`~/.hermes/plugins` absent). It honors `dryRun` (logs `Would remove stale
symlink …`). Pruning runs **only after** the path-safety guards and, for the
global plugins dir, **only on the untargeted path** — a scoped run must not
touch the global dir at all.

## Result shape

`linkSkills`/`linkPlugins` return `LinkResult[]` —
`{ source, destination, type: 'skill' | 'plugin' | 'hermes-plugin' |
'hermes-profiles', profile? }` — and `linkHermes` returns a single `LinkResult`.
The aggregate `linkAll` (in `src/core/sync.ts`) runs each step in its own
try/catch, collecting failures into `linkErrors`, and includes `linkHermes`
only when `includeHermesLink` is set. The CLI reports `linkErrors` through
`finishLinkErrors` (exit 1) and standalone link failures through `safeLink`.
See [CLI & Operations](/openwiki/operations.md) for the error/exit contract.
