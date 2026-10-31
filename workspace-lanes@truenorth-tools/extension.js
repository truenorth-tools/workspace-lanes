// SPDX-FileCopyrightText: 2012 Florian Müllner <fmuellner@gnome.org>
// SPDX-FileCopyrightText: 2013 Giovanni Campagna <gcampagna@src.gnome.org>
// SPDX-FileCopyrightText: 2014 Sylvain Pasche <sylvain.pasche@gmail.com>
//
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Workspace Lanes: a bottom taskbar, based on GNOME Shell's Window List
// extension, that orders windows by workspace and then by where they sit
// on screen. It can either split the bar into one even-width lane per
// workspace (a "section" in the code) or show one list with the stock
// workspace switcher.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {
    ANIMATION_TIME as SLIDE_ANIMATION_TIME,
} from 'resource:///org/gnome/shell/ui/overview.js';

import {AppButton, WindowButton} from './buttons.js';
import {WorkspaceColors} from './colors.js';
import {LightShell} from './lightShell.js';
import {SwitcherWatcher} from './switcher.js';
import {WorkspaceBackgrounds} from './backgrounds.js';
import {WorkspacePreview} from './preview.js';
import {WorkspaceIndicator} from './workspaceIndicator.js';

// How often, at most, the bar re-sorts while windows are moving
const SYNC_INTERVAL = 80;

const DND_ACTIVATE_TIMEOUT = 500;
const PREVIEW_CLOSE_DELAY = 250;

// Widths (logical px) a button needs before the row collapses further.
// Sections shrink labels down to SECTION_LABEL_MIN, then go icon-only,
// then group. The list layout groups as soon as buttons drop below their
// natural width, the same as Window List.
const SECTION_LABEL_MIN = 110;
const LIST_LABEL_MIN = 250;
const ICON_BUTTON_WIDTH = 42;

const GroupingMode = {
    NEVER: 0,
    AUTO: 1,
    ALWAYS: 2,
};

function workspaceIndex(window) {
    if (window.on_all_workspaces)
        return Infinity;
    return window.get_workspace()?.index() ?? Infinity;
}

// Left to right, then top to bottom, then oldest first
function compareSpatial(a, b) {
    const ra = a.get_frame_rect();
    const rb = b.get_frame_rect();
    return ra.x - rb.x ||
        ra.y - rb.y ||
        a.get_stable_sequence() - b.get_stable_sequence();
}

function compareWorkspaceThenSpatial(a, b) {
    const wa = workspaceIndex(a);
    const wb = workspaceIndex(b);
    if (wa !== wb)
        return wa < wb ? -1 : 1;
    return compareSpatial(a, b);
}

function sameWindows(a, b) {
    return !!a && !!b && a.length === b.length && a.every(w => b.includes(w));
}

// Move @window to @workspace on monitor @monitorIndex, keeping its size
// and position
function moveWindowTo(window, workspace, monitorIndex) {
    if (window.get_monitor() !== monitorIndex)
        window.move_to_monitor(monitorIndex);
    // still on all workspaces means the user pinned it there
    if (window.on_all_workspaces)
        window.unstick();
    if (window.get_workspace() !== workspace)
        window.change_workspace(workspace);
}

function findAncestor(actor, stop, predicate) {
    for (let a = actor; a && a !== stop; a = a.get_parent()) {
        if (predicate(a))
            return a;
    }
    return null;
}

function setStyleClass(actor, name, enabled) {
    if (enabled)
        actor.add_style_class_name(name);
    else
        actor.remove_style_class_name(name);
}

// The number badge at the start of a section or band
function workspaceLabel(index, settings) {
    const label = new St.Label({
        style_class: 'lanes-section-label',
        text: `${index + 1}`,
        y_align: Clutter.ActorAlign.CENTER,
    });
    settings.bind('show-workspace-numbers', label, 'visible',
        Gio.SettingsBindFlags.GET);
    return label;
}

// Tracks every window and emits a throttled 'changed' whenever anything
// that affects placement or order changes. Bars re-read the whole state
// on each 'changed', which keeps them simple and is cheap for the few
// dozen windows a desktop has.
class TaskbarModel extends Signals.EventEmitter {
    constructor() {
        super();

        this._windows = new Set();
        this._newWindows = new Set();
        this._timeoutId = 0;

        const queue = () => this.queueChanged();

        global.display.connectObject(
            'window-created', (d, w) => this._track(w, true),
            'window-entered-monitor', queue,
            'window-left-monitor', queue,
            this);
        global.workspace_manager.connectObject(
            'notify::n-workspaces', queue,
            'workspace-switched', queue,
            'workspaces-reordered', queue,
            this);
        Shell.WindowTracker.get_default().connectObject(
            'tracked-windows-changed', queue, this);

        global.get_window_actors().forEach(a => this._track(a.meta_window, false));
    }

    get windows() {
        return [...this._windows].filter(w => !w.skip_taskbar);
    }

    _track(window, isNew) {
        if (this._windows.has(window))
            return;

        const queue = () => this.queueChanged();
        window.connectObject(
            'position-changed', queue,
            'workspace-changed', queue,
            'notify::skip-taskbar', queue,
            'notify::on-all-workspaces', queue,
            'unmanaged', () => this._untrack(window),
            this);
        this._windows.add(window);
        if (isNew)
            this._newWindows.add(window);
        this.queueChanged();
    }

    _untrack(window) {
        window.disconnectObject(this);
        this._windows.delete(window);
        this._newWindows.delete(window);
        this.queueChanged();
    }

