import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runCli, useNodeEcosystem } from '../_fixture.js';

async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

/**
 * `rman info` is a **core** command, and it reports a package manager only because this plugin
 * augmented `SystemInfo` to ask about one. These two cases live here rather than in rman's own
 * specs for that reason: a core repository naming no plugin reports no npm binaries at all, which
 * is the point - "npm: Not Found" in a Cargo repository is a wrong answer, not a missing feature.
 *
 * The unit-level behaviour (what reaches envinfo, and the fallback for an unknown value) is covered
 * by `augmentation/system-info.augmentation.spec.ts`. This is the seam actually reaching a command.
 */
describe('commands/info - the package-manager augmentation reaching a core command', () => {
  useNodeEcosystem();

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function fixture(manifest: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-node-info-test-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
    return dir;
  }

  it('reports npm\'s own Binaries key by default (no .rmanrc "packageManager" set)', async () => {
    const dir = fixture({ name: 'my-pkg', version: '1.0.0' });
    const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['info', '--json'] }));
    const parsed = JSON.parse(lines[0]);
    expect(Object.keys(parsed.Binaries)).toContain('npm');
    expect(Object.keys(parsed.Binaries)).not.toContain('pnpm');
  });

  it("reports the configured package manager's own Binaries key instead of npm's", async () => {
    const dir = fixture({ name: 'my-pkg', version: '1.0.0', rman: { packageManager: 'pnpm' } });
    const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['info', '--json'] }));
    const parsed = JSON.parse(lines[0]);
    expect(Object.keys(parsed.Binaries)).toContain('pnpm');
    expect(Object.keys(parsed.Binaries)).not.toContain('npm');
  });
});
