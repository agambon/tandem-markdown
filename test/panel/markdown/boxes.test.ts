import { describe, expect, it } from 'vitest';
import { find, topLevel } from './treeHelpers';

const parts = (text: string) =>
  find(text, 'Box', 'BoxMark', 'BoxName', 'BoxTitle', 'Attributes').map((n) => `${n.name}:${n.text}`);

/** Each box's text, outermost first. */
const boxes = (text: string) => find(text, 'Box').map((n) => n.text);

describe('fenced boxes', () => {
  it('reads a name and the rest of the line as the title (VitePress)', () => {
    expect(parts('::: danger STOP\nDanger zone.\n:::')).toEqual([
      'Box:::: danger STOP\nDanger zone.\n:::',
      'BoxMark::::',
      'BoxName:danger',
      'BoxTitle:STOP',
      'BoxMark::::',
    ]);
  });

  it('reads a title in brackets after the name (Docusaurus)', () => {
    expect(parts(':::note[Your **title**]\n\nBody\n\n:::')).toEqual([
      'Box::::note[Your **title**]\n\nBody\n\n:::',
      'BoxMark::::',
      'BoxName:note',
      'BoxMark:[',
      'BoxTitle:Your **title**',
      'BoxMark:]',
      'BoxMark::::',
    ]);
    expect(find(':::note[Your **title**]\n:::', 'StrongEmphasis').map((n) => n.text)).toEqual(['**title**']);
  });

  it('reads the first class in braces, and a closing run of colons (Pandoc, Quarto)', () => {
    expect(parts('::: {.callout-note title="A"}\nText\n:::')).toEqual([
      'Box:::: {.callout-note title="A"}\nText\n:::',
      'BoxMark::::',
      'Attributes:{.callout-note title="A"}',
      'BoxMark::::',
    ]);
    expect(parts('::: Warning :::\nText\n:::')).toEqual([
      'Box:::: Warning :::\nText\n:::',
      'BoxMark::::',
      'BoxName:Warning',
      'BoxMark::::',
      'BoxMark::::',
    ]);
  });

  it('holds ordinary markdown', () => {
    const text = '::: tip\n# Heading\n\n- a\n- b\n\n> quote\n:::\nAfter';
    expect(topLevel(text)).toEqual(['Box', 'Paragraph']);
    expect(find(text, 'ATXHeading1', 'BulletList', 'Blockquote').map((n) => n.name)).toEqual([
      'ATXHeading1',
      'BulletList',
      'Blockquote',
    ]);
  });

  it('a line of colons closes the innermost box, whatever its length (VitePress, Docusaurus, Pandoc)', () => {
    expect(boxes(':::: warning\nouter\n::: tip\ninner\n:::\n::::\nafter')).toEqual([
      ':::: warning\nouter\n::: tip\ninner\n:::\n::::',
      '::: tip\ninner\n:::',
    ]);
    expect(boxes('::: Warning\nouter\n\n::: Danger\ninner\n:::\n:::\nafter')).toEqual([
      '::: Warning\nouter\n\n::: Danger\ninner\n:::\n:::',
      '::: Danger\ninner\n:::',
    ]);
  });

  it('a closing line ends a paragraph, and closes a box from below a list or a quote inside it', () => {
    expect(topLevel('::: note\nText\n:::\nAfter')).toEqual(['Box', 'Paragraph']);
    expect(boxes('::: note\n- item\n:::\nAfter')).toEqual(['::: note\n- item\n:::']);
    expect(boxes('::: note\n> quoted\n:::\nAfter')).toEqual(['::: note\n> quoted\n:::']);
  });

  it('a line of colons inside a quote within a box belongs to the quote', () => {
    const text = '::: note\n> quoted\n> :::\n:::';
    expect(boxes(text)).toEqual([text]);
    expect(find(text, 'Paragraph').map((n) => n.text)).toEqual(['quoted\n> :::']);
  });

  it('an unclosed box runs to the end of what holds it', () => {
    expect(boxes('::: note\nText\n\nMore')).toEqual(['::: note\nText\n\nMore']);
    expect(boxes('> ::: note\n> Text\n\nOutside')).toEqual(['::: note\n> Text']);
  });

  it('can interrupt a paragraph', () => {
    expect(topLevel('Para\n::: note\nx\n:::')).toEqual(['Paragraph', 'Box']);
  });

  it('`::: mermaid` is a code block in the mermaid language (Azure DevOps)', () => {
    const text = '::: mermaid\ngraph LR;\nA-->B\n:::\nAfter';
    expect(topLevel(text)).toEqual(['FencedCode', 'Paragraph']);
    expect(find(text, 'CodeMark', 'CodeInfo', 'CodeText').map((n) => `${n.name}:${n.text}`)).toEqual([
      'CodeMark::::',
      'CodeInfo:mermaid',
      'CodeText:graph LR;\nA-->B',
      'CodeMark::::',
    ]);
  });
});

describe('admonitions', () => {
  it('reads a type, a quoted title and an indented body (Python-Markdown)', () => {
    const text = '!!! note "Phasellus posuere"\n\n    Lorem ipsum.\n    More.\n\nAfter';
    expect(parts(text)).toEqual([
      'Box:!!! note "Phasellus posuere"\n\n    Lorem ipsum.\n    More.',
      'BoxMark:!!!',
      'BoxName:note',
      'BoxMark:"',
      'BoxTitle:Phasellus posuere',
      'BoxMark:"',
    ]);
    expect(topLevel(text)).toEqual(['Box', 'Paragraph']);
  });

  it('reads the folding forms, a title alone, and an empty title (PyMdown, Material)', () => {
    expect(parts('??? tip\n    Body')[1]).toBe('BoxMark:???');
    expect(parts('???+ tip\n    Body')[1]).toBe('BoxMark:???+');
    expect(parts('??? "Only a title"\n    Body')).toContain('BoxTitle:Only a title');
    expect(parts('!!! danger highlight blink "Careful"\n    Body')).toContain('BoxName:danger');
    expect(parts('!!! note ""\n    Body')).not.toContain('BoxTitle:');
    expect(boxes('!!! note ""\n    Body')).toEqual(['!!! note ""\n    Body']);
  });

  it('ends at the first line indented less than four spaces', () => {
    expect(boxes('!!! note\n    In.\n\nOut.')).toEqual(['!!! note\n    In.']);
  });
});

describe('text that stays text', () => {
  const none = (text: string) => expect(find(text, 'Box', 'BoxMark')).toEqual([]);

  it('a line of colons in prose', () => {
    none('Before\n\n:::\n\nAfter ::: and :::::');
  });

  it('a time, a ratio and colons followed by punctuation', () => {
    none(':::12:30 meeting');
    none('::: 10:30 start');
    none(':::-) a face');
    none(':: two colons only');
  });

  it('a definition and a property line', () => {
    none('Term\n: Its definition');
    none('Status:: done');
  });

  it('a sentence after question or exclamation marks', () => {
    none('??? no idea\n    indented');
    none('!!! wow that was close');
    none('!!!! four');
  });

  it('an opening line indented four spaces is code', () => {
    expect(topLevel('    ::: note\n    x')).toEqual(['CodeBlock']);
  });

  it('colons inside code', () => {
    none('```\n::: note\n:::\n```');
  });
});
