(function (root, factory) {
    const api = factory();

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    root.DifferenceFileTypes = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    const IMAGE_EXTENSION_TO_MIME = Object.freeze({
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.avif': 'image/avif'
    });

    function getFileExtension(filePath) {
        const normalizedPath = String(filePath || '')
            .trim()
            .replace(/[?#].*$/, '');
        const match = normalizedPath.match(/\.([A-Za-z0-9]+)$/);

        return match ? `.${match[1].toLowerCase()}` : '';
    }

    function isImageFilePath(filePath) {
        return Boolean(IMAGE_EXTENSION_TO_MIME[getFileExtension(filePath)]);
    }

    function getMimeTypeForFilePath(filePath) {
        return IMAGE_EXTENSION_TO_MIME[getFileExtension(filePath)] || 'application/octet-stream';
    }

    return {
        IMAGE_EXTENSION_TO_MIME,
        getFileExtension,
        isImageFilePath,
        getMimeTypeForFilePath
    };
});
