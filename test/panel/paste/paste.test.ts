// Paste and copy: which rule applies, and what each rule writes.
//
// The fixtures in ./fixtures are clipboard HTML in the shapes Chrome (a web page), Word,
// Google Docs and VS Code put on the Windows clipboard, each with the plain text the same
// copy carries. They are written by hand from those programs' clipboard formats. The HTML
// conversion itself needs a DOM and is checked against `*.expected.md` in the browser
// (harness/tests/find-paste.spec.mjs).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import type { FeatureRequest } from '../../../src/core/featureProtocol';
import type { PanelContext } from '../../../src/panel/context';
import { webAddress } from '../../../src/panel/links/read';
import { linkDestination } from '../../../src/panel/markdown/writing';
import { pastePlainFrom } from '../../../src/panel/paste';
import { blockChange, imageMarkdown, linkChange, markdownChange, plainChange } from '../../../src/panel/paste/changes';
import { choosePaste, MAX_PASTE_HTML, OWN_TYPE, type ClipboardInput } from '../../../src/panel/paste/choose';
import { classifyHtml, htmlFragment } from '../../../src/panel/paste/classifyHtml';
import { holdPaste, insertHeldPaste } from '../../../src/panel/paste/held';
import { fileToBase64, linksNotInText, notSavedText, saveAndLinkImages } from '../../../src/panel/paste/images';
import { markdownToHtml } from '../../../src/panel/paste/markdownToHtml';
import { fakeContext, standInView, stateOf, type StandInView } from '../helpers';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixture = (name: string) => readFileSync(`${here}fixtures/${name}`, 'utf8');

function clip(partial: Partial<ClipboardInput>): ClipboardInput {
  return { text: '', html: '', types: [], images: [], ...partial };
}

/** A state with `«` and `»` marking the selection. */
function selected(text: string): EditorState {
  const open = text.indexOf('«');
  const close = text.indexOf('»');
  const doc = text.slice(0, open) + text.slice(open + 1, close) + text.slice(close + 1);
  return at(doc, open, close - 1);
}

/** A state of `doc` with the selection at [anchor, head] (for text holding `|` of its own). */
function at(doc: string, anchor: number, head = anchor): EditorState {
  return stateOf(`‸${doc}`).update({ selection: EditorSelection.single(anchor, head) }).state;
}

function apply(state: EditorState, spec: TransactionSpec) {
  const tr = state.update(spec);
  return { text: tr.state.doc.toString(), cursor: tr.state.selection.main.head, tr };
}

const webHtml = fixture('web-page.html');
const webText = fixture('web-page.txt');
const wordHtml = fixture('word.html');
const wordText = fixture('word.txt');
const docsHtml = fixture('google-docs.html');
const docsText = fixture('google-docs.txt');
const vscodeHtml = fixture('vscode.html');
const vscodeText = fixture('vscode.txt');

