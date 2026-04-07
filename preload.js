const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    scan: (dirs) => ipcRenderer.invoke('scan', dirs),
    openDiffuse: (files) => ipcRenderer.invoke('open-diffuse', files),
    copyFile: (data) => ipcRenderer.invoke('copy-file', data)
});