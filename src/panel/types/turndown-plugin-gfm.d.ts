// Types for @joplin/turndown-plugin-gfm, which ships none. Each export is a turndown plugin;
// `gfm` is all the others together.
declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown';

  export const gfm: TurndownService.Plugin;
  export const highlightedCodeBlock: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
}
