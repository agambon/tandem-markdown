// Wikilink parsing, and matching a target against the workspace's files.
import { describe, expect, it } from 'vitest';
import { LinkIndex, parseWikilink } from '../../src/core/wikilinks';

describe('parseWikilink', () => {
  it('splits target, heading and alias', () => {
    expect(parseWikilink('Target')).toEqual({ target: 'Target' });
    expect(parseWikilink('Folder/Target')).toEqual({ target: 'Folder/Target' });
    expect(parseWikilink('Target|Alias')).toEqual({ target: 'Target', alias: 'Alias' });
    expect(parseWikilink('Target#Heading')).toEqual({ target: 'Target', heading: 'Heading' });
    expect(parseWikilink('Target#Heading|Alias')).toEqual({ target: 'Target', heading: 'Heading', alias: 'Alias' });
    expect(parseWikilink('#Heading')).toEqual({ target: '', heading: 'Heading' });
    expect(parseWikilink('image.png')).toEqual({ target: 'image.png' });
  });

  it('reads an escaped pipe (as in a table) as the alias divider, and trims', () => {
    expect(parseWikilink('Target\\|Alias')).toEqual({ target: 'Target', alias: 'Alias' });
    expect(parseWikilink(' Target # Heading | Alias ')).toEqual({
      target: 'Target',
      heading: 'Heading',
      alias: 'Alias',
    });
    expect(parseWikilink('Target|')).toEqual({ target: 'Target' });
    expect(parseWikilink('Target#')).toEqual({ target: 'Target' });
    expect(parseWikilink('a|b|c')).toEqual({ target: 'a', alias: 'b|c' });
  });
});

describe('LinkIndex.resolve', () => {
  const index = new LinkIndex([
    'Home.md',
    'notes/Topic/Name.md',
    'notes/XTopic/Name.md',
    'archive/Topic/Name.md',
    'notes/Other.markdown',
    'notes/img/diagram.png',
    'notes/Weekly.Review.md',
    'Projects/Plan.md',
    'Projects/sub/Plan.md',
    'zeta/Plan.md',
  ]);

  it('matches the whole path or its end at a folder boundary, ignoring case', () => {
    expect(index.resolve('home', 'x.md')).toEqual({ status: 'ok', path: 'Home.md', candidates: ['Home.md'] });
    expect(index.resolve('notes/topic/name', 'x.md').path).toBe('notes/Topic/Name.md');
    expect(index.resolve('Topic/Name', 'x.md').candidates.sort()).toEqual([
      'archive/Topic/Name.md',
      'notes/Topic/Name.md',
    ]);
    // "Topic/Name" must not match "XTopic/Name".
    expect(index.resolve('Topic/Name', 'x.md').candidates).not.toContain('notes/XTopic/Name.md');
    expect(index.resolve('opic/Name', 'x.md').status).toBe('missing');
  });

  it('drops a .md or .markdown ending, and matches other extensions by full name', () => {
    expect(index.resolve('Other.md', 'x.md').path).toBe('notes/Other.markdown');
    expect(index.resolve('Other.markdown', 'x.md').path).toBe('notes/Other.markdown');
    expect(index.resolve('Home.md', 'x.md').path).toBe('Home.md');
    expect(index.resolve('diagram.png', 'x.md')).toEqual({
      status: 'ok',
      path: 'notes/img/diagram.png',
      candidates: ['notes/img/diagram.png'],
    });
    expect(index.resolve('img/diagram.png', 'x.md').status).toBe('ok');
    expect(index.resolve('diagram', 'x.md').status).toBe('missing');
    expect(index.resolve('Weekly.Review', 'x.md').path).toBe('notes/Weekly.Review.md');
  });

  it('counts backslashes as forward slashes', () => {
    expect(index.resolve('notes\\Topic\\Name', 'x.md').path).toBe('notes/Topic/Name.md');
  });

  it('ranks several matches: shared leading folders, then fewest segments, then alphabetical', () => {
    const fromProjects = index.resolve('Plan', 'Projects/sub/Notes.md');
    expect(fromProjects.status).toBe('ambiguous');
    expect(fromProjects.candidates).toEqual(['Projects/sub/Plan.md', 'Projects/Plan.md', 'zeta/Plan.md']);
    expect(fromProjects.path).toBe('Projects/sub/Plan.md');
    expect(index.resolve('Plan', 'Home.md').candidates).toEqual([
      'Projects/Plan.md',
      'zeta/Plan.md',
      'Projects/sub/Plan.md',
    ]);
    expect(index.resolve('Topic/Name', 'archive/today.md').path).toBe('archive/Topic/Name.md');
    expect(index.resolve('Topic/Name', 'notes/today.md').path).toBe('notes/Topic/Name.md');
  });

  it('resolves an empty target to the note itself, and reports a missing one', () => {
    expect(index.resolve('', 'notes/Topic/Name.md')).toEqual({
      status: 'ok',
      path: 'notes/Topic/Name.md',
      candidates: ['notes/Topic/Name.md'],
    });
    expect(index.resolve('Nowhere', 'x.md')).toEqual({ status: 'missing', candidates: [] });
  });

  it('reads a target starting with / from the workspace root, and ./ or ../ from the note', () => {
    expect(index.resolve('/Projects/Plan', 'zeta/a.md')).toEqual({
      status: 'ok',
      path: 'Projects/Plan.md',
      candidates: ['Projects/Plan.md'],
    });
    expect(index.resolve('/Plan', 'zeta/a.md').status).toBe('missing');
    expect(index.resolve('./Plan', 'Projects/sub/a.md').path).toBe('Projects/sub/Plan.md');
    expect(index.resolve('../Plan', 'Projects/sub/a.md').path).toBe('Projects/Plan.md');
    expect(index.resolve('../../../Plan', 'Projects/sub/a.md').status).toBe('missing');
  });
});

