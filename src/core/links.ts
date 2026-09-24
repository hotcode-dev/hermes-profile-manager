import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureSymlinkSync } from '../utils/fs-helpers.js';
import { assertProfilePathInWorkspace } from '../utils/profile-name.js';
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

  // 2. Link to ~/.hermes/plugins
  const hermesPluginsDir = path.join(hermesDir, 'plugins');
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