describe('what kind of HTML is on the clipboard', () => {
  it('reads the four fixtures', () => {
    expect(classifyHtml(webHtml)).toBe('rich');
    expect(classifyHtml(wordHtml)).toBe('rich');
    expect(classifyHtml(docsHtml)).toBe('rich');
    expect(classifyHtml(vscodeHtml)).toBe('code');
  });

  it('takes a lone code block copied from anywhere as a code editor copy', () => {
    const jetbrains =
      '<html><head><meta http-equiv="content-type" content="text/html; charset=UTF-8"></head><body><pre style="background-color:#1e1f22;color:#bcbec4"><span style="color:#cf8e6d;">val </span>x = <span style="color:#2aacb8;">1</span></pre></body></html>';
    expect(classifyHtml(jetbrains)).toBe('code');
  });

  it('takes a span or one paragraph of text as a plain wrapper', () => {
    const chromeSpan =
      '<meta charset=\'utf-8\'><span style="color: rgb(31, 35, 40); font-family: -apple-system, &quot;Segoe UI&quot;; font-size: 16px; font-style: normal; font-weight: 400; white-space: normal; display: inline !important; float: none;">Just some words from a page.</span>';
    const docsSpan =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><span style="font-size:11pt;font-family:Arial,sans-serif;font-weight:400;font-style:normal;white-space:pre;white-space:pre-wrap;">one line</span></b>';
    expect(classifyHtml(chromeSpan)).toBe('wrapper');
    expect(classifyHtml(docsSpan)).toBe('wrapper');
    expect(classifyHtml('<p>one paragraph</p>')).toBe('wrapper');
  });

  it('counts two paragraphs, a styled bold span or a Word list paragraph as more than a wrapper', () => {
    expect(classifyHtml('<p>one</p><p>two</p>')).toBe('rich');
    expect(classifyHtml('<span style="font-weight:700">bold</span> text')).toBe('rich');
    expect(classifyHtml("<p class=MsoListParagraph style='mso-list:l0 level1 lfo1'>item</p>")).toBe('rich');
  });

  it('tells images alone and nothing at all apart', () => {
    expect(classifyHtml('<meta charset="utf-8"><img src="https://example.com/a.png" alt="a">')).toBe('images');
    expect(classifyHtml('<meta charset="utf-8">')).toBe('empty');
    expect(classifyHtml('')).toBe('empty');
  });

  // A web page decides what a copy puts on the clipboard. Each of these takes seconds, or
  // overflows the stack, in a reader that looks at text again from every tag.
  it('reads crafted HTML through in one pass: tags, comments and blocks never closed, deep nesting', () => {
    const n = 30_000;
    expect(classifyHtml('<p>hi</p>' + '<a'.repeat(n))).toBe('wrapper');
    expect(classifyHtml('<p>hi</p>' + '<!--'.repeat(n))).toBe('wrapper');
    expect(classifyHtml('<p>hi</p>' + '<script>'.repeat(n))).toBe('wrapper');
    expect(classifyHtml('<p>hi</p>' + '<![if '.repeat(n))).toBe('wrapper');
    expect(classifyHtml('<p>hi</p>' + '<!DOCTYPE '.repeat(n))).toBe('wrapper');
    expect(classifyHtml('<div>'.repeat(n) + 'deep' + '</p>'.repeat(n))).toBe('wrapper');
    expect(classifyHtml(`<p><span style="${'text-decoration:'.repeat(2 * n)}">x</span></p>`)).toBe('wrapper');
  });

  it('strips comments and blocks that are not content', () => {
    expect(classifyHtml('<p>a</p><!-- <p>b</p> --><style>p{}</style><SCRIPT>x</script ><p>c</p>')).toBe('rich');
    expect(classifyHtml('<!-- <p>b</p> --><p>a</p><script>x</script>')).toBe('wrapper');
    expect(classifyHtml('<style><p>a</p><p>b</p></style><p>c</p>')).toBe('wrapper');
  });

  it('cuts the copied fragment out of Windows clipboard HTML', () => {
    expect(htmlFragment('<html><body>\r\n<!--StartFragment--><b>x</b><!--EndFragment-->\r\n</body></html>')).toBe(
      '<b>x</b>',
    );
    expect(htmlFragment('<b>x</b>')).toBe('<b>x</b>');
  });
});

