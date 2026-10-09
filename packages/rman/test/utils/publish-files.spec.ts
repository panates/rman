import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { PublishFiles } from '../../src/utils/publish-files.js';

describe('utils/PublishFiles', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /** A git repository with a package holding a build output and two platform files to copy in. */
  function repo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-publish-files-'));
    dirs.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    };
    write('pkg/dist/config.json', '{"from":"build"}');
    write('pkg/deploy/config.json', '{"from":"deploy"}');
    write('pkg/deploy/brand/logo.png', 'PNG');
    return dir;
  }

  const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf-8');
  const exists = (dir: string, rel: string) => fs.existsSync(path.join(dir, rel));
  const files = (dir: string): PublishFiles.File[] => [
    { source: path.join(dir, 'pkg/deploy/config.json'), dest: path.join(dir, 'pkg/dist/config.json') },
    { source: path.join(dir, 'pkg/deploy/brand'), dest: path.join(dir, 'pkg/dist/assets/brand') },
  ];

  it('copies files and directories in, and puts back exactly what was there', () => {
    const dir = repo();
    const staged = PublishFiles.stage(dir, '[test]', files(dir));

    expect(read(dir, 'pkg/dist/config.json')).toBe('{"from":"deploy"}');
    expect(read(dir, 'pkg/dist/assets/brand/logo.png')).toBe('PNG');

    staged.restore();

    expect(read(dir, 'pkg/dist/config.json')).toBe('{"from":"build"}');
    /** A directory staging created to hold a copy goes with it. */
    expect(exists(dir, 'pkg/dist/assets')).toBe(false);
    expect(fs.existsSync(PublishFiles.stateDir(dir))).toBe(false);
  });

  it('keeps its journal and the moved-aside originals inside .git', () => {
    const dir = repo();
    const staged = PublishFiles.stage(dir, '[test]', files(dir));
    try {
      expect(PublishFiles.stateDir(dir)).toBe(path.join(fs.realpathSync(dir), '.git', 'rman', 'publish-files'));
      expect(fs.existsSync(path.join(PublishFiles.stateDir(dir), 'journal.json'))).toBe(true);
    } finally {
      staged.restore();
    }
  });

  /** A run killed after copying - its restore never ran - is finished by the next one. */
  it('recovers what an interrupted run left in place', () => {
    const dir = repo();
    const staged = PublishFiles.stage(dir, '[test]', files(dir));
    /** Stand in for a kill: the exit hook is dropped and nothing is restored. */
    (staged as unknown as { _unhook: () => void })._unhook();

    const recovered = PublishFiles.recover(dir);

    expect(recovered).toHaveLength(2);
    expect(read(dir, 'pkg/dist/config.json')).toBe('{"from":"build"}');
    expect(exists(dir, 'pkg/dist/assets')).toBe(false);
    expect(PublishFiles.recover(dir)).toEqual([]);
  });

  it('restores once, however many times it is asked', () => {
    const dir = repo();
    const staged = PublishFiles.stage(dir, '[test]', files(dir));
    staged.restore();
    fs.writeFileSync(path.join(dir, 'pkg/dist/config.json'), '{"from":"later build"}');
    staged.restore();
    expect(read(dir, 'pkg/dist/config.json')).toBe('{"from":"later build"}');
  });
});
