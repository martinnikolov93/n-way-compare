(function (root, factory) {
    const api = factory();

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    root.DifferenceTransfer = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    function isStructuralLine(text) {
        const trimmed = typeof text === 'string' ? text.trim() : '';
        return trimmed === '' || /^[{}()[\],;]+$/.test(trimmed);
    }

    function getPreviousMeaningfulLine(lines, startIndex) {
        for (let lineIndex = startIndex - 1; lineIndex >= 0; lineIndex -= 1) {
            const text = lines[lineIndex];
            if (typeof text !== 'string') {
                continue;
            }

            if (!isStructuralLine(text)) {
                return text;
            }
        }

        return '';
    }

    function getNextMeaningfulLine(lines, startIndex) {
        for (let lineIndex = startIndex + 1; lineIndex < lines.length; lineIndex += 1) {
            const text = lines[lineIndex];
            if (typeof text !== 'string') {
                continue;
            }

            if (!isStructuralLine(text)) {
                return text;
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

    function buildTransferItem(tab, sourcePaneIndex, lineIndex) {
        const sourceLines = tab.panes[sourcePaneIndex].lines;
        const text = sourceLines[lineIndex] || '';
        const runInfo = getRunInfo(sourceLines, lineIndex);

        return {
            text,
            hint: {
                previousMeaningful: getPreviousMeaningfulLine(sourceLines, lineIndex),
                nextMeaningful: getNextMeaningfulLine(sourceLines, lineIndex),
                runOffset: runInfo.offset,
                runLength: runInfo.length
            }
        };
    }

    function buildTransferItemsFromLineRange(tab, sourcePaneIndex, startLineIndex, endLineIndexExclusive) {
        const items = [];

        for (let lineIndex = startLineIndex; lineIndex < endLineIndexExclusive; lineIndex += 1) {
            items.push(buildTransferItem(tab, sourcePaneIndex, lineIndex));
        }

        return items;
    }

    function getTransferLinesFromPane(tab, sourcePaneIndex, targetPaneIndex, startRow, endRow) {
        const sourceCells = [];
        let targetHasContent = false;

        for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
            const sourceCell = tab.rows[rowIndex]?.cells?.[sourcePaneIndex];
            const targetCell = tab.rows[rowIndex]?.cells?.[targetPaneIndex];

            if (sourceCell && !sourceCell.missing && sourceCell.lineNumber != null) {
                sourceCells.push(sourceCell);
            }

            if (targetCell && !targetCell.missing && targetCell.lineNumber != null) {
                targetHasContent = true;
            }
        }

        if (!sourceCells.length) {
            return [];
        }

        if (targetHasContent) {
            return sourceCells.map(cell => buildTransferItem(tab, sourcePaneIndex, cell.lineNumber - 1));
        }

        let blockStart = startRow;
        while (blockStart > 0) {
            const targetCell = tab.rows[blockStart - 1]?.cells?.[targetPaneIndex];
            if (!targetCell || !targetCell.missing) {
                break;
            }

            blockStart -= 1;
        }

        let blockEnd = endRow;
        while (blockEnd + 1 < tab.rows.length) {
            const targetCell = tab.rows[blockEnd + 1]?.cells?.[targetPaneIndex];
            if (!targetCell || !targetCell.missing) {
                break;
            }

            blockEnd += 1;
        }

        const blockSourceCells = [];
        for (let rowIndex = blockStart; rowIndex <= blockEnd; rowIndex += 1) {
            const sourceCell = tab.rows[rowIndex]?.cells?.[sourcePaneIndex];
            if (sourceCell && !sourceCell.missing && sourceCell.lineNumber != null) {
                blockSourceCells.push({
                    rowIndex,
                    lineNumber: sourceCell.lineNumber
                });
            }
        }

        const inferredBlockStartLineIndex = blockSourceCells.length
            ? blockSourceCells[0].lineNumber - 1 - (blockSourceCells[0].rowIndex - blockStart)
            : -1;
        const blockHasStableSourceOffsets = (
            inferredBlockStartLineIndex >= 0 &&
            blockSourceCells.every((cell) => {
                return (cell.lineNumber - 1) === inferredBlockStartLineIndex + (cell.rowIndex - blockStart);
            })
        );

        if (blockHasStableSourceOffsets) {
            const startOffset = startRow - blockStart;
            const endOffset = endRow - blockStart;
            const startLineIndex = Math.max(0, inferredBlockStartLineIndex + startOffset);
            const endLineIndex = Math.min(
                tab.panes[sourcePaneIndex].lines.length,
                inferredBlockStartLineIndex + endOffset + 1
            );

            if (endLineIndex > startLineIndex) {
                return buildTransferItemsFromLineRange(tab, sourcePaneIndex, startLineIndex, endLineIndex);
            }
        }

        let firstLineIndex = sourceCells[0].lineNumber - 1;
        let lastLineIndex = sourceCells[sourceCells.length - 1].lineNumber - 1;
        const desiredLineCount = endRow - startRow + 1;
        let searchBefore = startRow - 1;
        let searchAfter = endRow + 1;

        while ((lastLineIndex - firstLineIndex + 1) < desiredLineCount) {
            let extended = false;

            for (let rowIndex = searchAfter; rowIndex < tab.rows.length; rowIndex += 1) {
                const sourceCell = tab.rows[rowIndex]?.cells?.[sourcePaneIndex];
                const targetCell = tab.rows[rowIndex]?.cells?.[targetPaneIndex];

                if (sourceCell && !sourceCell.missing && sourceCell.lineNumber != null) {
                    if ((!targetCell || targetCell.lineNumber == null) && sourceCell.lineNumber - 1 === lastLineIndex + 1) {
                        lastLineIndex += 1;
                        searchAfter = rowIndex + 1;
                        extended = true;
                    }
                    break;
                }

                if (targetCell && targetCell.lineNumber != null) {
                    break;
                }
            }

            if ((lastLineIndex - firstLineIndex + 1) >= desiredLineCount) {
                break;
            }

            for (let rowIndex = searchBefore; rowIndex >= 0; rowIndex -= 1) {
                const sourceCell = tab.rows[rowIndex]?.cells?.[sourcePaneIndex];
                const targetCell = tab.rows[rowIndex]?.cells?.[targetPaneIndex];

                if (sourceCell && !sourceCell.missing && sourceCell.lineNumber != null) {
                    if ((!targetCell || targetCell.lineNumber == null) && sourceCell.lineNumber - 1 === firstLineIndex - 1) {
                        firstLineIndex -= 1;
                        searchBefore = rowIndex - 1;
                        extended = true;
                    }
                    break;
                }

                if (targetCell && targetCell.lineNumber != null) {
                    break;
                }
            }

            if (!extended) {
                break;
            }
        }

        return buildTransferItemsFromLineRange(tab, sourcePaneIndex, firstLineIndex, lastLineIndex + 1);
    }

    return {
        buildTransferItem,
        buildTransferItemsFromLineRange,
        getNextMeaningfulLine,
        getPreviousMeaningfulLine,
        getRunInfo,
        getTransferLinesFromPane
    };
});