describe('which paste rule applies', () => {
  it('converts the web page, Word and Google Docs fixtures', () => {
    const state = stateOf('‸');
    expect(choosePaste(state, clip({ text: webText, html: webHtml }))).toEqual({ rule: 'html' });
    expect(choosePaste(state, clip({ text: wordText, html: wordHtml }))).toEqual({ rule: 'html' });
    expect(choosePaste(state, clip({ text: docsText, html: docsHtml }))).toEqual({ rule: 'html' });
  });

  it("pastes VS Code's copy as its plain text, with or without its own clipboard type", () => {
    const state = stateOf('‸');
    const plain = { rule: 'plain', why: 'codeEditor' };
    expect(
      choosePaste(
        state,
        clip({ text: vscodeText, html: vscodeHtml, types: ['text/plain', 'text/html', 'vscode-editor-data'] }),
      ),
    ).toEqual(plain);
    expect(
      choosePaste(state, clip({ text: vscodeText, html: vscodeHtml, types: ['text/plain', 'text/html'] })),
    ).toEqual(plain);
  });

  it('pastes the plain text when the HTML is over MAX_PASTE_HTML', () => {
    const state = stateOf('‸');
    const html = `<p>${'word '.repeat(MAX_PASTE_HTML / 5)}</p><p>two</p>`;
    expect(html.length).toBeGreaterThan(MAX_PASTE_HTML);
    expect(choosePaste(state, clip({ text: 'words', html }))).toEqual({ rule: 'plain', why: 'tooLong' });
    expect(choosePaste(state, clip({ text: 'words', html: '<p>one</p><p>two</p>' }))).toEqual({ rule: 'html' });
  });

  it('pastes a plain wrapper as its text', () => {
    const state = stateOf('‸');
    expect(choosePaste(state, clip({ text: 'words', html: '<span style="color:red">words</span>' }))).toEqual({
      rule: 'plain',
      why: 'wrapper',
    });
  });

  it('makes a link of a web address pasted over selected text', () => {
    const state = selected('See «the guide» here.');
    expect(choosePaste(state, clip({ text: 'https://example.com/guide' }))).toEqual({
      rule: 'link',
      address: 'https://example.com/guide',
    });
  });

  it('pastes a web address as text with no selection, one across lines, or one touching a link', () => {
    const address = clip({ text: 'https://example.com/' });
    expect(choosePaste(stateOf('See ‸here.'), address)).toEqual({ rule: 'plain', why: 'text' });
    expect(choosePaste(selected('one «two\nthree» four'), address)).toEqual({ rule: 'plain', why: 'text' });
    expect(choosePaste(selected('a «[old](https://old.example)» b'), address)).toEqual({ rule: 'plain', why: 'text' });
    expect(choosePaste(selected('a [[«note»]] b'), address)).toEqual({ rule: 'plain', why: 'text' });
  });

  it('turns tab-separated text into a table outside a table', () => {
    const choice = choosePaste(stateOf('Before\n\n‸'), clip({ text: 'Name\tAge\nAda\t36\n' }));
    expect(choice.rule).toBe('table');
    if (choice.rule === 'table') expect(choice.table).toBe('| Name | Age |\n| ---- | --- |\n| Ada  | 36  |');
  });

  it('pastes tab-separated text as text inside a table', () => {
    const table = '| a | b |\n| - | - |\n| 1 | 2 |\n';
    const state = at(table, table.indexOf('2') + 1);
    expect(choosePaste(state, clip({ text: 'x\ty\nz\tw' }))).toEqual({ rule: 'plain', why: 'text' });
  });

  it('pastes plain text in a code block, code span, front matter or HTML block, whatever is copied', () => {
    const rich = clip({ text: webText, html: webHtml });
    const code = { rule: 'plain', why: 'code' };
    expect(choosePaste(stateOf('```js\nlet x = ‸1;\n```\n'), rich)).toEqual(code);
    expect(choosePaste(stateOf('```js\nlet x = 1;\n‸'), rich)).toEqual(code); // an unclosed fence runs to the end
    expect(choosePaste(stateOf('Some `co‸de` here.'), rich)).toEqual(code);
    expect(choosePaste(stateOf('    indented ‸code\n'), rich)).toEqual(code);
    expect(choosePaste(stateOf('---\ntitle: ‸x\n---\n\nBody\n'), rich)).toEqual(code);
    expect(choosePaste(stateOf('<div>\ninside ‸it\n</div>\n'), rich)).toEqual(code);
    expect(choosePaste(stateOf('```\ncode\n```\n‸'), rich)).toEqual({ rule: 'html' }); // just after the block
    expect(choosePaste(selected('Some `«code»`.'), clip({ text: 'https://example.com/' }))).toEqual(code);
    expect(choosePaste(stateOf('```\nx‸\n```'), clip({ text: 'a\tb\nc\td' }))).toEqual(code);
    expect(choosePaste(stateOf('```\nx‸\n```'), clip({ images: [{ name: 'image.png', type: 'image/png' }] }))).toEqual(
      code,
    );
  });

  it('pastes an image when the clipboard has no text, or HTML that is only an image', () => {
    const image = [{ name: 'image.png', type: 'image/png' }];
    expect(choosePaste(stateOf('‸'), clip({ images: image }))).toEqual({ rule: 'image' });
    expect(
      choosePaste(
        stateOf('‸'),
        clip({ images: image, text: 'https://example.com/a.png', html: '<img src="https://example.com/a.png">' }),
      ),
    ).toEqual({
      rule: 'image',
    });
  });

  it('prefers the text when an image comes with it (Excel puts a picture of the cells beside them)', () => {
    const image = [{ name: 'image.png', type: 'image/png' }];
    const excel = clip({
      images: image,
      text: 'Region\tChange\nNorth\t+4%\n',
      html: '<table><tr><td>Region</td><td>Change</td></tr></table>',
    });
    expect(choosePaste(stateOf('‸'), excel).rule).toBe('table');
  });

  it('pastes text copied from this editor exactly, and still links an address over a selection', () => {
    const own = [OWN_TYPE, 'text/plain', 'text/html'];
    expect(
      choosePaste(
        stateOf('‸'),
        clip({ text: '- [[x]] and **y**', html: '<ul><li>[[x]] and <strong>y</strong></li></ul>', types: own }),
      ),
    ).toEqual({
      rule: 'plain',
      why: 'own',
    });
    expect(choosePaste(stateOf('‸'), clip({ text: 'a\tb\nc\td', types: own }))).toEqual({ rule: 'plain', why: 'own' });
    expect(choosePaste(selected('«word»'), clip({ text: 'https://example.com/', types: own })).rule).toBe('link');
  });

  it('does nothing of its own in Rich view', () => {
    expect(choosePaste(stateOf('‸', { mode: 'view' }), clip({ text: webText, html: webHtml }))).toEqual({
      rule: 'plain',
      why: 'readOnly',
    });
  });

  it('knows a web address when it sees one', () => {
    expect(webAddress(' https://example.com/a?b=c#d \n')).toBe('https://example.com/a?b=c#d');
    expect(webAddress('mailto:someone@example.com')).toBe('mailto:someone@example.com');
    expect(webAddress('www.example.com/guide')).toBe('https://www.example.com/guide');
    expect(webAddress('https://example.com/a b')).toBeNull();
    expect(webAddress('example.com')).toBeNull();
    expect(webAddress('see https://example.com')).toBeNull();
  });
});

