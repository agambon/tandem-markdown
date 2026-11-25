// The folder index: the linkable files of the workspace, wikilinks resolved against them, and the
// targets a completion offers.

import { describe, expect, it } from 'vitest';
import { FolderIndex } from '../../../src/host/model/folderIndex';

describe('the folder index', () => {
  const files = [
    'Notes/Topic.md',
    'Notes/Deep/Topic.md',
    'Other.md',
    'img/pic.png',
    'archive/img/pic.png',
    'doc.pdf',
    'code/x.ts',
    'node_modules/p/README.md',
  ];

  it('keeps linkable files only, never inside node_modules or .git', () => {
    const index = new FolderIndex(files);
    expect(index.paths().sort()).toEqual([
      'Notes/Deep/Topic.md',
      'Notes/Topic.md',
      'Other.md',
      'archive/img/pic.png',
      'doc.pdf',
      'img/pic.png',
    ]);
    expect(index.add('.git/x.md')).toBe(false);
    expect(index.add('a/b.MD')).toBe(true);
  });

  it('resolves wikilinks and follows adds and removes', () => {
    const index = new FolderIndex(files);
    expect(index.resolve('Other', 'Notes/Topic.md').status).toBe('ok');
    expect(index.resolve('Topic', 'Other.md')).toMatchObject({ status: 'ambiguous', path: 'Notes/Topic.md' });
    expect(index.resolve('New', 'Other.md').status).toBe('missing');
    index.add('New.md');
    expect(index.resolve('New', 'Other.md').status).toBe('ok');
    index.remove('Notes');
    expect(index.resolve('Topic', 'Other.md').status).toBe('missing');
    expect(index.has('Other.md')).toBe(true);
  });

  it('offers completion targets, names first, with the shortest unique target', () => {
    const index = new FolderIndex(files);
    const items = index.targets('top', 'Other.md');
    expect(items.map((i) => i.target)).toEqual(['Notes/Topic', 'Deep/Topic']);
    expect(items[0]).toMatchObject({ label: 'Topic', detail: 'Notes' });
    expect(index.targets('pic.p', 'Other.md').map((i) => i.target)).toEqual(['img/pic.png', 'archive/img/pic.png']);
    // "Topic" holds "pic": names holding the query come after names starting with it.
    expect(index.targets('pic', 'Other.md').map((i) => i.label)).toEqual(['pic.png', 'pic.png', 'Topic', 'Topic']);
    expect(index.targets('', 'img/note.md')[0]!.target).toBe('img/pic.png');
    expect(index.targets('', 'Other.md').some((i) => i.label === 'Other')).toBe(false);
    expect(index.targets('zzz', 'Other.md')).toEqual([]);
  });

  it('answers at most the limit', () => {
    const many = Array.from({ length: 120 }, (_, i) => `n/note${i}.md`);
    expect(new FolderIndex(many).targets('note', 'x.md')).toHaveLength(50);
  });
});
