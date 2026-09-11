import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, getProfileNames } from '../utils/fs-helpers.js';

export interface MergeSoulOptions {
  rootDir?: string;
  profiles?: string[];
  logger?: (msg: string) => void;
  dryRun?: boolean;
}

export interface MergeSoulResult {
  profile: string;
  outputPath: string;
  status: 'merged' | 'skipped' | 'error';
  error?: string;
}

/**
 * Merges profile custom SOUL (profiles/<profile>/SOUL.custom.md)
 * with common SOUL (profiles/common/SOUL.md)
 * into profiles/<profile>/SOUL.md.
 * Order: Profile custom SOUL comes first; common SOUL is appended last.
 */
export function mergeSoul(options: MergeSoulOptions = {}): MergeSoulResult[] {
  const rootDir = options.rootDir || process.cwd();
  const log = options.logger || console.log;
  const commonSoulPath = path.join(rootDir, 'profiles', 'common', 'SOUL.md');

  if (!fs.existsSync(commonSoulPath)) {
    throw new Error(`Common SOUL file not found: ${commonSoulPath}`);
  }

  const commonSoulContent = fs.readFileSync(commonSoulPath, 'utf8').trim();
  const profilesDir = path.join(rootDir, 'profiles');
  const availableProfiles = getProfileNames(profilesDir);
  const targetProfiles = options.profiles && options.profiles.length > 0
    ? options.profiles
    : availableProfiles;

  const results: MergeSoulResult[] = [];
  let foundAnyCustom = false;

  for (const profile of targetProfiles) {
    const profileDir = path.join(profilesDir, profile);
    const customSoulPath = path.join(profileDir, 'SOUL.custom.md');
    const outputSoulPath = path.join(profileDir, 'SOUL.md');

    if (!fs.existsSync(customSoulPath)) {
      continue;
    }

    foundAnyCustom = true;

    try {
      const customSoulContent = fs.readFileSync(customSoulPath, 'utf8').trim();
      const combined = `${customSoulContent}\n\n${commonSoulContent}\n`;

      if (!options.dryRun) {
        atomicWriteFileSync(outputSoulPath, combined);
      }

      log(`Merged SOUL written to: ${outputSoulPath}`);
      results.push({
        profile,
        outputPath: outputSoulPath,
        status: 'merged'
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`Error merging SOUL for ${profile}: ${errorMsg}`);
      results.push({
        profile,
        outputPath: outputSoulPath,
        status: 'error',
        error: errorMsg
      });
    }
  }

  if (!foundAnyCustom) {
    throw new Error(`Error: no profiles with SOUL.custom.md found under ${profilesDir}`);
  }

  return results;
}
