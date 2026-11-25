// Pictures stored in a file as `data:` addresses. Only PNG, JPEG, GIF and WebP are shown: a
// picture element decodes them without fetching anything, and the page's policy allows `data:`
// for pictures and nothing else. Shared by the HTML door and the markdown picture drawing.

/**
 * The longest stored picture drawn, in characters of its address. A file is drawn only under
 * `tandemMarkdown.maxRichFileSizeKb`, so this matters only where that is raised; past it the
 * picture's place says why.
 */
export const MAX_STORED_PICTURE = 8 * 1024 * 1024;

/** The picture that many characters hold, in megabytes: base64 holds three bytes in four characters. */
const MAX_STORED_MB = Math.round((MAX_STORED_PICTURE / 4) * 3 * 1e-6);

const STORED_PREFIX = /^data:image\/(?:png|jpeg|gif|webp);base64,/i;

/** Whether `address` is a picture stored in the file that may be drawn. */
export function isStoredPicture(address: string): boolean {
  return address.length <= MAX_STORED_PICTURE && STORED_PREFIX.test(address);
}

/** Why the `data:` address `address` is not drawn, or null when it is. */
export function storedPictureRefusal(address: string): string | null {
  if (!STORED_PREFIX.test(address)) return 'Only PNG, JPEG, GIF and WebP pictures stored in the file are shown';
  if (address.length > MAX_STORED_PICTURE) return `Larger than ${MAX_STORED_MB} MB`;
  return null;
}