describe('what each rule writes', () => {
  it('wraps the selection as a link and puts the cursor after it', () => {
    const state = selected('See «the guide» here.');
    const { text, cursor } = apply(state, linkChange(state, 'https://example.com/guide'));
    expect(text).toBe('See [the guide](https://example.com/guide) here.');
    expect(cursor).toBe('See [the guide](https://example.com/guide)'.length);
  });

  it('puts an address with unbalanced parentheses or spaces in angle brackets', () => {
    expect(linkDestination('https://en.wikipedia.org/wiki/Mars_(planet)')).toBe(
      'https://en.wikipedia.org/wiki/Mars_(planet)',
    );
    expect(linkDestination('https://example.com/a)b')).toBe('<https://example.com/a)b>');
    expect(linkDestination('images/My Note-20261114.png')).toBe('<images/My Note-20261114.png>');
  });

  it('inserts a block on an empty line between paragraphs with the blank lines it needs', () => {
    const state = stateOf('Before\n‸\nAfter');
    expect(apply(state, blockChange(state, '| a |\n| - |')).text).toBe('Before\n\n| a |\n| - |\n\nAfter');
  });

  it('breaks a paragraph around a block pasted into the middle of it', () => {
    const state = stateOf('One two‸ three');
    const { text, cursor } = apply(state, blockChange(state, '| a |\n| - |'));
    expect(text).toBe('One two\n\n| a |\n| - |\n\nthree');
    expect(text.slice(0, cursor)).toBe('One two\n\n| a |\n| - |');
  });

  it('adds nothing around a block in an empty document or between blank lines', () => {
    expect(apply(stateOf('‸'), blockChange(stateOf('‸'), 'x\ny')).text).toBe('x\ny');
    const between = stateOf('A\n\n‸\n\nB');
    expect(apply(between, blockChange(between, 'x\ny')).text).toBe('A\n\nx\ny\n\nB');
  });

  it("carries a quote's marks onto every line of a block pasted inside it", () => {
    const state = stateOf('> Quoted ‸text\n> more\n');
    expect(apply(state, blockChange(state, 'Para one\n\nPara two')).text).toBe(
      '> Quoted\n>\n> Para one\n>\n> Para two\n>\n> text\n> more\n',
    );
  });

  it("indents a block pasted into a list item to the item's text", () => {
    const state = stateOf('- First‸\n- Second\n');
    expect(apply(state, blockChange(state, '| a | b |\n| - | - |')).text).toBe(
      '- First\n\n  | a | b |\n  | - | - |\n\n- Second\n',
    );
  });

  it('keeps a block pasted on a blank line inside a list item, or after a lazy line, in the item', () => {
    const blank = stateOf('- a\n\n‸\n\n  b\n');
    expect(apply(blank, blockChange(blank, '| a |\n| - |')).text).toBe('- a\n\n  | a |\n  | - |\n\n  b\n');
    const lazy = stateOf('- a\nlazy‸\n');
    expect(apply(lazy, blockChange(lazy, '| a |\n| - |')).text).toBe('- a\nlazy\n\n  | a |\n  | - |\n');
  });

  it('keeps a tight list tight around a fenced code block pasted into an item', () => {
    const end = stateOf('- one‸\n- two\n');
    expect(apply(end, blockChange(end, '```\ncode\n```')).text).toBe('- one\n  ```\n  code\n  ```\n- two\n');
    const inside = stateOf('- o‸ne\n- two\n');
    expect(apply(inside, blockChange(inside, '```\ncode\n```')).text).toBe('- o\n  ```\n  code\n  ```\n  ne\n- two\n');
    // Text after the fence would run into the next line: that block takes its blank lines.
    expect(apply(end, blockChange(end, '```\ncode\n```\n\nAfter')).text).toBe(
      '- one\n\n  ```\n  code\n  ```\n\n  After\n\n- two\n',
    );
  });

  it('writes a rule pasted after a bullet of its own character in the other, so the item stays', () => {
    const empty = stateOf('- ‸\n- b\n');
    expect(apply(empty, blockChange(empty, '---')).text).toBe('- ***\n- b\n');
    const start = stateOf('- ‸item\n- two\n');
    expect(apply(start, blockChange(start, '---')).text).toBe('- ***\n  item\n- two\n');
    const star = stateOf('* ‸\n* b\n');
    expect(apply(star, blockChange(star, '***')).text).toBe('* ---\n\n* b\n');
    // After another bullet the rule is already its own, and is written as pasted.
    const plus = stateOf('+ ‸\n+ b\n');
    expect(apply(plus, blockChange(plus, '---')).text).toBe('+ ---\n\n+ b\n');
  });

  it("indents a block to the item's text, not to a deeper line's indent", () => {
    const state = stateOf('- item\n    deeper‸\n');
    expect(apply(state, blockChange(state, '| a |\n| - |')).text).toBe('- item\n    deeper\n\n  | a |\n  | - |\n');
  });

  it("pastes a block onto an empty list item's line, after its marker", () => {
    for (const marker of ['- ‸', '-‸', '-   ‸']) {
      const state = stateOf(`- a\n${marker}\n`);
      expect(apply(state, blockChange(state, '| a |\n| - |')).text, marker).toBe('- a\n- | a |\n  | - |\n');
    }
  });

  it('replaces a selection with a block', () => {
    const state = selected('Keep «this whole line»\n');
    expect(apply(state, blockChange(state, 'x\ny')).text).toBe('Keep\n\nx\ny\n');
  });

  it('inserts one line of converted markdown as typed, and more as a block', () => {
    const inline = stateOf('Some ‸text');
    expect(apply(inline, markdownChange(inline, '**bold** words ')).text).toBe('Some **bold** words text');
    const block = stateOf('Some ‸text');
    expect(apply(block, markdownChange(block, '# Title')).text).toBe('Some\n\n# Title\n\ntext');
  });

  it('writes saved images as image links, one per line', () => {
    expect(imageMarkdown(['note-1.png'])).toBe('![](note-1.png)');
    expect(imageMarkdown(['a b.png', 'c.png'])).toBe('![](<a b.png>)\n![](c.png)');
  });

  it('marks every paste as one change that is not typing', () => {
    const state = selected('«word» and more');
    for (const spec of [
      linkChange(state, 'https://example.com/'),
      blockChange(state, 'a\nb'),
      plainChange(state, 'x'),
      markdownChange(state, '*x*'),
    ]) {
      const tr = state.update(spec);
      expect(tr.isUserEvent('input.paste')).toBe(true);
      expect(tr.isUserEvent('input.type')).toBe(false);
    }
  });
});

