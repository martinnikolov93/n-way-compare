const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');
const DifferenceFileTypes = require('./difference-file-types');

let mainWindow = null;
let updatePromptOpen = false;
let updateDownloadInProgress = false;

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        icon: path.join(__dirname, 'assets', 'app-icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js')
        }
    });

    win.loadFile('index.html');
    mainWindow = win;

    win.on('closed', () => {
        if (mainWindow === win) {
            mainWindow = null;
        }
    });
}

function getUpdateDialogWindow() {
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
}

function showUpdateMessage(options) {
    const ownerWindow = getUpdateDialogWindow();
    return ownerWindow
        ? dialog.showMessageBox(ownerWindow, options)
        : dialog.showMessageBox(options);
}

function formatUpdateVersion(info = {}) {
    return info.version ? `v${info.version}` : 'the latest version';
}

function setUpdateProgress(value) {
    const ownerWindow = getUpdateDialogWindow();

    if (ownerWindow) {
        ownerWindow.setProgressBar(value);
    }
}

function sendUpdateStatus(status) {
    const ownerWindow = getUpdateDialogWindow();

    if (ownerWindow) {
        ownerWindow.webContents.send('update-status', status);
    }
}

function configureAutoUpdater() {
    if (!app.isPackaged) {
        return;
    }

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('update-available', async info => {
        if (updatePromptOpen || updateDownloadInProgress) {
            return;
        }

        updatePromptOpen = true;

        try {
            const result = await showUpdateMessage({
                type: 'info',
                buttons: ['Update now', 'Later'],
                defaultId: 0,
                cancelId: 1,
                title: 'Update available',
                message: `N-Way Compare ${formatUpdateVersion(info)} is available.`,
                detail: `You are currently using v${app.getVersion()}.\n\nIf you update now, the app will download the latest installer and restart to complete the update.`
            });

            if (result.response !== 0) {
                return;
            }

            updateDownloadInProgress = true;
            setUpdateProgress(2);
            sendUpdateStatus({
                state: 'downloading',
                version: info.version || null,
                percent: 0,
                transferred: 0,
                total: 0
            });
            autoUpdater.downloadUpdate();
        } finally {
            updatePromptOpen = false;
        }
    });

    autoUpdater.on('download-progress', progress => {
        if (typeof progress?.percent === 'number') {
            setUpdateProgress(Math.max(0, Math.min(1, progress.percent / 100)));
        }

        sendUpdateStatus({
            state: 'progress',
            percent: typeof progress?.percent === 'number' ? progress.percent : 0,
            transferred: progress?.transferred || 0,
            total: progress?.total || 0,
            bytesPerSecond: progress?.bytesPerSecond || 0
        });
    });

    autoUpdater.on('update-downloaded', () => {
        updateDownloadInProgress = false;
        sendUpdateStatus({
            state: 'installing',
            percent: 100
        });
        setUpdateProgress(-1);
        autoUpdater.quitAndInstall(false, true);
    });

    autoUpdater.on('error', async err => {
        const shouldNotify = updateDownloadInProgress;
        updateDownloadInProgress = false;
        setUpdateProgress(-1);

        if (!shouldNotify) {
            console.error('Update check failed:', err);
            sendUpdateStatus({
                state: 'idle'
            });
            return;
        }

        sendUpdateStatus({
            state: 'error',
            message: err?.message || String(err)
        });

        await showUpdateMessage({
            type: 'error',
            buttons: ['OK'],
            title: 'Update failed',
            message: 'N-Way Compare could not complete the update.',
            detail: err?.message || String(err)
        });

        sendUpdateStatus({
            state: 'idle'
        });
    });

    setTimeout(() => {
        autoUpdater.checkForUpdates().catch(err => {
            console.error('Update check failed:', err);
        });
    }, 1500);
}

app.whenReady().then(() => {
    createWindow();
    configureAutoUpdater();
});

const chokidar = require('chokidar');
let folderWatcher = null;
let activeScanState = null;
const WATCH_DEBOUNCE_MS = 120;
const WATCH_MAX_WAIT_MS = 700;

function normalizeExclusionPattern(pattern = '') {
    return String(pattern)
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '');
}

function normalizePathForMatch(relativePath = '') {
    return String(relativePath)
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '');
}

