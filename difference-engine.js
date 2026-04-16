(function () {
    function detectNewline(text) {
        return text.includes('\r\n') ? '\r\n' : '\n';
    }

    function parseTextContent(content) {
        const safeContent = typeof content === 'string' ? content : '';
        const newline = detectNewline(safeContent);
        const normalized = safeContent.replace(/\r\n/g, '\n');
        const trailingNewline = normalized.endsWith('\n');

        if (!normalized.length) {
            return {
                content: safeContent,
                newline,
                trailingNewline: false,
                lines: []
            };
        }

        const parts = normalized.split('\n');
        if (trailingNewline) {
            parts.pop();
        }

        return {
            content: safeContent,
            newline,
            trailingNewline,
            lines: parts
        };
    }

    function serializeTextContent(pane) {
        const lines = Array.isArray(pane.lines) ? pane.lines : [];
        if (!lines.length) {
            return '';
        }

        let text = lines.join(pane.newline || '\n');
        if (pane.trailingNewline) {
            text += pane.newline || '\n';
        }

        return text;
    }

    function createCell(text, lineIndex) {
        return {
            text,
            lineNumber: lineIndex + 1
        };
    }

    function cellsEqual(left, right) {
        if (!left && !right) return true;
        if (!left || !right) return false;
        return left.text === right.text;
    }

    function buildGreedyDiff(leftLines, rightLines) {
        const ops = [];
        let leftIndex = 0;
        let rightIndex = 0;
        const lookAhead = 40;

        while (leftIndex < leftLines.length || rightIndex < rightLines.length) {
            if (leftIndex < leftLines.length && rightIndex < rightLines.length && leftLines[leftIndex] === rightLines[rightIndex]) {
                ops.push({ type: 'equal', aIndex: leftIndex, bIndex: rightIndex });
                leftIndex += 1;
                rightIndex += 1;
                continue;
            }

            let insertedMatch = -1;
            let deletedMatch = -1;

            for (let step = 1; step <= lookAhead; step += 1) {
                if (insertedMatch === -1 && rightIndex + step < rightLines.length && leftIndex < leftLines.length && leftLines[leftIndex] === rightLines[rightIndex + step]) {
                    insertedMatch = step;
                }

                if (deletedMatch === -1 && leftIndex + step < leftLines.length && rightIndex < rightLines.length && leftLines[leftIndex + step] === rightLines[rightIndex]) {
                    deletedMatch = step;
                }

                if (insertedMatch !== -1 || deletedMatch !== -1) {
                    break;
                }
            }

            if (insertedMatch !== -1 && (deletedMatch === -1 || insertedMatch <= deletedMatch)) {
                for (let step = 0; step < insertedMatch; step += 1) {
                    ops.push({ type: 'insert', bIndex: rightIndex });
                    rightIndex += 1;
                }
                continue;
            }

            if (deletedMatch !== -1) {
                for (let step = 0; step < deletedMatch; step += 1) {
                    ops.push({ type: 'delete', aIndex: leftIndex });
                    leftIndex += 1;
                }
                continue;
            }

            if (leftIndex < leftLines.length) {
                ops.push({ type: 'delete', aIndex: leftIndex });
                leftIndex += 1;
            }

            if (rightIndex < rightLines.length) {
                ops.push({ type: 'insert', bIndex: rightIndex });
                rightIndex += 1;
            }
        }

        return ops;
    }

    function buildExactDiff(leftLines, rightLines) {
        const leftLength = leftLines.length;
        const rightLength = rightLines.length;
        const matrix = Array.from({ length: leftLength + 1 }, () => new Uint32Array(rightLength + 1));

        for (let leftIndex = leftLength - 1; leftIndex >= 0; leftIndex -= 1) {
            const row = matrix[leftIndex];
            const nextRow = matrix[leftIndex + 1];

            for (let rightIndex = rightLength - 1; rightIndex >= 0; rightIndex -= 1) {
                row[rightIndex] = leftLines[leftIndex] === rightLines[rightIndex]
                    ? nextRow[rightIndex + 1] + 1
                    : Math.max(nextRow[rightIndex], row[rightIndex + 1]);
            }
        }

        const ops = [];
        let leftIndex = 0;
        let rightIndex = 0;

        while (leftIndex < leftLength && rightIndex < rightLength) {
            if (leftLines[leftIndex] === rightLines[rightIndex]) {
                ops.push({ type: 'equal', aIndex: leftIndex, bIndex: rightIndex });
                leftIndex += 1;
                rightIndex += 1;
                continue;
            }

            if (matrix[leftIndex + 1][rightIndex] >= matrix[leftIndex][rightIndex + 1]) {
                ops.push({ type: 'delete', aIndex: leftIndex });
                leftIndex += 1;
                continue;
            }

            ops.push({ type: 'insert', bIndex: rightIndex });
            rightIndex += 1;
        }

        while (leftIndex < leftLength) {
            ops.push({ type: 'delete', aIndex: leftIndex });
            leftIndex += 1;
        }

        while (rightIndex < rightLength) {
            ops.push({ type: 'insert', bIndex: rightIndex });
            rightIndex += 1;
        }

        return ops;
    }

    function buildDiff(leftLines, rightLines) {
        let prefix = 0;
        let leftEnd = leftLines.length;
        let rightEnd = rightLines.length;

        while (prefix < leftEnd && prefix < rightEnd && leftLines[prefix] === rightLines[prefix]) {
            prefix += 1;
        }

        while (leftEnd > prefix && rightEnd > prefix && leftLines[leftEnd - 1] === rightLines[rightEnd - 1]) {
            leftEnd -= 1;
            rightEnd -= 1;
        }

        const middleLeft = leftLines.slice(prefix, leftEnd);
        const middleRight = rightLines.slice(prefix, rightEnd);
        const ops = [];

        for (let index = 0; index < prefix; index += 1) {
            ops.push({ type: 'equal', aIndex: index, bIndex: index });
        }

        const product = middleLeft.length * middleRight.length;
        const middleOps = product <= 4000000
            ? buildExactDiff(middleLeft, middleRight)
            : buildGreedyDiff(middleLeft, middleRight);

        middleOps.forEach(op => {
            if (op.type === 'equal') {
                ops.push({
                    type: 'equal',
                    aIndex: op.aIndex + prefix,
                    bIndex: op.bIndex + prefix
                });
                return;
            }

            if (op.type === 'delete') {
                ops.push({
                    type: 'delete',
                    aIndex: op.aIndex + prefix
                });
                return;
            }

            ops.push({
                type: 'insert',
                bIndex: op.bIndex + prefix
            });
        });

        const leftSuffixStart = leftLines.length - (leftLines.length - leftEnd);
        const rightSuffixStart = rightLines.length - (rightLines.length - rightEnd);
        const suffixLength = leftLines.length - leftEnd;

        for (let index = 0; index < suffixLength; index += 1) {
            ops.push({
                type: 'equal',
                aIndex: leftSuffixStart + index,
                bIndex: rightSuffixStart + index
            });
        }

        return ops;
    }

    function getAnchorPaneIndex(panes) {
        if (!panes.length) {
            return 0;
        }

        const middle = Math.floor((panes.length - 1) / 2);
        const distances = panes.map((pane, index) => ({
            index,
            exists: pane.exists !== false,
            lineCount: pane.lines.length,
            distance: Math.abs(index - middle)
        }));

        distances.sort((left, right) => {
            if (left.exists !== right.exists) {
                return left.exists ? -1 : 1;
            }

            if (left.distance !== right.distance) {
                return left.distance - right.distance;
            }

            return right.lineCount - left.lineCount;
        });

        return distances[0]?.index ?? 0;
    }

    function buildPaneAlignment(anchorLines, paneLines) {
        const beforeInserts = Array.from({ length: anchorLines.length + 1 }, () => []);
        const cellsByAnchor = Array(anchorLines.length).fill(null);
        const ops = buildDiff(anchorLines, paneLines);
        let anchorCursor = 0;
        let blockStart = 0;
        let deletedIndices = [];
        let insertedIndices = [];

        function flushBlock() {
            if (!deletedIndices.length && !insertedIndices.length) {
                return;
            }

            const pairedCount = Math.min(deletedIndices.length, insertedIndices.length);

            for (let index = 0; index < pairedCount; index += 1) {
                const anchorIndex = deletedIndices[index];
                const paneIndex = insertedIndices[index];
                cellsByAnchor[anchorIndex] = createCell(paneLines[paneIndex], paneIndex);
            }

            for (let index = pairedCount; index < deletedIndices.length; index += 1) {
                cellsByAnchor[deletedIndices[index]] = null;
            }

            if (insertedIndices.length > pairedCount) {
                const insertionPosition = blockStart + deletedIndices.length;
                for (let index = pairedCount; index < insertedIndices.length; index += 1) {
                    beforeInserts[insertionPosition].push(createCell(paneLines[insertedIndices[index]], insertedIndices[index]));
                }
            }

            deletedIndices = [];
            insertedIndices = [];
        }

        ops.forEach(op => {
            if (op.type === 'equal') {
                flushBlock();
                cellsByAnchor[op.aIndex] = createCell(paneLines[op.bIndex], op.bIndex);
                anchorCursor = op.aIndex + 1;
                return;
            }

            if (!deletedIndices.length && !insertedIndices.length) {
                blockStart = anchorCursor;
            }

            if (op.type === 'delete') {
                deletedIndices.push(op.aIndex);
                anchorCursor = op.aIndex + 1;
                return;
            }

            insertedIndices.push(op.bIndex);
        });

        flushBlock();

        return {
            beforeInserts,
            cellsByAnchor
        };
    }

    function buildRows(panes) {
        if (!panes.length) {
            return [];
        }

        const anchorPaneIndex = getAnchorPaneIndex(panes);
        const anchorLines = panes[anchorPaneIndex].lines;
        const alignments = panes.map((pane, paneIndex) => {
            if (paneIndex === anchorPaneIndex) {
                return {
                    beforeInserts: Array.from({ length: anchorLines.length + 1 }, () => []),
                    cellsByAnchor: anchorLines.map((line, lineIndex) => createCell(line, lineIndex))
                };
            }

            return buildPaneAlignment(anchorLines, pane.lines);
        });

        const rows = [];

        for (let anchorIndex = 0; anchorIndex <= anchorLines.length; anchorIndex += 1) {
            const insertCount = alignments.reduce((max, alignment) => {
                return Math.max(max, alignment.beforeInserts[anchorIndex].length);
            }, 0);

            for (let insertOffset = 0; insertOffset < insertCount; insertOffset += 1) {
                rows.push({
                    cells: panes.map((_, paneIndex) => alignments[paneIndex].beforeInserts[anchorIndex][insertOffset] || null)
                });
            }

            if (anchorIndex < anchorLines.length) {
                rows.push({
                    cells: panes.map((_, paneIndex) => alignments[paneIndex].cellsByAnchor[anchorIndex] || null)
                });
            }
        }

        return rows;
    }

    function buildHunks(rows) {
        const hunks = [];
        let start = null;

        function rowIsChanged(row) {
            return row.cells.some((cell, cellIndex) => {
                if (cellIndex === 0) return false;
                return !cellsEqual(row.cells[cellIndex - 1], cell);
            });
        }

        rows.forEach((row, index) => {
            if (rowIsChanged(row)) {
                if (start === null) {
                    start = index;
                }
                return;
            }

            if (start !== null) {
                hunks.push({ start, end: index - 1 });
                start = null;
            }
        });

        if (start !== null) {
            hunks.push({ start, end: rows.length - 1 });
        }

        return hunks.reduce((merged, hunk) => {
            const previous = merged[merged.length - 1];
            if (previous && hunk.start - previous.end <= 1) {
                previous.end = hunk.end;
            } else {
                merged.push({ start: hunk.start, end: hunk.end });
            }
            return merged;
        }, []);
    }

    function rebuildTab(tab) {
        tab.panes = tab.panes.map(pane => {
            const parsed = parseTextContent(pane.content);
            return {
                ...pane,
                ...parsed
            };
        });

        tab.rows = buildRows(tab.panes).map((row, rowIndex) => {
            const cells = row.cells.map((cell, paneIndex, allCells) => {
                if (!cell) {
                    return {
                        text: '',
                        lineNumber: null,
                        missing: true,
                        changedLeft: paneIndex > 0 && !cellsEqual(allCells[paneIndex - 1], null),
                        changedRight: paneIndex < allCells.length - 1 && !cellsEqual(null, allCells[paneIndex + 1])
                    };
                }

                return {
                    ...cell,
                    missing: false,
                    changedLeft: paneIndex > 0 && !cellsEqual(allCells[paneIndex - 1], cell),
                    changedRight: paneIndex < allCells.length - 1 && !cellsEqual(cell, allCells[paneIndex + 1])
                };
            });

            return {
                index: rowIndex,
                cells
            };
        });

        tab.hunks = buildHunks(tab.rows);
        tab.dirty = tab.panes.some(pane => pane.dirty);
        return tab;
    }

    function getSelectedLines(rows, paneIndex, startRow, endRow) {
        const lines = [];

        for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
            const cell = rows[rowIndex]?.cells?.[paneIndex];
            if (cell && !cell.missing) {
                lines.push(cell.text);
            }
        }

        return lines;
    }

    function getReplacementRange(rows, paneIndex, startRow, endRow) {
        const lineNumbers = [];

        for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
            const lineNumber = rows[rowIndex]?.cells?.[paneIndex]?.lineNumber;
            if (lineNumber != null) {
                lineNumbers.push(lineNumber);
            }
        }

        if (lineNumbers.length) {
            return {
                startLine: Math.min(...lineNumbers) - 1,
                endLine: Math.max(...lineNumbers)
            };
        }

        let insertionIndex = 0;
        for (let rowIndex = 0; rowIndex < startRow; rowIndex += 1) {
            const lineNumber = rows[rowIndex]?.cells?.[paneIndex]?.lineNumber;
            if (lineNumber != null) {
                insertionIndex = lineNumber;
            }
        }

        return {
            startLine: insertionIndex,
            endLine: insertionIndex
        };
    }

    function replacePaneSelection(tab, paneIndex, startRow, endRow, replacementLines) {
        const pane = tab.panes[paneIndex];
        const { startLine, endLine } = getReplacementRange(tab.rows, paneIndex, startRow, endRow);
        const nextLines = pane.lines
            .slice(0, startLine)
            .concat(replacementLines)
            .concat(pane.lines.slice(endLine));

        const nextPane = {
            ...pane,
            exists: true,
            lines: nextLines,
            trailingNewline: nextLines.length ? pane.trailingNewline : false,
            dirty: true
        };

        nextPane.content = serializeTextContent(nextPane);
        return nextPane;
    }

    function selectionHasContent(rows, paneIndex, startRow, endRow) {
        return getSelectedLines(rows, paneIndex, startRow, endRow).length > 0;
    }

    window.DifferenceEngine = {
        rebuildTab,
        getSelectedLines,
        replacePaneSelection,
        selectionHasContent
    };
})();
