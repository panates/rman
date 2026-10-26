import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { createRepository, useNodeEcosystem } from './_fixture.js';

/**
 * **Which directories a Node workspace's members are**, through the whole walk: what
 * `Repository.packages` holds. The pnpm cases are the layouts pnpm 12.10.1 was asked about with
 * `pnpm ls -r`, and the expected names are its answers.
 */
describe('plugins/node: workspace members', () => {
  useNodeEcosystem();

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /** A repository root holding `packages/a`, `packages/b`, `packages/group/c`, `packages/test-x` and
   *  a dependency inside `packages/a/node_modules`, plus whatever `files` adds. */
  function repo(files: Record<string, string>, rootManifest: object = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-node-ws-'));
    dirs.push(dir);
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    write('package.json', JSON.stringify({ name: 'root', private: true, ...rootManifest }));
    write('.rmanrc', '{}');
    for (const member of [
      'packages/a',
      'packages/b',
      'packages/group/c',
      'packages/test-x',
      'packages/a/node_modules/dep',
    ]) {
      write(`${member}/package.json`, JSON.stringify({ name: path.basename(member), version: '1.0.0' }));
    }
    for (const [rel, text] of Object.entries(files)) write(rel, text);
    return dir;
  }

  const names = async (dir: string) => (await createRepository(dir)).packages.map(p => p.name).sort();

  it('reads pnpm-workspace.yaml when package.json names no workspaces', async () => {
    expect(await names(repo({ 'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n' }))).toEqual(['a', 'b', 'test-x']);
  });

  /** pnpm ignores `package.json#workspaces`, so its own file is the one the installed tree follows. */
  it("prefers pnpm-workspace.yaml's list over package.json's workspaces", async () => {
    const dir = repo({ 'pnpm-workspace.yaml': 'packages:\n  - "packages/a"\n' }, { workspaces: ['packages/*'] });
    expect(await names(dir)).toEqual(['a']);
  });

  it('takes members at any depth under **, and none under node_modules', async () => {
    expect(await names(repo({ 'pnpm-workspace.yaml': 'packages:\n  - "packages/**"\n' }))).toEqual([
      'a',
      'b',
      'c',
      'test-x',
    ]);
  });

  it('leaves out what a ! pattern names', async () => {
    const dir = repo({ 'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n  - "!packages/test-*"\n' });
    expect(await names(dir)).toEqual(['a', 'b']);
  });

  /** pnpm 9 moved its settings into this file, so one holding settings alone is ordinary. pnpm sees
   *  no members there (measured); rman keeps reading `workspaces`, as it did before. */
  it('falls back to package.json workspaces when pnpm-workspace.yaml lists no packages', async () => {
    const dir = repo(
      { 'pnpm-workspace.yaml': 'publicHoistPattern:\n  - "*eslint*"\n' },
      { workspaces: ['packages/*'] },
    );
    expect(await names(dir)).toEqual(['a', 'b', 'test-x']);
  });

  it('keeps npm workspaces one level deep, as before', async () => {
    expect(await names(repo({}, { workspaces: ['packages/*'] }))).toEqual(['a', 'b', 'test-x']);
  });

  /** Nothing else reads this file, so a parse error swallowed here would read as no packages. */
  it('refuses a pnpm-workspace.yaml that is not valid YAML, naming it', async () => {
    const dir = repo({ 'pnpm-workspace.yaml': 'packages: [unclosed\n' });
    await expect(createRepository(dir)).rejects.toThrow(`Cannot read ${path.join(dir, 'pnpm-workspace.yaml')}`);
  });
});
