import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onExit } from 'signal-exit';

/**
 * Files copied into a package for one publish target, and put back afterwards - see
 * `publish.<target>.files`.
 *
 * `stage` writes a journal, moves aside whatever each destination held, and copies the sources in;
 * `restore` removes the copies and moves the originals back. A run that dies between the two leaves
 * the journal behind, and `recover` - called before the next publish plans anything - finishes the
 * restore, so one target's files never reach another target's publish.
 */
/* **Kept in `.git/rman/publish-files`**, the user's choice and for three reasons: it is inside the
 * repository, so the next run finds it; git never commits it, so it needs no `.gitignore`; and it
 * survives a reboot, which `os.tmpdir()` may not - and a reboot is the case the journal exists for.
 * A directory that is not a git repository falls back to the temporary directory.
 *
 * **Moved aside, not copied.** A rename on one filesystem is instant whatever the size - an image,
 * a whole directory - and the original is untouched until it is moved back. Across filesystems it
 * copies and removes instead.
 *
 * **The journal is written before anything is touched**, listing every destination and whether it
 * held something, so a run killed at any point leaves enough to undo exactly what it did.
 *
 * Restoring is synchronous, so it can run from `signal-exit`'s handler on Ctrl-C or a terminated
 * CI job - the same hook `child-tracker` uses to kill children. */
export class PublishFiles {
  protected readonly dir: string;
  protected readonly journal: PublishFiles.Journal;
  private _done = false;
  private _unhook?: () => void;

  protected constructor(dir: string, journal: PublishFiles.Journal) {
    this.dir = dir;
    this.journal = journal;
  }

  /**
   * Copies `files` in, after moving aside whatever their destinations held, and returns the handle
   * that puts everything back. `label` names the run in the journal - `[docker] my-app`.
   */
  static stage(repositoryDir: string, label: string, files: readonly PublishFiles.File[]): PublishFiles {
    const dir = PublishFiles.stateDir(repositoryDir);
    fs.mkdirSync(path.join(dir, 'backup'), { recursive: true });
    const entries = files.map((file, i): PublishFiles.JournalEntry => {
      const existed = lexists(file.dest);
      return {
        dest: file.dest,
        backup: existed ? path.join(dir, 'backup', String(i)) : undefined,
        createdDirs: missingParents(file.dest),
      };
    });
    const staged = new this(dir, { label, entries });
    staged.writeJournal();
    staged._unhook = onExit(() => staged.restore());
    for (const [i, entry] of entries.entries()) {
      if (entry.backup) move(entry.dest, entry.backup);
      fs.mkdirSync(path.dirname(entry.dest), { recursive: true });
      fs.cpSync(files[i]!.source, entry.dest, { recursive: true });
    }
    return staged;
  }

  /**
   * Finishes the restore a previous run left unfinished, and returns the destinations it put back -
   * empty when there was nothing to do.
   */
  static recover(repositoryDir: string): string[] {
    const dir = PublishFiles.stateDir(repositoryDir);
    const file = path.join(dir, JOURNAL);
    if (!fs.existsSync(file)) return [];
    const journal = JSON.parse(fs.readFileSync(file, 'utf-8')) as PublishFiles.Journal;
    new this(dir, journal).restore();
    return journal.entries.map(e => e.dest);
  }

  /** Where the journal and the moved-aside originals live for this repository. */
  static stateDir(repositoryDir: string): string {
    try {
      const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
        cwd: repositoryDir,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
      return path.join(gitDir, 'rman', 'publish-files');
    } catch {
      return path.join(os.tmpdir(), 'rman-publish-files', Buffer.from(repositoryDir).toString('base64url'));
    }
  }

  /** Removes the copies, moves the originals back, drops the directories staging created, and the
   *  journal last. Safe to call twice. */
  restore(): void {
    if (this._done) return;
    this._done = true;
    this._unhook?.();
    for (const entry of [...this.journal.entries].reverse()) {
      fs.rmSync(entry.dest, { recursive: true, force: true });
      if (entry.backup && lexists(entry.backup)) {
        fs.mkdirSync(path.dirname(entry.dest), { recursive: true });
        move(entry.backup, entry.dest);
      }
      for (const created of [...entry.createdDirs].reverse()) {
        if (fs.existsSync(created) && !fs.readdirSync(created).length) fs.rmdirSync(created);
      }
    }
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  protected writeJournal(): void {
    fs.writeFileSync(path.join(this.dir, JOURNAL), JSON.stringify(this.journal, undefined, 2));
  }
}

export namespace PublishFiles {
  /** One copy: `source` into `dest`, both absolute. */
  export interface File {
    source: string;
    dest: string;
  }

  export interface JournalEntry {
    dest: string;
    /** Where the destination's previous content was moved, when it had any. */
    backup?: string;
    /** Directories that did not exist and were created to hold `dest`, outermost first. */
    createdDirs: string[];
  }

  export interface Journal {
    label: string;
    entries: JournalEntry[];
  }
}

const JOURNAL = 'journal.json';

/** Whether anything is at `p`, a broken symbolic link included. */
function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** The directories above `file` that do not exist yet, outermost first. */
function missingParents(file: string): string[] {
  const missing: string[] = [];
  let dir = path.dirname(file);
  while (!fs.existsSync(dir) && dir !== path.dirname(dir)) {
    missing.unshift(dir);
    dir = path.dirname(dir);
  }
  return missing;
}

/** `rename`, or copy and remove where the two paths are on different filesystems. */
function move(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e;
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}
