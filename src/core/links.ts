import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureSymlinkSync, getProfileNames, pruneStaleSymlinks } from '../utils/fs-helpers.js';
import { validateProfileName, assertProfilePathInWorkspace } from '../utils/profile-name.js';

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

  // User-controlled profile names (global -p/--profiles option) are a
  // path-traversal vector: path.join(profilesDir, '../../x') resolves
  // OUTSIDE the workspace, so symlinks would be created at attacker-chosen
  // locations. Validate every explicitly targeted name BEFORE any symlink
  // or filesystem side effect, mirroring initWorkspace's "validated before
  // path construction" contract. (Discovered names come from readdirSync,
  // not user input.)
  for (const profile of options.profiles ?? []) {
    validateProfileName(profile);
  }

  const commonSkillsDir = path.join(rootDir, 'profiles', 'common', 'skills');

  if (!fs.existsSync(commonSkillsDir)) {
    throw new Error(`Common skills directory not found: ${commonSkillsDir}`);
  }

  const skillEntries = fs.readdirSync(commonSkillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name);

  const profilesDir = path.join(rootDir, 'profiles');
  const availableProfiles = getProfileNames(profilesDir);
  const targetProfiles = options.profiles && options.profiles.length > 0
    ? options.profiles
    : availableProfiles;

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
 * Links common plugins to all profiles and to ~/.hermes/plugins:
 * 1. profiles/common/plugins/<plugin> -> profiles/<profile>/plugins/<plugin> (relative)
 * 2. profiles/common/plugins/<plugin> -> ~/.hermes/plugins/<plugin> (absolute)
 */
export function linkPlugins(options: LinkOptions = {}): LinkResult[] {
  const rootDir = options.rootDir || process.cwd();
  const hermesDir = options.hermesDir || process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
  const log = options.logger || console.log;

  // User-controlled profile names (global -p/--profiles option) are a
  // path-traversal vector: path.join(profilesDir, '../../x') resolves
  // OUTSIDE the workspace, so symlinks would be created at attacker-chosen
  // locations. Validate every explicitly targeted name BEFORE any symlink
  // or filesystem side effect, mirroring initWorkspace's "validated before
  // path construction" contract. (Discovered names come from readdirSync,
  // not user input.)
  for (const profile of options.profiles ?? []) {
    validateProfileName(profile);
  }

  const commonPluginsDir = path.join(rootDir, 'profiles', 'common', 'plugins');

  if (!fs.existsSync(commonPluginsDir)) {
    throw new Error(`Common plugins directory not found: ${commonPluginsDir}`);
  }

  const pluginEntries = fs.readdirSync(commonPluginsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name);

  const profilesDir = path.join(rootDir, 'profiles');
  const availableProfiles = getProfileNames(profilesDir);
  const targetProfiles = options.profiles && options.profiles.length > 0
    ? options.profiles
    : availableProfiles;

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

  // 2. Link to ~/.hermes/plugins (prune dangling symlinks there first; the
  // dir may legitimately be absent, in which case pruning is a no-op).
  const hermesPluginsDir = path.join(hermesDir, 'plugins');
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
