/**
 * Per-profile merge result shape shared by mergeConfig / mergeJobs /
 * mergeSoul. Link results have a different shape (no per-profile status)
 * and are intentionally not covered by these helpers.
 */
export interface MergeStatusResult {
  profile: string;
  outputPath: string;
  status: 'merged' | 'skipped' | 'error';
  error?: string;
}

/**
 * Returns the subset of entries with `status === 'error'` across one or
 * more per-profile merge result arrays.
 *
 * The core merge modules (mergeConfig / mergeJobs / mergeSoul) deliberately
 * catch per-profile failures and record them as `status: 'error'` entries
 * in the returned arrays instead of throwing. `skipped` entries (a profile
 * with no per-concern custom source) are an intended no-op and are NOT
 * treated as errors here.
 *
 * The CLI uses this to gate its success banner and process exit code on
 * the presence of actual merge failures, so automation (CI, cron,
 * pipelines) sees a non-zero exit when a profile merge fails.
 */
export function collectMergeErrors(...arrays: MergeStatusResult[][]): MergeStatusResult[] {
  const errors: MergeStatusResult[] = [];
  for (const array of arrays) {
    for (const entry of array) {
      if (entry?.status === 'error') {
        errors.push(entry);
      }
    }
  }
  return errors;
}

/**
 * Exit-code / banner decision for a CLI action that ran one or more
 * per-profile merge steps.
 *
 * - any `status: 'error'` entry → failure: exit 1, no success banner.
 * - only `merged` / `skipped` entries (or no entries at all) → success:
 *   exit 0, success banner. `skipped` is the intended no-op behavior for
 *   profiles without a custom source and never fails the run.
 */
export interface MergeRunDecision {
  /** True when no merge errors were found; the CLI may print its banner. */
  success: boolean;
  /** Process exit code: 0 on success, 1 when any entry has status 'error'. */
  exitCode: 0 | 1;
}

export function decideMergeExit(...arrays: MergeStatusResult[][]): MergeRunDecision {
  const hasErrors = arrays.some((array) => array.some((entry) => entry?.status === 'error'));
  return hasErrors ? { success: false, exitCode: 1 } : { success: true, exitCode: 0 };
}
