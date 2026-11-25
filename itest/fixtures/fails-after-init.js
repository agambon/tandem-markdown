// Served in place of dist/panel/main.js by itest/suite/faults.test.ts: a panel that starts,
// says it is ready, receives its init, and then fails as boot.ts does when building the editor
// throws: it posts startFailed and draws "Tandem Markdown could not start in this tab." with Show Source.
// From then on it answers nothing but the suite's test messages (its state, and a click on the
// button).
const PROTOCOL = 1; // src/core/protocol.ts
const api = acquireVsCodeApi();
const root = document.getElementById('tm-root');
let button = null;

function fail() {
  api.postMessage({ type: 'startFailed', detail: 'Failed on purpose after its init' });
  const box = document.createElement('div');
  const text = document.createElement('p');
  text.textContent = 'Tandem Markdown could not start in this tab.';
  button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Show Source';
  button.addEventListener('click', () => api.postMessage({ type: 'showSource' }));
  box.append(text, button);
  root.append(box);
}

window.addEventListener('message', (event) => {
  const m = event.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'init' && button === null) fail();
  if (m.type === 'test') {
    for (const a of Array.isArray(m.actions) ? m.actions : []) {
      if (a && a.type === 'click' && a.target === 'showSource' && button) button.click();
    }
    api.postMessage({ type: 'testResult', requestId: m.requestId, result: { failurePage: button !== null, text: root.textContent, cspViolations: [] } });
  }
});

api.postMessage({ type: 'ready', protocol: PROTOCOL });
