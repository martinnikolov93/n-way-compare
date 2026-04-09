const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    scan: (dirs) => ipcRenderer.invoke('scan', dirs),
    openDiffuse: (files) => ipcRenderer.invoke('open-diffuse', files),
    copyFile: (data) => ipcRenderer.invoke('copy-file', data),
    deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
    onFolderChange: (callback) => ipcRenderer.on('folder-changed', callback),
    watchFolders: (dirs) => ipcRenderer.invoke('watch-folders', dirs)
});