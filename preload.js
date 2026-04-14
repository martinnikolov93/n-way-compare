const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    scan: (dirs) => ipcRenderer.invoke('scan', dirs),
    openDiffuse: (files) => ipcRenderer.invoke('open-diffuse', files),
    copyFile: (data) => ipcRenderer.invoke('copy-file', data),
    deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
    onFolderChange: (callback) => ipcRenderer.on('folder-changed', callback),
    watchFolders: (dirs) => ipcRenderer.invoke('watch-folders', dirs),
    loadConfig: () => ipcRenderer.invoke('load-config'),
    saveConfig: (data) => ipcRenderer.invoke('save-config', data),
    runCommand: (data) => ipcRenderer.invoke('run-command', data),
    copyFolder: (data) => ipcRenderer.invoke('copy-folder', data),
    deleteFolder: (path) => ipcRenderer.invoke('delete-folder', path),
});