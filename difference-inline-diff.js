(function (root, factory) {
    const api = factory();

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    root.DifferenceInlineDiff = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    const CHAR_DIFF_PRODUCT_LIMIT = 250000;

    function mergeRanges(ranges) {
        if (!ranges.length) {
            return [];
        }

        const sorted = ranges
            .filter((range) => range.end > range.start)
            .sort((left, right) => left.start - right.start);

        if (!sorted.length) {
            return [];
        }

        const merged = [sorted[0]];

        for (let index = 1; index < sorted.length; index += 1) {
            const current = sorted[index];
            const previous = merged[merged.length - 1];

            if (current.start <= previous.end) {
                previous.end = Math.max(previous.end, current.end);
                continue;
            }

            merged.push({ ...current });
        }

        return merged;
    }

    function tokenizeInlineDifference(text) {
        const tokens = [];
        const pattern = /\s+|[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|./g;
        let match = pattern.exec(text);

        while (match) {
            tokens.push({
                value: match[0],
                start: match.index,
                end: match.index + match[0].length
            });
            match = pattern.exec(text);
        }

        return tokens;
    }

    function getTokenDifferenceRanges(sourceText, compareText, sourceOffset = 0) {
        if (!sourceText.length) {
            return [];
        }

        if (!compareText.length) {
            // Nothing on the other side to match against, so the whole
            // slice is genuinely different - not the same as "couldn't
            // compute", which is why this isn't folded into the guard below.
            return [{ start: sourceOffset, end: sourceOffset + sourceText.length }];
        }

        const sourceTokens = tokenizeInlineDifference(sourceText);
        const compareTokens = tokenizeInlineDifference(compareText);
        const product = sourceTokens.length * compareTokens.length;

        if (
            !sourceTokens.length ||
            !compareTokens.length ||
            sourceTokens.length > 1000 ||
            compareTokens.length > 1000 ||
            product > 120000
        ) {
            // Too expensive (or nothing usable) to get a real answer here.
            // Returning null signals "unknown" to the caller, which is not
            // the same as finding zero differences - conflating the two
            // used to make a line highlight in full just because the other
            // side happened to compute a genuinely empty diff.
            return null;
        }

        const matrix = Array.from(
            { length: sourceTokens.length + 1 },
            () => new Uint16Array(compareTokens.length + 1)
        );

        for (let sourceIndex = sourceTokens.length - 1; sourceIndex >= 0; sourceIndex -= 1) {
            const row = matrix[sourceIndex];
            const nextRow = matrix[sourceIndex + 1];

            for (let compareIndex = compareTokens.length - 1; compareIndex >= 0; compareIndex -= 1) {
                row[compareIndex] = sourceTokens[sourceIndex].value === compareTokens[compareIndex].value
                    ? nextRow[compareIndex + 1] + 1
                    : Math.max(nextRow[compareIndex], row[compareIndex + 1]);
            }
        }

        const ranges = [];
        let sourceIndex = 0;
        let compareIndex = 0;

        while (sourceIndex < sourceTokens.length && compareIndex < compareTokens.length) {
            if (sourceTokens[sourceIndex].value === compareTokens[compareIndex].value) {
                sourceIndex += 1;
                compareIndex += 1;
                continue;
            }

            if (matrix[sourceIndex + 1][compareIndex] >= matrix[sourceIndex][compareIndex + 1]) {
                const token = sourceTokens[sourceIndex];
                ranges.push({
                    start: sourceOffset + token.start,
                    end: sourceOffset + token.end
                });
                sourceIndex += 1;
                continue;
            }

            compareIndex += 1;
        }

        while (sourceIndex < sourceTokens.length) {
            const token = sourceTokens[sourceIndex];
            ranges.push({
                start: sourceOffset + token.start,
                end: sourceOffset + token.end
            });
            sourceIndex += 1;
        }

        return mergeRanges(ranges);
    }

    // Splits into Unicode code points rather than raw UTF-16 code units, so a
    // surrogate pair (e.g. an emoji) is always treated - and highlighted - as
    // one indivisible character instead of being split across a range.
    function getCodePoints(text) {
        const items = [];
        let index = 0;

        while (index < text.length) {
            const codePoint = text.codePointAt(index);
            const length = codePoint > 0xFFFF ? 2 : 1;
            items.push({
                value: text.slice(index, index + length),
                start: index,
                end: index + length
            });
            index += length;
        }

        return items;
    }

    // Finds the longest run of consecutive matching items shared between the
    // two slices, preferring the earliest occurrence on ties. Returns null if
    // nothing in the slices matches at all.
    function findLongestCommonRun(sourceItems, compareItems, sourceStart, sourceEnd, compareStart, compareEnd) {
        const sourceLength = sourceEnd - sourceStart;
        const compareLength = compareEnd - compareStart;

        if (sourceLength <= 0 || compareLength <= 0) {
            return null;
        }

        let previousRow = new Uint32Array(compareLength + 1);
        let currentRow = new Uint32Array(compareLength + 1);
        let bestLength = 0;
        let bestSourceIndex = -1;
        let bestCompareIndex = -1;

        for (let i = sourceLength - 1; i >= 0; i -= 1) {
            for (let j = compareLength - 1; j >= 0; j -= 1) {
                if (sourceItems[sourceStart + i].value === compareItems[compareStart + j].value) {
                    const runLength = previousRow[j + 1] + 1;
                    currentRow[j] = runLength;
                    if (runLength >= bestLength) {
                        bestLength = runLength;
                        bestSourceIndex = sourceStart + i;
                        bestCompareIndex = compareStart + j;
                    }
                } else {
                    currentRow[j] = 0;
                }
            }

            const swap = previousRow;
            previousRow = currentRow;
            currentRow = swap;
        }

        if (!bestLength) {
            return null;
        }

        return { sourceIndex: bestSourceIndex, compareIndex: bestCompareIndex, length: bestLength };
    }

    function pushUnmatchedRange(ranges, items, start, end) {
        if (start >= end) {
            return;
        }

        ranges.push({ start: items[start].start, end: items[end - 1].end });
    }

    // Diffuse highlights inline changes with Python's difflib.SequenceMatcher,
    // which repeatedly finds the longest matching block and recurses on the
    // remainder either side of it. This mirrors that approach instead of a
    // naive prefix/suffix trim followed by a greedy word-token LCS: the
    // earlier version could let a short coincidental match (e.g. two lines
    // that both merely start with the same "<" character, for entirely
    // different reasons) throw off the whole alignment, and could lump an
    // unrelated but adjacent unchanged span in with a genuine token-level
    // difference (a decimal number or identifier swallowing a same-content
    // suffix). Recursing on the longest real match first avoids both.
    function getCharacterDifferenceRanges(sourceText, compareText) {
        if (!sourceText.length) {
            return [];
        }

        if (!compareText.length) {
            return [{ start: 0, end: sourceText.length }];
        }

        const sourceItems = getCodePoints(sourceText);
        const compareItems = getCodePoints(compareText);
        const product = sourceItems.length * compareItems.length;

        if (product > CHAR_DIFF_PRODUCT_LIMIT) {
            return null;
        }

        const ranges = [];
        const stack = [{
            sourceStart: 0,
            sourceEnd: sourceItems.length,
            compareStart: 0,
            compareEnd: compareItems.length
        }];

        while (stack.length) {
            const region = stack.pop();
            const match = findLongestCommonRun(
                sourceItems,
                compareItems,
                region.sourceStart,
                region.sourceEnd,
                region.compareStart,
                region.compareEnd
            );

            if (!match) {
                pushUnmatchedRange(ranges, sourceItems, region.sourceStart, region.sourceEnd);
                continue;
            }

            if (region.sourceStart < match.sourceIndex && region.compareStart < match.compareIndex) {
                stack.push({
                    sourceStart: region.sourceStart,
                    sourceEnd: match.sourceIndex,
                    compareStart: region.compareStart,
                    compareEnd: match.compareIndex
                });
            } else {
                pushUnmatchedRange(ranges, sourceItems, region.sourceStart, match.sourceIndex);
            }

            const afterSourceStart = match.sourceIndex + match.length;
            const afterCompareStart = match.compareIndex + match.length;

            if (afterSourceStart < region.sourceEnd && afterCompareStart < region.compareEnd) {
                stack.push({
                    sourceStart: afterSourceStart,
                    sourceEnd: region.sourceEnd,
                    compareStart: afterCompareStart,
                    compareEnd: region.compareEnd
                });
            } else {
                pushUnmatchedRange(ranges, sourceItems, afterSourceStart, region.sourceEnd);
            }
        }

        return mergeRanges(ranges);
    }

    function getDifferenceRanges(sourceText, compareText) {
        if (typeof sourceText !== 'string' || typeof compareText !== 'string' || sourceText === compareText) {
            return [];
        }

        const ranges = getCharacterDifferenceRanges(sourceText, compareText);

        if (ranges === null) {
            // Too expensive to compute exactly; fall back to a cheap
            // prefix/suffix trim so we still highlight *something* useful
            // rather than nothing, or the whole line, on pathologically
            // long input.
            let prefix = 0;
            const maxPrefix = Math.min(sourceText.length, compareText.length);
            while (prefix < maxPrefix && sourceText[prefix] === compareText[prefix]) {
                prefix += 1;
            }

            let suffix = 0;
            const maxSuffix = Math.min(sourceText.length - prefix, compareText.length - prefix);
            while (
                suffix < maxSuffix &&
                sourceText[sourceText.length - 1 - suffix] === compareText[compareText.length - 1 - suffix]
            ) {
                suffix += 1;
            }

            const start = prefix;
            const end = sourceText.length - suffix;
            return end > start ? [{ start, end }] : [];
        }

        return ranges;
    }

    return {
        getDifferenceRanges,
        getTokenDifferenceRanges,
        tokenizeInlineDifference
    };
});
