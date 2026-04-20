let currentData = {};
let dirs = [];
let currentTree = null;
let currentDiffCache = new Map();
let currentStats = { folders: 0, files: 0, diffs: 0 };
let preservedScrollState = null;
let scrollRestoreToken = 0;
let activeRenderController = null;
let statsRefreshTimer = null;

const collapseState = {};
let lastWatchedDirs = [];
let scanPromise = null;
let scanQueued = false;
let queuedResetCache = false;

const COMPARE_LAYOUT = Object.freeze({
    nameWidth: 360,
    directoryWidth: 168,
    actionsWidth: 352
});

function arraysEqual(a, b) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

function getDirs() {
    const inputs = document.querySelectorAll('.folder-input');
    return Array.from(inputs).map(input => input.value.trim()).filter(Boolean);
}

function getFoldersContainer() {
    return document.getElementById('folders');
}

function refreshFolderInputPlaceholders() {
    document.querySelectorAll('.folder-input').forEach((input, index) => {
        input.placeholder = `Folder ${index + 1}`;
    });
}

async function openFolderPickerForInput(input) {
    if (!input) {
        return;
    }

    try {
        const selectedPath = await window.api.pickFolder(input.value.trim());

        if (selectedPath) {
            input.value = selectedPath;
            input.title = selectedPath;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
    } catch (err) {
        alert('Folder picker error: ' + err.message);
    } finally {
        input.focus();
    }
}

function createFolderInputField(value = '') {
    const wrapper = document.createElement('div');
    wrapper.className = 'folder-input-shell';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'folder-input';
    input.value = value;
    input.title = value;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.addEventListener('input', () => {
        input.title = input.value.trim();
    });

    const pickerButton = document.createElement('button');
    pickerButton.type = 'button';
    pickerButton.className = 'folder-picker-btn';
    pickerButton.title = 'Browse for folder';
    pickerButton.setAttribute('aria-label', 'Browse for folder');
    pickerButton.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M3.75 6.75a2.25 2.25 0 0 1 2.25-2.25h4.2c.58 0 1.13.23 1.54.64l1.12 1.11h5.14a2.25 2.25 0 0 1 2.25 2.25v7.5A2.25 2.25 0 0 1 18 18.75H6A2.25 2.25 0 0 1 3.75 16.5v-9.75Z"/>
        </svg>
    `;
    pickerButton.addEventListener('click', () => {
        openFolderPickerForInput(input);
    });

    wrapper.appendChild(input);
    wrapper.appendChild(pickerButton);

    return wrapper;
}

function appendFolderInputField(value = '') {
    const foldersContainer = getFoldersContainer();
    const field = createFolderInputField(value);

    foldersContainer.appendChild(field);
    refreshFolderInputPlaceholders();

    return field.querySelector('.folder-input');
}

function setFolderInputs(paths = []) {
    const foldersContainer = getFoldersContainer();
    foldersContainer.replaceChildren();

    paths.forEach(folderPath => {
        foldersContainer.appendChild(createFolderInputField(folderPath));
    });

    while (foldersContainer.children.length < 2) {
        foldersContainer.appendChild(createFolderInputField(''));
    }

    refreshFolderInputPlaceholders();
}

function setScanLoading(isLoading) {
    const loader = document.getElementById('scanLoader');
    if (!loader) return;
    loader.classList.toggle('is-visible', isLoading);
}

function rebuildRenderCaches() {
    currentTree = groupFiles();
    currentDiffCache = new Map();
    currentStats = collectTreeStats(currentTree, currentDiffCache);
}

function createTreeFolderNode(name, relativePath) {
    return {
        name,
        __entryKey: null,
        __relativePath: relativePath,
        __files: [],
        __children: {}
    };
}

function normalizeDataPath(relativePath = '') {
    return relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function normalizeDataMap(data = {}) {
    const normalized = {};

    Object.entries(data || {}).forEach(([relativePath, entry]) => {
        normalized[normalizeDataPath(relativePath)] = entry;
    });

    return normalized;
}

function buildNodeId(relativePath = '') {
    const normalizedPath = normalizeDataPath(relativePath);
    return normalizedPath ? `root/${normalizedPath}` : 'root';
}

function getParentNodeId(nodeId) {
    if (!nodeId || nodeId === 'root') {
        return null;
    }

    const parts = nodeId.split('/');
    if (parts.length <= 2) {
        return 'root';
    }

    return parts.slice(0, -1).join('/');
}

function isDirectoryEntry(entry) {
    const existingEntries = Object.values(entry || {}).filter(Boolean);
    return existingEntries.length > 0 && existingEntries.every(item => item.isDir);
}

function getTreeFolderNode(parts) {
    let node = currentTree;

    for (const part of parts) {
        node = node?.__children?.[part];

        if (!node) {
            return null;
        }
    }

    return node;
}

function ensureTreeFolderNode(parts, entryKey = null) {
    if (!currentTree) {
        currentTree = createTreeFolderNode('root', '');
    }

    let node = currentTree;
    let relativePath = '';

    parts.forEach(part => {
        relativePath = relativePath ? `${relativePath}/${part}` : part;

        if (!node.__children[part]) {
            node.__children[part] = createTreeFolderNode(part, relativePath);
        }

        node = node.__children[part];
    });

    if (entryKey !== null) {
        node.__entryKey = entryKey;
    }

    return node;
}

function pruneTreeFolders(parts) {
    for (let depth = parts.length; depth > 0; depth -= 1) {
        const nodeParts = parts.slice(0, depth);
        const node = getTreeFolderNode(nodeParts);

        if (!node) {
            continue;
        }

        if (node.__entryKey || node.__files.length || Object.keys(node.__children).length) {
            break;
        }

        const parent = depth === 1 ? currentTree : getTreeFolderNode(parts.slice(0, depth - 1));
        if (parent) {
            delete parent.__children[nodeParts[nodeParts.length - 1]];
        }
    }
}

function removeTreeEntry(relativePath) {
    const normalizedPath = normalizeDataPath(relativePath);
    if (!normalizedPath || !currentTree) {
        return;
    }

    const parts = normalizedPath.split('/');
    const parentParts = parts.slice(0, -1);
    const parent = parentParts.length ? getTreeFolderNode(parentParts) : currentTree;

    if (parent) {
        parent.__files = parent.__files.filter(file => file !== normalizedPath);
    }

    const folderNode = getTreeFolderNode(parts);
    if (folderNode) {
        const folderParent = parentParts.length ? getTreeFolderNode(parentParts) : currentTree;
        if (folderParent) {
            delete folderParent.__children[parts[parts.length - 1]];
        }
    }

    pruneTreeFolders(parentParts);
}

function upsertTreeEntry(relativePath) {
    const normalizedPath = normalizeDataPath(relativePath);
    if (!normalizedPath) {
        return;
    }

    const entry = currentData[relativePath] || currentData[normalizedPath];
    if (!entry) {
        removeTreeEntry(normalizedPath);
        return;
    }

    removeTreeEntry(normalizedPath);

    const parts = normalizedPath.split('/');

    if (isDirectoryEntry(entry)) {
        ensureTreeFolderNode(parts, normalizedPath);
        return;
    }

    const parent = ensureTreeFolderNode(parts.slice(0, -1));
    if (!parent.__files.includes(normalizedPath)) {
        parent.__files.push(normalizedPath);
    }
}

function applyTreePatch(impactedPaths) {
    if (!currentTree) {
        currentTree = createTreeFolderNode('root', '');
    }

    impactedPaths.forEach(relativePath => {
        const normalizedPath = normalizeDataPath(relativePath);

        if (!normalizedPath) {
            return;
        }

        if (currentData[relativePath] || currentData[normalizedPath]) {
            upsertTreeEntry(normalizedPath);
            return;
        }

        removeTreeEntry(normalizedPath);
    });
}

function scheduleStatsRefresh() {
    if (statsRefreshTimer) {
        clearTimeout(statsRefreshTimer);
    }

    statsRefreshTimer = setTimeout(() => {
        statsRefreshTimer = null;

        if (!currentTree) {
            currentStats = { folders: 0, files: 0, diffs: 0 };
            activeRenderController?.refreshMeta?.();
            return;
        }

        currentDiffCache = new Map();
        currentStats = collectTreeStats(currentTree, currentDiffCache);
        activeRenderController?.refreshMeta?.();
    }, 120);
}

function getParentFolderNodeId(relativePath) {
    const normalizedPath = normalizeDataPath(relativePath);

    if (!normalizedPath) {
        return 'root';
    }

    const parts = normalizedPath.split('/');
    if (parts.length <= 1) {
        return 'root';
    }

    return buildNodeId(parts.slice(0, -1).join('/'));
}

function ensurePreservedScrollState() {
    if (!preservedScrollState) {
        preservedScrollState = captureRenderScrollState();
    }
}

function applyIncrementalScanResult(scanResult) {
    if (!scanResult || typeof scanResult !== 'object') {
        currentData = normalizeDataMap(scanResult || {});
        return {
            changed: true,
            mode: 'full',
            impactedPaths: []
        };
    }

    if (!scanResult.mode) {
        currentData = normalizeDataMap(scanResult);
        return {
            changed: true,
            mode: 'full',
            impactedPaths: []
        };
    }

    if (scanResult.mode === 'full') {
        currentData = normalizeDataMap(scanResult.data || {});
        return {
            changed: true,
            mode: 'full',
            impactedPaths: []
        };
    }

    if (scanResult.mode === 'patch') {
        if (!currentData || typeof currentData !== 'object') {
            currentData = {};
        }

        const impactedPaths = new Set();

        Object.entries(scanResult.upserts || {}).forEach(([relativePath, entry]) => {
            const normalizedPath = normalizeDataPath(relativePath);
            currentData[normalizedPath] = entry;
            impactedPaths.add(normalizedPath);
        });

        (scanResult.removals || []).forEach(relativePath => {
            const normalizedPath = normalizeDataPath(relativePath);
            delete currentData[normalizedPath];
            impactedPaths.add(normalizedPath);
        });

        return {
            changed: true,
            mode: 'patch',
            impactedPaths: Array.from(impactedPaths)
        };
    }

    if (scanResult.mode === 'noop') {
        return {
            changed: false,
            mode: 'noop',
            impactedPaths: []
        };
    }

    currentData = normalizeDataMap(scanResult.data || {});
    return {
        changed: true,
        mode: 'full',
        impactedPaths: []
    };
}

async function performScan(resetCache = false) {
    ensurePreservedScrollState();
    setScanLoading(true);

    try {
        dirs = getDirs();

        if (dirs.length < 2) {
            return alert('Please enter at least 2 folders');
        }

        if (resetCache) {
            Object.keys(collapseState).forEach(key => delete collapseState[key]);
        }

        const scanResult = await window.api.scan(dirs);
        const scanUpdate = applyIncrementalScanResult(scanResult);
        const shouldRender = scanUpdate.changed || resetCache;

        if (shouldRender) {
            const canUsePatchRender = !resetCache &&
                scanUpdate.mode === 'patch' &&
                activeRenderController;

            if (canUsePatchRender) {
                applyTreePatch(scanUpdate.impactedPaths);
                currentDiffCache = new Map();
                scheduleStatsRefresh();

                const didPartialRender = activeRenderController.rerenderPaths(scanUpdate.impactedPaths);

                if (!didPartialRender) {
                    rebuildRenderCaches();
                    render();
                }
            } else {
                rebuildRenderCaches();
                render();
            }
        } else {
            preservedScrollState = null;
        }

        if (!arraysEqual(dirs, lastWatchedDirs)) {
            window.api.watchFolders(dirs);
            lastWatchedDirs = [...dirs];
        }
    } catch (err) {
        preservedScrollState = null;
        alert('Scan error: ' + err.message);
    } finally {
        setScanLoading(false);
    }
}

function scan(resetCache = false) {
    scanQueued = true;
    queuedResetCache = queuedResetCache || resetCache;

    if (scanPromise) {
        return scanPromise;
    }

    scanPromise = (async () => {
        try {
            while (scanQueued) {
                const nextResetCache = queuedResetCache;
                scanQueued = false;
                queuedResetCache = false;
                await performScan(nextResetCache);
            }
        } finally {
            scanPromise = null;
        }
    })();

    return scanPromise;
}

window.api.onFolderChange(() => {
    scan();
});

function groupFiles() {
    const root = {
        name: 'root',
        __entryKey: '',
        __relativePath: '',
        __files: [],
        __children: {}
    };

    function ensureFolderNode(parts, entryKey = null) {
        let node = root;
        let relativePath = '';

        parts.forEach(part => {
            relativePath = relativePath ? relativePath + '/' + part : part;

            if (!node.__children[part]) {
                node.__children[part] = {
                    name: part,
                    __entryKey: null,
                    __relativePath: relativePath,
                    __files: [],
                    __children: {}
                };
            }

            node = node.__children[part];
        });

        if (entryKey !== null) {
            node.__entryKey = entryKey;
        }

        return node;
    }

    Object.keys(currentData)
        .sort((left, right) => left.localeCompare(right))
        .forEach(entryPath => {
            const entries = currentData[entryPath];
            const existingEntries = Object.values(entries).filter(Boolean);
            const parts = entryPath.split(/\\|\//).filter(Boolean);

            if (!parts.length || !existingEntries.length) {
                return;
            }

            const isDirectory = existingEntries.every(entry => entry.isDir);

            if (isDirectory) {
                ensureFolderNode(parts, entryPath);
                return;
            }

            const parentNode = ensureFolderNode(parts.slice(0, -1));
            parentNode.__files.push(entryPath);
        });

    return root;
}

function fileEntriesDiffer(entries) {
    if (!entries) return false;
    const hashes = dirs.map((_, index) => entries[index]?.hash || '__MISSING__');
    return new Set(hashes).size > 1;
}

function nodeHasDiff(node, diffCache = new Map()) {
    const cacheKey = node.__relativePath || '__root__';

    if (diffCache.has(cacheKey)) {
        return diffCache.get(cacheKey);
    }

    let hasDiff = false;

    if (node.__entryKey) {
        const folderPresence = dirs.map((_, index) => Boolean(currentData[node.__entryKey]?.[index]?.isDir));
        hasDiff = new Set(folderPresence).size > 1;
    }

    if (!hasDiff) {
        hasDiff = node.__files.some(file => fileEntriesDiffer(currentData[file]));
    }

    if (!hasDiff) {
        hasDiff = Object.values(node.__children).some(child => nodeHasDiff(child, diffCache));
    }

    diffCache.set(cacheKey, hasDiff);
    return hasDiff;
}

function collectTreeStats(node, diffCache) {
    const stats = {
        folders: 0,
        files: 0,
        diffs: 0
    };

    function visit(currentNode, includeFolder) {
        if (includeFolder) {
            stats.folders += 1;
            if (nodeHasDiff(currentNode, diffCache)) {
                stats.diffs += 1;
            }
        }

        currentNode.__files.forEach(file => {
            stats.files += 1;
            if (fileEntriesDiffer(currentData[file])) {
                stats.diffs += 1;
            }
        });

        Object.values(currentNode.__children).forEach(child => visit(child, true));
    }

    visit(node, false);
    return stats;
}

function getFolderName(fullPath) {
    if (!fullPath) return '';
    return fullPath.split(/\\|\//).filter(Boolean).pop();
}

function getFileName(fullPath) {
    return fullPath.split(/\\|\//).filter(Boolean).pop() || fullPath;
}

function getEntryMeta(entryPath) {
    const parts = entryPath.split(/\\|\//).filter(Boolean);
    if (parts.length <= 1) {
        return 'Root level';
    }

    return parts.slice(0, -1).join('/');
}

function buildFileTargetPath(dir, relativePath) {
    return dir.replace(/[\\/]+$/, '') + '/' + relativePath.replace(/^[\\/]+/, '');
}

function folderExistsInDir(dirIndex, node) {
    if (!node.__relativePath) return true;
    if (node.__entryKey && currentData[node.__entryKey]?.[dirIndex]?.isDir) return true;

    return node.__files.some(file => currentData[file]?.[dirIndex]) ||
        Object.values(node.__children).some(child => folderExistsInDir(dirIndex, child));
}

function buildGridTemplate() {
    const directoryColumns = dirs.length ? ` repeat(${dirs.length}, ${COMPARE_LAYOUT.directoryWidth}px)` : '';
    return `${COMPARE_LAYOUT.nameWidth}px${directoryColumns} minmax(${COMPARE_LAYOUT.actionsWidth}px, max-content)`;
}

function applyGridTemplate(element) {
    element.style.setProperty('--compare-grid-template', buildGridTemplate());
}

function createCompareCell(cellClassName, surfaceClassName) {
    const cell = document.createElement('div');
    cell.className = `compare-cell ${cellClassName}`.trim();

    const surface = document.createElement('div');
    surface.className = `compare-surface ${surfaceClassName}`.trim();

    cell.appendChild(surface);
    return { cell, surface };
}

function createActionButton({ label, className = '', title = '', disabled = false, onClick }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `compare-action-btn ${className}`.trim();
    button.textContent = label;
    button.title = title;
    button.disabled = disabled;
    button.addEventListener('click', onClick);
    return button;
}

function createControlChip(input, label, disabled = false) {
    const chip = document.createElement('label');
    chip.className = 'compare-toggle-chip';

    if (disabled) {
        chip.classList.add('is-disabled');
    }

    chip.appendChild(input);

    const text = document.createElement('span');
    text.textContent = label;
    chip.appendChild(text);

    return chip;
}

function createKindIcon(kind) {
    const icon = document.createElement('span');
    icon.className = `compare-kind-icon ${kind === 'DIR' ? 'is-folder' : 'is-file'}`;
    icon.title = kind === 'DIR' ? 'Folder' : 'File';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = kind === 'DIR' ? '📁' : '📄';
    return icon;
}

function createDepthGuides(depth) {
    if (!depth) {
        return null;
    }

    const guides = document.createElement('div');
    guides.className = 'compare-depth-guides';

    for (let index = 0; index < depth; index += 1) {
        const guide = document.createElement('span');
        guide.className = 'compare-depth-guide';

        if (index === depth - 1) {
            guide.classList.add('is-last');
        }

        guides.appendChild(guide);
    }

    return guides;
}

function setAllFoldersExpanded(node, expanded, path = 'root') {
    collapseState[path] = expanded;

    Object.entries(node.__children).forEach(([name, child]) => {
        setAllFoldersExpanded(child, expanded, `${path}/${name}`);
    });
}

function setDiffFoldersExpanded(node, diffCache, path = 'root') {
    collapseState[path] = nodeHasDiff(node, diffCache);

    Object.entries(node.__children).forEach(([name, child]) => {
        setDiffFoldersExpanded(child, diffCache, `${path}/${name}`);
    });
}

function captureRenderScrollState() {
    const grid = document.querySelector('#fileList .compare-grid-scroll');

    return {
        pageX: window.scrollX,
        pageY: window.scrollY,
        gridTop: grid?.scrollTop ?? 0,
        gridLeft: grid?.scrollLeft ?? 0
    };
}

function restoreRenderScrollState(state) {
    if (!state) {
        return;
    }

    const restoreToken = ++scrollRestoreToken;
    const applyScrollState = () => {
        const grid = document.querySelector('#fileList .compare-grid-scroll');

        if (grid) {
            grid.scrollTop = state.gridTop;
            grid.scrollLeft = state.gridLeft;
        }

        window.scrollTo(state.pageX, state.pageY);
    };

    applyScrollState();

    requestAnimationFrame(() => {
        if (restoreToken !== scrollRestoreToken) {
            return;
        }

        applyScrollState();
        preservedScrollState = null;
    });
}

function render() {
    const list = document.getElementById('fileList');
    const onlyDiff = document.getElementById('onlyDiff').checked;
    ensurePreservedScrollState();
    const scrollState = preservedScrollState;
    const nextChildren = document.createDocumentFragment();

    if (!dirs.length) {
        dirs = getDirs();
    }

    if (!currentTree) {
        rebuildRenderCaches();
    }

    activeRenderController = null;
    const sectionStates = new Map();
    const fileRowStates = new Map();

    function getTreeNodeById(nodeId) {
        if (!currentTree || !nodeId) {
            return null;
        }

        if (nodeId === 'root') {
            return currentTree;
        }

        const parts = nodeId.split('/').slice(1);
        let node = currentTree;

        for (const part of parts) {
            node = node?.__children?.[part];

            if (!node) {
                return null;
            }
        }

        return node;
    }

    function clearSectionDescendants(nodeId) {
        const descendantPrefix = `${nodeId}/`;

        Array.from(sectionStates.keys()).forEach(key => {
            if (key.startsWith(descendantPrefix)) {
                sectionStates.delete(key);
            }
        });
    }

    function clearFileRowStatesForNode(nodeId) {
        Array.from(fileRowStates.entries()).forEach(([filePath, state]) => {
            if (state.parentNodeId === nodeId || state.parentNodeId.startsWith(`${nodeId}/`)) {
                fileRowStates.delete(filePath);
            }
        });
    }

    const toolbar = document.createElement('div');
    toolbar.className = 'compare-toolbar';

    const toolbarGroup = document.createElement('div');
    toolbarGroup.className = 'compare-toolbar-group';

    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'app-btn app-btn-secondary';
    expandBtn.textContent = 'Expand All';
    expandBtn.addEventListener('click', () => {
        setAllFoldersExpanded(currentTree, true);
        render();
    });

    const expandDiffBtn = document.createElement('button');
    expandDiffBtn.type = 'button';
    expandDiffBtn.className = 'app-btn app-btn-secondary';
    expandDiffBtn.textContent = 'Expand Diff';
    expandDiffBtn.addEventListener('click', () => {
        setDiffFoldersExpanded(currentTree, currentDiffCache);
        render();
    });

    const collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className = 'app-btn app-btn-secondary';
    collapseBtn.textContent = 'Collapse All';
    collapseBtn.addEventListener('click', () => {
        setAllFoldersExpanded(currentTree, false);
        render();
    });

    toolbarGroup.appendChild(expandBtn);
    toolbarGroup.appendChild(expandDiffBtn);
    toolbarGroup.appendChild(collapseBtn);

    const meta = document.createElement('div');
    meta.className = 'compare-toolbar-meta';
    meta.textContent = `${dirs.length} folders | ${currentStats.folders} folders in tree | ${currentStats.files} files | ${currentStats.diffs} diff items`;

    toolbar.appendChild(toolbarGroup);
    toolbar.appendChild(meta);
    nextChildren.appendChild(toolbar);

    const scroll = document.createElement('div');
    scroll.className = 'compare-grid-scroll';

    const canvas = document.createElement('div');
    canvas.className = 'compare-grid-canvas';

    function createHeaderRow() {
        const row = document.createElement('div');
        row.className = 'compare-grid-row compare-grid-header';
        applyGridTemplate(row);

        const { cell: nameCell, surface: nameSurface } = createCompareCell('compare-name-cell', 'compare-header-panel');
        const nameLabel = document.createElement('div');
        nameLabel.className = 'compare-header-label';
        nameLabel.textContent = 'Path';

        const namePath = document.createElement('div');
        namePath.className = 'compare-header-path';
        namePath.textContent = 'Sticky file and folder names';

        nameSurface.appendChild(nameLabel);
        nameSurface.appendChild(namePath);
        row.appendChild(nameCell);

        dirs.forEach(dir => {
            const { cell, surface } = createCompareCell('', 'compare-header-panel');
            const label = document.createElement('div');
            label.className = 'compare-header-label';
            label.textContent = getFolderName(dir) || dir;

            const path = document.createElement('div');
            path.className = 'compare-header-path';
            path.textContent = dir;
            path.title = dir;

            surface.appendChild(label);
            surface.appendChild(path);
            row.appendChild(cell);
        });

        const { cell: actionsCell, surface: actionsSurface } = createCompareCell('compare-actions-cell', 'compare-header-panel');
        const actionLabel = document.createElement('div');
        actionLabel.className = 'compare-header-label';
        actionLabel.textContent = 'Actions';

        const actionPath = document.createElement('div');
        actionPath.className = 'compare-header-path';
        actionPath.textContent = 'Diff, copy, and delete tools';

        actionsSurface.appendChild(actionLabel);
        actionsSurface.appendChild(actionPath);
        row.appendChild(actionsCell);

        return row;
    }

    function createNamePanel({ depth, title, metaText, kind, hasDiff, expandable, expanded, onToggle, isFileRow = false }) {
        const { cell, surface } = createCompareCell(
            'compare-name-cell',
            `compare-name-panel${isFileRow && hasDiff ? ' is-file-diff' : ''}`
        );

        const content = document.createElement('div');
        content.className = 'compare-name-content';

        const guides = createDepthGuides(depth);
        if (guides) {
            content.appendChild(guides);
        }

        if (expandable) {
            const toggleBtn = document.createElement('button');
            toggleBtn.type = 'button';
            toggleBtn.className = `compare-chevron${expanded ? ' is-expanded' : ''}`;
            toggleBtn.title = expanded ? 'Collapse folder' : 'Expand folder';
            toggleBtn.addEventListener('click', event => {
                event.stopPropagation();
                onToggle();
            });
            content.appendChild(toggleBtn);
        } else {
            const spacer = document.createElement('div');
            spacer.className = 'compare-node-spacer';
            content.appendChild(spacer);
        }

        const info = document.createElement('div');
        info.className = 'compare-name-info';

        const line = document.createElement('div');
        line.className = 'compare-name-line';

        const kindIcon = createKindIcon(kind);

        const titleEl = document.createElement('span');
        titleEl.className = 'compare-name-title';
        titleEl.textContent = title;
        titleEl.title = title;

        const stateBadge = document.createElement('span');
        stateBadge.className = `compare-state-badge ${hasDiff ? 'is-diff' : 'is-clean'}`;
        stateBadge.textContent = hasDiff ? 'Diff' : 'Synced';

        line.appendChild(kindIcon);
        line.appendChild(titleEl);
        line.appendChild(stateBadge);

        const path = document.createElement('div');
        path.className = 'compare-name-path';
        path.textContent = metaText;
        path.title = metaText;

        info.appendChild(line);
        info.appendChild(path);
        content.appendChild(info);
        surface.appendChild(content);

        if (expandable) {
            surface.addEventListener('click', onToggle);
            surface.style.cursor = 'pointer';
        }

        return { cell };
    }

    function createFolderSlot({ node, dir, dirIndex, fullPath, isRoot, hasDiff, folderCheckboxes, onSourceChange, onTargetChange }) {
        const { cell, surface } = createCompareCell('', 'compare-slot');
        const relativePath = fullPath.replace(/^root[\\/]/, '');
        const folderPath = isRoot ? dir : buildFileTargetPath(dir, relativePath);
        const exists = folderExistsInDir(dirIndex, node);

        if (!exists) {
            surface.classList.add('is-missing');
        } else if (hasDiff) {
            surface.classList.add('is-diff');
        }

        surface.title = folderPath;

        const status = document.createElement('div');
        status.className = 'compare-slot-status';
        status.textContent = exists ? (hasDiff ? 'Diff' : 'Synced') : 'Missing';

        if (!exists) {
            status.classList.add('is-missing');
        } else if (hasDiff) {
            status.classList.add('is-diff');
        } else {
            status.classList.add('is-clean');
        }

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = `folder-${fullPath}`;
        radio.disabled = !exists;
        radio.addEventListener('change', event => {
            event.stopPropagation();
            onSourceChange(folderPath);
        });

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = folderPath;
        checkbox.dataset.exists = exists ? 'true' : 'false';
        checkbox.addEventListener('change', event => {
            event.stopPropagation();
            onTargetChange();
        });

        folderCheckboxes.push(checkbox);

        const controls = document.createElement('div');
        controls.className = 'compare-slot-controls';
        controls.appendChild(createControlChip(radio, 'Source', !exists));
        controls.appendChild(createControlChip(checkbox, 'Target'));

        surface.appendChild(status);
        surface.appendChild(controls);
        return cell;
    }

    function createFileSlot({ file, dir, entry, rowHasDiff, sourceName, checkboxes, onSourceChange, onTargetChange }) {
        const { cell, surface } = createCompareCell('', 'compare-slot');
        const targetPath = entry?.path || buildFileTargetPath(dir, file);

        if (!entry) {
            surface.classList.add('is-missing');
        } else if (rowHasDiff) {
            surface.classList.add('is-diff');
        }

        surface.title = targetPath;

        const status = document.createElement('div');
        status.className = 'compare-slot-status';
        status.textContent = entry ? (rowHasDiff ? 'Diff' : 'Synced') : 'Missing';

        if (!entry) {
            status.classList.add('is-missing');
        } else if (rowHasDiff) {
            status.classList.add('is-diff');
        } else {
            status.classList.add('is-clean');
        }

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = sourceName;
        radio.disabled = !entry;
        radio.addEventListener('change', () => onSourceChange(targetPath));

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = targetPath;
        checkbox.dataset.exists = entry ? 'true' : 'false';
        checkbox.addEventListener('change', onTargetChange);

        checkboxes.push(checkbox);

        const controls = document.createElement('div');
        controls.className = 'compare-slot-controls';
        controls.appendChild(createControlChip(radio, 'Source', !entry));
        controls.appendChild(createControlChip(checkbox, 'Target'));

        surface.appendChild(status);
        surface.appendChild(controls);
        return cell;
    }

    function createFileRow(file, depth, parentNodeId) {
        const entries = currentData[file];
        const rowHasDiff = fileEntriesDiffer(entries);

        if (onlyDiff && !rowHasDiff) {
            fileRowStates.delete(file);
            return null;
        }

        const row = document.createElement('div');
        row.className = 'compare-grid-row compare-file-row is-hoverable';
        applyGridTemplate(row);

        const fileNameCell = createNamePanel({
            depth,
            title: getFileName(file),
            metaText: getEntryMeta(file),
            kind: 'FILE',
            hasDiff: rowHasDiff,
            expandable: false,
            expanded: false,
            onToggle: () => { },
            isFileRow: true
        });

        row.appendChild(fileNameCell.cell);

        let selectedSource = null;
        const checkboxes = [];
        let refreshFileActions = () => { };

        dirs.forEach((dir, dirIndex) => {
            row.appendChild(createFileSlot({
                file,
                dir,
                entry: entries?.[dirIndex],
                rowHasDiff,
                sourceName: `file-${file}`,
                checkboxes,
                onSourceChange: sourcePath => {
                    selectedSource = sourcePath;
                    refreshFileActions();
                },
                onTargetChange: () => refreshFileActions()
            }));
        });

        const { cell: fileActionCell, surface: fileActionSurface } = createCompareCell('compare-actions-cell', 'compare-actions-panel');
        const fileActionGroup = document.createElement('div');
        fileActionGroup.className = 'compare-action-group';

        const availableFiles = Object.values(entries || {}).filter(Boolean).map(entry => entry.path);

        const diffuseBtn = createActionButton({
            label: 'Diffuse',
            title: 'Open the external multi-file diff tool',
            disabled: availableFiles.length < 2,
            onClick: () => {
                window.api.openDiffuse(availableFiles);
            }
        });

        const differenceBtn = createActionButton({
            label: 'Difference',
            className: 'is-primary',
            title: 'Open the built-in difference viewer',
            onClick: async () => {
                if (!window.differenceViewer) {
                    alert('Difference viewer is not available.');
                    return;
                }

                try {
                    await window.differenceViewer.openComparison({
                        title: getFileName(file),
                        relativePath: file,
                        panes: dirs.map((dir, dirIndex) => ({
                            label: getFolderName(dir),
                            path: entries?.[dirIndex]?.path || buildFileTargetPath(dir, file)
                        }))
                    });
                } catch (err) {
                    alert('Difference error: ' + err.message);
                }
            }
        });

        const copyBtn = createActionButton({
            label: 'Copy',
            title: 'Copy the selected file into the checked targets',
            disabled: true,
            onClick: () => {
                if (!selectedSource) {
                    return alert('Select source');
                }

                const targets = checkboxes
                    .filter(checkbox => checkbox.checked && checkbox.value !== selectedSource)
                    .map(checkbox => checkbox.value);

                if (!targets.length) {
                    return alert('No targets selected');
                }

                window.api.copyFile({ src: selectedSource, targets })
                    .then(() => {
                        alert('Copied!');
                    })
                    .catch(err => alert('Error: ' + err.message));
            }
        });

        const deleteBtn = createActionButton({
            label: 'Delete',
            className: 'is-danger',
            title: 'Delete the checked existing files',
            disabled: true,
            onClick: () => {
                const targets = checkboxes
                    .filter(checkbox => checkbox.checked && checkbox.dataset.exists === 'true')
                    .map(checkbox => checkbox.value);

                if (!targets.length) {
                    return alert('No existing targets selected');
                }

                if (!confirm(`Delete ${targets.length} file(s)?`)) {
                    return;
                }

                Promise.all(targets.map(target => window.api.deleteFile(target)))
                    .then(() => {
                        alert('Deleted!');
                    })
                    .catch(err => alert('Error: ' + err.message));
            }
        });

        fileActionGroup.appendChild(diffuseBtn);
        fileActionGroup.appendChild(differenceBtn);
        fileActionGroup.appendChild(copyBtn);
        fileActionGroup.appendChild(deleteBtn);
        fileActionSurface.appendChild(fileActionGroup);
        row.appendChild(fileActionCell);

        refreshFileActions = () => {
            const checkedTargets = checkboxes.filter(checkbox => checkbox.checked);
            const existingTargets = checkedTargets.filter(checkbox => checkbox.dataset.exists === 'true');

            copyBtn.disabled = !selectedSource || !checkedTargets.some(checkbox => checkbox.value !== selectedSource);
            deleteBtn.disabled = existingTargets.length === 0;
        };

        refreshFileActions();
        fileRowStates.set(file, {
            filePath: file,
            parentNodeId,
            depth,
            row
        });
        return row;
    }

    function renderNode(nodeMap, path = '', depth = 0) {
        const container = document.createElement('div');

        Object.entries(nodeMap)
            .sort(([left], [right]) => left.localeCompare(right))
            .forEach(([name, node]) => {
                const isRoot = name === 'root';
                const fullPath = path ? `${path}/${name}` : name;
                const latestNode = getTreeNodeById(fullPath) || node;
                const hasDiff = nodeHasDiff(latestNode, currentDiffCache);

                if (onlyDiff && !hasDiff) {
                    return;
                }

                const nodeId = fullPath;
                let expanded = collapseState[nodeId];

                if (expanded === undefined) {
                    expanded = hasDiff;
                    collapseState[nodeId] = expanded;
                }

                const section = document.createElement('section');
                section.className = 'compare-folder';
                section.style.setProperty('--folder-accent-color', depth > 0 ? '#d9e2ee' : 'transparent');
                section.style.setProperty('--folder-content-bg', depth > 0 ? '#fbfcfe' : 'transparent');

                const header = document.createElement('div');
                header.className = `compare-grid-row compare-folder-row is-hoverable${hasDiff ? ' is-diff' : ''}`;
                applyGridTemplate(header);

                const content = document.createElement('div');
                content.className = 'compare-folder-content';
                content.hidden = !expanded;
                const sectionState = {
                    nodeId,
                    name,
                    depth,
                    isRoot,
                    section,
                    header,
                    content,
                    contentInitialized: false,
                    populateContent: () => { },
                    renderHeader: () => { },
                    setExpandedState: () => { }
                };
                sectionStates.set(nodeId, sectionState);

                const setExpandedState = nextValue => {
                    expanded = nextValue;
                    collapseState[nodeId] = nextValue;

                    if (nextValue && !sectionState.contentInitialized) {
                        sectionState.populateContent();
                    }

                    content.hidden = !nextValue;

                    const chevron = sectionState.header.querySelector('.compare-chevron');
                    if (chevron) {
                        chevron.classList.toggle('is-expanded', nextValue);
                        chevron.title = nextValue ? 'Collapse folder' : 'Expand folder';
                    }
                };
                sectionState.setExpandedState = setExpandedState;

                sectionState.renderHeader = () => {
                    const nextNode = getTreeNodeById(nodeId) || node;
                    const nextHasDiff = nodeHasDiff(nextNode, currentDiffCache);
                    const nextHeader = document.createElement('div');
                    nextHeader.className = `compare-grid-row compare-folder-row is-hoverable${nextHasDiff ? ' is-diff' : ''}`;
                    applyGridTemplate(nextHeader);

                    const nameCell = createNamePanel({
                        depth,
                        title: isRoot ? 'Workspace root' : name,
                        metaText: isRoot ? 'Bulk actions for the selected root folders.' : nextNode.__relativePath,
                        kind: 'DIR',
                        hasDiff: nextHasDiff,
                        expandable: true,
                        expanded,
                        onToggle: () => setExpandedState(!expanded)
                    });

                    nextHeader.appendChild(nameCell.cell);

                    let selectedSourceFolder = null;
                    const folderCheckboxes = [];
                    let refreshFolderActions = () => { };

                    dirs.forEach((dir, dirIndex) => {
                        nextHeader.appendChild(createFolderSlot({
                            node: nextNode,
                            dir,
                            dirIndex,
                            fullPath,
                            isRoot,
                            hasDiff: nextHasDiff,
                            folderCheckboxes,
                            onSourceChange: folderPath => {
                                selectedSourceFolder = folderPath;
                                refreshFolderActions();
                            },
                            onTargetChange: () => refreshFolderActions()
                        }));
                    });

                    const { cell: actionCell, surface: actionSurface } = createCompareCell('compare-actions-cell', 'compare-actions-panel');
                    const actionGroup = document.createElement('div');
                    actionGroup.className = 'compare-action-group';

                    const copyFolderBtn = createActionButton({
                        label: 'Copy',
                        className: 'is-primary',
                        title: 'Copy the selected folder into the checked targets',
                        disabled: true,
                        onClick: () => {
                            if (!selectedSourceFolder) {
                                return alert('Select source folder');
                            }

                            const targets = folderCheckboxes
                                .filter(checkbox => checkbox.checked && checkbox.value !== selectedSourceFolder)
                                .map(checkbox => checkbox.value);

                            if (!targets.length) {
                                return alert('No targets selected');
                            }

                        window.api.copyFolder({ src: selectedSourceFolder, targets })
                            .then(() => {
                                alert('Folder copied!');
                            })
                            .catch(err => alert(err.message));
                        }
                    });

                    const deleteFolderBtn = createActionButton({
                        label: 'Delete',
                        className: 'is-danger',
                        title: 'Delete the checked existing folders',
                        disabled: true,
                        onClick: () => {
                            const targets = folderCheckboxes
                                .filter(checkbox => checkbox.checked && checkbox.dataset.exists === 'true')
                                .map(checkbox => checkbox.value);

                            if (!targets.length) {
                                return alert('No existing targets selected');
                            }

                            if (!confirm(`Delete selected folders?\n${targets.join('\n')}`)) {
                                return;
                            }

                            Promise.all(targets.map(target => window.api.deleteFolder(target)))
                                .then(() => {
                                    alert('Deleted!');
                                })
                                .catch(err => alert(err.message));
                        }
                    });

                    actionGroup.appendChild(copyFolderBtn);
                    actionGroup.appendChild(deleteFolderBtn);
                    actionSurface.appendChild(actionGroup);
                    nextHeader.appendChild(actionCell);

                    refreshFolderActions = () => {
                        const checkedTargets = folderCheckboxes.filter(checkbox => checkbox.checked);
                        const existingTargets = checkedTargets.filter(checkbox => checkbox.dataset.exists === 'true');

                        copyFolderBtn.disabled = !selectedSourceFolder || !checkedTargets.some(checkbox => checkbox.value !== selectedSourceFolder);
                        deleteFolderBtn.disabled = existingTargets.length === 0;
                    };

                    refreshFolderActions();

                    if (sectionState.header && sectionState.header.parentNode) {
                        sectionState.header.parentNode.replaceChild(nextHeader, sectionState.header);
                    }

                    sectionState.header = nextHeader;
                };

                sectionState.renderHeader();

                sectionState.populateContent = (force = false) => {
                    const nextNode = getTreeNodeById(nodeId) || node;

                    if (sectionState.contentInitialized && !force) {
                        return;
                    }

                    clearSectionDescendants(nodeId);
                    clearFileRowStatesForNode(nodeId);

                    const fragment = document.createDocumentFragment();

                    [...nextNode.__files]
                        .sort((left, right) => left.localeCompare(right))
                        .forEach(file => {
                            const row = createFileRow(file, depth + 1, nodeId);

                            if (row) {
                                fragment.appendChild(row);
                            }
                        });

                    const childNodes = renderNode(nextNode.__children, fullPath, depth + 1);
                    if (childNodes.childElementCount) {
                        fragment.appendChild(childNodes);
                    }

                    content.replaceChildren(fragment);
                    sectionState.contentInitialized = true;
                };

                if (expanded) {
                    sectionState.populateContent();
                }

                section.appendChild(sectionState.header);
                section.appendChild(content);
                container.appendChild(section);
            });

        return container;
    }

    canvas.appendChild(createHeaderRow());

    const treeContent = renderNode({ root: currentTree });
    if (treeContent.childElementCount) {
        canvas.appendChild(treeContent);
    } else {
        const emptyState = document.createElement('div');
        emptyState.className = 'compare-empty-state';
        emptyState.textContent = onlyDiff
            ? 'No differences are visible for the current filter.'
            : 'Nothing to render yet. Run a scan with at least two folders.';
        canvas.appendChild(emptyState);
    }

    scroll.appendChild(canvas);
    nextChildren.appendChild(scroll);
    list.replaceChildren(nextChildren);

    function getConnectedChildFolderStates(parentNodeId) {
        return Array.from(sectionStates.values())
            .filter(state => (
                state.nodeId !== parentNodeId &&
                getParentNodeId(state.nodeId) === parentNodeId &&
                state.section?.isConnected
            ))
            .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
    }

    activeRenderController = {
        onlyDiff,
        refreshMeta() {
            meta.textContent = `${dirs.length} folders | ${currentStats.folders} folders in tree | ${currentStats.files} files | ${currentStats.diffs} diff items`;
        },
        rerenderFileRow(filePath) {
            const normalizedPath = normalizeDataPath(filePath);
            const state = fileRowStates.get(normalizedPath);
            const nextEntry = currentData[normalizedPath];
            const parentNodeId = getParentFolderNodeId(normalizedPath);
            const parentState = sectionStates.get(parentNodeId);

            if (!state || !state.row.isConnected) {
                fileRowStates.delete(normalizedPath);

                if (!nextEntry || isDirectoryEntry(nextEntry) || !parentState || !parentState.section.isConnected) {
                    return nextEntry ? false : true;
                }

                if (!parentState.contentInitialized) {
                    return true;
                }

                const nextRow = createFileRow(normalizedPath, parentState.depth + 1, parentNodeId);
                if (!nextRow) {
                    return true;
                }

                const nextSiblingState = Array.from(fileRowStates.values())
                    .filter(fileState => fileState.parentNodeId === parentNodeId && fileState.row.isConnected && fileState.filePath.localeCompare(normalizedPath) > 0)
                    .sort((left, right) => left.filePath.localeCompare(right.filePath))[0];

                if (nextSiblingState?.row?.parentNode === parentState.content) {
                    parentState.content.insertBefore(nextRow, nextSiblingState.row);
                    return true;
                }

                const firstSection = Array.from(parentState.content.children).find(element => element.tagName === 'SECTION');
                if (firstSection) {
                    parentState.content.insertBefore(nextRow, firstSection);
                } else {
                    parentState.content.appendChild(nextRow);
                }

                return true;
            }

            if (!nextEntry || isDirectoryEntry(nextEntry)) {
                state.row.remove();
                fileRowStates.delete(normalizedPath);
                return true;
            }

            const nextRow = createFileRow(normalizedPath, state.depth, state.parentNodeId);

            if (!nextRow) {
                state.row.remove();
                fileRowStates.delete(normalizedPath);
                return true;
            }

            state.row.parentNode.replaceChild(nextRow, state.row);
            return true;
        },
        rerenderFolderSection(relativePath) {
            const normalizedPath = normalizeDataPath(relativePath);
            const nodeId = buildNodeId(normalizedPath);
            const parentNodeId = getParentFolderNodeId(normalizedPath);
            const parentState = sectionStates.get(parentNodeId);
            const existingState = sectionStates.get(nodeId);
            const nextEntry = currentData[normalizedPath];
            const nextNode = getTreeNodeById(nodeId);

            if (existingState && (!existingState.section || !existingState.section.isConnected)) {
                clearSectionDescendants(nodeId);
                clearFileRowStatesForNode(nodeId);
                sectionStates.delete(nodeId);
            }

            if (!nextEntry || !isDirectoryEntry(nextEntry) || !nextNode) {
                if (!existingState?.section?.isConnected) {
                    return !nextEntry;
                }

                clearSectionDescendants(nodeId);
                clearFileRowStatesForNode(nodeId);
                sectionStates.delete(nodeId);
                existingState.section.remove();
                return true;
            }

            if (!parentState || !parentState.section.isConnected) {
                return false;
            }

            if (!parentState.contentInitialized) {
                return true;
            }

            clearSectionDescendants(nodeId);
            clearFileRowStatesForNode(nodeId);
            sectionStates.delete(nodeId);

            const folderName = normalizedPath.split('/').pop();
            const rendered = renderNode({ [folderName]: nextNode }, parentNodeId, parentState.depth + 1);
            const nextSection = rendered.firstElementChild;

            if (!nextSection) {
                return false;
            }

            if (existingState?.section?.isConnected) {
                existingState.section.replaceWith(nextSection);
                return true;
            }

            const nextSiblingState = getConnectedChildFolderStates(parentNodeId)
                .find(state => state.nodeId.localeCompare(nodeId) > 0);

            if (nextSiblingState?.section?.parentNode === parentState.content) {
                parentState.content.insertBefore(nextSection, nextSiblingState.section);
                return true;
            }

            parentState.content.appendChild(nextSection);
            return true;
        },
        rerenderFolderContent(nodeId) {
            const state = sectionStates.get(nodeId);

            if (!state || !state.section.isConnected) {
                sectionStates.delete(nodeId);
                return false;
            }

            clearSectionDescendants(nodeId);
            clearFileRowStatesForNode(nodeId);

            if (!collapseState[nodeId]) {
                state.content.replaceChildren();
                state.contentInitialized = false;
                return true;
            }

            state.contentInitialized = false;
            state.populateContent(true);
            return true;
        },
        refreshFolderHeader(nodeId) {
            const state = sectionStates.get(nodeId);

            if (!state || !state.section.isConnected) {
                sectionStates.delete(nodeId);
                return false;
            }

            state.renderHeader();
            return true;
        },
        rerenderPaths(impactedPaths) {
            if (onlyDiff || !Array.isArray(impactedPaths) || !impactedPaths.length) {
                return false;
            }

            const patchScrollState = preservedScrollState;
            const targetContentNodeIds = new Set();
            const headerNodeIds = new Set();
            let didWork = false;

            impactedPaths.forEach(relativePath => {
                const normalizedPath = normalizeDataPath(relativePath);
                const parentNodeId = getParentFolderNodeId(normalizedPath);
                const nextEntry = currentData[normalizedPath];
                const folderNodeId = buildNodeId(normalizedPath);
                const isFileEntry = nextEntry ? !isDirectoryEntry(nextEntry) : fileRowStates.has(normalizedPath);
                const isFolderEntry = nextEntry ? isDirectoryEntry(nextEntry) : sectionStates.has(folderNodeId);

                if (!nextEntry && !fileRowStates.has(normalizedPath) && !sectionStates.has(folderNodeId)) {
                    // Ignore transient temp-file paths that were never rendered.
                } else if (isFileEntry && this.rerenderFileRow(normalizedPath)) {
                    didWork = true;
                } else if (isFolderEntry && this.rerenderFolderSection(normalizedPath)) {
                    didWork = true;
                } else {
                    targetContentNodeIds.add(parentNodeId);
                }

                let currentNodeId = parentNodeId;
                while (currentNodeId) {
                    headerNodeIds.add(currentNodeId);
                    currentNodeId = getParentNodeId(currentNodeId);
                }
            });

            Array.from(targetContentNodeIds)
                .sort((left, right) => left.length - right.length)
                .filter((nodeId, index, items) => {
                    return !items.slice(0, index).some(existing => nodeId.startsWith(`${existing}/`));
                })
                .forEach(nodeId => {
                if (this.rerenderFolderContent(nodeId)) {
                    didWork = true;
                }
            });

            Array.from(headerNodeIds)
                .sort((left, right) => right.length - left.length)
                .forEach(nodeId => {
                    if (this.refreshFolderHeader(nodeId)) {
                        didWork = true;
                    }
                });

            if (!didWork) {
                return false;
            }

            this.refreshMeta();
            restoreRenderScrollState(patchScrollState);
            return true;
        }
    };
    restoreRenderScrollState(scrollState);
}

document.getElementById('onlyDiff').onchange = render;

async function loadConfig() {
    try {
        const data = await window.api.loadConfig();
        if (!data) return;

        if (!Array.isArray(data)) {
            return alert('Invalid config format. Expected array.');
        }

        setFolderInputs(data);
    } catch (err) {
        alert('Error loading config: ' + err.message);
    }
}

async function saveConfig() {
    try {
        const inputs = document.querySelectorAll('.folder-input');
        const paths = Array.from(inputs)
            .map(input => input.value.trim())
            .filter(Boolean);

        if (paths.length < 2) {
            return alert('Add at least 2 folders to save config');
        }

        await window.api.saveConfig(paths);
        alert('Config saved!');
    } catch (err) {
        alert('Error saving config: ' + err.message);
    }
}

async function runCmd() {
    const input = document.getElementById('cmdInput');
    const command = input.value.trim();

    if (!command) return alert('Enter command');

    dirs = getDirs();

    if (!dirs.length) return alert('No folders');

    try {
        await window.api.runCommand({ dirs, command });
        alert('Command executed!');
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

window.runCmd = runCmd;
window.saveConfig = saveConfig;
window.loadConfig = loadConfig;
window.scan = scan;

document.getElementById('addFolderBtn').addEventListener('click', async () => {
    const input = appendFolderInputField('');
    await openFolderPickerForInput(input);
});

document.getElementById('loadConfigBtn').addEventListener('click', () => loadConfig());
document.getElementById('saveConfigBtn').addEventListener('click', () => saveConfig());
document.getElementById('scanBtn').addEventListener('click', () => scan());
document.getElementById('runCmdBtn').addEventListener('click', () => runCmd());

setFolderInputs(Array.from(document.querySelectorAll('#folders .folder-input')).map(input => input.value));
