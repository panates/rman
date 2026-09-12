import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import expect from 'expect';
import { npmRunPath, npmRunPathEnv } from '../../src/utils/npm-run-path.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-runpath-test-'));
}

describe('utils/npm-run-path', () => {
  describe('npmRunPath()', () => {
    it('prepends node_modules/.bin for cwd and every ancestor up to the filesystem root', () => {
      const root = mkTmp();
      const nested = path.join(root, 'a', 'b');
      fs.mkdirSync(nested, { recursive: true });

      const result = npmRunPath({ cwd: nested, path: '' });
      const entries = result.split(path.delimiter);

      expect(entries).toContain(path.join(nested, 'node_modules/.bin'));
      expect(entries).toContain(path.join(root, 'a', 'node_modules/.bin'));
      expect(entries).toContain(path.join(root, 'node_modules/.bin'));

      fs.rmSync(root, { recursive: true, force: true });
    });

    it('lists the nearer directories before farther ones', () => {
      const root = mkTmp();
      const nested = path.join(root, 'a', 'b');
      fs.mkdirSync(nested, { recursive: true });

      const entries = npmRunPath({ cwd: nested, path: '' }).split(path.delimiter);
      const nestedIdx = entries.indexOf(path.join(nested, 'node_modules/.bin'));
      const rootIdx = entries.indexOf(path.join(root, 'node_modules/.bin'));
      expect(nestedIdx).toBeGreaterThanOrEqual(0);
      expect(rootIdx).toBeGreaterThan(nestedIdx);

      fs.rmSync(root, { recursive: true, force: true });
    });

    it('appends the given PATH at the end, and omits it entirely when set to an empty string', () => {
      const dir = mkTmp();
      const withPath = npmRunPath({ cwd: dir, path: '/custom/bin' });
      expect(withPath.endsWith('/custom/bin')).toBe(true);

      const withoutPath = npmRunPath({ cwd: dir, path: '' });
      expect(withoutPath.endsWith(path.delimiter)).toBe(false);
      expect(withoutPath.includes('/custom/bin')).toBe(false);

      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('includes the directory of the current Node executable', () => {
      const dir = mkTmp();
      const entries = npmRunPath({ cwd: dir, path: '' }).split(path.delimiter);
      expect(entries).toContain(path.dirname(process.execPath));
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('npmRunPathEnv()', () => {
    it('returns an env object with PATH augmented, leaving other variables untouched', () => {
      const dir = mkTmp();
      const env = npmRunPathEnv({ cwd: dir, env: { PATH: '/usr/bin', FOO: 'bar' } });
      expect(env.FOO).toBe('bar');
      expect(env.PATH).toContain(path.join(dir, 'node_modules/.bin'));
      expect(env.PATH).toContain('/usr/bin');
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
