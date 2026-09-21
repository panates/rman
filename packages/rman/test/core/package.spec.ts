import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { Package } from '../../src/core/package.js';
import { createApp, useTestEcosystem } from '../_fixture.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-package-test-'));
}

/**
 * `Package` no longer knows what a `package.json` is - `manifest`/`manifestFileName`/`provider`
 * come from whichever `Plugin`'s manifest members claimed the directory, and the fixture's is the one
 * registered here. The specs that used to assert `pkg.json`/`reloadJson`/`writeJson` assert the
 * manifest equivalents; the one that used to expect a *throw* for a missing file asserts the
 * fallback instead, which is the deliberate change: `rman info` has to work in a repository whose
 * `.rmanrc` names no plugin yet.
 */

describe('core/Package', () => {
  useTestEcosystem();

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function tmp(json: unknown): string {
    const d = mkTmp();
    dirs.push(d);
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify(json));
    return d;
  }

  it('falls back to the directory name at 0.0.0 when no provider recognizes the directory', () => {
    const d = mkTmp();
    dirs.push(d);
    const pkg = new Package(d, createApp());
    expect(pkg.name).toBe(path.basename(d));
    expect(pkg.version).toBe('0.0.0');
    /** Nothing was read, so there is no file to name and no ecosystem to report. */
    expect(pkg.manifestFileName).toBe('');
    expect(pkg.provider).toBe('');
  });

  it('exposes name, version, basename, manifest and manifestFileName through the provider', () => {
    const dir = tmp({ name: '@scope/foo', version: '1.2.3' });
    const pkg = new Package(dir, createApp());
    expect(pkg.name).toBe('@scope/foo');
    expect(pkg.version).toBe('1.2.3');
    expect(pkg.basename).toBe(path.basename(dir));
    expect(pkg.manifest.raw).toEqual({ name: '@scope/foo', version: '1.2.3' });
    expect(pkg.manifestFileName).toBe(path.join(dir, 'package.json'));
  });

  it('reports which ecosystem claimed it', () => {
    const pkg = new Package(tmp({ name: 'a', version: '1.0.0' }), createApp());
    expect(pkg.provider).toBe('test');
  });

  it('numbers versions with the scheme the provider brought, semver by default', () => {
    const pkg = new Package(tmp({ name: 'a', version: '1.2.3' }), createApp());
    expect(pkg.versionScheme.name).toBe('semver');
    expect(pkg.versionScheme.next('1.2.3', 'minor')).toBe('1.3.0');
  });

  it('isPrivate reflects the manifest\'s "private" flag, defaulting to false', () => {
    expect(new Package(tmp({ name: 'a', version: '1.0.0' }), createApp()).isPrivate).toBe(false);
    expect(new Package(tmp({ name: 'a', version: '1.0.0', private: true }), createApp()).isPrivate).toBe(true);
  });

  it('starts with an empty config and no dependencies', () => {
    const pkg = new Package(tmp({ name: 'a', version: '1.0.0' }), createApp());
    expect(pkg.config).toEqual({});
    expect(pkg.dependencies.map(d => d.name)).toEqual([]);
  });

  it('reloadManifest() picks up external changes to the manifest file', () => {
    const dir = tmp({ name: 'a', version: '1.0.0' });
    const pkg = new Package(dir, createApp());
    expect(pkg.version).toBe('1.0.0');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'a', version: '2.0.0' }));
    expect(pkg.version).toBe('1.0.0'); // unchanged until reloadManifest() is called
    pkg.reloadManifest();
    expect(pkg.version).toBe('2.0.0');
  });

  it('writeManifest() persists the current version through the provider', () => {
    const dir = tmp({ name: 'a', version: '1.0.0' });
    const pkg = new Package(dir, createApp());
    pkg.manifest.version = '3.0.0';
    pkg.writeManifest();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    expect(onDisk.version).toBe('3.0.0');
    /** The provider owns serialization, so the rest of the document survives the round trip. */
    expect(onDisk.name).toBe('a');
  });
});
