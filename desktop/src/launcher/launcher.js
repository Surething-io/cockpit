// Launcher page: renders the main process's boot state and forwards button
// clicks. All logic lives in main.mjs; this file only draws.
const api = window.cockpitLauncher;
const $ = (id) => document.getElementById(id);
let s = {};

const fill = (text, vars = {}) => String(text || '').replace(/\{(\w+)\}/g, (w, k) => (k in vars ? String(vars[k]) : w));

// Per phase: [title key, body, spinner?, buttons as [label key, action, primary?]]
function view(state) {
  switch (state.phase) {
    case 'need-node':
      return {
        title: s.needNodeTitle,
        body: fill(s.needNodeBody, { minNode: state.minNode }),
        note: state.nodeVersion ? fill(s.needNodeFound, { version: state.nodeVersion }) : null,
        buttons: [
          ['getNode', 'open-node-site', true],
          ['retry', 'retry'],
        ],
      };
    case 'need-install':
      return {
        title: s.needInstallTitle,
        body: s.needInstallBody,
        buttons: [
          ['install', 'install', true],
          ['retry', 'retry'],
        ],
      };
    case 'install-failed':
      return {
        title: s.failedTitle,
        body: state.message,
        buttons: [
          ['install', 'install', true],
          ['retry', 'retry'],
        ],
      };
    case 'failed':
      return {
        title: s.failedTitle,
        body: state.message,
        buttons: [
          ['retry', 'retry', true],
          ['openLogs', 'open-logs'],
        ],
      };
    case 'stopped':
      return {
        title: s.stopped,
        buttons: [
          ['start', 'start', true],
          ['openLogs', 'open-logs'],
        ],
      };
    case 'installing':
      return { title: s.installing, spinner: true };
    case 'restarting':
      return { title: s.restarting, spinner: true };
    case 'stopping':
      return { title: s.stopping, spinner: true };
    case 'checking':
      return { title: s.checking, spinner: true };
    default:
      // starting / connected
      return { title: s.starting, spinner: true };
  }
}

function render(state) {
  const v = view(state);
  $('title').textContent = v.title || '';
  $('body').textContent = v.body || '';
  $('body').hidden = !v.body;
  $('note').textContent = v.note || '';
  $('note').hidden = !v.note;
  $('spinner').hidden = !v.spinner;

  const actions = $('actions');
  actions.replaceChildren(
    ...(v.buttons || []).map(([label, action, primary]) => {
      const b = document.createElement('button');
      b.textContent = s[label] || label;
      if (primary) b.className = 'primary';
      b.addEventListener('click', () => {
        for (const other of actions.querySelectorAll('button')) other.disabled = true;
        api.action(action);
      });
      return b;
    }),
  );

  const log = $('log');
  const lines = state.log || [];
  log.hidden = lines.length === 0;
  log.textContent = lines.join('\n');
  log.scrollTop = log.scrollHeight;
}

(async () => {
  s = (await api.getStrings()) || {};
  document.title = s.appName || 'OpenCockpit';
  api.onState(render);
  render((await api.getState()) || { phase: 'checking' });
})();
