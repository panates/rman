import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

export interface GitOptions {
  cwd?: string;
}

export interface CommitInfo {
  sha: string;
  subject: string;
  /** Absolute paths of every file this commit touched. */
  files: string[];
}

export class GitHelper {
  cwd: string;

  constructor(options?: GitOptions) {
    this.cwd = options?.cwd || process.cwd();
  }

  /** Files with uncommitted local changes (working tree + index). */
  async listDirtyFiles(options?: { absolute?: boolean }): Promise<string[]> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: this.cwd }));
    } catch {
      return [];
    }
    /** Don't trim the whole output first - porcelain lines have a fixed-width status
     *  prefix (e.g. " M "), and trimming would eat the leading space of the first line. */
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const files = lines.map(line => line.slice(3).trim());
    return options?.absolute ? files.map(f => path.join(this.cwd, f)) : files;
  }

  /** Files committed on the current branch but not yet in its upstream. */
  async listCommittedFiles(options?: { absolute?: boolean }): Promise<string[]> {
    let shaList: string;
    try {
      ({ stdout: shaList } = await execFileAsync('git', ['cherry'], { cwd: this.cwd }));
    } catch {
      /** No upstream configured, or not a git repository - nothing to report. */
      return [];
    }
    const shas = Array.from(shaList.matchAll(/[a-f0-9]{7,40}/gi)).map(m => m[0]);
    const files: string[] = [];
    for (const sha of shas) {
      const { stdout } = await execFileAsync('git', ['show', sha, '--name-only', '--pretty=format:'], {
        cwd: this.cwd,
      });
      files.push(...(stdout.trim() ? stdout.trim().split(/\r?\n/) : []));
    }
    return options?.absolute ? files.map(f => path.join(this.cwd, f)) : files;
  }

  /** Files changed since `hash` (committed diffs plus any uncommitted local changes). */
  async listChangedSince(hash: string, options?: { absolute?: boolean }): Promise<string[]> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('git', ['diff', '--name-only', hash], { cwd: this.cwd }));
    } catch (e: any) {
      throw new Error(`Unable to compute changes since "${hash}": ${e.message}`, { cause: e });
    }
    const files = stdout.trim() ? stdout.trim().split(/\r?\n/) : [];
    return options?.absolute ? files.map(f => path.join(this.cwd, f)) : files;
  }

  /**
   * Real commits only (never uncommitted/dirty changes - those have no message and can't be
   * described in a changelog), oldest first: with `hash`, everything committed since that ref;
   * without one, whatever's committed on the current branch but not yet in its upstream (same
   * source as `listCommittedFiles`, via `git cherry`).
   */
  async listCommits(options?: { hash?: string }): Promise<CommitInfo[]> {
    const hash = options?.hash;
    let shas: string[];
    if (hash) {
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync('git', ['log', '--reverse', '--format=%H', `${hash}..HEAD`], {
          cwd: this.cwd,
        }));
      } catch (e: any) {
        throw new Error(`Unable to list commits since "${hash}": ${e.message}`, { cause: e });
      }
      shas = stdout.trim() ? stdout.trim().split(/\r?\n/) : [];
    } else {
      let cherryOut: string;
      try {
        ({ stdout: cherryOut } = await execFileAsync('git', ['cherry'], { cwd: this.cwd }));
      } catch {
        return [];
      }
      shas = Array.from(cherryOut.matchAll(/[a-f0-9]{7,40}/gi)).map(m => m[0]);
    }

    const commits: CommitInfo[] = [];
    for (const sha of shas) {
      const { stdout: subject } = await execFileAsync('git', ['show', sha, '--no-patch', '--format=%s'], {
        cwd: this.cwd,
      });
      const { stdout: filesOut } = await execFileAsync('git', ['show', sha, '--name-only', '--pretty=format:'], {
        cwd: this.cwd,
      });
      const files = filesOut.trim() ? filesOut.trim().split(/\r?\n/) : [];
      commits.push({ sha, subject: subject.trim(), files: files.map(f => path.join(this.cwd, f)) });
    }
    return commits;
  }

  /** Tag names matching the glob `pattern` (e.g. `"v*"`, `"pkg-a@*"`), newest version first. */
  async listTags(pattern: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync('git', ['tag', '--list', pattern, '--sort=-v:refname'], {
        cwd: this.cwd,
      });
      return stdout.trim() ? stdout.trim().split(/\r?\n/) : [];
    } catch {
      return [];
    }
  }

  /** Whether `tag` exists as an exact git tag name (not a glob - a literal ref check). */
  async tagExists(tag: string): Promise<boolean> {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { cwd: this.cwd });
      return true;
    } catch {
      return false;
    }
  }

  /** The most recent commit that changed `file` (tracked history only) - `undefined` if it has
   *  never been committed. Answers "since when has this file last been updated", independent of
   *  any tag/version scheme - e.g. to check whether a changelog file has fallen behind. */
  async lastCommitTouching(file: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%H', '--', file], { cwd: this.cwd });
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** The best common ancestor of `a` and `b` - `undefined` if none exists (unrelated histories,
   *  an invalid ref, ...). */
  async mergeBase(a: string, b: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('git', ['merge-base', a, b], { cwd: this.cwd });
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** The most recent tag matching the glob `pattern` that HEAD actually descends from (unlike
   *  `listTags`, this follows commit ancestry rather than just sorting tag names - the right
   *  choice for a single repo-wide tag scheme, where a package has no tag of its own). */
  async describeTag(pattern: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('git', ['describe', '--tags', '--abbrev=0', '--match', pattern], {
        cwd: this.cwd,
      });
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }
}

const execFileAsync = promisify(execFile);
