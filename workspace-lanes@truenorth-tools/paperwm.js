// SPDX-License-Identifier: GPL-2.0-or-later
//
// Reads PaperWM's own state while it is running, for the two places where
// GNOME's view of a window is not what the user sees:
//
// - PaperWM lays each workspace out as a strip wider than the display and
//   parks the windows scrolled out of view beyond its edges, which can be
//   over another display. GNOME then counts them as on that display, so
//   their buttons would jump to its taskbar. windowMonitor() gives the
//   display of the window's strip instead.
// - PaperWM's own window switching (its live Alt+Tab, and moving through
//   windows with Super+arrows while Super is held) doesn't use GNOME's
//   switchers, so it reports the window it has selected through
//   'switcher-select' and 'navigator-select'.
//
// - PaperWM shows a workspace of its own on each display. With Workspace
//   Keeper each secondary display keeps one workspace, and the primary
//   works through the rest, as GNOME does with workspaces on the primary
//   display only. secondaryWorkspaces() and primaryWorkspace() tell the
//   taskbars which is where.
//
// PaperWM's modules are already loaded, so importing them gives the live
// ones rather than copies. Nothing here changes what PaperWM does.

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const PAPERWM_UUID = 'paperwm@paperwm.github.com';

const STRIP_CHANGES = ['monitor-changed', 'swapped', 'window-added', 'window-removed'];

let active = null;

// The index of the display @window belongs to: the one its PaperWM strip
// is on for windows PaperWM tiles, else the one GNOME reports
export function windowMonitor(window) {
    const tiling = active?.tiling;
    if (tiling) {
        try {
            const space = tiling.spaces?.spaceOfWindow(window);
            if (space && space.indexOf(window) !== -1 && space.monitor)
                return space.monitor.index;
        } catch (e) {
            console.debug(`Workspace Lanes: can't read PaperWM's layout: ${e}`);
        }
    }
    return window.get_monitor();
}

// The workspaces PaperWM shows on displays other than the primary, while
// it runs with more than one display (else an empty set)
export function secondaryWorkspaces() {
    const monitors = active?.tiling?.spaces?.monitors;
    const primary = Main.layoutManager.primaryMonitor;
    if (!monitors || Main.layoutManager.monitors.length < 2)
        return new Set();
    try {
        return new Set([...monitors]
            .filter(([monitor, space]) => monitor !== primary && space?.workspace)
            .map(([, space]) => space.workspace));
    } catch (e) {
        console.debug(`Workspace Lanes: can't read PaperWM's layout: ${e}`);
        return new Set();
    }
}

// The workspace PaperWM shows on the primary display, or null without
// PaperWM. With PaperWM the active workspace is the one under the pointer,
// which may be a secondary display's.
export function primaryWorkspace() {
    try {
        return active?.tiling?.spaces?.monitors
            ?.get(Main.layoutManager.primaryMonitor)?.workspace ?? null;
    } catch (e) {
        console.debug(`Workspace Lanes: can't read PaperWM's layout: ${e}`);
        return null;
    }
}

// The order of @a and @b in their PaperWM strip (column, then top to
// bottom), or null unless PaperWM tiles both in the same strip. Their
// positions don't give it: PaperWM parks every window scrolled out of
// view at the same spot just past the display's edge.
export function compareInStrip(a, b) {
    const tiling = active?.tiling;
    if (!tiling)
        return null;
    try {
        const space = tiling.spaces?.spaceOfWindow(a);
        if (!space || space !== tiling.spaces.spaceOfWindow(b))
            return null;
        const ca = space.indexOf(a);
        const cb = space.indexOf(b);
        if (ca === -1 || cb === -1)
            return null;
        return ca - cb || space[ca].indexOf(a) - space[cb].indexOf(b);
    } catch (e) {
        console.debug(`Workspace Lanes: can't read PaperWM's layout: ${e}`);
        return null;
    }
}

// Signals:
// - 'changed': PaperWM started or stopped, a strip changed order or
//   moved to another display, or a display shows another workspace
// - 'switcher-select' (popup, window): PaperWM's Alt+Tab selected @window
// - 'navigator-select' (window): moving with Super held selected @window,
//   or null when it finished
export class PaperWMWatcher extends Signals.EventEmitter {
    constructor() {
        super();

        this.tiling = null;
        this._injections = new InjectionManager();
        this._loading = 0;
        active = this;

        Main.extensionManager.connectObject('extension-state-changed',
            (_manager, extension) => {
                if (extension.uuid === PAPERWM_UUID)
                    this._load();
            }, this);
        this._load();
    }

    async _load() {
        const loading = ++this._loading;
        const extension = Main.extensionManager.lookup(PAPERWM_UUID);
        let modules = null;
        if (extension?.state === ExtensionState.ACTIVE) {
            const load = name => import(extension.dir.get_child(name).get_uri());
            try {
                modules = await Promise.all(
                    ['tiling.js', 'navigator.js', 'liveAltTab.js'].map(load));
            } catch (e) {
                console.debug(`Workspace Lanes: can't read PaperWM's state: ${e}`);
            }
        }
        // destroyed, or PaperWM's state changed again while importing
        if (active !== this || loading !== this._loading)
            return;

        this._injections.clear();
        this.tiling = null;
        if (modules) {
            const [tiling, navigator, liveAltTab] = modules;
            this.tiling = tiling;
            this._inject(tiling, navigator, liveAltTab);
        }
        this.emit('changed');
    }

    _inject(tiling, navigator, liveAltTab) {
        // eslint-disable-next-line consistent-this
        const self = this;

        // A Space is one workspace's strip. It emits 'select' whenever
        // its selected window changes, 'monitor-changed' when it moves to
        // another display, and the others when its order changes (a
        // swap of two windows parked out of view moves neither).
        const space = tiling.Space?.prototype;
        if (space?.emit) {
            this._injections.overrideMethod(space, 'emit',
                original => function (name, ...args) {
                    const result = original.call(this, name, ...args);
                    try {
                        if (name === 'select' && navigator.navigating)
                            self.emit('navigator-select', this.selectedWindow ?? null);
                        else if (STRIP_CHANGES.includes(name))
                            self.emit('changed');
                    } catch (e) {
                        console.debug(`Workspace Lanes: ${e}`);
                    }
                    return result;
                });
        }

        // PaperWM records which workspace each display shows here, on
        // every workspace switch and display change
        const spaces = tiling.Spaces?.prototype;
        if (spaces?.setMonitors) {
            this._injections.overrideMethod(spaces, 'setMonitors',
                original => function (...args) {
                    const result = original.apply(this, args);
                    self.emit('changed');
                    return result;
                });
        }

        // Releasing Super ends the navigation and focuses the window
        const nav = navigator.Navigator?.prototype;
        if (nav?.destroy) {
            this._injections.overrideMethod(nav, 'destroy',
                original => function (...args) {
                    try {
                        return original.apply(this, args);
                    } finally {
                        self.emit('navigator-select', null);
                    }
                });
        }

        const alt = liveAltTab.LiveAltTab?.prototype;
        if (alt?._select) {
            this._injections.overrideMethod(alt, '_select',
                original => function (num, ...args) {
                    const result = original.call(this, num, ...args);
                    self.emit('switcher-select', this,
                        this._switcherList?.windows?.[this._selectedIndex] ?? null);
                    return result;
                });
        }
    }

    destroy() {
        Main.extensionManager.disconnectObject(this);
        this._injections.clear();
        this.tiling = null;
        if (active === this)
            active = null;
    }
}
