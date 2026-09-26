import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureSymlinkSync, pruneStaleSymlinks } from '../utils/fs-helpers.js';
import { assertProfilePathInWorkspace, assertPathInBase } from '../utils/profile-name.js';
import { validateExplicitProfiles, resolveTargetProfiles } from '../utils/profile-targets.js';

export interface LinkOptions {
  rootDir?: string;
  hermesDir?: string;
  profiles?: string[];
  logger?: (msg: string) => void;
  dryRun?: boolean;
}

export interface LinkResult {
  source: string;
  destination: string;
  type: 'skill' | 'plugin' | 'hermes-plugin' | 'hermes-profiles';
  profile?: string;
}

/**
 * Links common skills to all profiles:
 * profiles/common/skills/<skill> -> profiles/<profile>/skills/<skill>
 * Uses relative symlinks (../../common/skills/<skill>) for portability.
 */
export function linkSkills(options: LinkOptions = {}): LinkResult[] {
  const rootDir = options.rootDir || process.cwd();
  const log = options.logger || console.log;

  // Explicit profile names (global -p/--profiles option) are a
  // path-traversal vector; validated BEFORE any symlink or filesystem side
  // effect (see validateExplicitProfiles). Discovered names come from
  // readdirSync.
  validateExplicitProfiles(options.profiles);

  const commonSkillsDir = path.join(rootDir, 'profiles', 'common', 'skills');

  if (!fs.existsSync(commonSkillsDir)) {
    throw new Error(`Common skills directory not found: ${commonSkillsDir}`);
  }

  const skillEntries = fs.readdirSync(commonSkillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name);

  const profilesDir = path.join(rootDir, 'profiles');
  const targetProfiles = resolveTargetProfiles(options.profiles, profilesDir);

  const results: LinkResult[] = [];

  for (const profile of targetProfiles) {
    const profileSkillsDir = path.join(profilesDir, profile, 'skills');
    // Defense in depth: the profile dir must stay strictly under
    // profilesDir (closes traversal even for non-explicit names).
    assertProfilePathInWorkspace(profilesDir, profileSkillsDir);

    // Prune dangling symlinks left behind by deleted/renamed common skills
    // (runs only after the guards above; real dirs are never touched).
    pruneStaleSymlinks(profileSkillsDir, Boolean(options.dryRun), log);

    for (const skillName of skillEntries) {
      const targetRel = `../../common/skills/${skillName}`;
      const linkPath = path.join(profileSkillsDir, skillName);

      if (!options.dryRun) {
        ensureSymlinkSync(targetRel, linkPath, { logger: log });
      }

      // Under --dry-run the symlink was not created, so phrase the line as a
      // preview rather than asserting a side effect that did not happen.
      log(
        options.dryRun
          ? `Would link ${skillName} to ${profile} profile`
          : `Linked ${skillName} to ${profile} profile`
      );
      results.push({
        source: targetRel,
        destination: linkPath,
        type: 'skill',
        profile
      });
    }
  }

  return results;
}

/**
 * Links common plugins to all profiles and (only on a default, untargeted
 * run) to ~/.hermes/plugins:
 * 1. profiles/common/plugins/<plugin> -> profiles/<profile>/plugins/<plugin> (relative)
 * 2. profiles/common/plugins/<plugin> -> ~/.hermes/plugins/<plugin> (absolute)
 *
 * Step 2 is gated on the ABSENCE of an explicit non-empty `profiles` target
 * list, mirroring the `!options.profiles` exemption pattern the merge steps
 * (mergeConfig/mergeJobs/mergeSoul) use: `-p/--profiles` is a scope gate, so
 * a user who explicitly names profiles has scoped the run to those profiles
 * and must not get a machine-wide write into their global Hermes home
 * directory. A default run (no explicit `profiles`) keeps the historical
 * behavior and links the global plugins dir as before.
 */
