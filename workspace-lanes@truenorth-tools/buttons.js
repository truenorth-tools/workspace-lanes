// SPDX-FileCopyrightText: 2012 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2013 Giovanni Campagna <gcampagna@src.gnome.org>
// SPDX-FileCopyrightText: 2014 Sylvain Pasche <sylvain.pasche@gmail.com>
//
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Taskbar buttons, adapted from GNOME Shell's Window List extension.
// Unlike Window List, buttons don't decide their own visibility or order:
// the row that owns them hands them their windows.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {DashItemContainer} from 'resource:///org/gnome/shell/ui/dash.js';

import {clutterSettings} from './divider.js';

const ICON_TEXTURE_SIZE = 24;

const DRAG_OPACITY = 0.3;
const DRAG_FADE_DURATION = 200;

const ATTENTION_INDICATOR_MAX_SCALE = 0.4;
const ATTENTION_INDICATOR_TRANSITION_DURATION = 300;

class WindowContextMenu extends PopupMenu.PopupMenu {
    constructor(source, metaWindow) {
        super(source, 0.5, St.Side.BOTTOM);

        this._metaWindow = metaWindow;

        this._minimizeItem = new PopupMenu.PopupMenuItem('');
        this._minimizeItem.connect('activate', () => {
            if (this._metaWindow.minimized)
                this._metaWindow.unminimize();
            else
                this._metaWindow.minimize();
        });
        this.addMenuItem(this._minimizeItem);

        this._maximizeItem = new PopupMenu.PopupMenuItem('');
        this._maximizeItem.connect('activate', () => {
            if (this._metaWindow.is_maximized())
                this._metaWindow.unmaximize();
            else
                this._metaWindow.maximize();
        });
        this.addMenuItem(this._maximizeItem);

        this._closeItem = new PopupMenu.PopupMenuItem(_('Close'));
        this._closeItem.connect('activate', () => {
            this._metaWindow.delete(global.get_current_time());
        });
        this.addMenuItem(this._closeItem);

        this._metaWindow.connectObject(
            'notify::minimized', this._updateMinimizeItem.bind(this),
            'notify::maximized-horizontally', this._updateMaximizeItem.bind(this),
            'notify::maximized-vertically', this._updateMaximizeItem.bind(this),
            this.actor);

        this._updateMinimizeItem();
        this._updateMaximizeItem();

        this.connect('open-state-changed', () => {
            if (!this.isOpen)
                return;

            this._minimizeItem.setSensitive(this._metaWindow.can_minimize());
            this._maximizeItem.setSensitive(this._metaWindow.can_maximize());
            this._closeItem.setSensitive(this._metaWindow.can_close());
        });
    }

    _updateMinimizeItem() {
        this._minimizeItem.label.text = this._metaWindow.minimized
            ? _('Unminimize') : _('Minimize');
    }

    _updateMaximizeItem() {
        this._maximizeItem.label.text = this._metaWindow.is_maximized()
            ? _('Unmaximize') : _('Maximize');
    }
}

class AppContextMenu extends PopupMenu.PopupMenu {
    constructor(source) {
        super(source, 0.5, St.Side.BOTTOM);

        this._appButton = source;

        this._minimizeItem = new PopupMenu.PopupMenuItem(_('Minimize all'));
        this._minimizeItem.connect('activate', () => {
            const windows = this._getWindows(w => w.can_minimize());
            windows.forEach(w => w.minimize());
        });
        this.addMenuItem(this._minimizeItem);

        this._unminimizeItem = new PopupMenu.PopupMenuItem(_('Unminimize all'));
        this._unminimizeItem.connect('activate', () => {
            const windows = this._getWindows(w => w.can_minimize());
            windows.forEach(w => w.unminimize());
        });
        this.addMenuItem(this._unminimizeItem);

        this._maximizeItem = new PopupMenu.PopupMenuItem(_('Maximize all'));
        this._maximizeItem.connect('activate', () => {
            const windows = this._getWindows(w => w.can_maximize());
            windows.forEach(w => w.maximize());
        });
        this.addMenuItem(this._maximizeItem);

        this._unmaximizeItem = new PopupMenu.PopupMenuItem(_('Unmaximize all'));
        this._unmaximizeItem.connect('activate', () => {
            const windows = this._getWindows(w => w.can_maximize());
            windows.forEach(w => w.unmaximize());
        });
        this.addMenuItem(this._unmaximizeItem);

        this._closeItem = new PopupMenu.PopupMenuItem(_('Close all'));
        this._closeItem.connect('activate', () => {
            const windows = this._getWindows(w => w.can_close());
            windows.forEach(w => w.delete(global.get_current_time()));
        });
        this.addMenuItem(this._closeItem);
    }

