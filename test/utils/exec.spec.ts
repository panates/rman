import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import expect from 'expect';
import { exec } from '../../src/utils/exec.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-exec-test-'));
}

describe('utils/exec', () => {
  it('resolves with exit code 0 for a successful command', async () => {
    const result = await exec('echo hi');
    expect(result.code).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it('captures full stdout on `result.stdout` regardless of onLine', async () => {
    const result = await exec('printf "a\\nb\\n"');
    expect(result.stdout).toBe('a\nb\n');
  });

  it('rejects on a non-zero exit by default (throwOnError: true)', async () => {
    await expect(exec('exit 1')).rejects.toThrow();
  });

  it('with throwOnError: false, resolves with the error and code set instead of throwing', async () => {
    const result = await exec('exit 3', { throwOnError: false });
    expect(result.code).toBe(3);
    expect(result.error).toBeInstanceOf(Error);
  });

  it('respects the cwd option', async () => {
    const dir = mkTmp();
    const result = await exec('pwd');
    expect(result.stdout?.trim()).not.toBe(dir);
    const result2 = await exec('pwd', { cwd: dir });
    // resolve both sides in case of symlinked tmp dirs (e.g. /tmp -> /private/tmp on macOS).
    expect(fs.realpathSync(result2.stdout!.trim())).toBe(fs.realpathSync(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('onLine', () => {
    it('splits stdout into individual lines, none of them empty for clean output', async () => {
      const lines: string[] = [];
      await exec('printf "one\\ntwo\\nthree\\n"', { stdio: 'pipe', onLine: line => lines.push(line) });
      expect(lines).toEqual(['one', 'two', 'three']);
    });

    it('does not emit a spurious empty line at the end of a clean, newline-terminated stream', async () => {
      // Regression test: the flush logic used to synthesize a trailing newline even when the
      // per-stream buffer was already empty, producing one bogus blank onLine call per exec().
      const lines: string[] = [];
      await exec('echo only-line', { stdio: 'pipe', onLine: line => lines.push(line) });
      expect(lines).toEqual(['only-line']);
    });

    it('flushes a final unterminated line that has no trailing newline', async () => {
      const lines: string[] = [];
      await exec('printf "no-newline-at-end"', { stdio: 'pipe', onLine: line => lines.push(line) });
      expect(lines).toEqual(['no-newline-at-end']);
    });

    it('keeps stdout and stderr in separate buffers, never splicing one stream into the other', async () => {
      // Regression test: stdout/stderr used to share one buffer, so an unterminated chunk from
      // one stream could get glued onto a chunk from the other.
      const lines: { line: string; stdio: string }[] = [];
      await exec("node -e \"process.stdout.write('out-line\\n'); process.stderr.write('err-line\\n');\"", {
        stdio: 'pipe',
        onLine: (line, stdio) => lines.push({ line, stdio }),
      });
      expect(lines.filter(l => l.stdio === 'stdout').map(l => l.line)).toEqual(['out-line']);
      expect(lines.filter(l => l.stdio === 'stderr').map(l => l.line)).toEqual(['err-line']);
    });
  });

  describe('stdio: inherit', () => {
    it('still resolves/rejects correctly, even though output is not captured via onLine', async () => {
      // output is redirected to /dev/null - this test only checks resolve/reject behavior,
      // and 'inherit' would otherwise stream "hi" straight to the real test-runner terminal.
      const ok = await exec('echo hi > /dev/null 2>&1', { stdio: 'inherit' });
      expect(ok.code).toBe(0);
      await expect(exec('exit 1', { stdio: 'inherit' })).rejects.toThrow();
    });
  });

  describe('PATH augmentation', () => {
    it('can invoke a locally-installed (node_modules/.bin) binary by its bare name', async () => {
      const dir = mkTmp();
      const binDir = path.join(dir, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      const script = path.join(binDir, 'my-local-tool');
      fs.writeFileSync(script, '#!/usr/bin/env node\nconsole.log("local-tool-ran");\n');
      fs.chmodSync(script, 0o755);

      const result = await exec('my-local-tool', { cwd: dir });
      expect(result.stdout?.trim()).toBe('local-tool-ran');
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
