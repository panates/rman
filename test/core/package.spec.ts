import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import expect from 'expect';
import { Package } from '../../src/core/package.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-package-test-'));
}

describe('core/Package', () => {
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

  it('throws if package.json does not exist', () => {
    const d = mkTmp();
    dirs.push(d);
    expect(() => new Package(d)).toThrow(/Package\.json not found/);
  });

  it('exposes name, version, basename, json, jsonFileName from package.json', () => {
    const dir = tmp({ name: '@scope/foo', version: '1.2.3' });
    const pkg = new Package(dir);
    expect(pkg.name).toBe('@scope/foo');
    expect(pkg.version).toBe('1.2.3');
    expect(pkg.basename).toBe(path.basename(dir));
    expect(pkg.json).toEqual({ name: '@scope/foo', version: '1.2.3' });
    expect(pkg.jsonFileName).toBe(path.join(dir, 'package.json'));
  });

  it('isPrivate reflects the "private" field, defaulting to false', () => {
    expect(new Package(tmp({ name: 'a', version: '1.0.0' })).isPrivate).toBe(false);
    expect(new Package(tmp({ name: 'a', version: '1.0.0', private: true })).isPrivate).toBe(true);
  });

  it('starts with an empty config and no dependencies', () => {
    const pkg = new Package(tmp({ name: 'a', version: '1.0.0' }));
    expect(pkg.config).toEqual({});
    expect(pkg.dependencies).toEqual([]);
  });

  it('reloadJson() picks up external changes to package.json', () => {
    const dir = tmp({ name: 'a', version: '1.0.0' });
    const pkg = new Package(dir);
    expect(pkg.version).toBe('1.0.0');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'a', version: '2.0.0' }));
    expect(pkg.version).toBe('1.0.0'); // unchanged until reloadJson() is called
    pkg.reloadJson();
    expect(pkg.version).toBe('2.0.0');
  });

  it('writeJson() persists the current json object to disk', () => {
    const dir = tmp({ name: 'a', version: '1.0.0' });
    const pkg = new Package(dir);
    pkg.json.version = '3.0.0';
    pkg.writeJson();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    expect(onDisk.version).toBe('3.0.0');
  });
});
