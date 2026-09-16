import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import expect from 'expect';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'schemas/rmanrc.schema.json'), 'utf-8'));
const interfaceSource = fs.readFileSync(path.join(root, 'src/interfaces/rman-config.interface.ts'), 'utf-8');

/**
 * The `RmanConfig` interface and the JSON Schema describe the same thing twice, for two different
 * audiences - the compiler and the editor - and nothing but this keeps them saying the same thing.
 * A key added to one and forgotten in the other is silent: config that rman honors gets underlined
 * as an error, or a typo the schema would have caught sails through.
 *
 * So the interface is read as text and its key names compared. Unusual, but it is the only place
 * those names exist at test time (a TypeScript interface leaves nothing behind at runtime), it
 * needs no dependency, and it fails loudly rather than quietly: a formatting change the regex can't
 * follow empties the key set, and an empty set matches nothing.
 */
function interfaceKeys(block: string): string[] {
  const body = interfaceSource.slice(interfaceSource.indexOf(block) + block.length);
  /** Whichever closing brace comes *first*: a nested interface ends at `\n  }`, `RmanConfig` itself
   *  at `\n}`. Preferring one over the other ran `RmanConfig`'s slice straight through its own end
   *  and into the next interface's keys. */
  const ends = ['\n  }', '\n}'].map(m => body.indexOf(m)).filter(i => i !== -1);
  const end = Math.min(...ends);
  return [...body.slice(0, end).matchAll(/^\s{2,4}([A-Za-z_]\w*)\??\s*:/gm)].map(m => m[1]);
}

/** Resolves one `$ref` hop, so a `{ "$ref": "#/definitions/x" }` slot is compared by what it points at. */
function propertiesOf(node: any): Record<string, unknown> {
  const target = node?.$ref ? schema.definitions[node.$ref.replace('#/definitions/', '')] : node;
  return target?.properties ?? {};
}

describe('schemas/rmanrc.schema.json', () => {
  const cases: [string, string, Record<string, unknown>][] = [
    ['RmanConfig', 'export interface RmanConfigKeys {', schema.properties],
    ['version', 'export interface VersionOptionsKeys {', propertiesOf(schema.properties.version)],
    ['changelog', 'export interface ChangelogOptionsKeys {', propertiesOf(schema.properties.changelog)],
    ['clean', 'export interface CleanOptionsKeys {', propertiesOf(schema.properties.clean)],
    ['publish', 'export interface PublishOptionsKeys {', propertiesOf(schema.properties.publish)],
    [
      'publish.docker',
      'export interface DockerPublishOptionsKeys {',
      propertiesOf(schema.definitions.dockerPublishConfig),
    ],
    [
      'githubRelease',
      'export interface GithubReleaseOptionsKeys {',
      propertiesOf(schema.definitions.githubReleaseConfig),
    ],
    ['run.<script>', 'export interface RunScriptOptionsKeys {', propertiesOf(schema.definitions.runScriptConfig)],
  ];

  for (const [label, block, schemaProps] of cases) {
    it(`describes exactly the keys \`${label}\` declares`, () => {
      const declared = interfaceKeys(block).sort();
      expect(declared.length).toBeGreaterThan(0); // a regex that stopped matching must not pass
      /** The interfaces compared here are the `*Keys` ones - the plain settings, before
       *  `WithAppend` adds a `+key` for each. Two schema keys have no place among them: `$schema`
       *  is editor tooling rman never reads, and `extends` lives on `RmanConfig` itself, being
       *  about inheritance rather than a setting. */
      const extras = ['$schema', 'extends'];
      expect(
        Object.keys(schemaProps)
          .filter(k => !extras.includes(k))
          .sort(),
      ).toEqual(declared);
    });
  }

  it('rejects an unknown key at every level, so a typo surfaces instead of being ignored', () => {
    // The root used to be the one permissive level, which let `packages.<name>` keep validating
    // long after rman stopped reading it - and every top-level typo with it.
    expect(schema.additionalProperties).toBe(false);

    // Collected rather than asserted one at a time: a failure then names the offenders instead of
    // stopping at whichever happened to come first.
    const permissive = [
      ...Object.entries<any>(schema.definitions).map(([n, v]) => [`definitions.${n}`, v] as const),
      ...Object.entries<any>(schema.properties).map(([n, v]) => [`properties.${n}`, v] as const),
    ]
      .filter(([, v]) => v.type === 'object' && v.properties && v.additionalProperties !== false)
      .map(([name]) => name);
    expect(permissive).toEqual([]);
  });

  it('routes a `"[selector]"` key back through the whole schema, so its contents are checked too', () => {
    const pattern = '^\\[.+\\]$';
    expect(Object.keys(schema.patternProperties ?? {})).toContain(pattern);
    expect(schema.patternProperties[pattern].$ref).toBe('#');
    // And a real selector matches it while a plain config key does not.
    const re = new RegExp(pattern);
    expect(re.test('[*]')).toBe(true);
    expect(re.test('[*-dialect]')).toBe(true);
    expect(re.test('publish')).toBe(false);
  });

  it('allows `+key` beside the declared keys of every closed object', () => {
    // `additionalProperties: false` is what makes a typo surface, so every object that has it also
    // needs the append pattern - or `+before` reads as a typo itself. Collected, so a failure names
    // the objects that were missed.
    const missing: string[] = [];
    const visit = (node: any, label: string) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'object' && node.properties && node.additionalProperties === false) {
        if (!node.patternProperties?.['^\\+.+$']) missing.push(label);
      }
      for (const [key, value] of Object.entries<any>(node)) visit(value, `${label}.${key}`);
    };
    for (const [name, def] of Object.entries<any>(schema.definitions)) visit(def, `definitions.${name}`);
    for (const [name, prop] of Object.entries<any>(schema.properties)) visit(prop, `properties.${name}`);
    expect(missing).toEqual([]);
    // And at the root, beside the selector pattern.
    expect(Object.keys(schema.patternProperties)).toContain('^\\+.+$');
  });

  it('accepts a bare string for `run.<script>`, the shorthand for `exec`', () => {
    const variants = (schema.properties.run.additionalProperties.oneOf as any[]).map(v => v.$ref);
    expect(variants).toContain('#/definitions/stringOrStringArray');
    expect(variants).toContain('#/definitions/runScriptConfig');
  });

  it('keeps `publish.target` to the registries, never the GitHub Release', () => {
    // "github" as a target value reads as GitHub Packages; the repository's release is not a place
    // a package ships to - see the `github-release` command.
    expect(schema.definitions.publishTarget.enum).toEqual(['npm', 'docker']);
  });
});