function escapeRegExp(value) {
    return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(pattern) {
    const normalized = normalizeExclusionPattern(pattern);
    let source = '';

    for (let index = 0; index < normalized.length; index += 1) {
        const char = normalized[index];
        const nextChar = normalized[index + 1];

        if (char === '*' && nextChar === '*') {
            source += '.*';
            index += 1;
            continue;
        }

        if (char === '*') {
            source += '[^/]*';
            continue;
        }

        if (char === '?') {
            source += '[^/]';
            continue;
        }

        source += escapeRegExp(char);
    }

    return new RegExp(`^${source}$`, 'i');
}

function createExclusionMatcher(patterns = []) {
    const normalizedPatterns = Array.from(new Set(
        (Array.isArray(patterns) ? patterns : [])
            .map(normalizeExclusionPattern)
            .filter(Boolean)
    ));

    const rules = normalizedPatterns.map(pattern => {
        const hasSlash = pattern.includes('/');
        const hasWildcard = /[*?]/.test(pattern);

        return {
            pattern,
            hasSlash,
            hasWildcard,
            regex: hasWildcard ? globToRegExp(pattern) : null
        };
    });

    return {
        patterns: normalizedPatterns,
        signature: [...normalizedPatterns].sort((left, right) => left.localeCompare(right)).join('||'),
        matches(relativePath = '') {
            const normalizedPath = normalizePathForMatch(relativePath);
            if (!normalizedPath) {
                return false;
            }

            const segments = normalizedPath.split('/');
            const basename = segments[segments.length - 1];

            return rules.some(rule => {
                if (rule.hasWildcard) {
                    if (rule.hasSlash && rule.pattern.endsWith('/**')) {
                        const subtreeRoot = rule.pattern.slice(0, -3);
                        if (normalizedPath === subtreeRoot || normalizedPath.startsWith(`${subtreeRoot}/`)) {
                            return true;
                        }
                    }

                    return rule.hasSlash
                        ? rule.regex.test(normalizedPath)
                        : rule.regex.test(basename);
                }

                if (rule.hasSlash) {
                    return normalizedPath === rule.pattern || normalizedPath.startsWith(`${rule.pattern}/`);
                }

                return segments.includes(rule.pattern);
            });
        }
    };
}

function normalizeScanRequest(input) {
    if (Array.isArray(input)) {
        return {
            dirs: input,
            exclusions: []
        };
    }

    if (!input || typeof input !== 'object') {
        return {
            dirs: [],
            exclusions: []
        };
    }

    return {
        dirs: Array.isArray(input.dirs) ? input.dirs : [],
        exclusions: Array.isArray(input.exclusions) ? input.exclusions : []
    };
}

function getDirsSignature(baseDirs, exclusions = []) {
    const exclusionSignature = Array.isArray(exclusions)
        ? [...exclusions].map(normalizeExclusionPattern).filter(Boolean).sort((left, right) => left.localeCompare(right)).join('||')
        : '';
    return `${baseDirs.map(dir => path.resolve(dir)).join('||')}::exclusions::${exclusionSignature}`;
}

function createScanState(baseDirs, exclusions = []) {
    const resolvedDirs = baseDirs.map(dir => path.resolve(dir));
    const exclusionMatcher = createExclusionMatcher(exclusions);

    return {
        signature: getDirsSignature(resolvedDirs, exclusionMatcher.patterns),
        baseDirs: resolvedDirs,
        exclusionMatcher,
        map: {},
        entriesByDir: resolvedDirs.map(() => new Map()),
        dirtyRootsByDir: resolvedDirs.map(() => new Set([''])),
        initialized: false
    };
}

function normalizeRelativePath(relativePath) {
    if (!relativePath || relativePath === '.') {
        return '';
    }

    return path.normalize(relativePath);
}

function isExcludedRelativePath(state, relativePath) {
    return Boolean(state?.exclusionMatcher?.matches(relativePath));
}

function isSameOrDescendantPath(candidate, root) {
    if (!root) {
        return true;
    }

    return candidate === root || candidate.startsWith(root + path.sep);
}

function markStateDirty(state, dirIndex, relativePath = '') {
    const dirtyRoots = state?.dirtyRootsByDir?.[dirIndex];
    if (!dirtyRoots) {
        return;
    }

    const normalizedPath = normalizeRelativePath(relativePath);

    if (normalizedPath && isExcludedRelativePath(state, normalizedPath)) {
        return;
    }

    if (!normalizedPath) {
        dirtyRoots.clear();
        dirtyRoots.add('');
        return;
    }

    if (dirtyRoots.has('')) {
        return;
    }

    const descendantsToRemove = [];

    for (const dirtyRoot of dirtyRoots) {
        if (isSameOrDescendantPath(normalizedPath, dirtyRoot)) {
            return;
        }

        if (isSameOrDescendantPath(dirtyRoot, normalizedPath)) {
            descendantsToRemove.push(dirtyRoot);
        }
    }

    descendantsToRemove.forEach(dirtyRoot => dirtyRoots.delete(dirtyRoot));
    dirtyRoots.add(normalizedPath);
}

function markPathDirty(fullPath) {
    if (!activeScanState || !fullPath) {
        return;
    }

    const resolvedPath = path.resolve(fullPath);

    activeScanState.baseDirs.forEach((baseDir, dirIndex) => {
        const relativePath = path.relative(baseDir, resolvedPath);

        if (relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))) {
            markStateDirty(activeScanState, dirIndex, relativePath);
        }
    });
}

