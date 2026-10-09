import { expect } from 'expect';
import { dirtyReason, filesUnder } from '../../src/utils/git.js';

describe('utils/git dirtyReason', () => {
  it('names up to three files, relative to the root, and counts the rest', () => {
    expect(dirtyReason(['/r/a.txt'], '/r')).toBe('uncommitted local changes: a.txt');
    expect(dirtyReason(['/r/a', '/r/b', '/r/c', '/r/d', '/r/e'], '/r')).toBe(
      'uncommitted local changes: a, b, c (+2 more)',
    );
    expect(dirtyReason(['pkg/x'], '/r')).toBe('uncommitted local changes: pkg/x');
    expect(dirtyReason([], '/r')).toBe('uncommitted local changes');
  });

  it('keeps the files under a directory, and not a sibling sharing its prefix', () => {
    expect(filesUnder(['/r/pkg/a', '/r/pkg-b/a', '/r/other'], '/r/pkg')).toEqual(['/r/pkg/a']);
  });
});
