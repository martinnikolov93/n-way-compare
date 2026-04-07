
let currentData = {};

async function scan() {
    const inputs = document.querySelectorAll('.folder-input');
    const dirs = Array.from(inputs).map(i => i.value.trim()).filter(Boolean);
    if (dirs.length < 2) return alert('Please enter at least 2 folders');

    currentData = await window.api.scan(dirs);
    render(dirs);
}

function render(dirs) {
    const list = document.getElementById('fileList');
    const onlyDiff = document.getElementById('onlyDiff').checked;
    list.innerHTML = '';

    Object.keys(currentData).forEach(file => {
        const entries = currentData[file];
        const hashes = Object.values(entries).map(x => x?.hash);
        const unique = new Set(hashes);

        if (onlyDiff && unique.size <= 1) return;

        const row = document.createElement('div');
        row.style.display = 'grid';
        row.style.gridTemplateColumns = `300px repeat(${dirs.length}, 120px) 120px`;
        row.style.borderBottom = '1px solid #ccc';
        row.style.padding = '4px';

        const name = document.createElement('div');
        name.innerText = file;
        if (unique.size > 1) name.style.color = 'red';
        row.appendChild(name);

        let selectedSource = null;
        const checkboxes = [];

        dirs.forEach((dir, idx) => {
            const cell = document.createElement('div');
            const entry = entries[idx];
            if (!entry) { cell.innerText = '—'; row.appendChild(cell); return; }

            const wrapper = document.createElement('div');
            const radio = document.createElement('input');
            radio.type = 'radio'; radio.name = file; radio.onclick = () => selectedSource = entry.path;
            const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = entry.path; checkboxes.push(cb);
            wrapper.appendChild(radio); wrapper.appendChild(cb); wrapper.appendChild(document.createTextNode(' ' + (idx + 1)));
            if (unique.size > 1 && entry.hash !== hashes[0]) wrapper.style.background = '#ffdddd';
            cell.appendChild(wrapper); row.appendChild(cell);
        });

        const actions = document.createElement('div');
        const diffBtn = document.createElement('button'); diffBtn.innerText = 'Diff';
        diffBtn.onclick = () => { const files = Object.values(entries).filter(Boolean).map(e => e.path); window.api.openDiffuse(files); };
        const copyBtn = document.createElement('button'); copyBtn.innerText = 'Apply';
        copyBtn.onclick = () => {
            if (!selectedSource) return alert('Select source');
            const targets = checkboxes.filter(cb => cb.checked && cb.value !== selectedSource).map(cb => cb.value);
            window.api.copyFile({ src: selectedSource, targets });
        };
        actions.appendChild(diffBtn); actions.appendChild(copyBtn);
        row.appendChild(actions);

        list.appendChild(row);
    });
}

window.scan = scan;
