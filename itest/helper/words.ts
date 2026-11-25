// What the test helper extension reports and how it fixes it, shared by the helper and the
// tests that read what it did.

/** The `source` of every problem the helper reports. */
export const HELPER_SOURCE = 'itest-helper';

/** A word the helper reports, with two fixes: an edit (the preferred one) and a command. */
export const FIXED_BY_EDIT = { word: 'wrnog', fix: 'wrong' } as const;

/** A word the helper reports, with one fix, a command that makes the edit itself. */
export const FIXED_BY_COMMAND = { word: 'mispel', fix: 'misspell' } as const;

export const HELPER_WORDS = [FIXED_BY_EDIT, FIXED_BY_COMMAND] as const;

/** The command the helper's fixes run: (uri, start offset, end offset, text). */
export const HELPER_REPLACE = 'tandemMarkdownItestHelper.replace';