describe('copy as HTML', () => {
  it('renders the markdown with raw HTML escaped', () => {
    const html = markdownToHtml('A **bold** word <script>alert(1)</script>\n\n<div onclick="x()">block</div>\n');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<div');
  });
});

// ---------------------------------------------------------------------------
// Images, through a fake host

function hostContext(answer: (message: { type: string; [key: string]: unknown }) => Promise<unknown>) {
  const fake = fakeContext();
  const requests: { type: string; [key: string]: unknown }[] = [];
  const ctx: PanelContext = {
    ...fake.ctx,
    request: <T>(sent: FeatureRequest) => {
      const message = { ...sent };
      requests.push(message);
      return answer(message) as Promise<T>;
    },
  };
  return { ctx, notices: fake.notices, logs: fake.logs, requests };
}

/** A host whose one answer the test gives, after the request has been made. */
function deferredHost() {
  let answer: (value: unknown) => void = () => {};
  let markAsked: () => void = () => {};
  const asked = new Promise<void>((resolve) => (markAsked = resolve));
  const host = hostContext(
    () =>
      new Promise((resolve) => {
        answer = resolve;
        markAsked();
      }),
  );
  return { ...host, asked, answer: (value: unknown) => answer(value) };
}

const png = (name = 'image.png') => new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], name, { type: 'image/png' });