    queueChanged() {
        if (this._timeoutId)
            return;

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SYNC_INTERVAL, () => {
            this._timeoutId = 0;
            const newWindows = this._newWindows;
            this._newWindows = new Set();
            this.emit('changed', newWindows);
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;

        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Shell.WindowTracker.get_default().disconnectObject(this);
        this._windows.forEach(w => w.disconnectObject(this));
        this._windows.clear();
        this._newWindows.clear();
    }
}

// One workspace's run of buttons in the window list layout: a hover and
// drop target like a section, with the workspace's number badge first
class WorkspaceBand extends St.BoxLayout {
    static {
        GObject.registerClass(this);
    }

    constructor(index, settings) {
        super({
            style_class: 'window-list lanes-ws-group',
            y_expand: true,
            reactive: true,
            track_hover: true,
        });

        this.index = index;
        this.label = null;
        // windows on every workspace get a band of their own, no number
        if (index === Infinity)
            return;

        this.add_style_class_name(`lanes-ws-${index}`);
        this.label = workspaceLabel(index, settings);
        this.add_child(this.label);

        global.workspace_manager.connectObject('active-workspace-changed',
            () => this._syncActive(), this);
        this._syncActive();
    }

    get workspace() {
        return this.index === Infinity
            ? null
            : global.workspace_manager.get_workspace_by_index(this.index);
    }

    get buttons() {
        return this.get_children().filter(c => c !== this.label && !c.animatingOut);
    }

    get empty() {
        return this.get_children().every(c => c === this.label);
    }

    _syncActive() {
        setStyleClass(this, 'active', !!this.workspace?.active);
    }
}

// A row of buttons for an ordered list of windows. It picks how compact
// to be from its own width: full labels, shrunk labels, icons only, and
// finally one button per app.
class ButtonRow extends St.Widget {
    static [GObject.signals] = {
        'button-hover': {param_types: [GObject.TYPE_JSOBJECT]},
        'button-drag-begin': {},
        'button-drag-end': {},
        'band-created': {param_types: [GObject.TYPE_OBJECT]},
    };

    static {
        GObject.registerClass(this);
    }

    constructor(settings, switcher, {iconStage, labelMin, tooltips, fill = false,
        groupWorkspaces = false}) {
        super({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
        });

        this._settings = settings;
        this._switcher = switcher;
        this._iconStage = iconStage;
        this._labelMin = labelMin;
        this._tooltips = tooltips;
        this._fill = fill;
        // buttons of each workspace sit together in their own box, which
        // colour coding turns into one band per workspace
        this._groupWorkspaces = groupWorkspaces;
        this._wsGroups = new Map();

        // with fill, buttons share the whole width equally
        this._box = new St.BoxLayout({
            style_class: 'window-list',
            x_align: fill ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
        });
        this._box.layout_manager.homogeneous = fill;
        this.add_child(this._box);

        this._windows = [];
        this._buttons = new Map();
        this._stage = null;
        this._laterId = 0;
        this._lastWidth = -1;

        this.connect('notify::allocation', () => {
            const {width} = this;
            if (width === this._lastWidth)
                return;
            this._lastWidth = width;
            this._queueSync();
        });
        this.connect('destroy', () => {
            if (this._laterId)
                global.compositor.get_laters().remove(this._laterId);
            this._laterId = 0;
        });
    }

    // Never ask for more room than we're given; buttons collapse instead
    vfunc_get_preferred_width(forHeight) {
        const [, natWidth] = super.vfunc_get_preferred_width(forHeight);
        return [0, natWidth];
    }

    get buttons() {
        return this._box.get_children()
            .flatMap(c => c instanceof WorkspaceBand ? c.buttons : [c])
            .filter(c => !c.animatingOut);
    }

    get bands() {
        return [...this._wsGroups.values()];
    }

    _wsGroup(index) {
        let group = this._wsGroups.get(index);
        if (!group) {
            group = new WorkspaceBand(index, this._settings);
            this._wsGroups.set(index, group);
            this.emit('band-created', group);
        }
        return group;
    }

    // Put @child in @parent, right after @prev (first if null)
    _place(parent, child, prev) {
        const current = child.get_parent();
        if (current !== parent) {
            current?.remove_child(child);
            parent.add_child(child);
        }
        if (prev === null) {
            if (parent.get_first_child() !== child)
                parent.set_child_below_sibling(child, null);
        } else if (prev.get_next_sibling() !== child) {
            parent.set_child_above_sibling(child, prev);
        }
    }

    setWindows(windows, newWindows = null) {
        this._windows = windows;
        this._sync(newWindows);
    }

    resync() {
        this._sync(null);
    }