function markPathsDirty(pathsToMark) {
    pathsToMark.forEach(fullPath => markPathDirty(fullPath));
}

function isExcludedWatchedPath(changedPath, watchedFolders, exclusionMatcher) {
    if (!changedPath || !exclusionMatcher) {
        return false;
    }

    const resolvedPath = path.resolve(changedPath);

    return watchedFolders.some(folder => {
        const relativePath = path.relative(path.resolve(folder), resolvedPath);
        if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
            return false;
        }

        return exclusionMatcher.matches(relativePath);
    });
}

function getWatcherIgnoreReason(event, changedPath, watchedFolders, exclusionMatcher = null) {
    if (!changedPath) {
        return 'missing-path';
    }

    if (isExcludedWatchedPath(changedPath, watchedFolders, exclusionMatcher)) {
        return 'excluded-path';
    }

    const resolvedPath = path.resolve(changedPath);
    const resolvedRoots = watchedFolders.map(folder => path.resolve(folder));

    if (event === 'change') {
        if (resolvedRoots.includes(resolvedPath)) {
            return 'root-directory-change';
        }

        try {
            if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
                return 'directory-metadata-change';
            }
        } catch {
            // If the path disappeared between events, let the scan path handle it.
        }
    }

    return null;
}

function shouldIgnoreWatcherEvent(event, changedPath, watchedFolders, exclusionMatcher = null) {
    return Boolean(getWatcherIgnoreReason(event, changedPath, watchedFolders, exclusionMatcher));
}

function setStateEntry(state, dirIndex, relativePath, entry) {
    state.entriesByDir[dirIndex].set(relativePath, entry);

    if (!state.map[relativePath]) {
        state.map[relativePath] = {};
    }

    state.map[relativePath][dirIndex] = entry;
}

function removeStateEntry(state, dirIndex, relativePath) {
    state.entriesByDir[dirIndex].delete(relativePath);

    const mapEntry = state.map[relativePath];
    if (!mapEntry) {
        return;
    }

    delete mapEntry[dirIndex];

    if (!Object.keys(mapEntry).length) {
        delete state.map[relativePath];
    }
}

// С„СѓРЅРєС†РёСЏ Р·Р° watch
function watchFolders(folders, exclusions = []) {
    if (folderWatcher) {
        folderWatcher.close();
    }

    const exclusionMatcher = createExclusionMatcher(exclusions);

    folderWatcher = chokidar.watch(folders, {
        ignored: changedPath => isExcludedWatchedPath(changedPath, folders, exclusionMatcher),
        ignoreInitial: true,
        persistent: true,
        depth: 99
    });

    let scanTimeout = null;
    let burstStartedAt = 0;

    const flushScan = () => {
        if (scanTimeout) {
            clearTimeout(scanTimeout);
            scanTimeout = null;
        }

        burstStartedAt = 0;

        BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('folder-changed');
        });
    };

    const triggerScan = () => {
        const now = Date.now();

        if (!burstStartedAt) {
            burstStartedAt = now;
        }

        if (scanTimeout) {
            clearTimeout(scanTimeout);
        }

        const elapsed = now - burstStartedAt;
        const remainingMaxWait = Math.max(0, WATCH_MAX_WAIT_MS - elapsed);
        const delay = Math.min(WATCH_DEBOUNCE_MS, remainingMaxWait);

        scanTimeout = setTimeout(() => {
            flushScan();
        }, delay);
    };

    folderWatcher.on('all', (event, changedPath) => {
        const ignoreReason = getWatcherIgnoreReason(event, changedPath, folders, exclusionMatcher);

        if (ignoreReason) {
            return;
        }

        markPathDirty(changedPath);

        triggerScan();
    });
}

ipcMain.handle('watch-folders', async (e, input) => {
    const { dirs, exclusions } = normalizeScanRequest(input);
    watchFolders(dirs, exclusions);
});

function hashFile(filePath) {
    try {
        const stat = fs.statSync(filePath);
        return stat.size + '-' + stat.mtimeMs; // faster than full hash
    } catch {
        return null;
    }
}

