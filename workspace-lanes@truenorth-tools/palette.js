// SPDX-License-Identifier: GPL-2.0-or-later
//
// Default workspace colours and colour strengths, shared by the shell side
// and the settings window (so no shell imports here)

// The parts that are coloured, and the setting for each one's strength
// (with "-light" or "-dark" added for the style)
export const COLOR_PARTS = {
    taskbar: 'taskbar-colors',
    preview: 'preview-colors',
    topBar: 'top-bar-color',
    background: 'background-colors',
};

// How strongly each strength tints, relative to "medium"
export const INTENSITY = {off: 0, subtle: 0.6, medium: 1, strong: 1.4};

// GNOME's accent colours, in an order that sweeps round the colour wheel
// so neighbouring workspaces sit well together
export const DEFAULT_PALETTE = [
    '#3584e4', // blue
    '#2190a4', // teal
    '#3a944a', // green
    '#c88800', // yellow
    '#ed5b00', // orange
    '#e62d42', // red
    '#d56199', // pink
    '#9141ac', // purple
    '#6f8396', // slate
];

// Whether GNOME Settings is set to Dark, given org.gnome.desktop.interface
// settings. That's not always the shell's own style: the shell stays dark
// in Light (“default”) unless it's set to prefer light.
export function prefersDark(interfaceSettings) {
    return interfaceSettings.get_string('color-scheme') === 'prefer-dark';
}

// The colour for workspace @index: the user's own if set, else the default
export function workspaceColor(custom, index) {
    const color = custom[index];
    return /^#[0-9a-f]{6}$/i.test(color ?? '')
        ? color
        : DEFAULT_PALETTE[index % DEFAULT_PALETTE.length];
}