    _queueSync() {
        if (this._laterId)
            return;

        // allocation is in progress; change children afterwards
        const laters = global.compositor.get_laters();
        this._laterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._sync(null);
            return GLib.SOURCE_REMOVE;
        });
    }

    _groups() {
        const tracker = Shell.WindowTracker.get_default();
        const groups = [];
        const byApp = new Map();
        for (const window of this._windows) {
            const app = tracker.get_window_app(window);
            // with workspace bands, an app's windows on different
            // workspaces stay apart so each band shows its own
            const ws = this._groupWorkspaces ? workspaceIndex(window) : 0;
            const groupKey = app ? `${app.get_id()}@${ws}` : null;
            let group = groupKey ? byApp.get(groupKey) : null;
            if (!group) {
                group = {app, ws, windows: []};
                groups.push(group);
                if (groupKey)
                    byApp.set(groupKey, group);
            }
            group.windows.push(window);
        }
        return groups;
    }

    _computeStage(groups) {
        const nWindows = this._windows.length;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = this.width;
        const fits = (count, minWidth) => count * minWidth * scale <= width;
        const mode = this._settings.get_enum('grouping-mode');

        if (mode !== GroupingMode.ALWAYS) {
            if (fits(nWindows, this._labelMin))
                return {grouped: false, iconOnly: false};
            if (this._iconStage && fits(nWindows, ICON_BUTTON_WIDTH))
                return {grouped: false, iconOnly: true};
            if (mode === GroupingMode.NEVER)
                return {grouped: false, iconOnly: this._iconStage};
        }

        return {
            grouped: true,
            iconOnly: this._iconStage && !fits(groups.length, this._labelMin),
        };
    }

    _sync(newWindows) {
        const groups = this._groups();
        const stage = this._computeStage(groups);
        const stageChanged = this._stage !== null &&
            (stage.grouped !== this._stage.grouped ||
             stage.iconOnly !== this._stage.iconOnly);
        this._stage = stage;

        // single windows keep the same key in both stages so their
        // buttons survive a switch between grouped and ungrouped
        const items = [];
        for (const {app, ws, windows} of groups) {
            if (stage.grouped && app && windows.length > 1) {
                items.push({key: `app:${app.get_id()}@${ws}`, app, windows});
            } else {
                for (const window of windows)
                    items.push({key: `window:${window.get_id()}`, window});
            }
        }
        if (!stage.grouped) {
            const position = new Map(this._windows.map((w, i) => [w, i]));
            items.sort((a, b) => position.get(a.window) - position.get(b.window));
        }

        const keep = new Set(items.map(i => i.key));
        for (const [key, button] of this._buttons) {
            if (keep.has(key))
                continue;
            this._buttons.delete(key);
            if (stageChanged)
                button.destroy();
            else
                button.animateOutAndDestroy();
        }

        const minimizeOnClick = this._settings.get_boolean('minimize-on-click');
        const prevIn = new Map();
        const usedGroups = new Set();
        for (const item of items) {
            let button = this._buttons.get(item.key);
            if (!button) {
                button = item.app
                    ? new AppButton(item.app, this._switcher)
                    : new WindowButton(item.window, this._switcher);
                if (this._fill)
                    button.x_align = Clutter.ActorAlign.FILL;
                button.connect('hover-changed', (b, hover) =>
                    this.emit('button-hover', hover ? b.getWindowList() : null));
                button.connect('drag-begin', () => this.emit('button-drag-begin'));
                button.connect('drag-end', () => this.emit('button-drag-end'));
                this._buttons.set(item.key, button);
            }

            let parent = this._box;
            if (this._groupWorkspaces) {
                const index = workspaceIndex(item.window ?? item.windows[0]);
                parent = this._wsGroup(index);
                if (!usedGroups.has(parent)) {
                    this._place(this._box, parent, prevIn.get(this._box) ?? null);
                    prevIn.set(this._box, parent);
                    usedGroups.add(parent);
                }
            }

            const isNew = !button.get_parent();
            // in a band, buttons follow the number badge
            this._place(parent, button, prevIn.get(parent) ?? parent.label ?? null);
            prevIn.set(parent, button);
            if (isNew) {
                const animate = !stageChanged &&
                    !!item.window && !!newWindows?.has(item.window);
                button.show(animate);
            }

            if (item.app)
                button.setWindows(item.windows);
            button.tooltipsEnabled = this._tooltips;
            button.minimizeOnClick = minimizeOnClick;
            button.setIconOnly(stage.iconOnly);
        }

        // drop bands left empty (ones still holding a closing button
        // go next time)
        for (const [index, group] of this._wsGroups) {
            if (!usedGroups.has(group) && group.empty) {
                group.destroy();
                this._wsGroups.delete(index);
            }
        }
    }
}

// Lays children out side by side at exactly equal widths, whatever they
// contain
class EqualColumnsLayout extends Clutter.LayoutManager {
    static {
        GObject.registerClass(this);
    }

    vfunc_get_preferred_width(_container, _forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(container, _forWidth) {
        let min = 0, nat = 0;
        for (const child of container) {
            const [childMin, childNat] = child.get_preferred_height(-1);
            min = Math.max(min, childMin);
            nat = Math.max(nat, childNat);
        }
        return [min, nat];
    }

    vfunc_allocate(container, box) {
        const children = container.get_children().filter(c => c.visible);
        const n = children.length;
        if (n === 0)
            return;

        const rtl = container.get_text_direction() === Clutter.TextDirection.RTL;
        const columnWidth = box.get_width() / n;
        children.forEach((child, i) => {
            const column = rtl ? n - 1 - i : i;
            const childBox = new Clutter.ActorBox();
            childBox.set_origin(box.x1 + Math.round(column * columnWidth), box.y1);
            childBox.set_size(
                Math.round((column + 1) * columnWidth) - Math.round(column * columnWidth),
                box.get_height());
            child.allocate(childBox);
        });
    }
}

// One workspace's slice of the bar
class Section extends St.Widget {
    static {
        GObject.registerClass(this);
    }

    constructor(index, settings, switcher) {
        super({
            style_class: 'lanes-section',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
            x_expand: true,
            y_expand: true,
        });

        this.index = index;
        this.workspace = global.workspace_manager.get_workspace_by_index(index);

        const box = new St.BoxLayout({x_expand: true, y_expand: true});
        this.add_child(box);

        this.add_style_class_name(`lanes-ws-${index}`);
        box.add_child(workspaceLabel(index, settings));

        this.row = new ButtonRow(settings, switcher, {
            iconStage: true,
            labelMin: SECTION_LABEL_MIN,
            tooltips: false,
            fill: true,
        });
        box.add_child(this.row);

        this.workspace.connectObject('notify::active',
            () => this._syncActive(), this);
        this._syncActive();

        this._pressed = false;
    }

