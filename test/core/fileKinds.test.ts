// Which files are markdown, images, video and sound, by their extension, as the host and the panel
// decide them.

import { describe, expect, it } from 'vitest';
import { extensionOf, isImagePath, isMarkdownPath, mediaKindOf } from '../../src/core/fileKinds';

describe('mediaKindOf', () => {
  it('tells video and sound by the file extension, query and fragment aside', () => {
    expect(mediaKindOf('clip.MP4')).toBe('video');
    expect(mediaKindOf('https://x.y/a.webm?v=1#t=3')).toBe('video');
    expect(mediaKindOf('talk.ogg')).toBe('audio');
    expect(mediaKindOf('song.mp3')).toBe('audio');
    expect(mediaKindOf('pic.png')).toBe(null);
    expect(mediaKindOf('folder.mp4/readme')).toBe(null);
  });
});

describe('extensionOf', () => {
  it('reads what follows the last dot of the last segment, in lower case', () => {
    expect(extensionOf('notes/Pic.PNG')).toBe('png');
    expect(extensionOf('a/b.tar.gz')).toBe('gz');
    expect(extensionOf('folder.v2/Note')).toBe('');
  });

  it('gives a name with no dot, or one that ends in a dot, no extension', () => {
    expect(extensionOf('README')).toBe('');
    expect(extensionOf('notes/draft.')).toBe('');
  });

  it('gives a name that starts with its only dot that extension, as VS Code does', () => {
    expect(extensionOf('.md')).toBe('md');
    expect(isMarkdownPath('notes/.md')).toBe(true);
    expect(isImagePath('.png')).toBe(true);
  });

  it('tells markdown and pictures in any letter case', () => {
    expect(['a.md', 'a.MD', 'a.Markdown'].every(isMarkdownPath)).toBe(true);
    expect(['a.mdx', 'a.md.txt', 'a.md/b'].some(isMarkdownPath)).toBe(false);
    expect(isImagePath('x/Photo.JPEG')).toBe(true);
  });
});