export function linkPlugins(options: LinkOptions = {}): LinkResult[] {
  const rootDir = options.rootDir || process.cwd();
  const hermesDir = options.hermesDir || process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
  const log = options.logger || console.log;

  // Explicit profile names (global -p/--profiles option) are a
  // path-traversal vector; validated BEFORE any symlink or filesystem side
  // effect (see validateExplicitProfiles). Discovered names come from
  // readdirSync.
  validateExplicitProfiles(options.profiles);

  const commonPluginsDir = path.join(rootDir, 'profiles', 'common', 'plugins');

  if (!fs.existsSync(commonPluginsDir)) {
    throw new Error(`Common plugins directory not found: ${commonPluginsDir}`);
  }

  const pluginEntries = fs.readdirSync(commonPluginsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name);

  const profilesDir = path.join(rootDir, 'profiles');
  const targetProfiles = resolveTargetProfiles(options.profiles, profilesDir);

  const results: LinkResult[] = [];

  // 1. Link to profiles
  for (const profile of targetProfiles) {
    const profilePluginsDir = path.join(profilesDir, profile, 'plugins');
    // Defense in depth: the profile dir must stay strictly under
    // profilesDir (closes traversal even for non-explicit names).
    assertProfilePathInWorkspace(profilesDir, profilePluginsDir);

    // Prune dangling symlinks left behind by deleted/renamed common plugins
    // (runs only after the guards above; real dirs are never touched).
    pruneStaleSymlinks(profilePluginsDir, Boolean(options.dryRun), log);

    for (const pluginName of pluginEntries) {
      const targetRel = `../../common/plugins/${pluginName}`;
      const linkPath = path.join(profilePluginsDir, pluginName);

      if (!options.dryRun) {
        ensureSymlinkSync(targetRel, linkPath, { logger: log });
      }

      // Under --dry-run the symlink was not created, so phrase the line as a
      // preview rather than asserting a side effect that did not happen.
      log(
        options.dryRun
          ? `Would link ${pluginName} to ${profile} profile`
          : `Linked ${pluginName} to ${profile} profile`
      );
      results.push({
        source: targetRel,
        destination: linkPath,
        type: 'plugin',
        profile
      });
    }
  }

  // 2. Link to ~/.hermes/plugins — ONLY when the run is NOT explicitly
  // scoped with a non-empty `profiles` list. The global plugins dir is a
  // machine-wide side effect outside the workspace, so it must not fire for
  // a scoped `-p/--profiles` run the user did not ask for it (the established
  // `-p` scoping contract; same exemption shape as the merge steps).
  const explicitlyTargeted = options.profiles && options.profiles.length > 0;
  if (!explicitlyTargeted) {
    const hermesPluginsDir = path.join(hermesDir, 'plugins');
    // Defense in depth: the plugins dir we write must stay strictly under
    // the hermes home dir (mirrors the profile-side boundary check).
    assertPathInBase(hermesDir, hermesPluginsDir);
    // Prune dangling symlinks left behind by deleted/renamed common plugins
    // first (the dir may legitimately be absent, in which case pruning is a
    // no-op). Runs only on the untargeted path: a scoped run must not touch
    // the global dir at all.
    pruneStaleSymlinks(hermesPluginsDir, Boolean(options.dryRun), log);

    for (const pluginName of pluginEntries) {
      const pluginSource = path.join(commonPluginsDir, pluginName);
      const linkPath = path.join(hermesPluginsDir, pluginName);

      if (!options.dryRun) {
        ensureSymlinkSync(pluginSource, linkPath, { logger: log });
      }

      // Under --dry-run the symlink was not created, so phrase the line as a
      // preview rather than asserting a side effect that did not happen.
      log(
        options.dryRun
          ? `Would link ${pluginName} to ${hermesPluginsDir}`
          : `Linked ${pluginName} to ${hermesPluginsDir}`
      );
      results.push({
        source: pluginSource,
        destination: linkPath,
        type: 'hermes-plugin'
      });
    }
  }

  return results;
}

/**
 * Links the profiles folder directly to ~/.hermes/profiles:
 * <rootDir>/profiles -> ~/.hermes/profiles
 */
export function linkHermes(options: LinkOptions = {}): LinkResult {
  const rootDir = options.rootDir || process.cwd();
  const hermesDir = options.hermesDir || process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
  const log = options.logger || console.log;

  const profilesSrc = path.join(rootDir, 'profiles');
  const hermesProfilesDest = path.join(hermesDir, 'profiles');
  // Defense in depth: the destination must stay strictly under the hermes
  // home dir (mirrors the profile-side boundary check and the plugins link).
  assertPathInBase(hermesDir, hermesProfilesDest);

  if (!fs.existsSync(profilesSrc)) {
    throw new Error(`Profiles source directory not found: ${profilesSrc}`);
  }

  if (!options.dryRun) {
    ensureSymlinkSync(profilesSrc, hermesProfilesDest, { logger: log });
  }

  // Under --dry-run the symlink was not created, so phrase the line as a
  // preview rather than asserting a side effect that did not happen.
  log(
    options.dryRun
      ? `Would link Hermes profiles to ${hermesDir}`
      : `Linked Hermes profiles to ${hermesDir}`
  );
  return {
    source: profilesSrc,
    destination: hermesProfilesDest,
    type: 'hermes-profiles'
  };
}