function collectDirectoryEntries(state, dirIndex, currentDir, rel = '', options = {}) {
    const { suppressErrors = false, impactedFiles = null, impactedPaths = null } = options;
    let dirEntries;

    try {
        dirEntries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (err) {
        if (suppressErrors) {
            return;
        }

        throw err;
    }

    dirEntries.forEach(entry => {
        const full = path.join(currentDir, entry.name);
        const relative = rel ? path.join(rel, entry.name) : entry.name;

        if (isExcludedRelativePath(state, relative)) {
            return;
        }

        if (entry.isDirectory()) {
            setStateEntry(state, dirIndex, relative, {
                path: full,
                isDir: true
            });

            if (impactedPaths) {
                impactedPaths.add(relative);
            }

            collectDirectoryEntries(state, dirIndex, full, relative, {
                suppressErrors,
                impactedFiles,
                impactedPaths
            });
            return;
        }

        const fileEntry = {
            path: full,
            isDir: false,
            hash: null
        };

        setStateEntry(state, dirIndex, relative, fileEntry);

        if (impactedFiles) {
            impactedFiles.add(relative);
        }

        if (impactedPaths) {
            impactedPaths.add(relative);
        }
    });
}

function removeEntriesUnderRoot(state, dirIndex, relativeRoot, impactedFiles, impactedPaths, fullPath = null) {
    const normalizedRoot = normalizeRelativePath(relativeRoot);

    if (normalizedRoot) {
        const directEntry = state.entriesByDir[dirIndex].get(normalizedRoot);

        if (directEntry && !directEntry.isDir) {
            if (impactedPaths) {
                impactedPaths.add(normalizedRoot);
            }

            impactedFiles.add(normalizedRoot);
            hashCache.delete(directEntry.path);
            removeStateEntry(state, dirIndex, normalizedRoot);
            return;
        }

        if (!directEntry && fullPath) {
            try {
                const stat = fs.statSync(fullPath);

                if (stat.isFile()) {
                    if (impactedPaths) {
                        impactedPaths.add(normalizedRoot);
                    }

                    return;
                }
            } catch {
                // Fall back to the subtree walk for missing or unreadable paths.
            }
        }
    }

    const entries = Array.from(state.entriesByDir[dirIndex].entries());

    entries.forEach(([relativePath, entry]) => {
        if (!normalizedRoot || isSameOrDescendantPath(relativePath, normalizedRoot)) {
            if (impactedPaths) {
                impactedPaths.add(relativePath);
            }

            if (entry && !entry.isDir) {
                impactedFiles.add(relativePath);
                hashCache.delete(entry.path);
            }

            removeStateEntry(state, dirIndex, relativePath);
        }
    });
}

function scanExistingRoot(state, dirIndex, relativeRoot, impactedFiles, impactedPaths) {
    const baseDir = state.baseDirs[dirIndex];
    const fullPath = relativeRoot ? path.join(baseDir, relativeRoot) : baseDir;

    if (relativeRoot && isExcludedRelativePath(state, relativeRoot)) {
        return;
    }

    if (!fs.existsSync(fullPath)) {
        return;
    }

    let stat;

    try {
        stat = fs.statSync(fullPath);
    } catch {
        return;
    }

    if (stat.isDirectory()) {
        if (relativeRoot) {
            setStateEntry(state, dirIndex, relativeRoot, {
                path: fullPath,
                isDir: true
            });

            if (impactedPaths) {
                impactedPaths.add(relativeRoot);
            }
        }

        collectDirectoryEntries(state, dirIndex, fullPath, relativeRoot, {
            suppressErrors: true,
            impactedFiles,
            impactedPaths
        });
        return;
    }

    const fileEntry = {
        path: fullPath,
        isDir: false,
        hash: null
    };

    setStateEntry(state, dirIndex, relativeRoot, fileEntry);
    impactedFiles.add(relativeRoot);

    if (impactedPaths) {
        impactedPaths.add(relativeRoot);
    }
}

function finalizeHashesForRelativePaths(state, relativePaths) {
    relativePaths.forEach(relativePath => {
        const mapEntry = state.map[relativePath];

        if (!mapEntry) {
            return;
        }

        const fileEntries = Object.values(mapEntry).filter(entry => entry && !entry.isDir);

        if (!fileEntries.length) {
            return;
        }

        if (fileEntries.length === 1) {
            fileEntries[0].hash = '__FILE_PRESENT__';
            return;
        }

        fileEntries.forEach(fileEntry => {
            fileEntry.hash = getSmartHash(fileEntry.path);
        });
    });
}

function hasPendingDirtyUpdates(state) {
    return state.dirtyRootsByDir.some(dirtyRoots => dirtyRoots.size > 0);
}

function buildIncrementalPayload(state, impactedPaths) {
    if (!impactedPaths.size) {
        return { mode: 'noop' };
    }

    const currentPathCount = Object.keys(state.map).length;
    if (impactedPaths.size > currentPathCount * 0.6) {
        return {
            mode: 'full',
            data: state.map
        };
    }

    const upserts = {};
    const removals = [];

    impactedPaths.forEach(relativePath => {
        if (state.map[relativePath]) {
            upserts[relativePath] = state.map[relativePath];
            return;
        }

        removals.push(relativePath);
    });

    if (!Object.keys(upserts).length && !removals.length) {
        return { mode: 'noop' };
    }

    return {
        mode: 'patch',
        upserts,
        removals
    };
}

function performFullScan(state) {
    state.map = {};
    state.entriesByDir = state.baseDirs.map(() => new Map());

    const impactedFiles = new Set();

    state.baseDirs.forEach((dir, dirIndex) => {
        collectDirectoryEntries(state, dirIndex, dir, '', {
            suppressErrors: false,
            impactedFiles
        });
    });

    finalizeHashesForRelativePaths(state, impactedFiles);
    state.dirtyRootsByDir = state.baseDirs.map(() => new Set());
    state.initialized = true;
}

function applyDirtyUpdates(state) {
    const impactedFiles = new Set();
    const impactedPaths = new Set();

    state.dirtyRootsByDir.forEach((dirtyRoots, dirIndex) => {
        if (!dirtyRoots.size) {
            return;
        }

        const rootsToRefresh = Array.from(dirtyRoots).sort((left, right) => left.length - right.length);
        dirtyRoots.clear();

        rootsToRefresh.forEach(relativeRoot => {
            const fullPath = relativeRoot ? path.join(state.baseDirs[dirIndex], relativeRoot) : state.baseDirs[dirIndex];
            removeEntriesUnderRoot(state, dirIndex, relativeRoot, impactedFiles, impactedPaths, fullPath);
            scanExistingRoot(state, dirIndex, relativeRoot, impactedFiles, impactedPaths);
        });
    });

    finalizeHashesForRelativePaths(state, impactedFiles);
    return buildIncrementalPayload(state, impactedPaths);
}

function scanDirs(baseDirs, exclusions = []) {
    const signature = getDirsSignature(baseDirs, exclusions);

    if (!activeScanState || activeScanState.signature !== signature) {
        activeScanState = createScanState(baseDirs, exclusions);
    }

    if (!activeScanState.initialized) {
        performFullScan(activeScanState);
        return {
            mode: 'full',
            data: activeScanState.map
        };
    }

    if (!hasPendingDirtyUpdates(activeScanState)) {
        return {
            mode: 'noop'
        };
    }

    return applyDirtyUpdates(activeScanState);
}

function resolveDialogDefaultPath(inputPath = '') {
    if (!inputPath || typeof inputPath !== 'string') {
        return undefined;
    }

    let candidatePath = path.resolve(inputPath.trim());

    while (candidatePath && candidatePath !== path.dirname(candidatePath)) {
        if (fs.existsSync(candidatePath)) {
            try {
                return fs.statSync(candidatePath).isDirectory()
                    ? candidatePath
                    : path.dirname(candidatePath);
            } catch {
                return path.dirname(candidatePath);
            }
        }

        candidatePath = path.dirname(candidatePath);
    }

    if (candidatePath && fs.existsSync(candidatePath)) {
        return candidatePath;
    }

    return undefined;
}

ipcMain.handle('pick-folder', async (event, initialPath) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const defaultPath = resolveDialogDefaultPath(initialPath);
    const result = await dialog.showOpenDialog(browserWindow, {
        properties: ['openDirectory'],
        defaultPath
    });

    if (result.canceled) {
        return null;
    }

    return result.filePaths[0] || null;
});

