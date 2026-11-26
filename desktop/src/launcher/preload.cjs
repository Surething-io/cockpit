// Preload for every app window. The launcher API goes only to the local
// launcher page (file:). Cockpit itself, served over http://localhost, gets a
// single cosmetic call (title-bar colours) and nothing that touches files,
// processes or the server: a page a user previews could reach whatever is
// exposed here. The main process re-checks the sender on every call, so this
// is the first fence, not the only one.
const { contextBridge, ipcRenderer } = require('electron');

// The one thing a cockpit page may tell the app: the colours of its top bar,
// so the Windows window controls painted over it match the theme. Top frame
// only (preloads do not run in subframes); main validates origin and values.
if (location.protocol === 'http:' && window.self === window.top) {
  contextBridge.exposeInMainWorld('cockpitDesktop', {
    setTitleBarColors: (color, symbolColor) =>
      ipcRenderer.send('desktop:title-bar-colors', { color, symbolColor }),
  });
}

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('cockpitLauncher', {
    getState: () => ipcRenderer.invoke('launcher:get-state'),
    getStrings: () => ipcRenderer.invoke('launcher:strings'),
    action: (name) => ipcRenderer.invoke('launcher:action', name),
    onState: (callback) => {
      ipcRenderer.on('launcher:state', (_event, state) => callback(state));
    },
  });
}
