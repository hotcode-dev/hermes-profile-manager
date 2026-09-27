import { getProfileNames } from './fs-helpers.js';
import { validateProfileName } from './profile-name.js';

/**
 * Shared per-profile orchestration for the merge/link entry points
 * (mergeConfig / mergeJobs / mergeSoul / linkSkills / linkPlugins).
 *
 * Historically each of these modules re-implemented the same boilerplate
 * — explicit-profile validation, target resolution, the no-targets guard,
 * and (for the merge steps) the trailing "nothing to merge" gate. That
 * duplication has repeatedly produced contract-drift bugs (missing custom
 * source, empty `profiles: []`, explicit `-p` targeting, dry-run wording),
 * so the shared blocks live here and each module delegates to them.
 */

/**
 * Mutable flag recording whether at least one DISCOVERED profile actually
 * had a custom source during the per-profile loop. The "nothing to merge"
 * gate is source-existence based, NOT merge-success based: a profile whose
 * custom source exists but fails to parse carries its failure in a
 * per-profile `status: 'error'` entry and flips this flag (the entry is the
 * real failure carrier), so the aggregate never masks a per-profile error.
 */
export interface FoundAnyCustom {
  foundAnyCustom: boolean;
}

/**
 * Validates every EXPLICITLY targeted profile name (the global
 * `-p/--profiles` CLI option).
 *
 * User-controlled profile names are a path-traversal vector:
 * path.join(profilesDir, '../../x') resolves OUTSIDE the workspace, letting
 * the merge/link steps write files or symlinks at an attacker-chosen
 * location. Every explicitly targeted name is validated BEFORE any
 * filesystem access or side effect, mirroring initWorkspace's "validated
 * before path construction" contract. (Discovered names come from
 * readdirSync, not user input, so they need no validation.)
 *
 * Callers pass the raw `options.profiles` (possibly undefined); an absent
 * or empty list is a validated no-op.
 */
export function validateExplicitProfiles(profiles: readonly string[] | undefined): void {
  for (const profile of profiles ?? []) {
    validateProfileName(profile);
  }
}

/**
 * Resolves the target profile list: a NON-EMPTY explicit `profiles` list
 * wins; otherwise the profiles discovered under `profilesDir` are used.
 *
 * An explicit `profiles: []` is treated as "no explicit targeting" (it names
 * no profile) and falls back to auto-discovery — so on a profile-less
 * workspace it yields an empty target list and is NOT exempted from the
 * no-targets guard.
 */
export function resolveTargetProfiles(
  explicit: readonly string[] | undefined,
  profilesDir: string
): string[] {
  const availableProfiles = getProfileNames(profilesDir);
  return explicit && explicit.length > 0 ? [...explicit] : availableProfiles;
}

/**
 * No-targets guard, shared verbatim by mergeConfig / mergeJobs / mergeSoul:
 * an empty target list (no profile subdirs found, or an explicit
 * `profiles: []` on a profile-less workspace) is a hard "no profiles found"
 * failure unless `allowEmpty` is set.
 *
 * The link steps (linkSkills / linkPlugins) deliberately do NOT have this
 * guard: an empty workspace is a successful no-op there (they return an
 * empty result list), so they must not call this.
 */
export function assertNonEmptyTargetProfiles(
  targetProfiles: readonly string[],
  profilesDir: string,
  allowEmpty: boolean | undefined
): void {
  if (targetProfiles.length === 0 && !allowEmpty) {
    throw new Error(`No profiles found under ${profilesDir}`);
  }
}

/**
 * Per-profile work unit for a merge step, executed by
 * {@link runPerProfileMerge}.
 *
 * `skipped` records the per-profile skipped entry for a profile whose
 * custom source is absent (a visible no-op, not an invisible one) and is
 * responsible for NOT flipping `found` — `foundAnyCustom` stays driven
 * only by real custom sources. Otherwise the unit runs its concern-specific
 * body (read source, compute output, log, record the `merged` or
 * `error` result) and flips `found.foundAnyCustom` to true, because the
 * custom source EXISTS.
 *
 * Note: the unit's own error handling (catch → log → `status: 'error'`
 * entry) stays in the calling module; a per-profile parse/merge failure
 * must NOT escape the runner's loop.
 */
export interface PerProfileMergeBody<T> {
  (profile: string, profilesDir: string, found: FoundAnyCustom): T | void;
}

/**
 * Drives the per-profile loop and the trailing "nothing to merge" gate for
 * a merge step, so the orchestration appears exactly once:
 *
 * 1. For each target profile, run `body`. A missing custom source produces
 *    a per-profile `skipped` entry; a real custom source flips
 *    `foundAnyCustom` (even if the profile's merge then fails — the failure
 *    rides on its per-profile `status: 'error'` entry).
 * 2. Reached only with a non-empty target list (an empty one is caught by
 *    the `No profiles found under` guard in
 *    {@link assertNonEmptyTargetProfiles}). The aggregate "nothing to merge"
 *    error throws only when NO custom source EXISTS anywhere in the
 *    discovered set AND no profiles were EXPLICITLY targeted — driven by
 *    source existence, NOT by merge success. With a non-empty explicit
 *    `profiles` list each named profile already got a per-profile
 *    `skipped`/`error` entry, so a top-level failure would be wrong and
 *    misleading. `allowEmpty` turns that throw into a successful no-op
 *    returning the collected results (the aggregate sync path).
 */
export function runPerProfileMerge<T>(
  targetProfiles: readonly string[],
  profilesDir: string,
  explicit: readonly string[] | undefined,
  allowEmpty: boolean | undefined,
  nothingToMergeMessage: (profilesDir: string) => string,
  body: PerProfileMergeBody<T>
): T[] {
  const results: T[] = [];
  const found: FoundAnyCustom = { foundAnyCustom: false };

  for (const profile of targetProfiles) {
    const result = body(profile, profilesDir, found);
    if (result !== undefined) {
      results.push(result);
    }
  }

  if (!found.foundAnyCustom && !explicit) {
    if (allowEmpty) {
      return results;
    }
    throw new Error(nothingToMergeMessage(profilesDir));
  }

  return results;
}