ipcMain.handle('load-config', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
    });

    if (result.canceled) return null;

    const filePath = result.filePaths[0];

    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (err) {
        console.error('Config load error:', err);
        throw err;
    }
});

ipcMain.handle('save-config', async (e, data) => {
    const { dialog } = require('electron');

    const result = await dialog.showSaveDialog({
        filters: [{ name: 'JSON', extensions: ['json'] }]
    });

    if (result.canceled) return;

    try {
        fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf-8');
        return { success: true };
    } catch (err) {
        console.error('Save error:', err);
        throw err;
    }
});

ipcMain.handle('run-command', async (e, { dirs, command }) => {
    const { spawn } = require('child_process');

    try {
        dirs.forEach(dir => {
            // СЃС‚Р°СЂС‚РёСЂР° cmd РІ С‚Р°Р·Рё РїР°РїРєР°
            spawn('cmd.exe', ['/c', command], {
                cwd: dir,
                detached: true,
                stdio: 'ignore',
                shell: true
            });
        });

        return { success: true };
    } catch (err) {
        console.error('CMD error:', err);
        throw err;
    }
});

ipcMain.handle('scan', async (e, input) => {
    const { dirs, exclusions } = normalizeScanRequest(input);
    return scanDirs(dirs, exclusions);
});

ipcMain.handle('open-diffuse', async (e, files) => {
    // Windows-safe execution using spawn instead of exec
    const { spawn } = require('child_process');

    const args = files.map(f => f);

    const proc = spawn('diffuse', args, {
        detached: true,
        stdio: 'ignore',
        shell: true
    });

});

