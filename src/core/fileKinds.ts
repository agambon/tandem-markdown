// Which files are markdown, images, video and sound, by the extension of their name, as Obsidian
// and GitLab tell a picture from a player. The host decides by these which documents get a
// coordinator and what its link index takes in; the panel, what it draws as an image and where it
// draws a player (only while `tandemMarkdown.syntax.media` is on).

export const MARKDOWN_EXTENSIONS = ['md', 'markdown'] as const;

export const MARKDOWN_EXT = new RegExp(`\\.(${MARKDOWN_EXTENSIONS.join('|')})$`, 'i');

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif'] as const;

const IMAGES = new Set<string>(IMAGE_EXTENSIONS);

/**
 * The extension of the last segment of `path`, in lower case: what follows its last dot, '' when
 * it has no dot or ends in one. A name that starts with its only dot has one (`.md` is markdown),
 * as VS Code's language and editor associations read a name.
 */
export function extensionOf(path: string): string {
  const name = lastSegment(path);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

const MARKDOWN = new Set<string>(MARKDOWN_EXTENSIONS);

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN.has(extensionOf(path));
}

export function isImagePath(path: string): boolean {
  return IMAGES.has(extensionOf(path));
}

export type MediaKind = 'video' | 'audio';

/** Extensions played as video; `webm` may hold sound alone, and a video player plays that too. */
const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'ogv', 'mov'];

/** Extensions played as sound. Obsidian plays `ogg` as sound. */
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac'];

export const MEDIA_EXTENSIONS: readonly string[] = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS];

const VIDEO = new Set(VIDEO_EXTENSIONS);
const AUDIO = new Set(AUDIO_EXTENSIONS);

/** The kind of player for the file at `address` (its query and fragment aside), or null for anything else. */
export function mediaKindOf(address: string): MediaKind | null {
  const extension = extensionOf(address.replace(/[?#].*$/, ''));
  return VIDEO.has(extension) ? 'video' : AUDIO.has(extension) ? 'audio' : null;
}

export function lastSegment(s: string): string {
  const slash = s.lastIndexOf('/');
  return slash < 0 ? s : s.slice(slash + 1);
}
