import fs from 'fs';
import * as yaml from 'js-yaml';
import path from 'path';
import merge from 'putil-merge';

/**
 * Reads the rman configuration defined at a single directory level, merging
 * (in increasing precedence): `package.json#rman`, `.rman.yml`, `.rmanrc`.
 */
export function readDirConfig(dirname: string): any {
  const result = {};

  const pkgJsonFile = path.join(dirname, 'package.json');
  if (fs.existsSync(pkgJsonFile)) {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonFile, 'utf-8'));
    if (pkgJson && typeof pkgJson.rman === 'object') merge(result, pkgJson.rman, { deep: true });
  }

  const ymlFile = path.join(dirname, '.rman.yml');
  if (fs.existsSync(ymlFile)) {
    const obj = yaml.load(fs.readFileSync(ymlFile, 'utf-8'));
    if (obj && typeof obj === 'object') merge(result, obj, { deep: true });
  }

  const rcFile = path.join(dirname, '.rmanrc');
  if (fs.existsSync(rcFile)) {
    const obj = JSON.parse(fs.readFileSync(rcFile, 'utf-8'));
    if (obj && typeof obj === 'object') merge(result, obj, { deep: true });
  }

  return result;
}

/**
 * Resolves the effective config for `targetDir` by cascading from `rootDir`
 * down to `targetDir` (inclusive), the same way tsconfig's `extends` chain
 * works: each directory level overrides the ones above it. This lets a
 * package (or any intermediate directory) narrow or override the repository's
 * root configuration for itself and everything below it.
 */
export function resolveConfig(rootDir: string, targetDir: string, cache: Map<string, any> = new Map()): any {
  const result = {};
  for (const dir of dirChain(rootDir, targetDir)) {
    let local = cache.get(dir);
    if (!local) {
      local = readDirConfig(dir);
      cache.set(dir, local);
    }
    merge(result, local, { deep: true });
  }
  return result;
}

function dirChain(rootDir: string, targetDir: string): string[] {
  const rel = path.relative(rootDir, targetDir);
  if (!rel || rel === '.' || rel.startsWith('..')) return [rootDir];
  const dirs = [rootDir];
  let dir = rootDir;
  for (const segment of rel.split(path.sep)) {
    dir = path.join(dir, segment);
    dirs.push(dir);
  }
  return dirs;
}