ipcMain.handle('read-files', async (e, filePaths) => {
    return filePaths.map(filePath => {
        const imageFile = DifferenceFileTypes.isImageFilePath(filePath);

        try {
            if (!filePath || !fs.existsSync(filePath)) {
                return {
                    path: filePath,
                    exists: false,
                    kind: imageFile ? 'image' : 'text',
                    content: '',
                    dataUrl: '',
                    mimeType: imageFile
                        ? DifferenceFileTypes.getMimeTypeForFilePath(filePath)
                        : ''
                };
            }

            if (imageFile) {
                const buffer = fs.readFileSync(filePath);
                const mimeType = DifferenceFileTypes.getMimeTypeForFilePath(filePath);

                return {
                    path: filePath,
                    exists: true,
                    kind: 'image',
                    content: '',
                    dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
                    mimeType
                };
            }

            return {
                path: filePath,
                exists: true,
                kind: 'text',
                content: fs.readFileSync(filePath, 'utf8')
            };
        } catch (err) {
            return {
                path: filePath,
                exists: false,
                kind: imageFile ? 'image' : 'text',
                content: '',
                dataUrl: '',
                mimeType: imageFile
                    ? DifferenceFileTypes.getMimeTypeForFilePath(filePath)
                    : '',
                error: err.message
            };
        }
    });
});

ipcMain.handle('write-file', async (e, { path: filePath, content }) => {
    try {
        const dirPath = path.dirname(filePath);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }

        fs.writeFileSync(filePath, content, 'utf8');

        return {
            success: true,
            path: filePath
        };
    } catch (err) {
        console.error('Write error:', err);
        throw err;
    }
});

const ACTION_HISTORY_LIMIT = 50;
const actionUndoStack = [];
const actionRedoStack = [];

function cleanupActionHistory() {
    [...actionUndoStack, ...actionRedoStack].forEach(cleanupActionRecord);
    actionUndoStack.length = 0;
    actionRedoStack.length = 0;
}

app.on('before-quit', cleanupActionHistory);

function getActionHistoryState() {
    const undoAction = actionUndoStack[actionUndoStack.length - 1] || null;
    const redoAction = actionRedoStack[actionRedoStack.length - 1] || null;

    return {
        canUndo: Boolean(undoAction),
        canRedo: Boolean(redoAction),
        undoLabel: undoAction?.label || '',
        redoLabel: redoAction?.label || ''
    };
}

function normalizeActionTargets(value) {
    return (Array.isArray(value) ? value : [value])
        .map(target => String(target || '').trim())
        .filter(Boolean);
}

function createActionRecord(type, label) {
    const tempRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'n-way-action-'));

    return {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type,
        label,
        backupRoot: tempRoot,
        items: []
    };
}

function cleanupActionRecord(record) {
    if (!record?.backupRoot || !fs.existsSync(record.backupRoot)) {
        return;
    }

    try {
        fs.rmSync(record.backupRoot, { recursive: true, force: true });
    } catch (err) {
        console.warn('Could not clean action backup:', err);
    }
}

function clearRedoHistory() {
    while (actionRedoStack.length) {
        cleanupActionRecord(actionRedoStack.pop());
    }
}

function pushUndoAction(record) {
    if (!record.items.length) {
        cleanupActionRecord(record);
        return;
    }

    clearRedoHistory();
    actionUndoStack.push(record);

    while (actionUndoStack.length > ACTION_HISTORY_LIMIT) {
        cleanupActionRecord(actionUndoStack.shift());
    }
}

function ensureParentDir(targetPath) {
    const dirPath = path.dirname(targetPath);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function removePath(targetPath) {
    if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { recursive: true, force: true });
    }
}

function copyPath(srcPath, destPath) {
    const stat = fs.statSync(srcPath);
    ensureParentDir(destPath);

    if (stat.isDirectory()) {
        fs.cpSync(srcPath, destPath, { recursive: true, force: true });
        return;
    }

    fs.copyFileSync(srcPath, destPath);
}

function copyDirectoryContents(srcDir, destDir) {
    if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
    }

    fs.readdirSync(srcDir, { withFileTypes: true }).forEach(entry => {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);

        if (entry.isDirectory()) {
            copyDirectoryContents(srcPath, destPath);
        } else {
            ensureParentDir(destPath);
            fs.copyFileSync(srcPath, destPath);
        }
    });
}

function capturePathState(record, targetPath, itemIndex, stateName) {
    if (!fs.existsSync(targetPath)) {
        return {
            existed: false,
            backupPath: ''
        };
    }

    const backupPath = path.join(record.backupRoot, String(itemIndex), stateName);
    copyPath(targetPath, backupPath);

    return {
        existed: true,
        backupPath
    };
}

function restorePathState(targetPath, state) {
    removePath(targetPath);

    if (state?.existed) {
        copyPath(state.backupPath, targetPath);
    }
}

