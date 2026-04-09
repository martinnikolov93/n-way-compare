let currentData = {};
let dirs = [];

// 🔥 collapse/expand cache
const collapseState = {};

let lastWatchedDirs = [];

function arraysEqual(a, b) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function scan(resetCache = false) {
    const inputs = document.querySelectorAll('.folder-input');
    dirs = Array.from(inputs).map(i => i.value.trim()).filter(Boolean);

    if (dirs.length < 2) return alert('Please enter at least 2 folders');

    if (resetCache) {
        for (let k in collapseState) delete collapseState[k];
    }

    currentData = await window.api.scan(dirs);
    render();

    // 🔥 само ако има промяна
    if (!arraysEqual(dirs, lastWatchedDirs)) {
        window.api.watchFolders(dirs);
        lastWatchedDirs = [...dirs];
    }
}

// автоматичен scan при промяна
window.api.onFolderChange(() => {
    console.log('Folder changed → rescanning');
    scan(); // пази collapseState
});

function groupFiles() {
    const root = {
        name: 'root',
        __files: [],
        __children: {}
    };

    Object.keys(currentData)
        .sort((a, b) => a.localeCompare(b))
        .forEach(file => {
            const parts = file.split(/\\|\//);
            let node = root;

            for (let i = 0; i < parts.length - 1; i++) {
                const part = parts[i];

                if (!node.__children[part]) {
                    node.__children[part] = {
                        name: part,
                        __files: [],
                        __children: {}
                    };
                }

                node = node.__children[part];
            }

            node.__files.push(file);
        });

    return root;
}

// 🔥 recursive diff check
function nodeHasDiff(node) {
    for (const file of node.__files) {
        const entries = currentData[file];
        const hashes = dirs.map((_, i) => entries[i]?.hash || '__MISSING__');
        if (new Set(hashes).size > 1) return true;
    }

    for (const child of Object.values(node.__children)) {
        if (nodeHasDiff(child)) return true;
    }

    return false;
}

function getFolderName(fullPath) {
    if (!fullPath) return '';
    return fullPath.split(/\\|\//).filter(Boolean).pop();
}

function render() {
    const list = document.getElementById('fileList');
    const onlyDiff = document.getElementById('onlyDiff').checked;
    list.innerHTML = '';

    const controls = document.createElement('div');
    const expandBtn = document.createElement('button');
    expandBtn.innerText = 'Expand All';
    const collapseBtn = document.createElement('button');
    collapseBtn.innerText = 'Collapse All';

    controls.appendChild(expandBtn);
    controls.appendChild(collapseBtn);
    list.appendChild(controls);

    const tree = groupFiles();

    expandBtn.onclick = () => {
        document.querySelectorAll('.folder-content').forEach(el => el.style.display = 'block');
        document.querySelectorAll('.folder-arrow').forEach(el => el.innerText = '▼ ');
        Object.keys(collapseState).forEach(k => collapseState[k] = true);
    };

    collapseBtn.onclick = () => {
        document.querySelectorAll('.folder-content').forEach(el => el.style.display = 'none');
        document.querySelectorAll('.folder-arrow').forEach(el => el.innerText = '▶ ');
        Object.keys(collapseState).forEach(k => collapseState[k] = false);
    };

    function renderNode(node, path = '', depth = 0) {
        const container = document.createElement('div');

        Object.entries(node).forEach(([name, data]) => {
            const isRoot = name === 'root';
            const fullPath = path ? path + '/' + name : name;
            const hasDiff = nodeHasDiff(data);

            // skip folder if onlyDiff и няма разлика
            if (onlyDiff && !hasDiff) return;

            const folderDiv = document.createElement('div');
            folderDiv.style.border = '1px solid #ccc';
            folderDiv.style.marginBottom = '4px';
            folderDiv.style.marginLeft = (depth * 10) + 'px';

            const header = document.createElement('div');
            header.style.display = 'grid';
            header.style.gridTemplateColumns = `300px repeat(${dirs.length}, 120px) 120px`;
            header.style.cursor = 'pointer';
            header.style.background = '#eee';
            header.style.padding = '4px';
            header.style.borderBottom = '1px solid #bbb';

            // 🔥 collapse/expand state
            const nodeId = fullPath;
            let expanded;
            if (collapseState[nodeId] !== undefined) {
                expanded = collapseState[nodeId];
            } else {
                expanded = hasDiff; // default behavior
                collapseState[nodeId] = expanded;
            }

            const arrow = document.createElement('span');
            arrow.className = 'folder-arrow';
            arrow.innerText = expanded ? '▼ ' : '▶ ';

            const title = document.createElement('span');
            title.innerText = isRoot ? '📁 root' : '📁 ' + name;

            const nameCol = document.createElement('div');
            nameCol.appendChild(arrow);
            nameCol.appendChild(title);
            header.appendChild(nameCol);

            dirs.forEach(dir => {
                const col = document.createElement('div');
                col.innerText = getFolderName(dir);
                col.style.textAlign = 'center';
                col.style.fontSize = '12px';
                col.style.whiteSpace = 'nowrap';
                col.style.overflow = 'hidden';
                col.style.textOverflow = 'ellipsis';
                col.style.padding = '0 6px';
                col.style.minWidth = '80px';
                header.appendChild(col);
            });

            const empty = document.createElement('div');
            header.appendChild(empty);

            const content = document.createElement('div');
            content.className = 'folder-content';
            content.style.display = expanded ? 'block' : 'none';

            header.onclick = () => {
                expanded = !expanded;
                collapseState[nodeId] = expanded; // update cache
                content.style.display = expanded ? 'block' : 'none';
                arrow.innerText = expanded ? '▼ ' : '▶ ';
            };

            // 📄 FILES
            data.__files.forEach(file => {
                const entries = currentData[file];
                const hashes = dirs.map((_, i) => entries[i]?.hash || '__MISSING__');
                const unique = new Set(hashes);
                if (onlyDiff && unique.size <= 1) return;

                const row = document.createElement('div');
                row.style.display = 'grid';
                row.style.gridTemplateColumns = `300px repeat(${dirs.length}, 120px) 120px`;
                row.style.borderBottom = '1px solid #ddd';
                row.style.padding = '2px';
                row.style.marginLeft = (depth * 10 + 10) + 'px';

                const nameDiv = document.createElement('div');
                nameDiv.innerText = file.split(/\\|\//).pop();
                if (unique.size > 1) nameDiv.style.color = 'red';
                row.appendChild(nameDiv);

                let selectedSource = null;
                const checkboxes = [];

                dirs.forEach((dir, idx) => {
                    const cell = document.createElement('div');
                    const entry = entries[idx];

                    if (!entry) {
                        const wrapper = document.createElement('div');
                        const missing = document.createElement('span');
                        missing.innerText = '❓';
                        missing.title = 'File missing in this folder (can copy here)';
                        const cb = document.createElement('input');
                        cb.type = 'checkbox';
                        cb.value = dirs[idx] + '/' + file;
                        checkboxes.push(cb);
                        wrapper.appendChild(missing);
                        wrapper.appendChild(cb);
                        wrapper.style.background = '#fff3cd';
                        cell.appendChild(wrapper);
                        row.appendChild(cell);
                        return;
                    }

                    const wrapper = document.createElement('div');

                    const radio = document.createElement('input');
                    radio.type = 'radio';
                    radio.name = file;
                    radio.onclick = () => selectedSource = entry.path;

                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.value = entry.path;
                    checkboxes.push(cb);

                    const delBtn = document.createElement('span');
                    delBtn.innerText = '❌';
                    delBtn.style.cursor = 'pointer';
                    delBtn.style.marginLeft = '4px';
                    delBtn.title = 'Delete this file from this folder';
                    delBtn.onclick = () => {
                        if (!confirm('Delete this file?')) return;
                        window.api.deleteFile(entry.path)
                            .then(() => {
                                alert('Deleted!');
                                scan();
                            })
                            .catch(err => alert('Error: ' + err.message));
                    };

                    wrapper.appendChild(radio);
                    wrapper.appendChild(cb);
                    wrapper.appendChild(delBtn);

                    if (unique.size > 1 && entry.hash !== hashes[0]) {
                        wrapper.style.background = '#ffdddd';
                    }

                    cell.appendChild(wrapper);
                    row.appendChild(cell);
                });

                const actions = document.createElement('div');
                const diffBtn = document.createElement('button');
                diffBtn.innerText = 'Diff';
                diffBtn.onclick = () => {
                    const files = Object.values(entries).filter(Boolean).map(e => e.path);
                    window.api.openDiffuse(files);
                };

                const copyBtn = document.createElement('button');
                copyBtn.innerText = 'Copy';
                copyBtn.onclick = () => {
                    if (!selectedSource) return alert('Select source');
                    const targets = checkboxes.filter(cb => cb.checked && cb.value !== selectedSource).map(cb => cb.value);
                    window.api.copyFile({ src: selectedSource, targets })
                        .then(() => {
                            alert('Copied!');
                            scan();
                        })
                        .catch(err => alert('Error: ' + err.message));
                };

                actions.appendChild(diffBtn);
                actions.appendChild(copyBtn);
                row.appendChild(actions);
                content.appendChild(row);
            });

            // 📁 CHILDREN
            const childNodes = renderNode(data.__children, fullPath, depth + 1);
            content.appendChild(childNodes);

            folderDiv.appendChild(header);
            folderDiv.appendChild(content);
            container.appendChild(folderDiv);
        });

        return container;
    }

    list.appendChild(renderNode({ root: tree }));
}

// 🔥 auto refresh при toggle
document.getElementById('onlyDiff').onchange = render;

window.scan = scan;