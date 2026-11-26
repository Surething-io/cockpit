// Preload for every app window. The launcher API goes only to the local
// launcher page (file:). Cockpit itself, served over http://localhost, gets a
// single cosmetic call (its theme setting) and nothing that touches files,
// processes or the server: a page a user previews could reach whatever is
// exposed here. The main process re-checks the sender on every call, so this
// is the first fence, not the only one.
const { contextBridge, ipcRenderer } = require('electron');

// The one thing a cockpit page may tell the app: its theme setting
// ('system' | 'light' | 'dark'), so the native title bar matches. Top frame
// only (preloads do not run in subframes); main validates origin and value.
if (location.protocol === 'http:' && window.self === window.top) {
  contextBridge.exposeInMainWorld('cockpitDesktop', {
    setTheme: (theme) => ipcRenderer.send('desktop:theme', theme),
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