    _getWindows(filterFunc = () => true) {
        return this._appButton.getWindowList().filter(filterFunc);
    }

    open(animate) {
        const windows = this._appButton.getWindowList();
        this._minimizeItem.visible =
            windows.some(w => w.can_minimize() && !w.minimized);
        this._unminimizeItem.visible =
            windows.some(w => w.can_minimize() && w.minimized);
        this._maximizeItem.visible =
            windows.some(w => w.can_maximize() && !w.is_maximized());
        this._unmaximizeItem.visible =
            windows.some(w => w.can_maximize() && w.is_maximized());

        super.open(animate);
        this._closeItem.setSensitive(windows.some(w => w.can_close()));
    }
}

class TitleWidget extends St.Widget {
    static {
        GObject.registerClass({
            GTypeFlags: GObject.TypeFlags.ABSTRACT,
        }, this);
    }

    constructor() {
        super({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });

        const hbox = new St.BoxLayout({
            style_class: 'window-button-box',
            x_expand: true,
            y_expand: true,
        });
        this.add_child(hbox);
        this._hbox = hbox;

        this._icon = new St.Bin({
            style_class: 'window-button-icon',
        });
        hbox.add_child(this._icon);

        this._count = new St.Label({
            style_class: 'lanes-window-count',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        hbox.add_child(this._count);

        this._label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
        });
        hbox.add_child(this._label);
        this.label_actor = this._label;

        this._attentionIndicator = new St.Widget({
            style_class: 'window-button-attention-indicator',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.END,
            scale_x: 0,
        });
        this._attentionIndicator.set_pivot_point(0.5, 0.5);
        this.add_child(this._attentionIndicator);
    }

    setIconOnly(iconOnly) {
        this._label.visible = !iconOnly;
        // centre the icon when its button is wider than the icon
        this._hbox.x_align = iconOnly
            ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL;
    }

    setNeedsAttention(enable) {
        this._attentionIndicator.ease({
            scaleX: enable ? ATTENTION_INDICATOR_MAX_SCALE : 0,
            duration: ATTENTION_INDICATOR_TRANSITION_DURATION,
        });
    }
}

class WindowTitle extends TitleWidget {
    static {
        GObject.registerClass(this);
    }

    constructor(metaWindow) {
        super();

        this._metaWindow = metaWindow;

        this._metaWindow.connectObject(
            'notify::wm-class',
            () => this._updateIcon(), GObject.ConnectFlags.AFTER,
            'notify::gtk-application-id',
            () => this._updateIcon(), GObject.ConnectFlags.AFTER,
            'notify::title', () => this._updateTitle(),
            'notify::minimized', () => this._minimizedChanged(),
            'notify::demands-attention', () => this._updateNeedsAttention(),
            'notify::urgent', () => this._updateNeedsAttention(),
            this);

        this._updateIcon();
        this._minimizedChanged();
        this._updateNeedsAttention();
    }

    _minimizedChanged() {
        this._icon.opacity = this._metaWindow.minimized ? 128 : 255;
        this._updateTitle();
    }

    _updateNeedsAttention() {
        const {urgent, demandsAttention} = this._metaWindow;
        this.setNeedsAttention(urgent || demandsAttention);
    }

