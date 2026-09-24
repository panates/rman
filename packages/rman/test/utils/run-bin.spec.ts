import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runBin } from '../../src/utils/run-bin.js';
import { createApp, useLocalBin } from '../_fixture.js';

describe('utils/run-bin', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /**
   * `runBin` finds a binary by PATH, and what goes on PATH is `BinPath`'s - which in the core has no
   * provider at all. So the spec brings one, pointing at a directory called `local-bin`:
   * deliberately **not** `node_modules/.bin`, because that is npm's layout and this file is testing
   * rman's core. `rman-node`'s own directories are its spec's business.
   */
  useLocalBin();

  /** `runBin` takes the application whose technologies put `local-bin` on PATH - there is no
   *  registry to read one out of any more. */
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = createApp();
  });

  /** A repository holding one fake binary where this ecosystem keeps them. */
  function fixture(script: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-run-bin-test-'));
    dirs.push(dir);
    const bin = path.join(dir, 'local-bin');
    fs.mkdirSync(bin, { recursive: true });
    const file = path.join(bin, 'fake-tool');
    fs.writeFileSync(file, script);
    fs.chmodSync(file, 0o755);
    return dir;
  }

  it("resolves the binary from whatever directory BinPath's provider offers", async () => {
    const dir = fixture('#!/bin/sh\necho hello from fake-tool\n');
    const result = await runBin('fake-tool', [], { cwd: dir, stdio: 'pipe', app });
    expect(result.code).toBe(0);
    expect(result.output.trim()).toBe('hello from fake-tool');
  });

  it('passes argv as separate arguments, so a value containing spaces stays one argument', async () => {
    // The whole reason this exists next to `exec`: through a shell, "two words" becomes two
    // arguments unless every interpolated value is quoted by hand - and one that isn't is not a
    // typo, it is an injection.
    const dir = fixture('#!/bin/sh\necho "count=$#"\nfor a in "$@"; do echo "arg=[$a]"; done\n');
    const result = await runBin('fake-tool', ['--name', 'two words', 'a;echo b'], { cwd: dir, stdio: 'pipe', app });
    expect(result.output.trim().split('\n')).toEqual(['count=3', 'arg=[--name]', 'arg=[two words]', 'arg=[a;echo b]']);
  });

  it('rejects on a non-zero exit, naming the command and the code', async () => {
    const dir = fixture('#!/bin/sh\nexit 3\n');
    await expect(runBin('fake-tool', ['--check'], { cwd: dir, stdio: 'pipe', app })).rejects.toThrow(
      '"fake-tool --check" exited with code 3',
    );
  });

  it('carries the exit code and captured output on the error', async () => {
    // A caller that wants to treat some code specially (eslint's 1 vs 2) needs it, and the output
    // is gone with the process otherwise.
    const dir = fixture('#!/bin/sh\necho "what went wrong"\nexit 2\n');
    const error: any = await runBin('fake-tool', [], { cwd: dir, stdio: 'pipe', logLevel: 'silent', app }).catch(
      e => e,
    );
    expect(error.code).toBe(2);
    expect(error.output.trim()).toBe('what went wrong');
  });

  it('asks the useful question when the binary is not installed', async () => {
    const dir = fixture('#!/bin/sh\n');
    await expect(runBin('not-installed-at-all', [], { cwd: dir })).rejects.toThrow(
      /"not-installed-at-all" was not found - is it installed in this repository\?/,
    );
  });

  it('captures instead of streaming below "info", which is what a quiet run means', async () => {
    const dir = fixture('#!/bin/sh\necho noise\n');
    const result = await runBin('fake-tool', [], { cwd: dir, logLevel: 'error', app });
    expect(result.output.trim()).toBe('noise');
  });
});
