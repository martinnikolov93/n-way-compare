const assert = require('node:assert/strict');

const DifferenceFileTypes = require('../difference-file-types.js');
const DifferenceInlineDiff = require('../difference-inline-diff.js');
const DifferenceTransfer = require('../difference-transfer.js');
const { createNumberedListFixtures, createProseAlignmentPanes } = require('./fixtures/difference-fixtures.js');
const { loadDifferenceEngine } = require('./helpers/load-difference-engine.js');

const DifferenceEngine = loadDifferenceEngine();
const tests = [];

function test(name, run) {
    tests.push({ name, run });
}

function createPane(content, label) {
    return {
        label,
        content,
        exists: true,
        dirty: false
    };
}

function rebuildTab(tab) {
    DifferenceEngine.rebuildTab(tab);
    return tab;
}

function createTabFromContents(contents) {
    return rebuildTab({
        panes: contents.map(({ label, content }) => createPane(content, label))
    });
}

function loadWorkspaceFixtureTab() {
    return createTabFromContents(createProseAlignmentPanes());
}

function loadKeyedFixtureTab() {
    return createTabFromContents(createNumberedListFixtures());
}

function findRowIndex(tab, text, paneIndex = 0) {
    return tab.rows.findIndex((row) => {
        const cell = row.cells[paneIndex];
        return cell && !cell.missing && cell.text.includes(text);
    });
}

function collectWindow(tab, startRow, endRow) {
    const rows = [];

    for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
        rows.push(
            tab.rows[rowIndex].cells.map((cell) => {
                if (cell.missing) {
                    return { missing: true };
                }

                return {
                    missing: false,
                    text: cell.text,
                    lineNumber: cell.lineNumber
                };
            })
        );
    }

    return rows;
}

function buildUpperBlockSignature(tab) {
    const rows = [];
    let started = false;

    for (let rowIndex = 0; rowIndex < tab.rows.length; rowIndex += 1) {
        const row = tab.rows[rowIndex];
        const texts = row.cells.map((cell) => (cell.missing ? '' : cell.text));

        if (!started && texts.some((text) => text.includes('A folded note rests beside the window latch.'))) {
            started = true;
        }

        if (!started) {
            continue;
        }

        rows.push(row.cells.map((cell) => {
            if (cell.missing) {
                return 'M';
            }

            if (cell.text.includes('A folded note rests beside the window latch.')) {
                return 'T';
            }

            if (cell.text.includes('A patient gull circles above the water.')) {
                return 'P';
            }

            if (cell.text.includes('Soft footsteps echo through the corridor.')) {
                return 'C';
            }

            if (cell.text.includes('The cedar gate stays open until dusk.')) {
                return 'L';
            }

            return cell.text.trim() === '' ? 'B' : 'X';
        }).join(''));

        if (texts.some((text) => text.includes('The cedar gate stays open until dusk.'))) {
            break;
        }
    }

    return rows.join('|');
}

test('image file type helper recognizes supported image formats including avif', () => {
    assert.equal(DifferenceFileTypes.isImageFilePath('poster.png'), true);
    assert.equal(DifferenceFileTypes.isImageFilePath('poster.AVIF'), true);
    assert.equal(DifferenceFileTypes.isImageFilePath('poster.jpeg'), true);
    assert.equal(DifferenceFileTypes.isImageFilePath('poster.svg'), true);
    assert.equal(DifferenceFileTypes.getMimeTypeForFilePath('poster.avif'), 'image/avif');
});

test('image file type helper leaves text and extensionless files in text mode', () => {
    assert.equal(DifferenceFileTypes.isImageFilePath('notes.txt'), false);
    assert.equal(DifferenceFileTypes.isImageFilePath('README'), false);
    assert.equal(DifferenceFileTypes.isImageFilePath('archive.tar.gz'), false);
});

test('synthetic prose fixtures keep inserted descriptive lines between the surrounding blank rows', () => {
    const tab = loadWorkspaceFixtureTab();
    const anchorRow = findRowIndex(tab, 'A folded note rests beside the window latch.', 0);
    const destinationRow = findRowIndex(tab, 'The cedar gate stays open until dusk.', 0);
    const block = collectWindow(tab, anchorRow, destinationRow);

    assert.equal(block.length, 8);
    assert.deepEqual(block[0].map((cell) => cell.missing ? 'M' : cell.text.trim()), [
        'A folded note rests beside the window latch.',
        'A folded note rests beside the window latch.',
        'A folded note rests beside the window latch.',
        'A folded note rests beside the window latch.'
    ]);
    assert.deepEqual(block[1].map((cell) => cell.missing ? 'M' : cell.text), ['', '', '', '']);
    assert.deepEqual(block[2].map((cell) => cell.missing ? 'M' : cell.text.trim()), [
        'The third lantern hums softly.',
        'The third lantern hums softly.',
        'The third lantern hums softly.',
        'The third lantern hums softly.'
    ]);
    assert.deepEqual(block[3].map((cell) => cell.missing ? 'M' : cell.text), ['', '', '', '']);
    assert.deepEqual(block[4].map((cell) => cell.missing ? 'M' : cell.text.trim()), [
        'M',
        'M',
        'A patient gull circles above the water.',
        'M'
    ]);
    assert.deepEqual(block[5].map((cell) => cell.missing ? 'M' : cell.text.trim()), [
        'M',
        'M',
        'Soft footsteps echo through the corridor.',
        'M'
    ]);
    assert.deepEqual(block[6].map((cell) => cell.missing ? 'M' : cell.text), ['', '', '', '']);
    assert.ok(block[7].every((cell) => !cell.missing && cell.text.includes('The cedar gate stays open until dusk.')));
});