    _updateTitle() {
        if (!this._metaWindow.title)
            return;

        if (this._metaWindow.minimized)
            this._label.text = '[%s]'.format(this._metaWindow.title);
        else
            this._label.text = this._metaWindow.title;
    }

    _updateIcon() {
        const app = Shell.WindowTracker.get_default().get_window_app(this._metaWindow);
        if (app) {
            this._icon.child = app.create_icon_texture(ICON_TEXTURE_SIZE);
        } else {
            this._icon.child = new St.Icon({
                icon_name: 'application-x-executable',
                icon_size: ICON_TEXTURE_SIZE,
            });
        }
    }
}

class AppTitle extends TitleWidget {
    static {
        GObject.registerClass(this);
    }

    constructor(app) {
        super();

        this._windows = new Set();

        this._icon.child = app.create_icon_texture(ICON_TEXTURE_SIZE);
        this._label.text = app.get_name();

        this.connect('destroy', () => {
            this._windows.forEach(w => w.disconnectObject(this));
            this._windows.clear();
        });
    }

    setWindows(windows) {
        for (const w of this._windows) {
            if (!windows.includes(w)) {
                w.disconnectObject(this);
                this._windows.delete(w);
            }
        }
        for (const w of windows) {
            if (this._windows.has(w))
                continue;
            w.connectObject(
                'notify::urgent', () => this._updateNeedsAttention(),
                'notify::demands-attention', () => this._updateNeedsAttention(),
                this);
            this._windows.add(w);
        }

        this._count.text = `${windows.length}`;
        this._count.visible = windows.length > 1;
        this._updateNeedsAttention();
    }

    _updateNeedsAttention() {
        const needsAttention =
            [...this._windows].some(w => w.urgent || w.demandsAttention);
        this.setNeedsAttention(needsAttention);
    }
}

class BaseButton extends DashItemContainer {
    static {
        GObject.registerClass({
            GTypeFlags: GObject.TypeFlags.ABSTRACT,
            Signals: {
                'hover-changed': {param_types: [GObject.TYPE_BOOLEAN]},
                'drag-begin': {},
                'drag-end': {},
            },
        }, this);
    }

    // @switcher: a SwitcherWatcher, to mark the button while its window
    // is selected in GNOME's window switching
    constructor(switcher) {
        super();

        this._switcher = switcher;
        this._button = new St.Button({
            style_class: 'window-button',
            can_focus: true,
            x_expand: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
        });
        this.setChild(this._button);

        this.tooltipsEnabled = true;
        this.minimizeOnClick = false;
        this._iconOnly = false;

        this._button.connect('notify::hover', () => {
            if (this._button.hover && this.tooltipsEnabled)
                this.showLabel();
            else
                this.hideLabel();
            this.emit('hover-changed', this._button.hover);
        });

        this.connect('notify::allocation',
            this._updateIconGeometry.bind(this));
        this._button.connect('clicked', this._onClicked.bind(this));
        this.connect('destroy', this._onDestroy.bind(this));
        this.connect('popup-menu', this._onPopupMenu.bind(this));

        this._contextMenuManager = new PopupMenu.PopupMenuManager(this);

        this._button._delegate = this;

        switcher.connectObject('changed', () => this._updateStyle(), this);
    }

    get active() {
        return this._button.has_style_class_name('focused');
    }

    get hovered() {
        return this._button.hover;
    }

    // The windows this button stands for
    getWindowList() {
        throw new GObject.NotImplementedError(
            `getWindowList in ${this.constructor.name}`);
    }

    setIconOnly(iconOnly) {
        if (this._iconOnly === iconOnly)
            return;

        this._iconOnly = iconOnly;
        if (iconOnly)
            this._button.add_style_class_name('icon-only');
        else
            this._button.remove_style_class_name('icon-only');
        this._button.child?.setIconOnly(iconOnly);
    }

    showLabel() {
        let labelText = this.label_actor.text;
        if (!this._iconOnly) {
            const [, , preferredTitleWidth] = this.label_actor.get_preferred_size();
            const maxTitleWidth = this.label_actor.allocation.get_width();
            if (preferredTitleWidth <= maxTitleWidth)
                labelText = '';
        }

        this.setLabelText(labelText);
        super.showLabel();
    }

