(function () {
    const EXACT_DIFF_PRODUCT_LIMIT = 250000;

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

    function normalizeComparableLine(text) {
        return typeof text === 'string' ? text.trim() : '';
    }

    function cellsEqual(left, right) {
        if (!left && !right) return true;
        if (!left || !right) return false;
        return normalizeComparableLine(left.text) === normalizeComparableLine(right.text);
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

    // Large sections need stable anchors beyond a short look-ahead. This mirrors
    // Diffuse's patience-style approach so long inserted blocks stay contained.
    function buildPatienceSubsequence(leftLines, rightLines) {
        const leftValues = new Map();
        const rightValues = new Map();

        leftLines.forEach((line, index) => {
            leftValues.set(line, leftValues.has(line) ? -1 : index);
        });

        rightLines.forEach((line, index) => {
            rightValues.set(line, rightValues.has(line) ? -1 : index);
        });

        const pile = [];
        const pointers = new Map();
        const leftToRight = new Map();

        rightLines.forEach((line) => {
            const leftIndex = leftValues.has(line) ? leftValues.get(line) : -1;
            const rightIndex = rightValues.has(line) ? rightValues.get(line) : -1;

            if (leftIndex === -1 || rightIndex === -1) {
                return;
            }

            leftToRight.set(leftIndex, rightIndex);

            let start = 0;
            let end = pile.length;

            if (end && leftIndex > pile[end - 1]) {
                start = end;
            } else {
                while (start < end) {
                    const middle = Math.floor((start + end) / 2);
                    if (leftIndex < pile[middle]) {
                        end = middle;
                    } else {
                        start = middle + 1;
                    }
                }
            }

            if (start < pile.length) {
                pile[start] = leftIndex;
            } else {
                pile.push(leftIndex);
            }

            if (start) {
                pointers.set(leftIndex, pile[start - 1]);
            }
        });

        const result = [];

        if (pile.length) {
            let leftIndex = pile[pile.length - 1];
            result.push([leftIndex, leftToRight.get(leftIndex)]);

            while (pointers.has(leftIndex)) {
                leftIndex = pointers.get(leftIndex);
                result.push([leftIndex, leftToRight.get(leftIndex)]);
            }

            result.reverse();
        }

        return result;
    }

    function buildLongestCommonBlockApprox(leftLines, rightLines) {
        const leftCounts = new Map();
        const rightLookup = new Map();

        leftLines.forEach((line) => {
            leftCounts.set(line, (leftCounts.get(line) || 0) + 1);
        });

        rightLines.forEach((line, index) => {
            if (!rightLookup.has(line)) {
                rightLookup.set(line, []);
            }
            rightLookup.get(line).push(index);
        });

        if (!Array.from(rightLookup.keys()).some(line => leftCounts.has(line))) {
            return null;
        }

        const popular = new Set();
        if (leftLines.length > 200) {
            leftCounts.forEach((count, line) => {
                if (count * 100 > leftLines.length) {
                    popular.add(line);
                }
            });
        }

        if (rightLines.length > 200) {
            rightLookup.forEach((indices, line) => {
                if (indices.length * 100 > rightLines.length) {
                    popular.add(line);
                }
            });
        }

        let previousMatches = new Map();
        let maxLength = 0;
        let maxIndices = [];

        leftLines.forEach((line, leftIndex) => {
            const indices = rightLookup.get(line);
            const matches = new Map();

            if (indices) {
                if (popular.has(line)) {
                    previousMatches.forEach((length, rightIndex) => {
                        const nextRightIndex = rightIndex + 1;
                        if (nextRightIndex < rightLines.length && rightLines[nextRightIndex] === line) {
                            const nextLength = length + 1;
                            matches.set(nextRightIndex, nextLength);
                            if (nextLength >= maxLength) {
                                if (nextLength === maxLength) {
                                    maxIndices.push([leftIndex, nextRightIndex]);
                                } else {
                                    maxLength = nextLength;
                                    maxIndices = [[leftIndex, nextRightIndex]];
                                }
                            }
                        }
                    });
                } else {
                    indices.forEach((rightIndex) => {
                        const length = (previousMatches.get(rightIndex - 1) || 0) + 1;
                        matches.set(rightIndex, length);
                        if (length >= maxLength) {
                            if (length === maxLength) {
                                maxIndices.push([leftIndex, rightIndex]);
                            } else {
                                maxLength = length;
                                maxIndices = [[leftIndex, rightIndex]];
                            }
                        }
                    });
                }
            }

            previousMatches = matches;
        });

        if (!maxIndices.length) {
            return null;
        }

        let bestLeftIndex = 0;
        let bestRightIndex = 0;
        let bestLength = 0;

        maxIndices.forEach(([leftIndex, rightIndex]) => {
            let length = maxLength;
            let startLeft = leftIndex + 1 - length;
            let startRight = rightIndex + 1 - length;

            while (startLeft && startRight && leftLines[startLeft - 1] === rightLines[startRight - 1]) {
                startLeft -= 1;
                startRight -= 1;
                length += 1;
            }

            if (length > bestLength) {
                bestLeftIndex = startLeft;
                bestRightIndex = startRight;
                bestLength = length;
            }
        });

        return bestLength
            ? { leftIndex: bestLeftIndex, rightIndex: bestRightIndex, length: bestLength }
            : null;
    }

    function buildPatienceMatches(leftLines, rightLines) {
        const matches = [];
        const blocks = [{
            leftStart: 0,
            leftEnd: leftLines.length,
            rightStart: 0,
            rightEnd: rightLines.length,
            matchIndex: 0
        }];

        while (blocks.length) {
            const block = blocks.pop();
            const leftSlice = leftLines.slice(block.leftStart, block.leftEnd);
            const rightSlice = rightLines.slice(block.rightStart, block.rightEnd);
            const pivots = buildPatienceSubsequence(leftSlice, rightSlice);

            if (pivots.length) {
                let leftStart = block.leftStart;
                let rightStart = block.rightStart;
                let matchIndex = block.matchIndex;

                pivots.forEach(([pivotLeftOffset, pivotRightOffset]) => {
                    const pivotLeft = pivotLeftOffset + block.leftStart;
                    const pivotRight = pivotRightOffset + block.rightStart;

                    if (leftStart > pivotLeft) {
                        return;
                    }

                    let leftIndex = pivotLeft;
                    let rightIndex = pivotRight;

                    while (
                        leftStart < leftIndex &&
                        rightStart < rightIndex &&
                        leftLines[leftIndex - 1] === rightLines[rightIndex - 1]
                    ) {
                        leftIndex -= 1;
                        rightIndex -= 1;
                    }

                    if (leftStart < leftIndex && rightStart < rightIndex) {
                        blocks.push({
                            leftStart,
                            leftEnd: leftIndex,
                            rightStart,
                            rightEnd: rightIndex,
                            matchIndex
                        });
                    }

                    leftStart = pivotLeft + 1;
                    rightStart = pivotRight + 1;

                    while (
                        leftStart < block.leftEnd &&
                        rightStart < block.rightEnd &&
                        leftLines[leftStart] === rightLines[rightStart]
                    ) {
                        leftStart += 1;
                        rightStart += 1;
                    }

                    matches.splice(matchIndex, 0, {
                        leftIndex,
                        rightIndex,
                        length: leftStart - leftIndex
                    });
                    matchIndex += 1;
                });

                if (leftStart < block.leftEnd && rightStart < block.rightEnd) {
                    blocks.push({
                        leftStart,
                        leftEnd: block.leftEnd,
                        rightStart,
                        rightEnd: block.rightEnd,
                        matchIndex
                    });
                }
                continue;
            }

            const fallback = buildLongestCommonBlockApprox(leftSlice, rightSlice);
            if (fallback) {
                const leftIndex = fallback.leftIndex + block.leftStart;
                const rightIndex = fallback.rightIndex + block.rightStart;

                if (block.leftStart < leftIndex && block.rightStart < rightIndex) {
                    blocks.push({
                        leftStart: block.leftStart,
                        leftEnd: leftIndex,
                        rightStart: block.rightStart,
                        rightEnd: rightIndex,
                        matchIndex: block.matchIndex
                    });
                }

                matches.splice(block.matchIndex, 0, {
                    leftIndex,
                    rightIndex,
                    length: fallback.length
                });

                const nextLeftStart = leftIndex + fallback.length;
                const nextRightStart = rightIndex + fallback.length;

                if (nextLeftStart < block.leftEnd && nextRightStart < block.rightEnd) {
                    blocks.push({
                        leftStart: nextLeftStart,
                        leftEnd: block.leftEnd,
                        rightStart: nextRightStart,
                        rightEnd: block.rightEnd,
                        matchIndex: block.matchIndex + 1
                    });
                }
            }
        }

        return matches.sort((left, right) => {
            if (left.leftIndex !== right.leftIndex) {
                return left.leftIndex - right.leftIndex;
            }
            return left.rightIndex - right.rightIndex;
        });
    }

    function buildDiffFromMatches(leftLines, rightLines, matches) {
        const ops = [];
        let leftIndex = 0;
        let rightIndex = 0;

        matches.forEach(match => {
            while (leftIndex < match.leftIndex) {
                ops.push({ type: 'delete', aIndex: leftIndex });
                leftIndex += 1;
            }

            while (rightIndex < match.rightIndex) {
                ops.push({ type: 'insert', bIndex: rightIndex });
                rightIndex += 1;
            }

            for (let offset = 0; offset < match.length; offset += 1) {
                ops.push({
                    type: 'equal',
                    aIndex: match.leftIndex + offset,
                    bIndex: match.rightIndex + offset
                });
            }

            leftIndex = match.leftIndex + match.length;
            rightIndex = match.rightIndex + match.length;
        });

        while (leftIndex < leftLines.length) {
            ops.push({ type: 'delete', aIndex: leftIndex });
            leftIndex += 1;
        }

        while (rightIndex < rightLines.length) {
            ops.push({ type: 'insert', bIndex: rightIndex });
            rightIndex += 1;
        }

        return ops;
    }

    function buildPatienceDiff(leftLines, rightLines) {
        return buildDiffFromMatches(leftLines, rightLines, buildPatienceMatches(leftLines, rightLines));
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
        const middleOps = product <= EXACT_DIFF_PRODUCT_LIMIT
            ? buildExactDiff(middleLeft, middleRight)
            : buildPatienceDiff(middleLeft, middleRight);

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

    function buildLineCountMap(lines, normalizer = (value) => value) {
        const counts = new Map();

        lines.forEach((line) => {
            const normalizedLine = normalizer(line);
            counts.set(normalizedLine, (counts.get(normalizedLine) || 0) + 1);
        });

        return counts;
    }

    function isStructuralLine(text) {
        const trimmed = typeof text === 'string' ? text.trim() : '';
        return trimmed === '' || /^[{}()[\],;]+$/.test(trimmed);
    }

    function isMeaningfulLine(text) {
        return !isStructuralLine(text);
    }

    function getNeighborMeaningfulLine(lines, startIndex, direction) {
        for (
            let lineIndex = startIndex + direction;
            lineIndex >= 0 && lineIndex < lines.length;
            lineIndex += direction
        ) {
            if (isMeaningfulLine(lines[lineIndex])) {
                return lines[lineIndex];
            }
        }

        return '';
    }

    function getRunInfo(lines, lineIndex) {
        const text = lines[lineIndex];
        let start = lineIndex;
        let end = lineIndex;

        while (start > 0 && lines[start - 1] === text) {
            start -= 1;
        }

        while (end + 1 < lines.length && lines[end + 1] === text) {
            end += 1;
        }

        return {
            offset: lineIndex - start,
            length: end - start + 1
        };
    }

    function buildAlignmentTokens(lines, ownCountMap, otherCountMap, lineHints, normalizer = (value) => value) {
        return lines.map((line, lineIndex) => {
            const normalizedLine = normalizer(line);
            const duplicateCount = Math.max(
                ownCountMap.get(normalizedLine) || 0,
                otherCountMap.get(normalizedLine) || 0
            );

            if (duplicateCount <= 1) {
                return normalizedLine;
            }

            const hint = Array.isArray(lineHints) ? lineHints[lineIndex] : null;
            const previousMeaningful = normalizer(
                hint?.previousMeaningful ?? getNeighborMeaningfulLine(lines, lineIndex, -1)
            );
            const nextMeaningful = normalizer(
                hint?.nextMeaningful ?? getNeighborMeaningfulLine(lines, lineIndex, 1)
            );
            const runInfo = {
                offset: hint?.runOffset,
                length: hint?.runLength
            };
            if (!Number.isInteger(runInfo.offset) || !Number.isInteger(runInfo.length)) {
                const computedRunInfo = getRunInfo(lines, lineIndex);
                runInfo.offset = computedRunInfo.offset;
                runInfo.length = computedRunInfo.length;
            }

            return [
                normalizedLine,
                previousMeaningful,
                nextMeaningful,
                String(runInfo.offset),
                String(runInfo.length)
            ].join('\u0001');
        });
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

    function buildPaneAlignment(anchorPane, pane) {
        const anchorLines = anchorPane.lines;
        const paneLines = pane.lines;
        const anchorCounts = buildLineCountMap(anchorLines, normalizeComparableLine);
        const paneCounts = buildLineCountMap(paneLines, normalizeComparableLine);
        const anchorTokens = buildAlignmentTokens(anchorLines, anchorCounts, paneCounts, anchorPane.lineHints, normalizeComparableLine);
        const paneTokens = buildAlignmentTokens(paneLines, paneCounts, anchorCounts, pane.lineHints, normalizeComparableLine);
        const beforeInserts = Array.from({ length: anchorLines.length + 1 }, () => []);
        const cellsByAnchor = Array(anchorLines.length).fill(null);
        const ops = buildDiff(anchorTokens, paneTokens);
        let anchorCursor = 0;
        let blockStart = 0;
        let deletedIndices = [];
        let insertedIndices = [];

        function flushBlock() {
            if (!deletedIndices.length && !insertedIndices.length) {
                return;
            }

            const deletedLines = deletedIndices.map(index => normalizeComparableLine(anchorLines[index]));
            const insertedLines = insertedIndices.map(index => normalizeComparableLine(paneLines[index]));
            const blockOps = buildDiff(deletedLines, insertedLines);
            let consumedDeleted = 0;
            let pendingDeleted = [];
            let pendingInserted = [];

            function flushPendingRun() {
                if (!pendingDeleted.length && !pendingInserted.length) {
                    return;
                }

                const pairCount = Math.min(pendingDeleted.length, pendingInserted.length);

                for (let index = 0; index < pairCount; index += 1) {
                    cellsByAnchor[pendingDeleted[index]] = createCell(
                        paneLines[pendingInserted[index]],
                        pendingInserted[index]
                    );
                }

                for (let index = pairCount; index < pendingDeleted.length; index += 1) {
                    cellsByAnchor[pendingDeleted[index]] = null;
                }

                if (pairCount < pendingInserted.length) {
                    const insertionPosition = blockStart + consumedDeleted + pendingDeleted.length;
                    for (let index = pairCount; index < pendingInserted.length; index += 1) {
                        beforeInserts[insertionPosition].push(
                            createCell(paneLines[pendingInserted[index]], pendingInserted[index])
                        );
                    }
                }

                consumedDeleted += pendingDeleted.length;
                pendingDeleted = [];
                pendingInserted = [];
            }

            blockOps.forEach(op => {
                if (op.type === 'equal') {
                    flushPendingRun();
                    const anchorIndex = deletedIndices[op.aIndex];
                    const paneIndex = insertedIndices[op.bIndex];
                    cellsByAnchor[anchorIndex] = createCell(paneLines[paneIndex], paneIndex);
                    consumedDeleted = op.aIndex + 1;
                    return;
                }

                if (op.type === 'delete') {
                    pendingDeleted.push(deletedIndices[op.aIndex]);
                    return;
                }

                pendingInserted.push(insertedIndices[op.bIndex]);
            });

            flushPendingRun();

            for (let index = 0; index < deletedIndices.length; index += 1) {
                const anchorIndex = deletedIndices[index];
                if (cellsByAnchor[anchorIndex] === undefined) {
                    cellsByAnchor[anchorIndex] = null;
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
        const anchorPane = panes[anchorPaneIndex];
        const anchorLines = anchorPane.lines;
        const alignments = panes.map((pane, paneIndex) => {
            if (paneIndex === anchorPaneIndex) {
                return {
                    beforeInserts: Array.from({ length: anchorLines.length + 1 }, () => []),
                    cellsByAnchor: anchorLines.map((line, lineIndex) => createCell(line, lineIndex))
                };
            }

            return buildPaneAlignment(anchorPane, pane);
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
            const lineHints = Array.isArray(pane.lineHints) && pane.lineHints.length === parsed.lines.length
                ? pane.lineHints
                : Array.from({ length: parsed.lines.length }, () => null);
            return {
                ...pane,
                ...parsed,
                lineHints
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

        // If the selection begins in the middle of a missing block, preserve that
        // relative offset when possible, but never jump past the next real line
        // in the target file.
        let missingOffset = 0;
        for (let rowIndex = startRow - 1; rowIndex >= 0; rowIndex -= 1) {
            const cell = rows[rowIndex]?.cells?.[paneIndex];
            if (!cell || cell.lineNumber != null) {
                break;
            }

            missingOffset += 1;
        }

        let nextExistingLineIndex = null;
        for (let rowIndex = startRow; rowIndex < rows.length; rowIndex += 1) {
            const lineNumber = rows[rowIndex]?.cells?.[paneIndex]?.lineNumber;
            if (lineNumber != null) {
                nextExistingLineIndex = lineNumber - 1;
                break;
            }
        }

        const desiredInsertionIndex = insertionIndex + missingOffset;
        const clampedInsertionIndex = nextExistingLineIndex == null
            ? desiredInsertionIndex
            : Math.min(desiredInsertionIndex, nextExistingLineIndex);

        return {
            startLine: clampedInsertionIndex,
            endLine: clampedInsertionIndex
        };
    }

    function replacePaneSelection(tab, paneIndex, startRow, endRow, replacementLines) {
        const pane = tab.panes[paneIndex];
        const { startLine, endLine } = getReplacementRange(tab.rows, paneIndex, startRow, endRow);
        const normalizedReplacement = replacementLines.map((line) => {
            if (line && typeof line === 'object' && !Array.isArray(line)) {
                return {
                    text: typeof line.text === 'string' ? line.text : '',
                    hint: line.hint || null
                };
            }

            return {
                text: typeof line === 'string' ? line : '',
                hint: null
            };
        });
        const existingLineHints = Array.isArray(pane.lineHints) && pane.lineHints.length === pane.lines.length
            ? pane.lineHints
            : Array.from({ length: pane.lines.length }, () => null);
        const nextLines = pane.lines
            .slice(0, startLine)
            .concat(normalizedReplacement.map((line) => line.text))
            .concat(pane.lines.slice(endLine));
        const nextLineHints = existingLineHints
            .slice(0, startLine)
            .concat(normalizedReplacement.map((line) => line.hint))
            .concat(existingLineHints.slice(endLine));

        const nextPane = {
            ...pane,
            exists: true,
            lines: nextLines,
            lineHints: nextLineHints,
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
