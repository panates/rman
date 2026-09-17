import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Repository } from '../core/repository.js';
import { GitHelper } from '../utils/git.js';

export namespace ImportService {
  export interface Options {
    /** Subdirectory (relative to the repository root) the new package is placed under - default `'packages'`. */
    dest?: string;
  }

  export interface Result {
    /** The imported package's name (from its own `package.json`, or its directory basename). */
    name: string;
    /** Where it was placed, absolute. */
    targetDir: string;
    commitCount: number;
  }

  /**
   * Imports `sourcePath` (a local clone of some other git repository) as a new package under this
   * repository, preserving its **entire commit history** - every original commit, author, date and
   * message stays intact, just as if the package had always lived at its new path. Unlike copying
   * the files over and making one "import" commit, `git blame`/`git log --follow` keep working on
   * the imported files afterward.
   *
   * How: every commit reachable from `sourcePath`'s HEAD is turned into a patch (`git format-patch
   * --root`, oldest first), each patch's file paths are rewritten to be prefixed with the new
   * subdirectory, then replayed onto this repository via `git am` (preserving authorship). A
   * source repo with merge commits or binary-file renames can still trip up a patch here or there -
   * same caveat `lerna import` has, since both use this same replay approach rather than a real
   * merge (which real `git subtree` would give, at the cost of far less predictable behavior
   * across git versions - the reason this - and lerna - avoid it).
   */
  export async function importRepo(repository: Repository, sourcePath: string, options: Options = {}): Promise<Result> {
    const absSource = path.resolve(sourcePath);
    if (!fs.existsSync(path.join(absSource, '.git'))) {
      throw new Error(`"${sourcePath}" is not a git repository (no .git found) - clone it locally first`);
    }

    const name = resolveSourceName(absSource);
    const dirName = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
    const destDir = options.dest ?? 'packages';
    const targetDir = path.join(repository.dirname, destDir, dirName);
    if (fs.existsSync(targetDir)) {
      throw new Error(`"${path.relative(repository.dirname, targetDir)}" already exists`);
    }

    const sourceGit = new GitHelper({ cwd: absSource });
    const patchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-import-'));
    try {
      const patches = await sourceGit.formatPatches(patchDir);
      if (!patches.length) throw new Error(`"${sourcePath}" has no commits to import`);

      const relTargetDir = path.relative(repository.dirname, targetDir).split(path.sep).join('/');
      for (const patchFile of patches) rewritePatchPaths(patchFile, relTargetDir);

      const targetGit = new GitHelper({ cwd: repository.dirname });
      await targetGit.applyPatches(patches);

      return { name, targetDir, commitCount: patches.length };
    } finally {
      fs.rmSync(patchDir, { recursive: true, force: true });
    }
  }
}

/** The source repo's own `package.json` name, or its directory's basename when it has none (or
 *  isn't even a package yet - a plain library repo being folded in). */
function resolveSourceName(absSource: string): string {
  const pkgJsonFile = path.join(absSource, 'package.json');
  if (fs.existsSync(pkgJsonFile)) {
    try {
      const json = JSON.parse(fs.readFileSync(pkgJsonFile, 'utf-8'));
      if (typeof json.name === 'string' && json.name) return json.name;
    } catch {
      // malformed package.json - fall through to the directory name below.
    }
  }
  return path.basename(absSource);
}

/**
 * Rewrites a `git format-patch`-produced file in place so every path it touches is prefixed with
 * `prefix` (the new subdirectory, forward-slash-separated) - `diff --git`/`---`/`+++`/rename
 * headers only; `--- /dev/null`/`+++ /dev/null` (new/deleted file markers) never match, since they
 * have no `a/`/`b/` prefix to rewrite in the first place.
 */
function rewritePatchPaths(patchFile: string, prefix: string): void {
  const content = fs.readFileSync(patchFile, 'utf-8');
  const rewritten = content
    .replace(/^diff --git a\/(.+?) b\/(.+)$/gm, (_m, a, b) => `diff --git a/${prefix}/${a} b/${prefix}/${b}`)
    .replace(/^--- a\/(.+)$/gm, (_m, p) => `--- a/${prefix}/${p}`)
    .replace(/^\+\+\+ b\/(.+)$/gm, (_m, p) => `+++ b/${prefix}/${p}`)
    .replace(/^rename from (.+)$/gm, (_m, p) => `rename from ${prefix}/${p}`)
    .replace(/^rename to (.+)$/gm, (_m, p) => `rename to ${prefix}/${p}`);
  fs.writeFileSync(patchFile, rewritten);
}
