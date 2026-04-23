(function (root, factory) {
    const api = factory();

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    root.DifferenceInlineDiff = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
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
        if (!sourceText.length || !compareText.length) {
            return [];
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
            return [];
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

    function getDifferenceRanges(sourceText, compareText) {
        if (typeof sourceText !== 'string' || typeof compareText !== 'string' || sourceText === compareText) {
            return [];
        }

        if (!sourceText.length) {
            return [];
        }

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
        if (end <= start) {
            return [];
        }

        const tokenRanges = getTokenDifferenceRanges(
            sourceText.slice(start, end),
            compareText.slice(prefix, compareText.length - suffix),
            start
        );

        if (tokenRanges.length) {
            return tokenRanges;
        }

        return [{ start, end }];
    }

    return {
        getDifferenceRanges,
        getTokenDifferenceRanges,
        tokenizeInlineDifference
    };
});