test('deleting the first blank row keeps the missing marker on the deleted row', () => {
    const tab = createTabFromContents([
        { label: 'A', content: 'text\n\n\n\ntext' },
        { label: 'B', content: 'text\n\ntext' },
        { label: 'C', content: 'text\n\ntext' },
        { label: 'D', content: 'text\n\ntext' }
    ]);

    tab.panes[0] = DifferenceEngine.replacePaneSelection(tab, 0, 1, 1, []);
    rebuildTab(tab);

    const rows = collectWindow(tab, 0, 4);
    assert.equal(rows[1][0].missing, true);
    assert.equal(rows[1][1].text, '');
    assert.equal(rows[2][0].text, '');
    assert.equal(rows[2][1].missing, true);
    assert.equal(rows[3][0].text, '');
    assert.equal(rows[3][1].missing, true);
});

test('deleting the same blank block twice stays stable and does not misalign the remaining text', () => {
    const tab = createTabFromContents([
        { label: 'A', content: 'text\n\n\n\ntext' },
        { label: 'B', content: 'text\n\ntext' }
    ]);

    tab.panes[0] = DifferenceEngine.replacePaneSelection(tab, 0, 1, 1, []);
    rebuildTab(tab);
    tab.panes[0] = DifferenceEngine.replacePaneSelection(tab, 0, 2, 2, []);
    rebuildTab(tab);

    const rows = collectWindow(tab, 0, 2);
    assert.deepEqual(rows.map((row) => row.map((cell) => cell.missing ? 'M' : cell.text)), [
        ['text', 'text'],
        ['', ''],
        ['text', 'text']
    ]);
});

test('editing lower blank rows and moving them right does not destabilize the upper diff block', () => {
    const baselineTab = loadWorkspaceFixtureTab();
    const baselineSignature = buildUpperBlockSignature(baselineTab);

    const tab = loadWorkspaceFixtureTab();
    const featureRow = findRowIndex(tab, 'The noon whistle fades away.', 0);

    tab.panes[0] = DifferenceEngine.replacePaneSelection(tab, 0, featureRow + 1, featureRow + 2, []);
    rebuildTab(tab);

    const movedLines = DifferenceTransfer.getTransferLinesFromPane(tab, 0, 1, featureRow + 2, featureRow + 3);
    tab.panes[1] = DifferenceEngine.replacePaneSelection(tab, 1, featureRow + 2, featureRow + 3, movedLines);
    rebuildTab(tab);

    assert.equal(buildUpperBlockSignature(tab), baselineSignature);
});

test('changed lines with blank lines above and below stay paired instead of turning into missing rows', () => {
    const tab = createTabFromContents([
        { label: 'A', content: '\nalpha\nbeta\n\n' },
        { label: 'B', content: '\ngamma\ndelta\n\n' }
    ]);

    const block = collectWindow(tab, 0, 3);
    assert.deepEqual(block[0].map((cell) => cell.missing ? 'M' : cell.text), ['', '']);
    assert.deepEqual(block[1].map((cell) => cell.missing ? 'M' : cell.text.trim()), ['alpha', 'gamma']);
    assert.deepEqual(block[2].map((cell) => cell.missing ? 'M' : cell.text.trim()), ['beta', 'delta']);
    assert.deepEqual(block[3].map((cell) => cell.missing ? 'M' : cell.text), ['', '']);
});

test('two-pane numbered prose rows stay aligned by their leading key', () => {
    const tab = createTabFromContents(createNumberedListFixtures().slice(0, 2));

    const rows = collectWindow(tab, 0, 2);
    assert.ok(rows[0].every((cell) => !cell.missing));
    assert.ok(rows[1].every((cell) => !cell.missing));
    assert.ok(rows[0][0].text.startsWith('1:'));
    assert.ok(rows[0][1].text.startsWith('1:'));
    assert.ok(rows[1][0].text.startsWith('2:'));
    assert.ok(rows[1][1].text.startsWith('2:'));
    assert.equal(rows[2][0].missing, true);
    assert.ok(rows[2][1].text.startsWith('3:'));
});

