import { exec } from './exec';
import path from 'path';

export namespace GitHelper {

  export interface FileStatus {
    filename: string;
    status: string;
  }
}

export interface GitOptions {
  cwd?: string;
}

export class GitHelper {
  cwd: string;

  constructor(options?: GitOptions) {
    this.cwd = options?.cwd || process.cwd();
  }

  async listDirtyFileStatus(options?: { absolute?: boolean }): Promise<GitHelper.FileStatus[]> {
    const x = await exec('git', {
      cwd: this.cwd,
      argv: ['status', '--porcelain']
    });
    const result: GitHelper.FileStatus[] = [];
    const files = x.stdout ? x.stdout.trim().split(/\s*\n\s*/) : [];
    for (const f of files) {
      const m = f.match(/^(\w+) (.+)$/);
      if (m) {
        result.push({
          filename: options?.absolute ? path.join(this.cwd, m[2]) : m[2],
          status: m[1]
        })
      }
    }
    return result;
  }

  async listDirtyFiles(options?: { absolute?: boolean }): Promise<string[]> {
    return (await this.listDirtyFileStatus(options)).map(x => x.filename);
  }

  async listCommitSha(): Promise<string[]> {
    const x = await exec('git', {
      cwd: this.cwd,
      argv: ['cherry']
    });
    const matches = x.stdout ? x.stdout.matchAll(/([a-f0-9]+)/gi) : [];
    const result: string[] = []
    for (const m of matches) {
      result.push(m[1]);
    }
    return result;
  }

  async listCommittedFiles(options?: {
    absolute?: boolean,
    commits?: string | string[]
  }): Promise<string[]> {
    const shaArr = options?.commits
        ? (Array.isArray(options?.commits) ? options?.commits : [options?.commits])
        : await this.listCommitSha();
    let result: string[] = [];
    for (const s of shaArr) {
      const x = await exec('git', {
        cwd: this.cwd,
        argv: ['show', s, '--name-only', '--pretty="format:"']
      });
      result.push(...(x.stdout ? x.stdout.trim().split(/\s*\n\s*/) : []));
    }
    if (options?.absolute)
      result = result.map(f => path.join(this.cwd, f));
    return result;
  }

  async readFileLastPublished(filePath: string, commitSha?: string): Promise<string> {
    const x = await exec('git', {
      cwd: this.cwd,
      argv: ['show', (commitSha || 'HEAD') + ':"' + filePath + '"']
    });
    return x.stdout || '';
  }

}
