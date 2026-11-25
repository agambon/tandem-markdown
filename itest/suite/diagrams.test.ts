/// <reference types="mocha" />
// Mermaid diagrams in a real VS Code, for what the browser specs cannot show: the frame they are
// drawn in starts inside VS Code's webview, under its origin and its policy, and draws with no
// violation; and while a large diagram is drawn the page goes on answering, which holds only
// when VS Code's Chromium runs the frame apart from the page. What diagrams look like, and what
// the frame may reach, is checked in the browser (harness/tests/drawn.spec.mjs).

import * as assert from 'node:assert/strict';
import { api, closeEverything, note, openRich, waitFor, writeFile } from './helpers';

/** A flowchart that takes Mermaid seconds to lay out. */
function largeFlowchart(nodes: number): string {
  const lines = ['graph TD;'];
  for (let i = 0; i < nodes; i++) lines.push(`  N${i}[Node ${i}] --> N${(i * 7 + 3) % nodes}`);
  for (let i = 0; i < nodes; i++) lines.push(`  N${i} --> N${(i * 13 + 5) % nodes}`);
  return lines.join('\n');
}

suite('Diagrams', () => {
  teardown(closeEverything);

  test('a diagram draws in its frame under the webview policy, with no violation', async () => {
    const hook = await api();
    hook.clearRecords();
    const uri = writeFile('diagrams/Flow.md', '# Flow\n\n```mermaid\ngraph TD;\n  A[Start] --> B{Is it?};\n```\n');
    await openRich(uri);
    await waitFor(
      async () => {
        const widgets = (await hook.panelState(uri)).widgets.join(' | ');
        return widgets.includes('tm-drawn-diagram') && !widgets.includes('tm-drawn-waiting');
      },
      'the diagram to be drawn',
      30_000,
    );
    const state = await hook.panelState(uri);
    assert.ok(!state.widgets.some((w) => w.includes('tm-drawn-failed')), state.widgets.join('\n'));
    assert.deepEqual(state.cspViolations, []);
    const lines = hook.logLines().map((line) => JSON.stringify(line));
    assert.ok(!lines.some((line) => /diagram frame|Diagrams could not|draws Diagram/i.test(line)), lines.join('\n'));
  });

  test('while a large diagram is drawn, the page goes on answering', async () => {
    const hook = await api();
    const uri = writeFile('diagrams/Large.md', `# Large\n\n\`\`\`mermaid\n${largeFlowchart(100)}\n\`\`\`\n`);
    await openRich(uri);
    const answers: number[] = [];
    const started = Date.now();
    let drawn = false;
    while (!drawn && Date.now() - started < 30_000) {
      const asked = Date.now();
      const widgets = (await hook.panelState(uri)).widgets.join(' | ');
      answers.push(Date.now() - asked);
      drawn = widgets.includes('tm-drawn-diagram') && !widgets.includes('tm-drawn-waiting');
    }
    assert.ok(drawn, 'the large diagram was not drawn within 30 seconds');
    note(
      `the page answered ${answers.length} times while the diagram was drawn, the slowest in ${Math.max(...answers)} ms`,
    );
    // A page blocked by Mermaid would answer once, after the drawing; one that goes on answering
    // answers many times while it lasts.
    assert.ok(answers.length > 5, `the page answered ${answers.length} times while the diagram was drawn`);
  });
});
