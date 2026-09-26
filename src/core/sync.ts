import { mergeConfig, MergeConfigOptions, MergeConfigResult } from './config.js';
import { mergeJobs, MergeJobsOptions, MergeJobsResult } from './jobs.js';
import { mergeSoul, MergeSoulOptions, MergeSoulResult } from './soul.js';
import { linkSkills, linkPlugins, linkHermes, LinkOptions, LinkResult } from './links.js';

export interface SyncOptions extends MergeConfigOptions, MergeJobsOptions, MergeSoulOptions, LinkOptions {
  includeHermesLink?: boolean;
}

/**
 * Top-level (pre-profile) failures of the individual merge steps, captured
 * instead of thrown so that a failure in ONE step (e.g. `mergeConfig`
 * throwing when `profiles/common/config.yaml` is missing or not a YAML
 * object) does not abort the other steps - each step still runs and its
 * per-profile results are still recorded in the returned arrays. A field is
 * present (a string) only when that step failed before reaching its
 * profiles; empty/absent otherwise.
 */
export interface MergeStepErrors {
  config?: string;
  jobs?: string;
  soul?: string;
}

export interface SyncAllResult {
  config: MergeConfigResult[];
  jobs: MergeJobsResult[];
  soul: MergeSoulResult[];
  skills: LinkResult[];
  plugins: LinkResult[];
  hermesLink?: LinkResult;
  /**
   * Errors from the link steps (skills / plugins / hermes), captured instead
   * of thrown so the aggregate never aborts before the CLI can report them.
   * Mirrors the merge path, where per-profile failures are recorded in the
   * returned arrays rather than thrown. Empty when every link step succeeded
   * (or was a no-op).
   */
  linkErrors: string[];
  /**
   * Per-step top-level (pre-profile) failures of the merge steps, captured
   * instead of thrown (see {@link MergeStepErrors}). ALL failed steps are
   * listed - a failure in one step no longer suppresses the remaining steps
   * or their failures. Empty object when every merge step succeeded.
   */
  stepErrors: MergeStepErrors;
  /**
   * @deprecated Use {@link stepErrors} instead, which names EACH failing
   * merge step (this field could only ever carry the FIRST step's failure,
   * because the aborting steps' failures were never visible). Kept for
   * backward compatibility of the public API: it holds the same messages
   * joined by newline and is set whenever `stepErrors` is non-empty.
   *
   * The per-profile failures are recorded as `status: 'error'` entries in
   * the merge arrays, but a merge step can ALSO fail before it even reaches
   * its profiles - e.g. `mergeConfig` throws when
   * `profiles/common/config.yaml` is missing or not a YAML object. Those
   * are captured here and in `stepErrors`, and `syncAll` therefore really
   * does never throw: the CLI gates its success banner and exit code on the
   * step errors, the per-profile error entries, and the link errors.
   */
  syncError?: string;
}

/**
 * Runs the three sub-merges (config, jobs, soul) over all profiles.
 * Each sub-merge is run with `allowEmpty: true` so that a workspace that
 * happens to have no custom source for a given concern (e.g. no
 * cron/jobs.custom.json anywhere) is a successful no-op for that concern
 * rather than a hard error that aborts the rest of the aggregate.
 *
 * Each sub-merge is ALSO wrapped in its own try/catch (mirroring
 * {@link linkAll}): a top-level (pre-profile) throw from one step - e.g.
 * `mergeConfig` throwing when `profiles/common/config.yaml` is missing or
 * not a YAML object - is captured into `stepErrors` instead of propagating,
 * so the remaining steps still run and their per-profile failures (invalid
 * custom sources, broken jobs files, ...) are still recorded and reported
 * instead of staying invisible behind the first failure.
 */
export function mergeAll(options: SyncOptions = {}): { config: MergeConfigResult[]; jobs: MergeJobsResult[]; soul: MergeSoulResult[]; stepErrors: MergeStepErrors } {
  const baseOptions = { ...options, allowEmpty: true };
  const stepErrors: MergeStepErrors = {};

  let config: MergeConfigResult[] = [];
  try {
    config = mergeConfig(baseOptions);
  } catch (err: unknown) {
    stepErrors.config = err instanceof Error ? err.message : String(err);
  }

  let jobs: MergeJobsResult[] = [];
  try {
    jobs = mergeJobs(baseOptions);
  } catch (err: unknown) {
    stepErrors.jobs = err instanceof Error ? err.message : String(err);
  }

  let soul: MergeSoulResult[] = [];
  try {
    soul = mergeSoul(baseOptions);
  } catch (err: unknown) {
    stepErrors.soul = err instanceof Error ? err.message : String(err);
  }

  return { config, jobs, soul, stepErrors };
}

/**
 * Runs the link steps (skills, plugins, and optionally the Hermes profiles
 * link). Each step is run inside its own try/catch so that a failure in one
 * step (e.g. a missing `profiles/common/skills` source dir) is *captured*
 * into `linkErrors` instead of thrown. This mirrors the merge path, where
 * per-profile failures are recorded in the returned arrays rather than
 * thrown, and guarantees the aggregate (`syncAll`) always returns so the CLI
 * can report BOTH the merge results and any link failures in one pass.
 */
export function linkAll(options: SyncOptions = {}): { skills: LinkResult[]; plugins: LinkResult[]; hermesLink?: LinkResult; linkErrors: string[] } {
  const linkErrors: string[] = [];
  let skills: LinkResult[] = [];
  let plugins: LinkResult[] = [];
  let hermesLink: LinkResult | undefined;

  try {
    skills = linkSkills(options);
  } catch (err: unknown) {
    linkErrors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    plugins = linkPlugins(options);
  } catch (err: unknown) {
    linkErrors.push(err instanceof Error ? err.message : String(err));
  }

  if (options.includeHermesLink) {
    try {
      hermesLink = linkHermes(options);
    } catch (err: unknown) {
      linkErrors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { skills, plugins, hermesLink, linkErrors };
}

export function syncAll(options: SyncOptions = {}): SyncAllResult {
  // mergeAll records per-profile failures as `status: 'error'` entries
  // (never thrown) and, since the step-isolation fix, captures EACH
  // top-level (pre-profile) failure of a merge step in its own
  // `stepErrors` slot (also never thrown) - e.g. a missing or non-object
  // `profiles/common/config.yaml` in mergeConfig no longer aborts the
  // jobs/soul steps. syncAll therefore really never throws and the CLI can
  // report every failure together with the link results instead of dying
  // with a raw stack trace.
  const baseOptions: SyncOptions = { ...options, allowEmpty: true };
  // mergeAll forces allowEmpty internally, so a genuinely empty workspace
  // is a benign no-op here; only real top-level step failures land in
  // stepErrors.
  const { config, jobs, soul, stepErrors } = mergeAll(baseOptions);
  const { skills, plugins, hermesLink, linkErrors } = linkAll(options);
  // Backward-compat carrier: join the per-step messages (config, jobs, soul
  // order) into the legacy single-field contract. Set only when at least
  // one step failed, mirroring the old "first step's error" behavior for
  // the single-step-failure case.
  const stepMessages = [stepErrors.config, stepErrors.jobs, stepErrors.soul].filter(
    (message): message is string => message !== undefined
  );
  const syncError = stepMessages.length > 0 ? stepMessages.join('\n') : undefined;
  return { config, jobs, soul, skills, plugins, hermesLink, linkErrors, stepErrors, syncError };
}
