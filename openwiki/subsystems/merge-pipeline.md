---
type: subsystem
title: Merge Pipeline (config, jobs, soul)
description: The three merge steps — file contracts, merge semantics, per-profile orchestration, the allowEmpty/exemption rules, and base-file recovery for jobs.
tags: [merge, yaml, cron-jobs, soul, orchestration, idempotence]
verified:
  - by: openwiki/0.6.0
    at: 2026-10-01T18:53:53.575Z
sources:
  - id: openwiki-source-6129bccdb8a11c1ab5894891
    resource: repo://src/core/config.ts
  - id: openwiki-source-61f9f213cc2d8f34f0a15da9
    resource: repo://src/core/jobs.ts
  - id: openwiki-source-e06cf0d004cc3743efc60904
    resource: repo://src/core/soul.ts
  - id: openwiki-source-1ba755ffe0d6f2e4c24455b5
    resource: repo://src/core/sync.ts
  - id: openwiki-source-733063205226f9760eaf646b
    resource: repo://src/utils/deep-merge.ts
  - id: openwiki-source-ae9ea22813ff9ea472c92c8b
    resource: repo://src/utils/profile-targets.ts
generated: { by: 'hermes', at: '2026-10-01T18:53:53.575Z' }
---

# Merge Pipeline (config, jobs, soul)

The three merge steps compile each profile's _custom_ source onto the shared
_common_ base into a per-profile _output_. All three live in `src/core/`
(`config.ts`, `jobs.ts`, `soul.ts`), share the per-profile orchestration in
`src/utils/profile-targets.ts`, and return `MergeStatusResult[]`.

## File contracts per profile

| Concern | Common base (source)            | Profile source                       | Output                        |
| :------ | :------------------------------ | :----------------------------------- | :---------------------------- |
| config  | `profiles/common/config.yaml`   | `profiles/<p>/config.custom.yaml`    | `profiles/<p>/config.yaml`    |
| jobs    | — (previous output is the base) | `profiles/<p>/cron/jobs.custom.json` | `profiles/<p>/cron/jobs.json` |
| soul    | `profiles/common/SOUL.md`       | `profiles/<p>/SOUL.custom.md`        | `profiles/<p>/SOUL.md`        |

Top-level preconditions (throw _before_ any profile is processed, so the
aggregate can capture them into `stepErrors`):

- `mergeConfig` throws if `profiles/common/config.yaml` is missing, is invalid
  YAML, or is not a YAML object.
- `mergeSoul` throws if `profiles/common/SOUL.md` is absent.
- `mergeJobs` has no required common source (the previous output is the base).

## Merge semantics

- **config** — `deepMerge(common, custom)`: recursive YAML-object override
  matching `yq`'s multiply operator. Nested objects merge recursively; any
  non-object value (arrays, scalars) in `custom` _replaces_ the base value;
  base keys absent from `custom` are preserved. It is pure and never mutates
  either input (base is `structuredClone`'d up front). The result is written
  back as YAML via `stringifyYaml`.
- **jobs** — `mergeJobsDocuments(base, custom)` (pure primitive, also exported):
  top-level properties custom-overrides-base; jobs with a matching `id` are
  merged (custom properties override the base job); custom-only jobs are
  appended; base job order is preserved. Idempotence for **id-less** jobs comes
  from dedup by canonical deep-content equality (`canonicalJson`, keys sorted
  recursively): because the previous run's `jobs.json` output is fed back in as
  the base, every custom job — id'd or not — is already present on the next
  run, so `f(f(base, custom), custom) === f(base, custom)` and repeated merges
  never grow the list. Every job is copied (not reference-pushed) so a
  post-call mutation of the returned doc can't alias back into the input.
- **soul** — plain concatenation with the **profile custom SOUL first**, the
  common SOUL appended last: `` `${custom}\n\n${common}\n` ``. Both inputs are
  trimmed. This order is intentional: the per-profile identity comes before the
  shared guidelines.

## Per-profile orchestration (`profile-targets.ts`)

Each merge step delegates its shared boilerplate to four helpers:

1. **`validateExplicitProfiles`** — validate the explicit `-p` names before any
   filesystem access (path-traversal vector; see
   [Architecture](/openwiki/architecture.md)).
2. **`resolveTargetProfiles`** — a **non-empty** explicit `profiles` list wins;
   otherwise the profiles discovered under `profiles/` are used. An explicit
   `profiles: []` is "no explicit targeting" and falls back to discovery (so on
   a profile-less workspace it yields an empty list and is _not_ exempted).
3. **`assertNonEmptyTargetProfiles`** — an empty target list is a hard
   `No profiles found under <dir>` failure unless `allowEmpty` is set.
4. **`runPerProfileMerge`** — drives the per-profile loop and the trailing
   "nothing to merge" gate. A missing custom source yields a per-profile
   `skipped` entry (a _visible_ no-op, not an invisible one) and does **not**
   flip `FoundAnyCustom`; a real custom source flips it (even if that profile's
   merge then fails — the failure rides on its `status: 'error'` entry). The
   trailing "nothing to merge" throw fires only when **no** custom source
   exists anywhere _and_ no profiles were explicitly targeted — i.e. it is
   source-existence based, not merge-success based — and `allowEmpty` turns that
   throw into a successful no-op returning the collected results.

Each per-profile body also calls `assertProfilePathInWorkspace` (defense in
depth) before touching the profile dir. Per-profile parse/merge failures are
caught _inside the body_ and recorded as `status: 'error'` entries — they never
escape the loop, so one bad profile does not abort the others.

## `allowEmpty` and the explicit-targeting exemption

`allowEmpty` governs two distinct "no targets" situations, in every merge step:

- An **empty** target list (no profile subdirs, or explicit `profiles: []` on a
  profile-less workspace) throws `No profiles found under <dir>` unless
  `allowEmpty`.
- A **non-empty explicit** `profiles` list is exempted from the "nothing to
  merge" throw: an explicitly named profile that simply has no custom source is
  a per-profile `skipped` no-op (exit 0), not a top-level failure.

The aggregate sync path runs the steps with `allowEmpty: true` (set by
`mergeAll`/`syncAll`), so a workspace lacking a given custom source is a
benign no-op for that concern rather than a hard error aborting the rest.
Standalone CLI merge calls keep the default (`false`) and still surface the
"nothing to merge" error.

## Base-file recovery for jobs

`mergeJobs` is the one step that reads its own previous output as the base. If
the base `jobs.json` exists but is **unparseable** JSON, or is valid JSON that
is **not a jobs document** (e.g. `42`, `"foo"`, `{noJobs: true}`), the step
falls back to an empty base (`{ jobs: []}`) so the run can proceed — but this
would silently drop every previously merged base job, so it logs a **Warning**
naming the file and telling the user the previously merged jobs will be lost
and the file should be fixed/restored. The custom source itself, if invalid
JSON, produces a per-profile `status: 'error'` entry.

## Dry-run

Each step honors `dryRun`: it computes the merged output but does not write it,
and logs a `Would merge …` preview line instead of `Merged … written to …`. The
per-profile `status` is still `merged`/`skipped`/`error` exactly as a real run
would record.
