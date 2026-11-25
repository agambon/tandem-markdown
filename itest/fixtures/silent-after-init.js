// Served in place of dist/panel/main.js by itest/suite/faults.test.ts: a panel that starts,
// says it is ready, receives its init, and then never answers a flush (as a page that is stuck
// would), so its unsent typing cannot be accounted for. It answers the suite's test messages.
const PROTOCOL = 1; // src/core/protocol.ts
const api = acquireVsCodeApi();
let inits = 0;

window.addEventListener('message', (event) => {
  const m = event.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'init') inits++;
  if (m.type === 'test') {
    api.postMessage({ type: 'testResult', requestId: m.requestId, result: { silentPage: true, inits, text: '', cspViolations: [] } });
  }
});

api.postMessage({ type: 'ready', protocol: PROTOCOL });
