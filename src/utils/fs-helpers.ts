import fs from 'node:fs';
import path from 'node:path';

/**
 * Atomically writes file content by writing to a temp file first and renaming it.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }
}

/**
 * Safely creates or updates a symbolic link.
 * If target exists and is a link or directory/file, it is replaced.
 */
export function ensureSymlinkSync(target: string, linkPath: string): void {
  const dir = path.dirname(linkPath);
  fs.mkdirSync(dir, { recursive: true });

  try {
    const lstat = fs.lstatSync(linkPath);
    if (lstat.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(linkPath);
      if (currentTarget === target) {
        return; // Already points to desired target
      }
      fs.unlinkSync(linkPath);
    } else if (lstat.isDirectory()) {
      fs.rmSync(linkPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(linkPath);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  fs.symlinkSync(target, linkPath);
}

/**
 * Discovers all profile directory names in profilesDir excluding 'common' and hidden dirs.
 */
export function getProfileNames(profilesDir: string): string[] {
  if (!fs.existsSync(profilesDir)) {
    return [];
  }

  return fs.readdirSync(profilesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'common' && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}