    get buttons() {
        return this.row.buttons;
    }

    _syncActive() {
        setStyleClass(this, 'active', this.workspace.active);
    }

    _onEmptySpace(event) {
        const target = global.stage.get_event_actor(event);
        return !findAncestor(target, this, a => a instanceof St.Button);
    }

    vfunc_button_press_event(event) {
        this._pressed = event.get_button() === Clutter.BUTTON_PRIMARY &&
            this._onEmptySpace(event);
        return this._pressed ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_release_event(event) {
        if (!this._pressed)
            return Clutter.EVENT_PROPAGATE;

        this._pressed = false;
        if (event.get_button() === Clutter.BUTTON_PRIMARY && this._onEmptySpace(event))
            this.workspace.activate(event.get_time());
        return Clutter.EVENT_STOP;
    }
}

class BottomWorkspaceIndicator extends WorkspaceIndicator {
    static {
        GObject.registerClass(this);
    }

    setMenu(menu) {
        super.setMenu(menu);

        if (!menu)
            return;

        this.menu.actor.updateArrowSide(St.Side.BOTTOM);
        this.menu.actor.remove_style_class_name('panel-menu');
    }
}

class Bar extends St.Widget {
    static {
        GObject.registerClass(this);
    }

    // @shared holds what all bars use: the window model, this extension's
    // settings and mutter's, and the window switching watcher
    constructor({model, settings, mutterSettings, switcher, backgrounds}, perMonitor, monitor, extension) {
        super({
            name: 'panel',
            style_class: 'bottom-panel solid',
            reactive: true,
            track_hover: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this.connect('destroy', this._onDestroy.bind(this));

        this._model = model;
        this._perMonitor = perMonitor;
        this._monitor = monitor;
        this._extension = extension;
        this._settings = settings;
        this._mutterSettings = mutterSettings;
        this._switcher = switcher;
        this._backgrounds = backgrounds;

        this._box = new St.BoxLayout({x_expand: true, y_expand: true});
        this.add_child(this._box);

        this._menuManager = new PopupMenu.PopupMenuManager(this);

        this._row = null;
        this._sections = null;
        this._workspaceIndicator = null;
        this._preview = null;
        this._previewSection = null;
        this._suppressedSection = null;
        this._suppressedWindows = null;
        this._hoveredWindows = null;
        this._openTimeoutId = 0;
        this._closeTimeoutId = 0;

        const inOverview = Main.overview.visible ||
            (Main.layoutManager._startingUp && Main.sessionMode.hasOverview);

        const overviewChromeOptions = {
            affectsStruts: true,
        };
        const chromeOptions = {
            ...overviewChromeOptions,
            trackFullscreen: true,
        };
        Main.layoutManager.addChrome(this, inOverview
            ? overviewChromeOptions
            : chromeOptions);

        Main.uiGroup.set_child_above_sibling(this, Main.layoutManager.panelBox);
        Main.ctrlAltTabManager.addGroup(this, _('Workspace Lanes'), 'start-here-symbolic');

        this.visible = !inOverview;

        this.width = this._monitor.width;
        this.connect('notify::height', this._updatePosition.bind(this));
        this._updatePosition();

        // Hack: OSK gesture is tied to visibility, piggy-back on that
        Main.keyboard._bottomDragGesture.connectObject('notify::enabled',
            action => {
                const visible = !action.enabled;
                if (visible) {
                    Main.uiGroup.set_child_above_sibling(
                        this, Main.layoutManager.keyboardBox);
                } else {
                    Main.uiGroup.set_child_above_sibling(
                        this, Main.layoutManager.panelBox);
                }
                this._updateKeyboardAnchor();
            }, this);

        Main.overview.connectObject(
            'showing', () => {
                this._hidePreview();
                this._retrackChrome(overviewChromeOptions);
                this._slideOut();
                this._updateKeyboardAnchor();
            },
            'hiding', () => {
                this._slideIn();
            },
            'hidden', () => {
                this._retrackChrome(chromeOptions);
                this._updateKeyboardAnchor();
            }, this);

        global.display.connectObject('in-fullscreen-changed', () => {
            this._updateKeyboardAnchor();
        }, this);

        Main.xdndHandler.connectObject(
            'drag-begin', () => this._monitorXdndDrag(),
            'drag-end', () => this._stopMonitoringXdndDrag(),
            this);
        this._xdndDragMonitor = {
            dragMotion: this._onXdndDragMotion.bind(this),
        };
        this._dndTimeoutId = 0;
        this._dndTarget = null;

        this._dropIndicator = null;
        this._windowDragActive = false;
        this._dragHoverSection = null;
        this._dragHoverTimeoutId = 0;
        this._itemDragMonitor = {
            dragMotion: dragEvent => {
                if (this._dropIndicator && !this.contains(dragEvent.targetActor))
                    this._setDropIndicator(null);
                const targets = this._targets();
                if (!findAncestor(dragEvent.targetActor, this, a => targets.includes(a)))
                    this._setDragHoverSection(null);
                return DND.DragMotionResult.CONTINUE;
            },
            dragDrop: () => {
                this._setDropIndicator(null);
                return DND.DragDropResult.CONTINUE;
            },
        };
        DND.addDragMonitor(this._itemDragMonitor);

        this.connect('scroll-event', this._onScrollEvent.bind(this));
        this.connect('captured-event', this._onCapturedEvent.bind(this));

        this._mutterSettings.connectObject(
            'changed::workspaces-only-on-primary', () => this._rebuild(),
            'changed::dynamic-workspaces', () => this._updateWorkspaceIndicatorVisibility(),
            this);

        this._settings.connectObject(
            'changed::layout', () => this._rebuild(),
            'changed::grouping-mode', () => this._resyncRows(),
            'changed::minimize-on-click', () => this._resyncRows(),
            'changed::display-all-workspaces', () => this.sync(null),
            'changed::color-workspaces', () => this._syncColors(),
            this);
        this._syncColors();

        switcher.connectObject('changed',
            () => this._syncThumbnailHighlight(), this);

        model.connectObject('changed',
            (m, newWindows) => this.sync(newWindows), this);

        this._rebuild();
    }

    get_transformed_position() {
        // HACK: Remove translation we use for animations
        //       to keep struts stable
        const [x, y] = super.get_transformed_position();
        return [x, y - this.translation_y];
    }

    _syncColors() {
        const enabled = this._settings.get_boolean('color-workspaces');
        setStyleClass(this, 'lanes-colors', enabled);
        this._preview?.setColorsEnabled(enabled);
    }

    // Whether this monitor has workspaces of its own (only the primary
    // does when workspaces are on the primary display only)
    get _hasWorkspaces() {
        return this._monitor === Main.layoutManager.primaryMonitor ||
            !this._mutterSettings.get_boolean('workspaces-only-on-primary');
    }

    get _useSections() {
        return this._hasWorkspaces && this._settings.get_string('layout') === 'sections';
    }

    // Build the bar contents for the current layout
    _rebuild() {
        this._hidePreview();
        this._box.destroy_all_children();
        this._row = null;
        this._sections = null;
        this._workspaceIndicator = null;

        if (this._useSections) {
            this._sectionsBox = new St.Widget({
                style_class: 'lanes-sections',
                layout_manager: new EqualColumnsLayout(),
                x_expand: true,
                y_expand: true,
            });
            this._box.add_child(this._sectionsBox);
            this._rebuildSections();
        } else {
            this._row = new ButtonRow(this._settings, this._switcher, {
                iconStage: false,
                labelMin: LIST_LABEL_MIN,
                tooltips: false,
                groupWorkspaces: true,
            });
            this._box.add_child(this._row);
            this._watchRowDrags(this._row);
            this._row.connect('band-created', (row, band) => {
                band.connect('notify::hover', () => this._onSectionHover(band));
                // a band goes when its workspace's last window does
                band.connect('destroy', () => {
                    if (this._previewSection === band)
                        this._hidePreview();
                    if (this._suppressedSection === band)
                        this._suppressedSection = null;
                    if (this._dragHoverSection === band)
                        this._setDragHoverSection(null);
                });
                this._setupSectionDrops(band);
            });
            this._row.connect('button-hover', (row, windows) =>
                this._onButtonHover(row.bands.find(b => b.hover) ?? null, windows));

            const indicatorsBox = new St.BoxLayout({x_align: Clutter.ActorAlign.END});
            this._box.add_child(indicatorsBox);

            this._workspaceIndicator = new BottomWorkspaceIndicator({
                baseStyleClass: 'window-list-workspace-indicator',
                extension: this._extension,
                settings: this._settings,
            });
            indicatorsBox.add_child(this._workspaceIndicator.container);
            this._workspaceIndicator.connectObject('menu-set',
                () => this._onWorkspaceMenuSet(), this);
            this._onWorkspaceMenuSet();
            this._updateWorkspaceIndicatorVisibility();
        }

        this.sync(null);
    }

    _rebuildSections() {
        this._hidePreview();
        this._sectionsBox.destroy_all_children();
        this._sections = [];

        const {nWorkspaces} = global.workspace_manager;
        for (let i = 0; i < nWorkspaces; i++) {
            const section = new Section(i, this._settings, this._switcher);
            section.connect('notify::hover', () => this._onSectionHover(section));
            section.row.connect('button-hover',
                (row, windows) => this._onButtonHover(section, windows));
            this._watchRowDrags(section.row);
            this._setupSectionDrops(section);
            this._sectionsBox.add_child(section);
            this._sections.push(section);
        }
    }

    _sectionsStale() {
        const {workspaceManager} = global;
        return this._sections.length !== workspaceManager.nWorkspaces ||
            this._sections.some((s, i) =>
                s.workspace !== workspaceManager.get_workspace_by_index(i));
    }

    _onMonitor(window) {
        return !this._perMonitor || window.get_monitor() === this._monitor.index;
    }

    // Re-read every window and hand each row its sorted share
    sync(newWindows) {
        const windows = this._model.windows.filter(w => this._onMonitor(w));
        const {workspaceManager} = global;

        if (this._sections) {
            if (this._sectionsStale())
                this._rebuildSections();

            const active = workspaceManager.get_active_workspace_index();
            const buckets = this._sections.map(() => []);
            for (const window of windows) {
                // windows on every workspace live in the current section
                const index = workspaceIndex(window);
                buckets[index === Infinity ? active : index]?.push(window);
            }
            this._sections.forEach((section, i) =>
                section.row.setWindows(buckets[i].sort(compareSpatial), newWindows));
        } else if (this._row) {
            const workspace = workspaceManager.get_active_workspace();
            const showAll = this._settings.get_boolean('display-all-workspaces');
            const shown = windows.filter(w => showAll || w.located_on_workspace(workspace));
            this._row.setWindows(shown.sort(compareWorkspaceThenSpatial), newWindows);
            this._updateWorkspaceIndicatorVisibility();
        }

        this._preview?.refresh();
    }

    _resyncRows() {
        this._row?.resync();
        this._sections?.forEach(s => s.row.resync());
    }

    _onWorkspaceMenuSet() {
        if (this._workspaceIndicator.menu)
            this._menuManager.addMenu(this._workspaceIndicator.menu);
    }

    _updateWorkspaceIndicatorVisibility() {
        if (!this._workspaceIndicator)
            return;

        const severalWorkspaces = this._mutterSettings.get_boolean('dynamic-workspaces') ||
            global.workspace_manager.n_workspaces > 1;
        this._workspaceIndicator.visible = severalWorkspaces && this._hasWorkspaces;
    }

    // Hover previews. A "target" is anything that previews a workspace on
    // hover and takes dropped windows: a section, a workspace's band in
    // the window list, or a switcher thumbnail. Each has .workspace,
    // .hover and .buttons

    _targets() {
        const thumbnails = this._workspaceIndicator?._thumbnails?._thumbnailsBox
            ?.get_children() ?? [];
        return [...this._sections ?? [], ...this._row?.bands ?? [], ...thumbnails];
    }

    _hoveredTarget() {
        return this._targets().find(t => t.hover) ?? null;
    }

    // Called by switcher thumbnails, which live in workspaceIndicator.js
    _lanesOnTargetHover(target) {
        this._onSectionHover(target);
    }

    _lanesOnTargetDragOver(target, source) {
        if (source?.metaWindow)
            this._setDragHoverSection(target);
    }

    // The switcher thumbnails highlight the window selected in GNOME's
    // window switching, else the hovered button's window, or while a
    // preview is open, whatever the preview highlights
    _syncThumbnailHighlight() {
        const selected = this._switcher.window;
        const windows = (selected ? [selected] : null) ?? this._hoveredWindows ??
            (this._previewSection ? this._preview.highlight : null);
        this._workspaceIndicator?.setHighlight(windows);
    }

    _onButtonHover(target, windows) {
        this._hoveredWindows = windows;
        this._syncThumbnailHighlight();
        if (!target)
            return;

        // the last button hovered stays highlighted after the pointer
        // leaves it, e.g. heading up into the preview
        if (windows && this._previewSection === target) {
            this._preview.setHighlight(windows);
            this._syncThumbnailHighlight();
        }

        // after a click, moving on to another button brings the preview
        // back
        if (windows && this._suppressedSection === target &&
            !sameWindows(windows, this._suppressedWindows)) {
            this._suppressedSection = null;
            this._scheduleOpen(target);
        }
    }

    _onSectionHover(section) {
        // the band for windows on every workspace has nothing to preview
        if (!section.workspace)
            return;

        if (section.hover) {
            this._clearCloseTimeout();
            if (this._suppressedSection === section)
                return;
            if (this._previewSection)
                this._showPreview(section);
            else
                this._scheduleOpen(section);
        } else {
            if (this._suppressedSection === section)
                this._suppressedSection = null;
            this._clearOpenTimeout();
            if (this._previewSection)
                this._scheduleClose();
        }
    }

    _scheduleOpen(section) {
        this._clearOpenTimeout();
        const delay = this._settings.get_int('preview-delay');
        this._openTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._openTimeoutId = 0;
            if (section.hover && !this._menuManager.activeMenu)
                this._showPreview(section);
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleClose() {
        if (this._closeTimeoutId)
            return;
        this._closeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PREVIEW_CLOSE_DELAY, () => {
            this._closeTimeoutId = 0;
            if (!this._preview?.hover && !this._windowDragActive &&
                !this._hoveredTarget())
                this._hidePreview();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearOpenTimeout() {
        if (this._openTimeoutId)
            GLib.source_remove(this._openTimeoutId);
        this._openTimeoutId = 0;
    }

    _clearCloseTimeout() {
        if (this._closeTimeoutId)
            GLib.source_remove(this._closeTimeoutId);
        this._closeTimeoutId = 0;
    }

    _ensurePreview() {
        if (this._preview)
            return;

        this._preview = new WorkspacePreview(this._monitor, this._backgrounds);
        this._preview.setColorsEnabled(this._settings.get_boolean('color-workspaces'));
        this._preview.connect('notify::hover', () => {
            if (this._preview.hover)
                this._clearCloseTimeout();
            else
                this._scheduleClose();
        });
        this._preview.connect('drag-begin', () => this._onWindowDragBegin());
        this._preview.connect('drag-end', () => this._onWindowDragEnd());
        this._preview.connect('window-dropped',
            (preview, window, x, y, centre) => this._placeDroppedWindow(window, x, y, centre));
        this._preview.connect('activated', () => {
            this._suppressedSection = this._hoveredTarget();
            this._suppressedWindows = null;
            this._hidePreview();
        });
    }

    _showPreview(section) {
        this._ensurePreview();
        this._previewSection = section;
        const [, barY] = this.get_transformed_position();
        this._preview.open(section.workspace, section, barY);

        // the button the pointer is on picks the highlighted window
        const hovered = section.buttons.find(b => b.hovered);
        if (hovered)
            this._preview.setHighlight(hovered.getWindowList());
        this._syncThumbnailHighlight();
    }

    _hidePreview() {
        this._clearOpenTimeout();
        this._clearCloseTimeout();
        this._previewSection = null;
        this._preview?.close();
        this._syncThumbnailHighlight();
    }

    _onCapturedEvent(actor, event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS ||
            type === Clutter.EventType.TOUCH_BEGIN) {
            // a click means the user has made their choice; don't pop the
            // preview back up until they move to another button or section
            this._suppressedSection = this._hoveredTarget();
            this._suppressedWindows = this._hoveredWindows;
            this._hidePreview();
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // Only presses that nothing else handled (buttons, the workspace
    // switcher) reach the bar itself
    vfunc_button_press_event(event) {
        this._secondaryPressed = event.get_button() === Clutter.BUTTON_SECONDARY &&
            this._onEmptySpace(event);
        return this._secondaryPressed ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_release_event(event) {
        if (!this._secondaryPressed)
            return Clutter.EVENT_PROPAGATE;

        this._secondaryPressed = false;
        if (event.get_button() === Clutter.BUTTON_SECONDARY && this._onEmptySpace(event))
            this._openLayoutMenu(event);
        return Clutter.EVENT_STOP;
    }

    _onEmptySpace(event) {
        const target = global.stage.get_event_actor(event);
        return !findAncestor(target, this, a =>
            a instanceof St.Button || a === this._workspaceIndicator);
    }

    // Right-click on empty space: switch layout or open settings
    _openLayoutMenu(event) {
        if (!this._menuAnchor) {
            this._menuAnchor = new St.Widget({width: 1});
            Main.uiGroup.add_child(this._menuAnchor);

            this._layoutMenu = new PopupMenu.PopupMenu(this._menuAnchor, 0.5, St.Side.BOTTOM);
            this._layoutMenu.actor.hide();
            Main.uiGroup.add_child(this._layoutMenu.actor);
            this._menuManager.addMenu(this._layoutMenu);

            this._sectionsItem = this._layoutMenu.addAction(_('Workspace lanes'),
                () => this._settings.set_string('layout', 'sections'));
            this._listItem = this._layoutMenu.addAction(_('Window list'),
                () => this._settings.set_string('layout', 'list'));
            this._layoutMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._layoutMenu.addAction(_('Settings'),
                () => this._extension.openPreferences());
        }

        const layout = this._settings.get_string('layout');
        this._sectionsItem.setOrnament(layout === 'sections'
            ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        this._listItem.setOrnament(layout === 'list'
            ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);

        const [x] = event.get_coords();
        const [, y] = this.get_transformed_position();
        this._menuAnchor.set_position(Math.round(x), y);
        this._menuAnchor.height = this.height;
        this._layoutMenu.open();
    }

    _onScrollEvent(actor, event) {
        if (this._sections)
            return Main.wm.handleWorkspaceScroll(event);

        const direction = event.get_scroll_direction();
        let diff = 0;
        if (direction === Clutter.ScrollDirection.DOWN)
            diff = 1;
        else if (direction === Clutter.ScrollDirection.UP)
            diff = -1;
        else
            return Clutter.EVENT_PROPAGATE;

        const children = this._row?.buttons.filter(c => c.visible) ?? [];
        if (children.length === 0)
            return Clutter.EVENT_PROPAGATE;
        const active = children.findIndex(c => c.active);
        const newActive = Math.max(0, Math.min(active + diff, children.length - 1));
        children[newActive].activate();
        return Clutter.EVENT_STOP;
    }

    _updatePosition() {
        this.set_position(
            this._monitor.x,
            this._monitor.y + this._monitor.height - this.height);
    }

    _retrackChrome(options) {
        Main.layoutManager.untrackChrome(this);
        Main.layoutManager.trackChrome(this, options);
    }

    _slideIn() {
        this.visible = !this._monitor.inFullscreen;
        this.ease({
            translation_y: 0,
            duration: SLIDE_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _slideOut() {
        this.visible = !this._monitor.inFullscreen;
        this.ease({
            translation_y: this.height,
            duration: SLIDE_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this.hide(),
        });
    }

    _updateKeyboardAnchor() {
        const translationY = Main.overview.visible ? 0 : this.height;
        Main.layoutManager.keyboardBox.translation_y = -translationY;
    }

    // Drop a window's button anywhere on another workspace's section to
    // move the window there; it keeps its size and position

    _setupSectionDrops(section) {
        section._delegate = {
            handleDragOver: source => this._sectionDragOver(section, source),
            acceptDrop: source => this._sectionAcceptDrop(section, source),
        };
    }

    _canMoveToSection(window, section) {
        return !!window && !!section.workspace &&
            window.get_workspace() !== section.workspace;
    }

    _sectionDragOver(section, source) {
        if (source?.metaWindow && section.workspace)
            this._setDragHoverSection(section);

        if (!this._canMoveToSection(source?.metaWindow, section)) {
            this._setDropIndicator(null);
            return DND.DragMotionResult.CONTINUE;
        }

        this._setDropIndicator(section, 'lanes-drop-target');
        return DND.DragMotionResult.MOVE_DROP;
    }

    _sectionAcceptDrop(section, source) {
        const window = source?.metaWindow;
        if (!this._canMoveToSection(window, section))
            return false;

        this._setDropIndicator(null);
        moveWindowTo(window, section.workspace, this._monitor.index);
        return true;
    }

    _watchRowDrags(row) {
        row.connect('button-drag-begin', () => this._onWindowDragBegin());
        row.connect('button-drag-end', () => {
            this._setDropIndicator(null);
            this._onWindowDragEnd();
        });
    }

    _onWindowDragBegin() {
        this._windowDragActive = true;
        this._clearOpenTimeout();
        this._clearCloseTimeout();
    }

    _onWindowDragEnd() {
        this._windowDragActive = false;
        this._setDragHoverSection(null);
        // hover states settle once the drag's grab is gone
        if (this._previewSection)
            this._scheduleClose();
    }

    // Holding a dragged window over a section opens (or switches) the
    // preview to that workspace, so the window can be dropped at a spot
    _setDragHoverSection(section) {
        if (section === this._dragHoverSection)
            return;

        this._dragHoverSection = section;
        if (this._dragHoverTimeoutId)
            GLib.source_remove(this._dragHoverTimeoutId);
        this._dragHoverTimeoutId = 0;

        if (!section || section === this._previewSection)
            return;

        const delay = this._settings.get_int('preview-delay');
        this._dragHoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._dragHoverTimeoutId = 0;
            if (this._dragHoverSection === section)
                this._showPreview(section);
            return GLib.SOURCE_REMOVE;
        });
    }

    // A window dropped on the preview: move it to the preview's workspace,
    // with its frame at x, y (or centred there), kept on screen
    _placeDroppedWindow(window, x, y, centre) {
        const workspace = this._preview.workspace;
        if (!workspace)
            return;

        moveWindowTo(window, workspace, this._monitor.index);

        // maximized, tiled and fullscreen windows keep their placement
        if (window.maximized_horizontally || window.maximized_vertically ||
            window.is_fullscreen())
            return;

        const frame = window.get_frame_rect();
        if (centre) {
            x -= frame.width / 2;
            y -= frame.height / 2;
        }
        const area = workspace.get_work_area_for_monitor(this._monitor.index);
        x = Math.clamp(x, area.x, Math.max(area.x, area.x + area.width - frame.width));
        y = Math.clamp(y, area.y, Math.max(area.y, area.y + area.height - frame.height));
        window.move_frame(true, Math.round(x), Math.round(y));
    }

    _setDropIndicator(actor, styleClass = null) {
        const current = this._dropIndicator;
        if (current?.actor === actor && current?.styleClass === styleClass)
            return;

        current?.actor.remove_style_class_name(current.styleClass);
        this._dropIndicator = actor ? {actor, styleClass} : null;
        actor?.add_style_class_name(styleClass);
    }

    // Dragging a file over a window button raises that window; over an
    // empty section, switches to that workspace

    _monitorXdndDrag() {
        DND.addDragMonitor(this._xdndDragMonitor);
    }

    _stopMonitoringXdndDrag() {
        DND.removeDragMonitor(this._xdndDragMonitor);
        this._removeActivateTimeout();
    }

    _onXdndDragMotion(dragEvent) {
        if (Main.overview.visible || !this.contains(dragEvent.targetActor)) {
            this._removeActivateTimeout();
            return DND.DragMotionResult.CONTINUE;
        }

        const holder = findAncestor(dragEvent.targetActor, this,
            a => a.metaWindow || a instanceof Section || a instanceof WorkspaceBand);
        const target = holder?.metaWindow ?? holder?.workspace ?? null;
        if (!target || this._dndTarget === target)
            return DND.DragMotionResult.CONTINUE;

        this._removeActivateTimeout();

        this._dndTarget = target;
        this._dndTimeoutId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT,
            DND_ACTIVATE_TIMEOUT, () => {
                this._dndTimeoutId = 0;
                this._dndTarget?.activate(global.get_current_time());
                this._dndTarget = null;
            });

        return DND.DragMotionResult.CONTINUE;
    }

    _removeActivateTimeout() {
        if (this._dndTimeoutId)
            GLib.source_remove(this._dndTimeoutId);
        this._dndTimeoutId = 0;
        this._dndTarget = null;
    }

    _onDestroy() {
        this._hidePreview();
        if (this._preview) {
            Main.layoutManager.removeChrome(this._preview);
            this._preview.destroy();
            this._preview = null;
        }

        this._layoutMenu?.destroy();
        this._menuAnchor?.destroy();

        Main.ctrlAltTabManager.removeGroup(this);

        this._stopMonitoringXdndDrag();
        DND.removeDragMonitor(this._itemDragMonitor);
        this._setDragHoverSection(null);

        this._model.disconnectObject(this);
        this._switcher.disconnectObject(this);
        this._mutterSettings.disconnectObject(this);
        this._settings.disconnectObject(this);

        global.get_window_actors().forEach(a => a.metaWindow.set_icon_geometry(null));
    }
}

export default class WorkspaceLanesExtension extends Extension {
    constructor(metadata) {
        super(metadata);

        this._bars = null;
    }

    enable() {
        this._model = new TaskbarModel();
        this._bars = [];
        this._settings = this.getSettings();
        this._mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._colors = new WorkspaceColors(this._settings, this._interfaceSettings);
        this._lightShell = new LightShell(this._settings);
        this._backgrounds = new WorkspaceBackgrounds(this._settings, this._interfaceSettings);
        this._switcher = new SwitcherWatcher();

        this._settings.connectObject('changed::show-on-all-monitors',
            () => this._buildBars(), this);

        Main.layoutManager.connectObject('monitors-changed',
            () => this._buildBars(), this);

        this._buildBars();
    }

    _buildBars() {
        this._bars.forEach(bar => bar.destroy());
        this._bars = [];

        const showOnAllMonitors = this._settings.get_boolean('show-on-all-monitors');
        const shared = {
            model: this._model,
            settings: this._settings,
            mutterSettings: this._mutterSettings,
            switcher: this._switcher,
            backgrounds: this._backgrounds,
        };

        Main.layoutManager.monitors.forEach(monitor => {
            if (showOnAllMonitors || monitor === Main.layoutManager.primaryMonitor)
                this._bars.push(new Bar(shared, showOnAllMonitors, monitor, this));
        });
    }

    disable() {
        if (!this._bars)
            return;

        Main.layoutManager.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._settings = null;

        this._bars.forEach(bar => {
            bar.hide();
            bar.destroy();
        });
        this._bars = null;

        this._model.destroy();
        this._model = null;

        this._switcher.destroy();
        this._switcher = null;

        this._backgrounds.destroy();
        this._backgrounds = null;

        this._lightShell.destroy();
        this._lightShell = null;

        this._colors.destroy();
        this._colors = null;

        this._mutterSettings = null;
        this._interfaceSettings = null;
    }
}
