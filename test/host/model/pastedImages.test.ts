// Where a pasted image is saved and what it is called.

import { describe, expect, it } from 'vitest';
import { imageExtensionFor, pastedImageStem, plainCopyDestination } from '../../../src/host/model/pastedImages';

describe('saving a pasted image', () => {
  it('takes its extension from the type, else the name; refuses what is not an image', () => {
    expect(imageExtensionFor('image/png', 'x')).toBe('png');
    expect(imageExtensionFor('image/jpeg', 'x')).toBe('jpg');
    expect(imageExtensionFor('image/svg+xml', 'x')).toBe('svg');
    expect(imageExtensionFor('', 'Photo.JPEG')).toBe('jpg');
    expect(imageExtensionFor('application/x-msdownload', 'evil.exe')).toBeNull();
    expect(imageExtensionFor('text/html', 'page.html')).toBeNull();
  });

  it('is named after the note and the time', () => {
    expect(pastedImageStem('My Note.md', new Date(2026, 10, 14, 9, 5, 7))).toBe('My Note-20261114-090507');
  });

  it('goes where markdown.copyFiles.destination names a plain folder, else beside the note', () => {
    expect(plainCopyDestination({ '**/*.md': 'images/' }, ['notes/a.md'])).toBe('images/');
    expect(plainCopyDestination({ '**/*.md': '/assets/' }, ['a.md'])).toBe('/assets/');
    expect(plainCopyDestination({ '**/*.md': 'images/${documentBaseName}/' }, ['a.md'])).toBeNull();
    expect(plainCopyDestination({ '**/*.md': 'images/pic.png' }, ['a.md'])).toBeNull();
    expect(plainCopyDestination({ 'docs/**': 'img/' }, ['notes/a.md'])).toBeNull();
    expect(plainCopyDestination({ 'docs/**': 'img/', '*': 'all/' }, ['notes/a.md'])).toBe('all/');
    expect(plainCopyDestination(undefined, ['a.md'])).toBeNull();
  });
});
