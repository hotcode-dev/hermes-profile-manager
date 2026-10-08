import fs from 'node:fs';
import path from 'node:path';

/** True when `p` exists and is a directory (following symlinks). */
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false; // missing entry (or broken symlink) => not a marker
  }
}

/**
 * Finds the project root by searching upwards for a directory containing `profiles/common`.
 * If not found, falls back to startDir or process.cwd().
 */
export function findProjectRoot(startDir: string = process.cwd()): string {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  while (current && current !== root) {
    const commonPath = path.join(current, 'profiles', 'common');
    if (isDirectory(commonPath)) {
      return current;
    }
    current = path.dirname(current);
  }

  // Check filesystem root as well
  if (isDirectory(path.join(root, 'profiles', 'common'))) {
    return root;
  }

  return path.resolve(startDir);
}
