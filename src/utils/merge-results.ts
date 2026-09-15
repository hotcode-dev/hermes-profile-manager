/**
 * Shared shape of the per-profile result entries returned by the merge
 * sub-commands (config, jobs, soul). The core modules record per-profile
 * failures as `status: 'error'` entries in their returned arrays rather than
 * throwing, so a run can complete "successfully" while individual profiles
 * failed. The CLI (and tests) use `mergeErrors` to recover those failures.
 */
export interface MergeEntry {
  profile: string;
  outputPath: string;
  status: 'merged' | 'skipped' | 'error';
  error?: string;
}

export interface MergeAllGroups {
  config: MergeEntry[];
  jobs: MergeEntry[];
  soul: MergeEntry[];
}

/**
 * Returns the entries with `status === 'error'` from one or more merge result
 * arrays. Accepts flat arrays (e.g. `mergeConfig`'s return value) and the
 * `{ config, jobs, soul }` shape returned by `mergeAll` (or any superset of
 * it, such as `SyncAllResult`), so callers can pass whatever they have
 * without reshaping. `skipped` entries (a profile with no custom source for
 * that concern) are intentionally NOT errors — they are the intended no-op
 * behavior.
 */
export function mergeErrors(...groups: (MergeEntry[] | MergeAllGroups | undefined)[]): MergeEntry[] {
  const entries: MergeEntry[] = [];
  for (const group of groups) {
    if (!group) continue;
    if (Array.isArray(group)) {
      entries.push(...group);
    } else {
      entries.push(...group.config, ...group.jobs, ...group.soul);
    }
  }
  return entries.filter((entry) => entry.status === 'error');
}
