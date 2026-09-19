import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { Logger, resolveRootLogLevel } from '../../src/utils/logger.js';
import { createRepository, useTestEcosystem } from '../_fixture.js';

/** Runs `fn` with console.log captured (plain-text lines) instead of printed. */
function captureLogs(fn: () => void): string[] {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

describe('utils/Logger', () => {
  useTestEcosystem();

  describe('info()', () => {
    it('prints at "info" and "verbose"', () => {
      expect(captureLogs(() => new Logger('info').info('hi'))).toEqual(['hi']);
      expect(captureLogs(() => new Logger('verbose').info('hi'))).toEqual(['hi']);
    });

    it('is silenced at "error" and "silent"', () => {
      expect(captureLogs(() => new Logger('error').info('hi'))).toEqual([]);
      expect(captureLogs(() => new Logger('silent').info('hi'))).toEqual([]);
    });
  });

  describe('verbose()', () => {
    it('prints only at "verbose"', () => {
      expect(captureLogs(() => new Logger('verbose').verbose('hi'))).toEqual(['hi']);
      expect(captureLogs(() => new Logger('info').verbose('hi'))).toEqual([]);
      expect(captureLogs(() => new Logger('error').verbose('hi'))).toEqual([]);
      expect(captureLogs(() => new Logger('silent').verbose('hi'))).toEqual([]);
    });
  });

  describe('error()', () => {
    it('prints at every level except "silent"', () => {
      expect(captureLogs(() => new Logger('verbose').error('hi'))).toEqual(['hi']);
      expect(captureLogs(() => new Logger('info').error('hi'))).toEqual(['hi']);
      expect(captureLogs(() => new Logger('error').error('hi'))).toEqual(['hi']);
    });

    it('is silenced only at "silent"', () => {
      expect(captureLogs(() => new Logger('silent').error('hi'))).toEqual([]);
    });
  });
});

describe('utils/resolveRootLogLevel', () => {
  useTestEcosystem();

  const dirs: string[] = [];
  function tmp(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-logger-test-'));
    dirs.push(d);
    return d;
  }
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function writeJson(dir: string, rel: string, data: unknown) {
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
  }

  it('defaults to "info" when .rmanrc has no logLevel', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true });
    const repo = await createRepository(dir);
    expect(resolveRootLogLevel(repo)).toBe('info');
  });

  it('reads the root .rmanrc "logLevel"', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true });
    writeJson(dir, '.rmanrc', { logLevel: 'silent' });
    const repo = await createRepository(dir);
    expect(resolveRootLogLevel(repo)).toBe('silent');
  });

  it('falls back to "info" for an invalid value, instead of failing', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true });
    writeJson(dir, '.rmanrc', { logLevel: 'chatty' });
    const repo = await createRepository(dir);
    expect(resolveRootLogLevel(repo)).toBe('info');
  });
});
