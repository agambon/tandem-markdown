// The ids of the two editors a markdown file opens in, as VS Code's commands and settings name
// them: this extension's custom editor and VS Code's own text editor.

/** This extension's editor, by the view type `contributes.customEditors` in package.json declares. */
export const VIEW_TYPE = 'tandemMarkdown.editor';

/**
 * VS Code's own text editor, by its id in `vscode.openWith`, `reopenActiveEditorWith` and both
 * editor associations settings; in the comparisons setting, its text comparison.
 */
export const TEXT_EDITOR = 'default';