/**
 * Starts saving an image into `t` over `from` to `to`, pasted or, by `userEvent`, dropped, with a
 * host that answers only when told, and waits until the host is asked to save it.
 */
async function savingImage(t: StandInView & EditorView, from: number, to: number, userEvent = 'input.paste') {
  const host = deferredHost();
  const done = saveAndLinkImages(t, host.ctx, [png()], from, to, userEvent);
  await host.asked;
  return { host, done };
}

describe('pasting an image', () => {
  it('deletes the selection at once, then asks the host to save the image and inserts its link there', async () => {
    const t = standInView(selected('Look: «replace me» done'));
    const { from, to } = t.state.selection.main;
    const { host, done } = await savingImage(t, from, to);
    expect(t.state.doc.toString()).toBe('Look:  done');
    host.answer({ markdownPath: 'note-20261114-101500.png' });
    expect(await done).toBe(true);
    expect(host.requests).toEqual([
      { type: 'saveImage', name: 'image.png', mime: 'image/png', dataBase64: 'iVBORwECAw==' },
    ]);
    expect(t.state.doc.toString()).toBe('Look: ![](note-20261114-101500.png) done');
    // Nothing moved the cursor meanwhile, so it follows the link.
    expect(t.state.selection.main.head).toBe('Look: ![](note-20261114-101500.png)'.length);
    expect(host.notices).toEqual([]);
    // Two changes, each sent at once (not typing): the selection going, then the link.
    const changes = t.specs.filter((s) => s.changes);
    expect(changes.map((s) => s.userEvent)).toEqual(['input.paste', 'input.paste']);
  });

  // The link replaces nothing, so typing done while the host saves is kept.
  it('keeps what was typed while the host saved the image, and leaves the cursor where the typing is', async () => {
    const t = standInView(selected('Keep this: «SELECTED» text.'));
    const { from, to } = t.state.selection.main;
    const { host, done } = await savingImage(t, from, to);
    t.dispatch({ ...t.state.replaceSelection('my new words'), userEvent: 'input.type' });
    host.answer({ markdownPath: 'img.png' });
    expect(await done).toBe(true);
    expect(t.state.doc.toString()).toBe('Keep this: ![](img.png)my new words text.');
    expect(t.state.selection.main.head).toBe('Keep this: ![](img.png)my new words'.length);
  });

  it('leaves the selected text gone, and inserts nothing, when the image cannot be saved', async () => {
    const t = standInView(selected('Keep this: «SELECTED» text.'));
    const { ctx, notices } = hostContext(async () => {
      throw new Error('Disk full.');
    });
    const { from, to } = t.state.selection.main;
    expect(await saveAndLinkImages(t, ctx, [png()], from, to, 'input.paste')).toBe(false);
    expect(t.state.doc.toString()).toBe('Keep this:  text.');
    expect(notices.map((x) => x.text)).toEqual([
      'The pasted image could not be saved, so nothing was added: Disk full.',
    ]);
  });

  it('puts the link where the paste was even when the text moved while the host was saving', async () => {
    const t = standInView(stateOf('End of line‸'));
    const pos = t.state.selection.main.head;
    const { host, done } = await savingImage(t, pos, pos);
    t.dispatch({ changes: { from: 0, insert: 'Typed first. ' } });
    host.answer({ markdownPath: 'shot.png' });
    expect(await done).toBe(true);
    expect(t.state.doc.toString()).toBe('Typed first. End of line![](shot.png)');
  });

  it('raises a notice and inserts nothing when the host cannot save it', async () => {
    const before = 'Some text‸';
    const t = standInView(stateOf(before));
    const { ctx, notices } = hostContext(async () => {
      throw new Error("The note's folder could not be written.");
    });
    const pos = t.state.selection.main.head;
    expect(await saveAndLinkImages(t, ctx, [png()], pos, pos, 'input.paste')).toBe(false);
    expect(t.state.doc.toString()).toBe('Some text');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.kind).toBe('error');
    expect(notices[0]!.text).toBe(
      "The pasted image could not be saved, so nothing was added: The note's folder could not be written.",
    );
  });

  it('inserts the dropped images that were saved and names how many were not, as dropped', async () => {
    const t = standInView(stateOf('‸'));
    let n = 0;
    const { ctx, notices } = hostContext(async () => {
      if (++n === 2) throw new Error('Disk full.');
      return { markdownPath: `img-${n}.png` };
    });
    expect(await saveAndLinkImages(t, ctx, [png('a.png'), png('b.png'), png('c.png')], 0, 0, 'input.drop')).toBe(true);
    expect(t.state.doc.toString()).toBe('![](img-1.png)\n![](img-3.png)');
    expect(notices.map((x) => x.text)).toEqual([
      '1 of the 3 dropped images could not be saved, so it was left out: Disk full.',
    ]);
  });

  it('says where the image went when the tab reloaded before the answer came, and offers its link', async () => {
    const t = standInView(stateOf('Text‸'));
    const { host, done } = await savingImage(t, 4, 4);
    t.state = stateOf('Text‸'); // a resync builds a fresh state
    host.answer({ markdownPath: 'shot.png' });
    expect(await done).toBe(false);
    expect(t.state.doc.toString()).toBe('Text');
    expect(host.notices.map((x) => x.kind)).toEqual(['warning']);
    expect(host.notices[0]!.text).toContain('shot.png');
    expect(host.notices[0]!.actions?.map((a) => a.label)).toEqual(['Copy link']);
  });

  it('says a dropped image was dropped when the tab reloaded before its link went in', async () => {
    const t = standInView(stateOf('Text‸'));
    const { host, done } = await savingImage(t, 4, 4, 'input.drop');
    t.state = stateOf('Text‸');
    host.answer({ markdownPath: 'shot.png' });
    expect(await done).toBe(false);
    expect(host.notices.map((x) => x.text)).toEqual([
      'The dropped image was saved as shot.png, but this tab reloaded before its link went in.',
    ]);
  });

  it('words what was not saved for one image, several, and some of several, pasted or dropped', () => {
    expect(notSavedText(1, 1, 0, 'Disk full.', 'pasted')).toBe(
      'The pasted image could not be saved, so nothing was added: Disk full.',
    );
    expect(notSavedText(2, 2, 0, 'Disk full.', 'dropped')).toBe(
      'The 2 dropped images could not be saved, so nothing was added: Disk full.',
    );
    expect(notSavedText(2, 3, 1, 'Disk full.', 'pasted')).toBe(
      '2 of the 3 pasted images could not be saved, so they were left out: Disk full.',
    );
    expect(linksNotInText(['a.png', 'b.png', 'c.png'], 'pasted')).toBe(
      'The pasted images were saved as a.png, b.png and c.png, but this tab reloaded before their links went in.',
    );
    expect(linksNotInText(['a.png', 'b.png'], 'dropped')).toBe(
      'The dropped images were saved as a.png and b.png, but this tab reloaded before their links went in.',
    );
  });

  it('encodes the bytes as base64', async () => {
    expect(await fileToBase64(new Blob([new Uint8Array([0, 255, 16])]))).toBe('AP8Q');
  });
});