describe("LinkIndex.resolveLink, with Bear's Note/Heading", () => {
  const index = new LinkIndex(['Recipes.md', 'Recipes/Soup.md', 'Journal.md', 'notes/Plan.md', 'img/pic.png']);
  const headings: Record<string, string[]> = {
    'Recipes.md': ['Soup', 'Bread'],
    'Journal.md': ['Monday'],
    'notes/Plan.md': ['Goals'],
  };
  const asked: string[] = [];
  const hasHeading = (path: string, heading: string) => {
    asked.push(`${path}#${heading}`);
    return Promise.resolve(headings[path]?.includes(heading) ?? false);
  };

  it('takes the folder reading whenever a file answers it', async () => {
    asked.length = 0;
    expect(await index.resolveLink('Recipes/Soup', 'x.md', hasHeading)).toEqual(index.resolve('Recipes/Soup', 'x.md'));
    expect(asked).toEqual([]);
  });

  it('goes to the heading in the note when no file answers and the note has it', async () => {
    expect(await index.resolveLink('Recipes/Bread', 'x.md', hasHeading)).toEqual({
      status: 'ok',
      path: 'Recipes.md',
      candidates: ['Recipes.md'],
      heading: 'Bread',
    });
    expect(await index.resolveLink('Plan/Goals', 'x.md', hasHeading)).toMatchObject({
      path: 'notes/Plan.md',
      heading: 'Goals',
    });
  });

  it('reads /Heading as a heading of the linking note', async () => {
    expect(await index.resolveLink('/Monday', 'Journal.md', hasHeading)).toMatchObject({
      path: 'Journal.md',
      heading: 'Monday',
    });
  });

  it('stays missing when the note lacks the heading, or the part before the slash is no note', async () => {
    expect(await index.resolveLink('Recipes/Cake', 'x.md', hasHeading)).toEqual({ status: 'missing', candidates: [] });
    expect(await index.resolveLink('Nowhere/Soup', 'x.md', hasHeading)).toEqual({ status: 'missing', candidates: [] });
    expect(await index.resolveLink('img/pic.png/Soup', 'x.md', hasHeading)).toEqual({
      status: 'missing',
      candidates: [],
    });
    expect(await index.resolveLink('Recipes/', 'x.md', hasHeading)).toEqual({ status: 'missing', candidates: [] });
  });
});

describe('LinkIndex.shortestTarget', () => {
  const index = new LinkIndex([
    'a/Unique.md',
    'notes/Topic/Name.md',
    'archive/Topic/Name.md',
    'x/Name.md',
    'img/pic.png',
    'other/img/pic.png',
    'twin/Note.md',
    'twin/Note.markdown',
  ]);

  it('gives the name alone when it is unique, without a markdown extension', () => {
    expect(index.shortestTarget('a/Unique.md')).toBe('Unique');
  });

  it('adds folders until the target is unique', () => {
    expect(index.shortestTarget('x/Name.md')).toBe('x/Name');
    expect(index.shortestTarget('notes/Topic/Name.md')).toBe('notes/Topic/Name');
    expect(index.shortestTarget('other/img/pic.png')).toBe('other/img/pic.png');
  });

  it('works for a path not yet in the index', () => {
    expect(index.shortestTarget('new/Fresh.md')).toBe('Fresh');
    expect(index.shortestTarget('new/Name.md')).toBe('new/Name');
  });

  it('returns the whole path when no target is unique', () => {
    expect(index.shortestTarget('twin/Note.md')).toBe('twin/Note');
    expect(index.shortestTarget('img/pic.png')).toBe('img/pic.png'); // the tail of other/img/pic.png
  });

  it('gives a target that resolves to the path alone whenever one exists', () => {
    for (const path of [
      'a/Unique.md',
      'x/Name.md',
      'notes/Topic/Name.md',
      'archive/Topic/Name.md',
      'other/img/pic.png',
    ]) {
      const r = index.resolve(index.shortestTarget(path), 'elsewhere/n.md');
      expect(r).toEqual({ status: 'ok', path, candidates: [path] });
    }
  });
});
