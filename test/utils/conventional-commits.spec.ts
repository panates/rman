import { expect } from 'expect';
import { isReleaseCommit } from '../../src/utils/conventional-commits.js';

describe('utils/conventional-commits', () => {
  describe('isReleaseCommit()', () => {
    it('matches the bare-version form other release tools commit', () => {
      expect(isReleaseCommit('6.0.1')).toBe(true);
      expect(isReleaseCommit('v2.3.0-beta.1')).toBe(true);
    });

    it("matches version's own built-in default commit message", () => {
      expect(isReleaseCommit('chore(release): v1.2.0')).toBe(true);
      expect(isReleaseCommit('chore(release): v1.2.0-rc.1')).toBe(true);
    });

    it('matches the multi-version form used when one commit spans several versions', () => {
      expect(isReleaseCommit('chore(release): pkg-a@1.2.0, @scope/pkg-b@2.0.0')).toBe(true);
    });

    it("matches the monorepo root's own version-sync commit", () => {
      expect(isReleaseCommit('chore: sync root version to 1.2.0')).toBe(true);
    });

    it('matches a repo\'s own .rmanrc "version.commitMessage" template', () => {
      expect(isReleaseCommit('release: v1.2.0', 'release: v{version}')).toBe(true);
      expect(isReleaseCommit('chore(release): v1.2.0', 'release: v{version}')).toBe(true); // built-ins still count
    });

    it('treats regex-special characters in a template as literals', () => {
      expect(isReleaseCommit('[release] 1.2.0 (auto)', '[release] {version} (auto)')).toBe(true);
      expect(isReleaseCommit('Xrelease] 1.2.0 (auto)', '[release] {version} (auto)')).toBe(false);
    });

    it('leaves real changes alone', () => {
      expect(isReleaseCommit('feat: add a thing')).toBe(false);
      expect(isReleaseCommit('fix: release notes typo')).toBe(false);
      expect(isReleaseCommit('chore: bump dependencies')).toBe(false);
      expect(isReleaseCommit('docs: describe 1.2.0')).toBe(false);
    });
  });
});