    _setLongPressTimeout() {
        if (this._longPressTimeoutId)
            return;

        const {longPressDuration} = clutterSettings();
        this._longPressTimeoutId =
            GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, longPressDuration, () => {
                delete this._longPressTimeoutId;

                if (this._canOpenPopupMenu() && !this._contextMenu.isOpen)
                    this._openMenu(this._contextMenu);
            });
    }

    _removeLongPressTimeout() {
        if (!this._longPressTimeoutId)
            return;
        GLib.source_remove(this._longPressTimeoutId);
        delete this._longPressTimeoutId;
    }

    // St.Widget has no default handlers for these (clicks are gestures
    // now), so there's no super to chain up to
    vfunc_button_press_event(event) {
        if (event.get_button() === 1)
            this._setLongPressTimeout();
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_release_event(_event) {
        this._removeLongPressTimeout();
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_touch_event(event) {
        if (event.type() === Clutter.EventType.TOUCH_BEGIN)
            this._setLongPressTimeout();
        else if (event.type() === Clutter.EventType.TOUCH_END)
            this._removeLongPressTimeout();
        return Clutter.EVENT_PROPAGATE;
    }

    activate() {
        if (this.active)
            return;

        this._onClicked(this, 1);
    }

    _onClicked(_actor, _button) {
        throw new GObject.NotImplementedError(
            `_onClicked in ${this.constructor.name}`);
    }

    _canOpenPopupMenu() {
        return true;
    }

    _openMenu(menu) {
        menu.open();

        const event = Clutter.get_current_event();
        if (event && event.type() === Clutter.EventType.KEY_RELEASE)
            menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }

    _minimizeOrActivateWindow(window) {
        const {focusWindow} = global.display;
        const useMinimize =
            focusWindow === window ||
            focusWindow?.get_transient_for() === window;

        if (useMinimize && this.minimizeOnClick && window.can_minimize())
            window.minimize();
        else if (!useMinimize)
            window.activate(global.get_current_time());
    }

    _onPopupMenu(_actor) {
        if (!this._canOpenPopupMenu() || this._contextMenu.isOpen)
            return;
        this._openMenu(this._contextMenu);
    }

    _isFocused() {
        const {focusWindow} = global.display;
        return !!focusWindow && this.getWindowList().includes(focusWindow);
    }

    _updateStyle() {
        if (this._isFocused())
            this._button.add_style_class_name('focused');
        else
            this._button.remove_style_class_name('focused');

        const selected = this._switcher.window;
        if (selected && this.getWindowList().includes(selected))
            this._button.add_style_class_name('lanes-switching');
        else
            this._button.remove_style_class_name('lanes-switching');
    }

    _getIconGeometry() {
        const rect = new Mtk.Rectangle();

        [rect.x, rect.y] = this.get_transformed_position();
        [rect.width, rect.height] = this.get_transformed_size();

        return rect;
    }

    _updateIconGeometry() {
        const rect = this._getIconGeometry();
        this.getWindowList().forEach(w => w.set_icon_geometry(rect));
    }

    _onDestroy() {
        this._removeLongPressTimeout();
    }
}

export class WindowButton extends BaseButton {
    static {
        GObject.registerClass(this);
    }

    constructor(metaWindow, switcher) {
        super(switcher);

        this.metaWindow = metaWindow;

        this._windowTitle = new WindowTitle(this.metaWindow);
        this._button.set_child(this._windowTitle);
        this.label_actor = this._windowTitle.label_actor;

        this._contextMenu = new WindowContextMenu(this, this.metaWindow);
        this._contextMenu.actor.hide();
        this._contextMenuManager.addMenu(this._contextMenu);
        Main.uiGroup.add_child(this._contextMenu.actor);

        global.display.connectObject('notify::focus-window',
            () => this._updateStyle(), this);
        this.metaWindow.connectObject('notify::minimized',
            () => this._updateStyle(), this);
        this._updateStyle();

        // drag the button onto a section or another button to move or
        // tile the window; drop targets are set up by the bar
        this._draggable = DND.makeDraggable(this._button);
        this._draggable.connectObject(
            'drag-begin', () => {
                this._removeLongPressTimeout();
                this.hideLabel();
                this.ease({
                    opacity: 255 * DRAG_OPACITY,
                    duration: DRAG_FADE_DURATION,
                });
                this.emit('drag-begin');
            },
            'drag-cancelled', () => this._onDragEnd(),
            'drag-end', () => this._onDragEnd(),
            this);
    }

    _onDragEnd() {
        this.ease({
            opacity: 255,
            duration: DRAG_FADE_DURATION,
        });
        this.emit('drag-end');
    }

    getDragActor() {
        const title = new WindowTitle(this.metaWindow);
        title.setIconOnly(this._iconOnly);
        return new St.Bin({
            style_class: 'window-button-drag-actor',
            child: title,
            width: this.width,
        });
    }

    getDragActorSource() {
        return this;
    }

    getWindowList() {
        return [this.metaWindow];
    }

    _onClicked(actor, button) {
        if (this._contextMenu.isOpen) {
            this._contextMenu.close();
            return;
        }

        if (!button || button === 1)
            this._minimizeOrActivateWindow(this.metaWindow);
        else
            this._openMenu(this._contextMenu);
    }

    _updateStyle() {
        super._updateStyle();

        if (this.metaWindow.minimized)
            this._button.add_style_class_name('minimized');
        else
            this._button.remove_style_class_name('minimized');
    }

    _onDestroy() {
        super._onDestroy();
        this._contextMenu.destroy();
    }
}

// A group of two or more windows of one app
export class AppButton extends BaseButton {
    static {
        GObject.registerClass(this);
    }

    constructor(app, switcher) {
        super(switcher);

        this.app = app;
        this._windows = [];

        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._menu = new PopupMenu.PopupMenu(this, 0.5, St.Side.BOTTOM);
        this._menu.actor.hide();
        this._menu.connect('activate', this._onMenuActivate.bind(this));
        this._menuManager.addMenu(this._menu);
        Main.uiGroup.add_child(this._menu.actor);

        this._appTitle = new AppTitle(app);
        this._button.set_child(this._appTitle);
        this.label_actor = this._appTitle.label_actor;

        this._contextMenu = new AppContextMenu(this);
        Main.uiGroup.add_child(this._contextMenu.actor);
        this._contextMenu.actor.hide();
        this._contextMenuManager.addMenu(this._contextMenu);

        global.display.connectObject('notify::focus-window',
            () => this._updateStyle(), this);
    }

    setWindows(windows) {
        this._windows = windows;
        this._appTitle.setWindows(windows);
        this._updateStyle();
        this._updateIconGeometry();
    }

    getWindowList() {
        return this._windows;
    }

    _onClicked(actor, button) {
        const menuWasOpen = this._menu.isOpen;
        if (menuWasOpen)
            this._menu.close();

        const contextMenuWasOpen = this._contextMenu.isOpen;
        if (contextMenuWasOpen)
            this._contextMenu.close();

        if (!button || button === 1) {
            if (menuWasOpen)
                return;

            this._menu.removeAll();
            for (const window of this._windows) {
                const windowTitle = new WindowTitle(window);
                const item = new PopupMenu.PopupBaseMenuItem();
                item.add_child(windowTitle);
                item._window = window;
                this._menu.addMenuItem(item);
            }
            this._openMenu(this._menu);
        } else {
            if (contextMenuWasOpen)
                return;
            this._openMenu(this._contextMenu);
        }
    }

    _canOpenPopupMenu() {
        return !this._menu.isOpen;
    }

    _onMenuActivate(menu, child) {
        child._window.activate(global.get_current_time());
    }

    _onDestroy() {
        super._onDestroy();
        this._menu.destroy();
        this._contextMenu.destroy();
    }
}
