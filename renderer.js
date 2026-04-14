let currentData = {};
let dirs = [];

// 🔥 collapse/expand cache
const collapseState = {};

let lastWatchedDirs = [];

function arraysEqual(a, b) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function scan(resetCache = false) {
    const loader = document.getElementById('scanLoader');
    loader.style.display = 'inline';

    try {
        const inputs = document.querySelectorAll('.folder-input');
        dirs = Array.from(inputs).map(i => i.value.trim()).filter(Boolean);

        if (dirs.length < 2) {
            loader.style.display = 'none';
            return alert('Please enter at least 2 folders');
        }

        if (resetCache) {
            for (let k in collapseState) delete collapseState[k];
        }

        currentData = await window.api.scan(dirs);
        render();

    } catch (err) {
        alert('Scan error: ' + err.message);
    } finally {
        loader.style.display = 'none';
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

function folderExistsInDir(dirIndex, node) {
    return node.__files.some(file => currentData[file]?.[dirIndex]) ||
        Object.values(node.__children).some(child => folderExistsInDir(dirIndex, child));
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
    const expandDiffBtn = document.createElement('button');
    expandDiffBtn.innerText = 'Expand Diff';

    controls.appendChild(expandBtn);
    controls.appendChild(expandDiffBtn);
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

    expandDiffBtn.onclick = () => {
        const tree = groupFiles();

        function apply(node, path = '') {
            Object.entries(node).forEach(([name, data]) => {
                const fullPath = path ? path + '/' + name : name;
                const key = fullPath;

                const hasDiff = nodeHasDiff(data);

                collapseState[key] = hasDiff;

                apply(data.__children, fullPath);
            });
        }

        apply({ root: tree });

        render();
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
            // folderDiv.style.marginLeft = (depth * 10) + 'px';
            folderDiv.style.marginLeft = '10px';
            folderDiv.style.width = "max-content";

            const header = document.createElement('div');
            header.style.display = 'grid';
            header.style.gridTemplateColumns = `300px repeat(${dirs.length}, 135px) 135px`;
            // header.style.cursor = 'pointer';
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
            arrow.style.cursor = 'pointer';
            arrow.onclick = () => {
                expanded = !expanded;
                collapseState[nodeId] = expanded; // update cache
                content.style.display = expanded ? 'block' : 'none';
                arrow.innerText = expanded ? '▼ ' : '▶ ';
            };

            const title = document.createElement('span');

            const icon = document.createElement('span');
            icon.innerText = hasDiff ? '❌ ' : '✅ ';

            const text = document.createElement('span');
            text.innerText = isRoot ? '📁 root' : '📁 ' + name;

            title.appendChild(icon);
            title.appendChild(text);

            const nameCol = document.createElement('div');
            nameCol.appendChild(arrow);
            nameCol.appendChild(title);
            header.appendChild(nameCol);

            let selectedSourceFolder = null;
            const folderCheckboxes = [];

            dirs.forEach((dir, idx) => {
                const col = document.createElement('div');
                const wrapper = document.createElement('div');
                wrapper.style.padding = '0 6px';
                wrapper.style.minWidth = '80px';
                wrapper.style.textAlign = 'center';

                // ⚠️ реален път към тази подпапка
                const folderPath = isRoot
                    ? dir
                    : dir + '/' + fullPath.replace(/^root[\\/]/, '');

                const exists = folderExistsInDir(idx, data);

                // 🔘 source radio
                const radio = document.createElement('input');
                radio.type = 'radio';
                radio.name = 'folder-' + fullPath;
                radio.disabled = !exists; // не може да е source ако липсва
                radio.onclick = (e) => {
                    e.stopPropagation();
                    selectedSourceFolder = folderPath;
                };


                // ☑️ target checkbox
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.value = folderPath;
                cb.onclick = (e) => {
                    e.stopPropagation();
                };
                folderCheckboxes.push(cb);

                const label = document.createElement('div');
                label.innerText = getFolderName(dir);
                label.style.fontSize = '12px';
                label.style.whiteSpace = 'nowrap';
                label.style.overflow = 'hidden';
                label.style.textOverflow = 'ellipsis';

                wrapper.appendChild(label);

                // ❓ missing indicator
                if (!exists) {
                    const missing = document.createElement('span');
                    missing.innerText = '❓';
                    missing.title = 'Folder missing in this location';
                    wrapper.appendChild(missing);
                }
                wrapper.appendChild(radio);
                wrapper.appendChild(cb);

                // 🔥 визуално highlight ако липсва
                if (!exists) {
                    wrapper.style.background = '#fff3cd';
                }

                col.appendChild(wrapper);
                header.appendChild(col);
            });

            const actions = document.createElement('div');
            actions.style.display = 'flex';
            actions.style.gap = '4px';

            // 📁 COPY
            const copyBtn = document.createElement('button');
            copyBtn.innerText = 'Copy';
            copyBtn.style.cursor = 'pointer';

            copyBtn.onclick = () => {
                if (!selectedSourceFolder) return alert('Select source folder');

                const targets = folderCheckboxes
                    .filter(cb => cb.checked && cb.value !== selectedSourceFolder)
                    .map(cb => cb.value);

                if (!targets.length) return alert('No targets selected');

                window.api.copyFolder({ src: selectedSourceFolder, targets })
                    .then(() => {
                        alert('Folder copied!');
                        scan();
                    })
                    .catch(err => alert(err.message));
            };

            // ❌ DELETE
            const deleteBtn = document.createElement('button');
            deleteBtn.innerText = 'Delete';
            deleteBtn.style.color = 'red';
            deleteBtn.style.cursor = 'pointer';

            deleteBtn.onclick = () => {
                const targets = folderCheckboxes
                    .filter(cb => cb.checked)
                    .map(cb => cb.value);

                if (!targets.length) return alert('No targets selected');

                // if (!confirm('Delete selected folders?')) return;
                if (!confirm(`Delete selected folders?\n${targets.join('\n')}`)) return;

                Promise.all(targets.map(t => window.api.deleteFolder(t)))
                    .then(() => {
                        alert('Deleted!');
                        scan();
                    })
                    .catch(err => alert(err.message));
            };

            actions.appendChild(copyBtn);
            actions.appendChild(deleteBtn);

            header.appendChild(actions);

            const content = document.createElement('div');
            content.className = 'folder-content';
            content.style.display = expanded ? 'block' : 'none';

            // header.onclick = () => {
            //     expanded = !expanded;
            //     collapseState[nodeId] = expanded; // update cache
            //     content.style.display = expanded ? 'block' : 'none';
            //     arrow.innerText = expanded ? '▼ ' : '▶ ';
            // };

            // 📄 FILES
            data.__files.forEach(file => {
                const entries = currentData[file];
                const hashes = dirs.map((_, i) => entries[i]?.hash || '__MISSING__');
                const unique = new Set(hashes);
                if (onlyDiff && unique.size <= 1) return;

                const row = document.createElement('div');
                row.style.display = 'grid';
                row.style.gridTemplateColumns = `300px repeat(${dirs.length}, 135px) 135px`;
                row.style.borderBottom = '1px solid #ddd';
                row.style.padding = '2px';
                // row.style.marginLeft = (depth * 10 + 10) + 'px';
                row.style.marginLeft = '10px';

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
                        wrapper.style.textAlign = "center";
                        cell.appendChild(wrapper);
                        row.appendChild(cell);
                        return;
                    }

                    const wrapper = document.createElement('div');
                    wrapper.style.textAlign = "center";

                    const radio = document.createElement('input');
                    radio.type = 'radio';
                    radio.name = file;
                    radio.onclick = () => selectedSource = entry.path;

                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.value = entry.path;
                    checkboxes.push(cb);

                    // const delBtn = document.createElement('span');
                    // delBtn.innerText = '❌';
                    // delBtn.style.cursor = 'pointer';
                    // delBtn.style.marginLeft = '4px';
                    // delBtn.title = 'Delete this file from this folder';
                    // delBtn.onclick = () => {
                    //     if (!confirm('Delete this file?')) return;
                    //     window.api.deleteFile(entry.path)
                    //         .then(() => {
                    //             alert('Deleted!');
                    //             scan();
                    //         })
                    //         .catch(err => alert('Error: ' + err.message));
                    // };

                    wrapper.appendChild(radio);
                    wrapper.appendChild(cb);
                    // wrapper.appendChild(delBtn);

                    if (unique.size > 1 && entry.hash !== hashes[0]) {
                        wrapper.style.background = '#ffdddd';
                    }

                    cell.appendChild(wrapper);
                    row.appendChild(cell);
                });

                const actions = document.createElement('div');

                // малко spacing между бутоните
                actions.style.display = 'flex';
                actions.style.gap = '6px';

                // 🔍 DIFF
                const diffBtn = document.createElement('button');
                diffBtn.innerText = 'Diff';
                diffBtn.style.cursor = "pointer";
                diffBtn.onclick = () => {
                    const files = Object.values(entries).filter(Boolean).map(e => e.path);
                    window.api.openDiffuse(files);
                };

                // 📋 COPY
                const copyBtn = document.createElement('button');
                copyBtn.innerText = 'Copy';
                copyBtn.style.cursor = "pointer";
                copyBtn.onclick = () => {
                    if (!selectedSource) return alert('Select source');

                    const targets = checkboxes
                        .filter(cb => cb.checked && cb.value !== selectedSource)
                        .map(cb => cb.value);

                    if (!targets.length) return alert('No targets selected');

                    window.api.copyFile({ src: selectedSource, targets })
                        .then(() => {
                            alert('Copied!');
                            scan();
                        })
                        .catch(err => alert('Error: ' + err.message));
                };

                const deleteBtn = document.createElement('button');
                deleteBtn.innerText = 'Delete';
                deleteBtn.style.color = 'red';
                // deleteBtn.style.background = '#ffdddd';
                // deleteBtn.style.border = '1px solid red';
                deleteBtn.style.cursor = "pointer";

                deleteBtn.onclick = () => {
                    const targets = checkboxes
                        .filter(cb => cb.checked)
                        .map(cb => cb.value);

                    if (!targets.length) return alert('No targets selected');

                    if (!confirm(`Delete ${targets.length} file(s)?`)) return;

                    Promise.all(targets.map(t => window.api.deleteFile(t)))
                        .then(() => {
                            alert('Deleted!');
                            scan();
                        })
                        .catch(err => alert('Error: ' + err.message));
                };

                actions.appendChild(diffBtn);
                actions.appendChild(copyBtn);
                actions.appendChild(deleteBtn);

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

async function loadConfig() {
    try {
        const data = await window.api.loadConfig();
        if (!data) return;

        if (!Array.isArray(data)) {
            return alert('Invalid config format. Expected array.');
        }

        const foldersDiv = document.getElementById('folders');
        foldersDiv.innerHTML = '';

        data.forEach((path, i) => {
            const input = document.createElement('input');
            input.className = 'folder-input';
            input.value = path;
            input.placeholder = `Folder ${i + 1}`;
            foldersDiv.appendChild(input);
        });

    } catch (err) {
        alert('Error loading config: ' + err.message);
    }
}

async function saveConfig() {
    try {
        const inputs = document.querySelectorAll('.folder-input');
        const paths = Array.from(inputs)
            .map(i => i.value.trim())
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