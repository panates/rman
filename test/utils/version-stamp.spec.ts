import { expect } from 'expect';
import { stampVersionConstant, stampVersionLabel } from '../../src/utils/version-stamp.js';

describe('utils/version-stamp', () => {
  describe('stampVersionLabel()', () => {
    it('rewrites the label to the given version', () => {
      const out = stampVersionLabel('FROM node:22\nLABEL org.opencontainers.image.version="0.0.4"\n', '1.2.0');
      expect(out).toBe('FROM node:22\nLABEL org.opencontainers.image.version="1.2.0"\n');
    });

    it('leaves every other line of the file exactly as it was', () => {
      const before = [
        'FROM node:22',
        'LABEL org.opencontainers.image.title="Formwave API Server"',
        'LABEL org.opencontainers.image.version="0.0.4"',
        'LABEL org.opencontainers.image.vendor="Panates Inc"',
        'CMD ["node", "index.js"]',
      ].join('\n');
      expect(stampVersionLabel(before, '1.2.0')).toBe(before.replace('0.0.4', '1.2.0'));
    });

    it('preserves the quoting style rather than normalizing it', () => {
      // The point is a one-token diff; re-quoting would show up as a change in every release.
      expect(stampVersionLabel("LABEL org.opencontainers.image.version='0.0.4'", '1.2.0')).toBe(
        "LABEL org.opencontainers.image.version='1.2.0'",
      );
      expect(stampVersionLabel('LABEL org.opencontainers.image.version=0.0.4', '1.2.0')).toBe(
        'LABEL org.opencontainers.image.version=1.2.0',
      );
    });

    it('handles a label sharing its line with others, and one split across continuations', () => {
      expect(stampVersionLabel('LABEL maintainer="x" org.opencontainers.image.version="0.0.4" foo=bar', '1.2.0')).toBe(
        'LABEL maintainer="x" org.opencontainers.image.version="1.2.0" foo=bar',
      );

      const multiline = [
        'LABEL maintainer="x" \\',
        '      org.opencontainers.image.version="0.0.4" \\',
        '      foo=bar',
      ].join('\n');
      expect(stampVersionLabel(multiline, '1.2.0')).toBe(multiline.replace('0.0.4', '1.2.0'));
    });

    it('returns undefined when the label already holds this version - nothing to write', () => {
      expect(stampVersionLabel('LABEL org.opencontainers.image.version="1.2.0"', '1.2.0')).toBeUndefined();
    });

    it('never inserts a label the Dockerfile does not declare', () => {
      // Which labels an image carries is the author's decision; only keeping a declared one
      // truthful is ours.
      expect(stampVersionLabel('FROM node:22\nCMD ["node", "index.js"]\n', '1.2.0')).toBeUndefined();
    });

    it('ignores the same key outside a LABEL instruction', () => {
      const before = [
        '# LABEL org.opencontainers.image.version="0.0.4" (disabled for now)',
        'ENV org.opencontainers.image.version=0.0.4',
        'RUN echo org.opencontainers.image.version=0.0.4',
      ].join('\n');
      expect(stampVersionLabel(before, '1.2.0')).toBeUndefined();
    });

    it('stops rewriting once a multi-line LABEL ends', () => {
      const before = ['LABEL foo=bar \\', '      baz=qux', 'ENV org.opencontainers.image.version=0.0.4'].join('\n');
      expect(stampVersionLabel(before, '1.2.0')).toBeUndefined();
    });
  });

  describe('stampVersionConstant()', () => {
    it('rewrites the string assigned to a version constant', () => {
      expect(stampVersionConstant("export const version = '1';\n", '6.0.10')).toBe(
        "export const version = '6.0.10';\n",
      );
    });

    it('matches an object property too, and keeps the quoting style', () => {
      expect(stampVersionConstant('{ name: "app", version: "1" }', '6.0.10')).toBe(
        '{ name: "app", version: "6.0.10" }',
      );
      expect(stampVersionConstant('export const version = `1`;', '6.0.10')).toBe('export const version = `6.0.10`;');
    });

    it('leaves the rest of the file untouched', () => {
      const before = ["import x from 'y';", "export const version = '1';", 'export const other = 42;'].join('\n');
      expect(stampVersionConstant(before, '6.0.10')).toBe(before.replace("'1'", "'6.0.10'"));
    });

    it('returns undefined when there is nothing to change', () => {
      expect(stampVersionConstant("export const version = '6.0.10';", '6.0.10')).toBeUndefined();
      expect(stampVersionConstant('export const other = 42;', '6.0.10')).toBeUndefined();
    });

    it('only matches the whole identifier, never the tail of a longer one', () => {
      // Someone else's constant that merely ends in the same letters.
      expect(stampVersionConstant("export const myversion = '1';", '6.0.10')).toBeUndefined();
      expect(stampVersionConstant("export const version2 = '1';", '6.0.10')).toBeUndefined();
    });

    it('accepts a different constant name', () => {
      expect(stampVersionConstant("export const appVersion = '1';", '6.0.10', 'appVersion')).toBe(
        "export const appVersion = '6.0.10';",
      );
    });
  });
});
