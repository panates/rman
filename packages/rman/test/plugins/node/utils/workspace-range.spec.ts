import { expect } from 'expect';
import { parseWorkspaceRange, resolveWorkspaceRange } from '../../../../src/plugins/node/utils/workspace-range.js';

describe('utils/workspace-range', () => {
  describe('parseWorkspaceRange()', () => {
    it('returns undefined for a plain semver range', () => {
      expect(parseWorkspaceRange('^1.0.0')).toBeUndefined();
    });

    it('returns undefined for a non-string value', () => {
      expect(parseWorkspaceRange(undefined)).toBeUndefined();
      expect(parseWorkspaceRange(123)).toBeUndefined();
    });

    it('parses a bare "*" selector', () => {
      expect(parseWorkspaceRange('workspace:*')).toEqual({ selector: '*' });
    });

    it('parses bare "^"/"~" selectors', () => {
      expect(parseWorkspaceRange('workspace:^')).toEqual({ selector: '^' });
      expect(parseWorkspaceRange('workspace:~')).toEqual({ selector: '~' });
    });

    it('parses an explicit version/range after the protocol prefix', () => {
      expect(parseWorkspaceRange('workspace:^1.0.0')).toEqual({ selector: 'explicit', range: '^1.0.0' });
      expect(parseWorkspaceRange('workspace:1.0.0')).toEqual({ selector: 'explicit', range: '1.0.0' });
    });
  });

  describe('resolveWorkspaceRange()', () => {
    it('"*" resolves to the exact version, with no operator', () => {
      expect(resolveWorkspaceRange({ selector: '*' }, '1.2.3')).toBe('1.2.3');
    });

    it('"^" and "~" prepend themselves to the version', () => {
      expect(resolveWorkspaceRange({ selector: '^' }, '1.2.3')).toBe('^1.2.3');
      expect(resolveWorkspaceRange({ selector: '~' }, '1.2.3')).toBe('~1.2.3');
    });

    it('an explicit range is used verbatim, ignoring `version`', () => {
      expect(resolveWorkspaceRange({ selector: 'explicit', range: '>=1.0.0 <2.0.0' }, '9.9.9')).toBe('>=1.0.0 <2.0.0');
    });
  });
});
