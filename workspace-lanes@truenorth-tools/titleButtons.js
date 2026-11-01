// SPDX-License-Identifier: GPL-2.0-or-later
//
// The minimize button in window title bars, for the switch in Settings.
// GNOME shows only close by default. The button lives in GNOME's own
// button-layout setting (the one GNOME Tweaks edits), e.g.
// 'appmenu:minimize,maximize,close'.

import Gio from 'gi://Gio';

const WM_SCHEMA = 'org.gnome.desktop.wm.preferences';
const KEY = 'button-layout';

function parse(layout) {
    const [left = '', right = ''] = layout.split(':');
    const split = s => s.split(',').filter(b => b !== '');
    return [split(left), split(right)];
}

function format([left, right]) {
    return `${left.join(',')}:${right.join(',')}`;
}

export function hasMinimize(layout) {
    return parse(layout).some(side => side.includes('minimize'));
}

// Put minimize just before maximize or close, on whichever side close is
export function addMinimize(layout) {
    if (hasMinimize(layout))
        return layout;
    const sides = parse(layout);
    let side = sides.find(s => s.includes('close')) ?? sides[1];
    let at = side.indexOf('maximize');
    if (at < 0)
        at = side.indexOf('close');
    if (at < 0)
        at = side.length;
    side.splice(at, 0, 'minimize');
    return format(sides);
}

export function removeMinimize(layout) {
    return format(parse(layout).map(side => side.filter(b => b !== 'minimize')));
}

export function wmSettings() {
    return new Gio.Settings({schema_id: WM_SCHEMA});
}

export function getLayout(settings) {
    return settings.get_string(KEY);
}

export function setMinimize(settings, show) {
    const layout = getLayout(settings);
    const next = show ? addMinimize(layout) : removeMinimize(layout);
    if (next !== layout)
        settings.set_string(KEY, next);
}
