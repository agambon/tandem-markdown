// The formats and blocks both the toolbar (toolbar.ts) and the insert menu (complete/insertMenu.ts)
// offer, each with the one label and codicon both show.

export interface Action {
  readonly label: string;
  /** A codicon's name. */
  readonly icon: string;
}

export const BOLD: Action = { label: 'Bold', icon: 'bold' };
export const ITALIC: Action = { label: 'Italic', icon: 'italic' };
export const STRIKETHROUGH: Action = { label: 'Strikethrough', icon: 'strikethrough' };
export const INLINE_CODE: Action = { label: 'Inline code', icon: 'code' };
export const LINK: Action = { label: 'Link', icon: 'link' };
export const BULLET_LIST: Action = { label: 'Bullet list', icon: 'list-unordered' };
export const NUMBERED_LIST: Action = { label: 'Numbered list', icon: 'list-ordered' };
export const TASK_LIST: Action = { label: 'Task list', icon: 'checklist' };
export const QUOTE: Action = { label: 'Quote', icon: 'quote' };
export const CODE_BLOCK: Action = { label: 'Code block', icon: 'file-code' };
export const TABLE: Action = { label: 'Table', icon: 'table' };
export const IMAGE: Action = { label: 'Image', icon: 'file-media' };
export const RULE: Action = { label: 'Rule', icon: 'horizontal-rule' };
