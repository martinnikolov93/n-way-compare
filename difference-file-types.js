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

    const AUDIO_EXTENSION_TO_MIME = Object.freeze({
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.oga': 'audio/ogg',
        '.opus': 'audio/opus',
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
        '.flac': 'audio/flac',
        '.weba': 'audio/webm'
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

    function isAudioFilePath(filePath) {
        return Boolean(AUDIO_EXTENSION_TO_MIME[getFileExtension(filePath)]);
    }

    function getMimeTypeForFilePath(filePath) {
        const extension = getFileExtension(filePath);
        return IMAGE_EXTENSION_TO_MIME[extension] || AUDIO_EXTENSION_TO_MIME[extension] || 'application/octet-stream';
    }

    return {
        IMAGE_EXTENSION_TO_MIME,
        AUDIO_EXTENSION_TO_MIME,
        getFileExtension,
        isImageFilePath,
        isAudioFilePath,
        getMimeTypeForFilePath
    };
});