describe('half of a surrogate pair on the clipboard', () => {
  // A lone high surrogate, a lone low one, and a whole pair.
  const pasted = 'a\uD83D b\uDE00 c\u{1F600}';

  it('is dropped from text the editor pastes or drops itself, and a whole pair is kept', () => {
    const state = stateOf('‸');
    const filters = state.facet(EditorView.clipboardInputFilter);
    expect(filters.reduce((text, filter) => filter(text, state), pasted)).toBe('a b c\u{1F600}');
  });

  it('is dropped from Paste as Plain Text', async () => {
    const t = standInView(stateOf('‸'));
    const { ctx } = hostContext(async () => undefined);
    expect(await pastePlainFrom(t, ctx, async () => pasted)).toBe(true);
    expect(t.state.doc.toString()).toBe('a b c\u{1F600}');
  });
});

describe('a paste whose text comes later', () => {
  it('replaces the selection it was made over, the cursor after it, when nothing happened meanwhile', () => {
    const t = standInView(selected('Keep «old» this'));
    const id = holdPaste(t, t.state.selection);
    expect(insertHeldPaste(t, id, (state) => plainChange(state, 'new'))).toBe(true);
    expect(t.state.doc.toString()).toBe('Keep new this');
    expect(t.state.selection.main.head).toBe('Keep new'.length);
  });

  it('never replaces what was typed while it waited, and leaves the cursor in the typing', () => {
    const t = standInView(selected('Keep «old» this'));
    const id = holdPaste(t, t.state.selection);
    t.dispatch({ ...t.state.replaceSelection('Z'), userEvent: 'input.type' });
    expect(insertHeldPaste(t, id, (state) => plainChange(state, 'new'))).toBe(true);
    expect(t.state.doc.toString()).toBe('Keep newZ this');
    expect(t.state.selection.main.head).toBe('Keep newZ'.length);
  });

  it('inserts nothing once the view was rebuilt', () => {
    const t = standInView(stateOf('Text‸'));
    const id = holdPaste(t, t.state.selection);
    t.state = stateOf('Text‸');
    expect(insertHeldPaste(t, id, (state) => plainChange(state, 'new'))).toBe(false);
    expect(t.state.doc.toString()).toBe('Text');
  });
});

