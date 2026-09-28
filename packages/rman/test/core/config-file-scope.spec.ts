import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { ConfigFileScope } from '../../src/core/config/config-file-scope.js';

/** **Self-contained: a directory and nothing else.** `ConfigFileScope` answers about the disk, so a
 *  spec gives it a disk and no repository, application or config. */
describe('core/ConfigFileScope', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-file-scope-'));
    dirs.push(d);
    return d;
  }
  function write(dir: string, name: string, contents: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, contents);
    return file;
  }

  describe('file: where something is', () => {
    /**
     * **Pinned, not merely documented.** `file` is evaluated while the config *resolves*, which
     * every command does - so a member that changed anything would change it on `rman list`,
     * `rman info` and `rman config`, once per package, with nothing having asked. A comment saying
     * so can be contradicted by the next person adding a plausible-sounding `copy`; this fails.
     *
     * It has been tried, in the only way a function that does not exist can be: a shared config
     * reaching for `file.copyMany(...)` made **every** rman command exit 1. Work belongs in a step,
     * which is the one thing rman runs on purpose - and a step can be a function too, so refusing
     * this costs nothing.
     */
    it('exposes exactly three members, all of them questions', () => {
      expect(Object.keys(new ConfigFileScope().fileScope(tmp())).sort()).toEqual(['exists', 'resolve', 'resolveFirst']);
    });

    it('leaves the directory untouched - nothing here creates, copies or writes', () => {
      const dir = tmp();
      write(dir, 'present.txt', 'x');
      const before = fs.readdirSync(dir).sort();

      const scope = new ConfigFileScope().fileScope(dir);
      expect(scope.exists('present.txt')).toBe(path.join(dir, 'present.txt'));
      expect(scope.exists('missing.txt')).toBe('');
      expect(scope.resolve('present.txt')).toBe(path.join(dir, 'present.txt'));
      expect(() => scope.resolve('missing.txt')).toThrow();
      expect(scope.resolveFirst('missing.txt', 'present.txt')).toBe(path.join(dir, 'present.txt'));
      expect(() => scope.resolveFirst('missing.txt', 'gone.txt')).toThrow();

      expect(fs.readdirSync(dir).sort()).toEqual(before);
    });

    it('resolves a relative path against the directory it was built for', () => {
      const dir = tmp();
      write(dir, 'tsconfig.json', '{}');
      expect(new ConfigFileScope().fileScope(dir).exists('tsconfig.json')).toBe(path.join(dir, 'tsconfig.json'));
    });

    /** `''` rather than `undefined`, so `a || b || c` picks the first present and a miss never
     *  reaches the "nullish inside a string" guard. */
    it('answers "" for a file that is not there', () => {
      expect(new ConfigFileScope().fileScope(tmp()).exists('nope.json')).toBe('');
    });

    it('builds a separate scope per directory', () => {
      const a = tmp();
      const b = tmp();
      write(a, 'only-in-a.json', '{}');
      const scope = new ConfigFileScope();
      expect(scope.fileScope(a).exists('only-in-a.json')).not.toBe('');
      expect(scope.fileScope(b).exists('only-in-a.json')).toBe('');
    });

    it('throws from resolve(), naming where it looked and what to use instead', () => {
      const dir = tmp();
      expect(() => new ConfigFileScope().fileScope(dir).resolve('nope.json')).toThrow(
        /found nothing at .*nope\.json[\s\S]*file\.exists\(\)/,
      );
    });

    it('takes the first resolveFirst() candidate that exists', () => {
      const dir = tmp();
      write(dir, 'tsconfig.json', '{}');
      const file = new ConfigFileScope().fileScope(dir);
      expect(file.resolveFirst('tsconfig-build.json', 'tsconfig.json')).toBe(path.join(dir, 'tsconfig.json'));
    });

    /**
     * **The reason `resolveFirst` exists rather than an `exists() || exists()` chain.** Such a
     * chain ending in `exists()` leaves `tsc -b ` with no argument when nothing matches, and tsc
     * then falls back to the directory's default rather than reporting that the package has none.
     */
    it('throws from resolveFirst(), naming every candidate', () => {
      const dir = tmp();
      expect(() => new ConfigFileScope().fileScope(dir).resolveFirst('a.json', 'b.json')).toThrow(
        /found none of: "a\.json", "b\.json"/,
      );
    });

    it('refuses a path that is not a usable string', () => {
      const file = new ConfigFileScope().fileScope(tmp());
      expect(() => file.exists('  ')).toThrow(/need a path/);
      expect(() => file.exists(undefined as never)).toThrow(/need a path/);
      expect(() => file.resolveFirst()).toThrow(/at least one path/);
    });
  });

  describe('read: what is in it', () => {
    it('parses each format the name says', () => {
      const dir = tmp();
      write(dir, 'a.json', '{"x":1}');
      write(dir, 'b.yml', 'x: 2\n');
      write(dir, 'c.ini', 'x=3\n');
      const read = new ConfigFileScope().readScope(dir);
      expect(read('a.json')).toEqual({ x: 1 });
      expect(read('b.yml')).toEqual({ x: 2 });
      expect(read('c.ini')).toEqual({ x: '3' });
    });

    /** A name that says nothing takes the format explicitly - `.npmrc` is the case. */
    it('takes an explicit format for a name that says nothing', () => {
      const dir = tmp();
      write(dir, '.npmrc', 'registry=https://example.test\n');
      expect(new ConfigFileScope().readScope(dir)('.npmrc', 'ini')).toEqual({
        registry: 'https://example.test',
      });
    });

    it('refuses a name it cannot classify, naming the four formats', () => {
      const dir = tmp();
      write(dir, 'mystery.bin', 'x');
      expect(() => new ConfigFileScope().readScope(dir)('mystery.bin')).toThrow(
        /cannot tell what "mystery\.bin" is[\s\S]*"json" \| "yaml" \| "ini" \| "xml"/,
      );
    });

    it('throws for a missing file, pointing at file.exists()', () => {
      expect(() => new ConfigFileScope().readScope(tmp())('nope.json')).toThrow(
        /found nothing at[\s\S]*file\.exists\(\) first/,
      );
    });

    it('throws for a directory', () => {
      const dir = tmp();
      fs.mkdirSync(path.join(dir, 'sub'));
      expect(() => new ConfigFileScope().readScope(dir)('sub')).toThrow(/a directory, not a file/);
    });

    /** The parser's own message says what is wrong with the syntax but never which file it read -
     *  and one expression can name several. */
    it('names the file when a parse fails', () => {
      const dir = tmp();
      write(dir, 'broken.json', '{ not json');
      expect(() => new ConfigFileScope().readScope(dir)('broken.json')).toThrow(
        /read\("broken\.json"\) could not parse .* as json/,
      );
    });

    it('refuses a path that is not a usable string', () => {
      expect(() => new ConfigFileScope().readScope(tmp())('')).toThrow(/read\(\) needs a path/);
    });
  });

  describe('xml is a DOM, not an object', () => {
    it('reads an element by tag name', () => {
      const dir = tmp();
      write(dir, 'pom.xml', '<project><version>1.2.3</version></project>');
      const doc: any = new ConfigFileScope().readScope(dir)('pom.xml');
      expect(doc.getElementsByTagName('version')[0].textContent).toBe('1.2.3');
    });

    /** A project file is XML whatever its extension calls itself. */
    it('recognizes the project-file family by extension', () => {
      const dir = tmp();
      write(dir, 'app.csproj', '<Project><Version>2.0.0</Version></Project>');
      const doc: any = new ConfigFileScope().readScope(dir)('app.csproj');
      expect(doc.getElementsByTagName('Version')[0].textContent).toBe('2.0.0');
    });

    /**
     * **A malformed file must throw.** xmldom reports problems through a handler and otherwise
     * carries on with whatever it salvaged, so without the check a truncated file came back as a
     * half-parsed DOM and the expression reading it simply found nothing.
     */
    it('throws on a malformed document rather than returning half of one', () => {
      const dir = tmp();
      write(dir, 'bad.xml', '<project><version>1.2.3</project>');
      expect(() => new ConfigFileScope().readScope(dir)('bad.xml')).toThrow(/could not parse .* as xml/);
    });

    /** Measured rather than assumed: a frozen xmldom document still answers for a tag first asked
     *  about *after* the freeze - the live-collection case that would have broken it. */
    it('stays usable after being frozen', () => {
      const dir = tmp();
      write(dir, 'pom.xml', '<project><version>1.2.3</version><name>x</name></project>');
      const doc: any = new ConfigFileScope().readScope(dir)('pom.xml');
      expect(Object.isFrozen(doc)).toBe(true);
      // `name` is asked about for the first time here, after the freeze.
      expect(doc.getElementsByTagName('name')[0].textContent).toBe('x');
    });
  });

  describe('the parse cache', () => {
    /** `interpolateConfig` runs once per package, so a cache living in one pass never helps across
     *  them - twenty packages reading one shared file would parse it twenty times. */
    it('parses one file once however many directories read it', () => {
      const root = tmp();
      const shared = write(root, 'shared.json', '{"x":1}');
      const scope = new (class extends ConfigFileScope {
        parses = 0;
        protected override parse(text: string, format: ConfigFileScope.FileFormat): unknown {
          this.parses++;
          return super.parse(text, format);
        }
      })();
      scope.readScope(root)('shared.json');
      scope.readScope(path.dirname(shared))('shared.json');
      scope.readScope(root)('./shared.json');
      expect(scope.parses).toBe(1);
    });

    /**
     * **Keyed on `mtimeNs:size`, not on the path** - rman writes files while it runs. `version`
     * rewrites every bumped manifest and then re-interpolates its deferred hooks, and a path-keyed
     * cache would hand those back as they were before the write.
     */
    it('re-reads a file that changed under it', () => {
      const dir = tmp();
      const file = write(dir, 'pkg.json', '{"version":"1.0.0"}');
      const read = new ConfigFileScope().readScope(dir);
      expect(read('pkg.json')).toEqual({ version: '1.0.0' });

      fs.writeFileSync(file, '{"version":"1.1.0"}');
      // The size differs here; `mtimeNs` is nanoseconds, so a same-size rewrite is caught too.
      expect(read('pkg.json')).toEqual({ version: '1.1.0' });
    });

    /** Every package gets the same object, so a mutation would quietly change what the next one
     *  sees - which is why it is frozen rather than copied. */
    it('hands back a deeply frozen value, shared between readers', () => {
      const dir = tmp();
      write(dir, 'a.json', '{"nested":{"x":1}}');
      const scope = new ConfigFileScope();
      const first: any = scope.readScope(dir)('a.json');
      const second: any = scope.readScope(dir)('a.json');
      expect(first).toBe(second);
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.nested)).toBe(true);
    });

    it('takes a cache from the caller, so several instances can share one', () => {
      const dir = tmp();
      write(dir, 'a.json', '{"x":1}');
      const cache = new Map<string, ConfigFileScope.CachedFile>();
      const first: any = new ConfigFileScope(cache).readScope(dir)('a.json');
      const second: any = new ConfigFileScope(cache).readScope(dir)('a.json');
      expect(first).toBe(second);
    });
  });

  describe('the steps are seams', () => {
    it('a subclass can add a format', () => {
      const dir = tmp();
      write(dir, 'data.csv', 'a,b');
      class WithCsv extends ConfigFileScope {
        protected override formatOf(file: string): ConfigFileScope.FileFormat {
          return file.endsWith('.csv') ? ('csv' as ConfigFileScope.FileFormat) : super.formatOf(file);
        }
        protected override parse(text: string, format: ConfigFileScope.FileFormat): unknown {
          return (format as string) === 'csv' ? text.split(',') : super.parse(text, format);
        }
      }
      expect(new WithCsv().readScope(dir)('data.csv')).toEqual(['a', 'b']);
    });
  });
});