function rollbackAction(record) {
    record.items
        .slice()
        .reverse()
        .forEach(item => restorePathState(item.target, item.before));
}

function notifyFolderChanged() {
    BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
            win.webContents.send('folder-changed');
        }
    });
}

function applyActionState(record, stateName) {
    const rollbackStateName = stateName === 'before' ? 'after' : 'before';
    const appliedItems = [];

    try {
        record.items.forEach(item => {
            restorePathState(item.target, item[stateName]);
            appliedItems.push(item);
        });
    } catch (err) {
        appliedItems
            .slice()
            .reverse()
            .forEach(item => restorePathState(item.target, item[rollbackStateName]));
        throw err;
    }

    markPathsDirty(record.items.map(item => item.target));
    notifyFolderChanged();
}

function countMainActionTargets(action) {
    return normalizeActionTargets(action?.targets).length;
}

function normalizeMainActions(actions) {
    return (Array.isArray(actions) ? actions : [actions])
        .filter(Boolean)
        .map(action => ({
            type: String(action.type || '').trim(),
            src: action.src ? String(action.src) : '',
            targets: normalizeActionTargets(action.targets)
        }))
        .filter(action => action.type && action.targets.length);
}

function createMainActionLabel(actions) {
    if (actions.length === 1) {
        const [action] = actions;
        const count = countMainActionTargets(action);

        if (action.type === 'copy-file') {
            return `Copy ${count} file${count === 1 ? '' : 's'}`;
        }

        if (action.type === 'delete-file') {
            return `Delete ${count} file${count === 1 ? '' : 's'}`;
        }

        if (action.type === 'copy-folder') {
            return `Copy ${count} folder${count === 1 ? '' : 's'}`;
        }

        if (action.type === 'delete-folder') {
            return `Delete ${count} folder${count === 1 ? '' : 's'}`;
        }
    }

    const copied = actions
        .filter(action => action.type.startsWith('copy-'))
        .reduce((total, action) => total + countMainActionTargets(action), 0);
    const deleted = actions
        .filter(action => action.type.startsWith('delete-'))
        .reduce((total, action) => total + countMainActionTargets(action), 0);
    const parts = [];

    if (copied) {
        parts.push(`${copied} copied`);
    }

    if (deleted) {
        parts.push(`${deleted} deleted`);
    }

    return `Batch action (${parts.join(', ') || '0 items'})`;
}

function getCopyTargets(action) {
    const resolvedSource = path.resolve(action.src);
    return normalizeActionTargets(action.targets)
        .filter(target => path.resolve(target) !== resolvedSource);
}

function appendCopyFileAction(record, action) {
    if (!action.src || !fs.existsSync(action.src)) {
        throw new Error(`Source file does not exist: ${action.src}`);
    }

    const targets = getCopyTargets(action);

    targets.forEach(target => {
        const index = record.items.length;
        const before = capturePathState(record, target, index, 'before');
        const item = { target, before, after: { existed: false, backupPath: '' } };
        record.items.push(item);

        ensureParentDir(target);
        fs.copyFileSync(action.src, target);
        item.after = capturePathState(record, target, index, 'after');
    });

    return targets;
}

function appendDeleteFileAction(record, action) {
    const targets = normalizeActionTargets(action.targets);

    targets.forEach(target => {
        const index = record.items.length;
        const before = capturePathState(record, target, index, 'before');
        const item = {
            target,
            before,
            after: {
                existed: false,
                backupPath: ''
            }
        };
        record.items.push(item);

        if (before.existed) {
            removePath(target);
        }
    });

    return targets;
}

function appendCopyFolderAction(record, action) {
    if (!action.src || !fs.existsSync(action.src)) {
        throw new Error(`Source folder does not exist: ${action.src}`);
    }

    const targets = getCopyTargets(action);

    targets.forEach(target => {
        const index = record.items.length;
        const before = capturePathState(record, target, index, 'before');
        const item = { target, before, after: { existed: false, backupPath: '' } };
        record.items.push(item);

        copyDirectoryContents(action.src, target);
        item.after = capturePathState(record, target, index, 'after');
    });

    return targets;
}

function appendDeleteFolderAction(record, action) {
    const targets = normalizeActionTargets(action.targets);

    targets.forEach(target => {
        const index = record.items.length;
        const before = capturePathState(record, target, index, 'before');
        const item = {
            target,
            before,
            after: {
                existed: false,
                backupPath: ''
            }
        };
        record.items.push(item);

        if (before.existed) {
            removePath(target);
        }
    });

    return targets;
}

function appendMainAction(record, action) {
    if (action.type === 'copy-file') {
        return appendCopyFileAction(record, action);
    }

    if (action.type === 'delete-file') {
        return appendDeleteFileAction(record, action);
    }

    if (action.type === 'copy-folder') {
        return appendCopyFolderAction(record, action);
    }

    if (action.type === 'delete-folder') {
        return appendDeleteFolderAction(record, action);
    }

    throw new Error(`Unsupported action type: ${action.type}`);
}

