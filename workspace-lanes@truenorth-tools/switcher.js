// SPDX-License-Identifier: GPL-2.0-or-later
//
// Follows GNOME's own window switching (Alt+` through the current app's
// windows, Alt+Tab once it moves on to an app's windows, and the window
// switcher if Alt+Tab is set to switch windows) and reports which window
// is selected, so the taskbar can mark its button. With PaperWM it also
// follows PaperWM's live Alt+Tab, and moving through windows with
// Super+arrows while Super is held. The switchers keep their own
// shortcuts and behaviour; this only reads their selection.

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as AltTab from 'resource:///org/gnome/shell/ui/altTab.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

export class SwitcherWatcher extends Signals.EventEmitter {
    // @paperwm: a PaperWMWatcher
    constructor(paperwm) {
        super();

        this._window = null;
        this._popup = null;
        this._paperwm = paperwm;
        this._injections = new InjectionManager();

        // eslint-disable-next-line consistent-this
        const self = this;

        // an app's windows: _currentWindow is -1 while only the app is
        // selected
        this._injections.overrideMethod(AltTab.AppSwitcherPopup.prototype, '_select',
            original => function (...args) {
                original.apply(this, args);
                const icon = this._items[this._selectedIndex];
                self._update(this, this._currentWindow >= 0
                    ? icon?.cachedWindows[this._currentWindow] : null);
            });

        this._injections.overrideMethod(AltTab.WindowSwitcherPopup.prototype, '_select',
            original => function (...args) {
                original.apply(this, args);
                self._update(this, this._items[this._selectedIndex]?.window ?? null);
            });

        paperwm.connectObject(
            'switcher-select', (_p, popup, window) => this._update(popup, window),
            'navigator-select', (_p, window) => {
                if (!this._popup)
                    this._setWindow(window);
            },
            this);
    }

    // The window selected in the open switcher, if any
    get window() {
        return this._window;
    }

    _update(popup, window) {
        if (popup !== this._popup) {
            this._popup?.disconnectObject(this);
            this._popup = popup;
            popup.connectObject('destroy', () => {
                this._popup = null;
                this._setWindow(null);
            }, this);
        }
        this._setWindow(window);
    }

    _setWindow(window) {
        if (window === this._window)
            return;
        this._window = window;
        this.emit('changed');
    }

    destroy() {
        this._injections.clear();
        this._paperwm.disconnectObject(this);
        this._popup?.disconnectObject(this);
        this._popup = null;
        this._window = null;
    }
}