describe('paste as plain text', () => {
  it("inserts the clipboard's text with no conversion", async () => {
    const t = standInView(stateOf('A ‸B'));
    const { ctx } = hostContext(async () => undefined);
    expect(await pastePlainFrom(t, ctx, async () => 'https://example.com/\ta\tb')).toBe(true);
    expect(t.state.doc.toString()).toBe('A https://example.com/\ta\tbB');
    expect(t.state.update(t.specs[0]!).isUserEvent('input.paste')).toBe(true);
  });

  it('inserts nothing, and only logs it, when a page with no host may not read the clipboard', async () => {
    const t = standInView(stateOf('A ‸B'));
    const { ctx, notices, logs } = hostContext(async () => undefined);
    expect(
      await pastePlainFrom(t, ctx, async () => Promise.reject(new DOMException('Denied', 'NotAllowedError'))),
    ).toBe(false);
    expect(await pastePlainFrom(t, ctx, undefined)).toBe(false);
    expect(notices).toEqual([]);
    expect(logs.filter((l) => l.message.includes('could not read the clipboard'))).toHaveLength(2);
    expect(t.state.doc.toString()).toBe('A B');
  });

  it('does nothing in Rich view', async () => {
    const t = standInView(stateOf('A ‸B', { mode: 'view' }));
    const { ctx } = hostContext(async () => undefined);
    expect(await pastePlainFrom(t, ctx, async () => 'x')).toBe(false);
    expect(t.state.doc.toString()).toBe('A B');
  });
});