test('multi-pane numbered prose rows keep shared keys paired and only tail rows become missing', () => {
    const tab = loadKeyedFixtureTab();
    const rows = collectWindow(tab, 0, 4);

    assert.ok(rows[0].every((cell) => !cell.missing && cell.text.startsWith('1:')));
    assert.ok(rows[1].every((cell) => !cell.missing && cell.text.startsWith('2:')));
    assert.equal(rows[2][0].missing, true);
    assert.ok(rows[2][1].text.startsWith('3:'));
    assert.ok(rows[2][2].text.startsWith('3:'));
    assert.ok(rows[2][3].text.startsWith('3:'));
    assert.equal(rows[3][0].missing, true);
    assert.equal(rows[3][1].missing, true);
    assert.ok(rows[3][2].text.startsWith('4:'));
    assert.ok(rows[3][3].text.startsWith('4:'));
    assert.equal(rows[4][0].missing, true);
    assert.equal(rows[4][1].missing, true);
    assert.equal(rows[4][2].missing, true);
    assert.ok(rows[4][3].text.startsWith('5:'));
});

test('copying a blank run into a missing block keeps the transferred rows aligned', () => {
    const tab = createTabFromContents([
        { label: 'A', content: 'before\n\n\nafter' },
        { label: 'B', content: 'before\nafter' }
    ]);

    const transferred = DifferenceTransfer.getTransferLinesFromPane(tab, 0, 1, 1, 2);
    tab.panes[1] = DifferenceEngine.replacePaneSelection(tab, 1, 1, 2, transferred);
    rebuildTab(tab);

    const rows = collectWindow(tab, 0, 3);
    assert.deepEqual(rows.map((row) => row.map((cell) => cell.missing ? 'M' : cell.text)), [
        ['before', 'before'],
        ['', ''],
        ['', ''],
        ['after', 'after']
    ]);
});

test('copying over existing target rows keeps a one-to-one replacement without inserting extra gaps', () => {
    const tab = createTabFromContents([
        { label: 'A', content: 'header\nalpha\nbeta\nfooter' },
        { label: 'B', content: 'header\none\ntwo\nfooter' }
    ]);

    const transferred = DifferenceTransfer.getTransferLinesFromPane(tab, 0, 1, 1, 2);
    tab.panes[1] = DifferenceEngine.replacePaneSelection(tab, 1, 1, 2, transferred);
    rebuildTab(tab);

    const rows = collectWindow(tab, 0, 3);
    assert.deepEqual(rows.map((row) => row.map((cell) => cell.missing ? 'M' : cell.text)), [
        ['header', 'header'],
        ['alpha', 'alpha'],
        ['beta', 'beta'],
        ['footer', 'footer']
    ]);
});

test('inline diff can highlight only the changed core of a similar word and leave the shared ending alone', () => {
    const source = 'A quiet amber lantern waits by the door.';
    const compare = 'A quiet silver lantern waits by the door.';
    const ranges = DifferenceInlineDiff.getDifferenceRanges(source, compare);

    assert.deepEqual(ranges, [{
        start: source.indexOf('amb'),
        end: source.indexOf('amb') + 'amb'.length
    }]);
    assert.equal(source.slice(ranges[0].end, ranges[0].end + 2), 'er');
});

test('inline diff highlights only the changed digit when the leading digit is shared', () => {
    const source = 'Inventory note: 12, 24, 36.';
    const compare = 'Inventory note: 19, 24, 36.';
    const ranges = DifferenceInlineDiff.getDifferenceRanges(source, compare);

    assert.deepEqual(ranges, [{
        start: source.indexOf('2'),
        end: source.indexOf('2') + 1
    }]);
    assert.equal(source.slice(ranges[0].end, ranges[0].end + 1), ',');
    assert.equal(source.slice(ranges[0].start - 1, ranges[0].start), '1');
});

test('inline diff leaves the source side unhighlighted when text is only inserted in the other side', () => {
    const source = 'Morning bells drift across the square.';
    const compare = 'Morning bells softly drift across the square.';

    assert.deepEqual(DifferenceInlineDiff.getDifferenceRanges(source, compare), []);
});

test('token diff isolates the changed core of a list item without swallowing neighboring commas', () => {
    const source = 'Market list: pears, plums, figs.';
    const compare = 'Market list: peaches, plums, figs.';
    const ranges = DifferenceInlineDiff.getDifferenceRanges(source, compare);
    const pearIndex = source.indexOf('pears');
    const changedCharIndex = source.indexOf('r', pearIndex);

    assert.deepEqual(ranges, [{
        start: changedCharIndex,
        end: changedCharIndex + 1
    }]);
    assert.equal(source.slice(ranges[0].start - 3, ranges[0].start), 'pea');
    assert.equal(source.slice(ranges[0].end, ranges[0].end + 2), 's,');
});

async function runTests() {
    let failures = 0;

    console.log(`Running ${tests.length} diff regression tests...\n`);

    for (const currentTest of tests) {
        try {
            await currentTest.run();
            console.log(`PASS ${currentTest.name}`);
        } catch (error) {
            failures += 1;
            console.error(`FAIL ${currentTest.name}`);
            console.error(error && error.stack ? error.stack : error);
            console.error('');
        }
    }

    if (failures) {
        console.error(`${failures} test(s) failed.`);
        process.exitCode = 1;
        return;
    }

    console.log(`\nAll ${tests.length} diff regression tests passed.`);
}

if (require.main === module) {
    runTests();
}

module.exports = {
    runTests
};
