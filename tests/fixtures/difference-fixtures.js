function joinLines(lines) {
    return lines.join('\n');
}

function createProseAlignmentPanes() {
    const standardPane = joinLines([
        'Travel Notes',
        'Morning settles over the harbor.',
        'The baker counts copper coins by the door.',
        'A folded note rests beside the window latch.',
        '',
        'The third lantern hums softly.',
        '',
        '',
        'The cedar gate stays open until dusk.',
        '',
        'Fresh mint dries on the sill.',
        'The noon whistle fades away.',
        '',
        '',
        '',
        'A narrow boat answers with a patient horn.',
        '',
        'We leave before the rain begins.'
    ]);

    const extendedPane = joinLines([
        'Travel Notes',
        'Morning settles over the harbor.',
        'The baker counts copper coins by the door.',
        'A folded note rests beside the window latch.',
        '',
        'The third lantern hums softly.',
        '',
        'A patient gull circles above the water.',
        'Soft footsteps echo through the corridor.',
        '',
        'The cedar gate stays open until dusk.',
        '',
        'Fresh mint dries on the sill.',
        'The noon whistle fades away.',
        '',
        '',
        '',
        'A narrow boat answers with a patient horn.',
        '',
        'We leave before the rain begins.'
    ]);

    return [
        { label: 'journal-alpha.txt', content: standardPane },
        { label: 'journal-beta.txt', content: standardPane },
        { label: 'journal-gamma.txt', content: extendedPane },
        { label: 'journal-delta.txt', content: standardPane }
    ];
}

function createNumberedListFixtures() {
    return [
        {
            label: 'list-a.txt',
            content: joinLines([
                '1: red apples by the gate,',
                '2: silver rain on the roof,'
            ])
        },
        {
            label: 'list-b.txt',
            content: joinLines([
                '1: amber tea near the fire,',
                '2: silver rain on the roof,',
                '3: quiet shoes in the hall,'
            ])
        },
        {
            label: 'list-c.txt',
            content: joinLines([
                '1: amber tea near the fire,',
                '2: silver rain on the roof,',
                '3: quiet shoes in the hall,',
                '4: blue chalk under the stairs,'
            ])
        },
        {
            label: 'list-d.txt',
            content: joinLines([
                '1: amber tea near the fire,',
                '2: silver rain on the roof,',
                '3: quiet shoes in the hall,',
                '4: blue chalk under the stairs,',
                '5: warm bread beside the lamp,'
            ])
        }
    ];
}

module.exports = {
    createNumberedListFixtures,
    createProseAlignmentPanes
};
