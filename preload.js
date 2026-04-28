const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    scan: (dirs) => ipcRenderer.invoke('scan', dirs),
    isDiffuseAvailable: () => ipcRenderer.invoke('is-diffuse-available'),
    openDiffuse: (files) => ipcRenderer.invoke('open-diffuse', files),
    readFiles: (paths) => ipcRenderer.invoke('read-files', paths),
    getFileStats: (paths) => ipcRenderer.invoke('get-file-stats', paths),
    writeFile: (data) => ipcRenderer.invoke('write-file', data),
    copyFile: (data) => ipcRenderer.invoke('copy-file', data),
    deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
    getMainActionHistoryState: () => ipcRenderer.invoke('get-main-action-history-state'),
    undoMainAction: () => ipcRenderer.invoke('undo-main-action'),
    redoMainAction: () => ipcRenderer.invoke('redo-main-action'),
    onFolderChange: (callback) => ipcRenderer.on('folder-changed', callback),
    watchFolders: (dirs) => ipcRenderer.invoke('watch-folders', dirs),
    pickFolder: (initialPath) => ipcRenderer.invoke('pick-folder', initialPath),
    loadConfig: () => ipcRenderer.invoke('load-config'),
    saveConfig: (data) => ipcRenderer.invoke('save-config', data),
    runCommand: (data) => ipcRenderer.invoke('run-command', data),
    copyFolder: (data) => ipcRenderer.invoke('copy-folder', data),
    deleteFolder: (path) => ipcRenderer.invoke('delete-folder', path),
    runMainActions: (actions) => ipcRenderer.invoke('run-main-actions', actions),
    onUpdateStatus: (callback) => {
        const listener = (event, status) => callback(status);
        ipcRenderer.on('update-status', listener);
        return () => ipcRenderer.removeListener('update-status', listener);
    },
});
