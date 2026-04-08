let currentData = {};
let dirs = [];

async function scan() {
    const inputs = document.querySelectorAll('.folder-input');
    dirs = Array.from(inputs).map(i => i.value.trim()).filter(Boolean);
    if (dirs.length < 2) return alert('Please enter at least 2 folders');

    currentData = await window.api.scan(dirs);
    render();
}

function groupFiles() {
    const tree = {};

    Object.keys(currentData).forEach(file => {
        const parts = file.split(/\\|\//);
        let node = tree;

        // create only folder nodes (exclude last part = file)
        parts.slice(0, -1).forEach(part => {
            if (!node[part]) {
                node[part] = {
                    __files: [],
                    __children: {}
                };
            }
            node = node[part].__children;
        });

        // add file to parent folder
        const parent = parts.slice(0, -1).reduce((acc, part) => acc[part].__children, tree);
        const folderNode = parts.length > 1 ? parts.slice(0, -1).reduce((acc, part) => acc[part], tree) : null;

        if (folderNode) {
            folderNode.__files.push(file);
        } else {
            // root-level files
            if (!tree.__root) tree.__root = { __files: [], __children: {} };
            tree.__root.__files.push(file);
        }
    });

    return tree;
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
    };

    collapseBtn.onclick = () => {
        document.querySelectorAll('.folder-content').forEach(el => el.style.display = 'none');
        document.querySelectorAll('.folder-arrow').forEach(el => el.innerText = '▶ ');
    };

    function renderNode(node, path = '', depth = 0) {
        const container = document.createElement('div');

        Object.entries(node).forEach(([name, data]) => {
            if (name === '__root') return;

            const fullPath = path ? path + '/' + name : name;

            let hasDiff = false;

            data.__files.forEach(file => {
                const entries = currentData[file];
                const hashes = Object.values(entries).map(x => x?.hash);
                if (new Set(hashes).size > 1) hasDiff = true;
            });

            const folderDiv = document.createElement('div');
            folderDiv.style.border = '1px solid #ccc';
            folderDiv.style.marginBottom = '4px';
            folderDiv.style.marginLeft = (depth * 10) + 'px';

            const header = document.createElement('div');
            header.style.cursor = 'pointer';
            header.style.background = '#eee';
            header.style.padding = '4px';

            let expanded = hasDiff;

            const arrow = document.createElement('span');
            arrow.className = 'folder-arrow';
            arrow.innerText = expanded ? '▼ ' : '▶ ';

            const title = document.createElement('span');
            title.innerText = '📁 ' + name;

            header.appendChild(arrow);
            header.appendChild(title);

            const content = document.createElement('div');
            content.className = 'folder-content';
            content.style.display = expanded ? 'block' : 'none';

            header.onclick = () => {
                expanded = !expanded;
                content.style.display = expanded ? 'block' : 'none';
                arrow.innerText = expanded ? '▼ ' : '▶ ';
            };

            // files (no folder UI, just rows)
            data.__files.forEach(file => {
                const entries = currentData[file];
                const hashes = Object.values(entries).map(x => x?.hash);
                const unique = new Set(hashes);

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
                        cell.innerText = '—';
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

                    wrapper.appendChild(radio);
                    wrapper.appendChild(cb);

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
                copyBtn.innerText = 'Apply';
                copyBtn.onclick = () => {
                    if (!selectedSource) return alert('Select source');

                    const targets = checkboxes
                        .filter(cb => cb.checked && cb.value !== selectedSource)
                        .map(cb => cb.value);

                    window.api.copyFile({ src: selectedSource, targets });
                };

                actions.appendChild(diffBtn);
                actions.appendChild(copyBtn);

                row.appendChild(actions);
                content.appendChild(row);
            });

            // children
            const childNodes = renderNode(data.__children, fullPath, depth + 1);
            content.appendChild(childNodes);

            folderDiv.appendChild(header);
            folderDiv.appendChild(content);
            container.appendChild(folderDiv);
        });

        return container;
    }

    list.appendChild(renderNode(tree));
}

window.scan = scan;