function executeMainActionsBatch(actions, label = '') {
    const normalizedActions = normalizeMainActions(actions);

    if (!normalizedActions.length) {
        return {
            success: false,
            message: 'No actions to run',
            history: getActionHistoryState()
        };
    }

    const record = createActionRecord('batch', label || createMainActionLabel(normalizedActions));
    const dirtyPaths = [];

    try {
        normalizedActions.forEach(action => {
            dirtyPaths.push(...appendMainAction(record, action));
        });

        pushUndoAction(record);
        markPathsDirty(dirtyPaths);
        return { success: true, history: getActionHistoryState() };
    } catch (err) {
        rollbackAction(record);
        cleanupActionRecord(record);
        throw err;
    }
}

function executeCopyFileAction({ src, targets }) {
    return executeMainActionsBatch({ type: 'copy-file', src, targets });
}

function executeDeleteFileAction(targets) {
    return executeMainActionsBatch({ type: 'delete-file', targets });
}

function executeCopyFolderAction({ src, targets }) {
    return executeMainActionsBatch({ type: 'copy-folder', src, targets });
}

function executeDeleteFolderAction(targets) {
    return executeMainActionsBatch({ type: 'delete-folder', targets });
}

ipcMain.handle('copy-file', async (e, data) => {
    try {
        return executeCopyFileAction(data);
    } catch (err) {
        console.error('Copy error:', err);
        throw err;
    }
});

ipcMain.handle('delete-file', async (e, targets) => {
    try {
        return executeDeleteFileAction(targets);
    } catch (err) {
        console.error('Delete error:', err);
        throw err;
    }
});

ipcMain.handle('copy-folder', async (e, data) => {
    try {
        return executeCopyFolderAction(data);
    } catch (err) {
        console.error('Folder copy error:', err);
        throw err;
    }
});

ipcMain.handle('delete-folder', async (e, targets) => {
    try {
        return executeDeleteFolderAction(targets);
    } catch (err) {
        console.error('Folder delete error:', err);
        throw err;
    }
});

ipcMain.handle('run-main-actions', async (e, actions) => {
    try {
        return executeMainActionsBatch(actions);
    } catch (err) {
        console.error('Batch action error:', err);
        throw err;
    }
});

ipcMain.handle('get-main-action-history-state', async () => {
    return getActionHistoryState();
});

ipcMain.handle('undo-main-action', async () => {
    const record = actionUndoStack.pop();

    if (!record) {
        return {
            success: false,
            message: 'Nothing to undo',
            history: getActionHistoryState()
        };
    }

    try {
        applyActionState(record, 'before');
        actionRedoStack.push(record);

        return {
            success: true,
            action: record.label,
            history: getActionHistoryState()
        };
    } catch (err) {
        actionUndoStack.push(record);
        console.error('Undo error:', err);
        throw err;
    }
});

ipcMain.handle('redo-main-action', async () => {
    const record = actionRedoStack.pop();

    if (!record) {
        return {
            success: false,
            message: 'Nothing to redo',
            history: getActionHistoryState()
        };
    }

    try {
        applyActionState(record, 'after');
        actionUndoStack.push(record);

        return {
            success: true,
            action: record.label,
            history: getActionHistoryState()
        };
    } catch (err) {
        actionRedoStack.push(record);
        console.error('Redo error:', err);
        throw err;
    }
});

function normalizeContent(buffer) {
    return buffer
        .toString('utf8')
        .replace(/\r\n/g, '\n') // CRLF в†’ LF
        .trim();                // РјР°С…Р° trailing whitespace
}

function getFileHash(filePath) {
    try {
        const data = fs.readFileSync(filePath);

        const normalized = normalizeContent(data);

        return crypto
            .createHash('md5')
            .update(normalized)
            .digest('hex');
    } catch (e) {
        return null;
    }
}

const hashCache = new Map();

function getSmartHash(filePath) {
    const stat = fs.statSync(filePath);
    const key = stat.size + '_' + stat.mtimeMs;

    // вњ… Р°РєРѕ РІРµС‡Рµ СЃРјРµ РіРѕ СЃРјСЏС‚Р°Р»Рё в†’ РІСЂСЉС‰Р°РјРµ РєРµС€Р°
    if (hashCache.has(filePath) && hashCache.get(filePath).key === key) {
        return hashCache.get(filePath).hash;
    }

    // вќ— СЃР°РјРѕ Р°РєРѕ РёРјР° РїСЂРѕРјСЏРЅР° в†’ РїСЂР°РІРёРј hash
    const hash = getFileHash(filePath);

    hashCache.set(filePath, { key, hash });

    return hash;
}
