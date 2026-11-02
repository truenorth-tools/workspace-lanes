// SPDX-License-Identifier: GPL-2.0-or-later
//
// Lanes exposé: click the current workspace's lane (or switcher thumbnail)
// again to spread its windows out over the workspace's own wallpaper, in
// the order the lane shows them. Click a window to bring it forward, or
// the lane again (or Esc, or empty space) to leave. Scrolling switches
// workspace, as it does on the taskbar, and the exposé follows.
//
// It is separate from GNOME's overview, which Super still opens: the
// exposé steps aside whenever the overview shows.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const OPEN_TIME = 250;
const STEP_TIME = 220;

// Logical px
const GRID_GAP = 32;
const GRID_MARGIN = 40;
const RING_WIDTH = 4;
const TITLE_GAP = 10;

// Windows are never shown larger than this in the grid, so even a lone
// window visibly steps back
const GRID_MAX_SCALE = 0.85;

const BACKGROUND_BLUR = 40;
const BACKGROUND_BRIGHTNESS = 0.7;

// A workspace switch can move focus; that alone shouldn't close the exposé
const SWITCH_FOCUS_GRACE = 600; // ms

const SHOWN_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY,
];

const Mode = {
    CLOSED: 0,
    OPEN: 1,
};

// Left to right, then top to bottom, then oldest first: the lane's order
function compareSpatial(a, b) {
    const ra = a.get_frame_rect();
    const rb = b.get_frame_rect();
    return ra.x - rb.x ||
        ra.y - rb.y ||
        a.get_stable_sequence() - b.get_stable_sequence();
}

// Where each window goes in the grid: {cx, cy, scale} in the order
// given, which fills rows left to right, top to bottom. Tries every row
// count and keeps the one that shows the windows largest.
function gridSlots(sizes, area, gap) {
    const n = sizes.length;
    let best = null;
    for (let rows = 1; rows <= n; rows++) {
        const cols = Math.ceil(n / rows);
        const chunks = [];
        for (let i = 0; i < n; i += cols)
            chunks.push(sizes.slice(i, i + cols));
        // ceil can leave fewer rows than asked for; that count gets its
        // own turn
        if (chunks.length !== rows)
            continue;

        const rowHeight = (area.height - gap * (rows - 1)) / rows;
        let scale = GRID_MAX_SCALE;
        for (const chunk of chunks) {
            const width = chunk.reduce((sum, s) => sum + s.width, 0);
            const height = Math.max(...chunk.map(s => s.height));
            const room = area.width - gap * (chunk.length - 1);
            scale = Math.min(scale, rowHeight / height, room / width);
        }
        if (!best || scale > best.scale * 1.0001)
            best = {scale, chunks};
    }

    const {scale, chunks} = best;
    const heights = chunks.map(c => Math.max(...c.map(s => s.height)) * scale);
    const total = heights.reduce((a, b) => a + b, 0) + gap * (chunks.length - 1);
    let y = area.y + (area.height - total) / 2;

    const slots = [];
    chunks.forEach((chunk, row) => {
        const width = chunk.reduce((sum, s) => sum + s.width * scale, 0) +
            gap * (chunk.length - 1);
        let x = area.x + (area.width - width) / 2;
        for (const s of chunk) {
            slots.push({
                cx: x + s.width * scale / 2,
                cy: y + heights[row] / 2,
                scale,
            });
            x += s.width * scale + gap;
        }
        y += heights[row] + gap;
    });
    return slots;
}

export class LanesExpose extends St.Widget {
    static [GObject.signals] = {
        'opened': {},
        'closed': {},
    };

    static {
        GObject.registerClass(this);
    }

    constructor(monitor, backgrounds) {
        super({
            style_class: 'lanes-expose',
            reactive: true,
            visible: false,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        });

        this._monitor = monitor;
        this._backgrounds = backgrounds;
        this._mode = Mode.CLOSED;
        this._closing = false;
        this._workspace = null;
        this._windows = [];
        this._items = new Map();
        this._selected = null;
        this._grab = null;
        this._switchedAt = 0;
        this._wsClass = null;
        this._generation = 0;
        this._focusIdleId = 0;

        // the workspace's own wallpaper, blurred and darkened
        this._backdrop = new Clutter.Actor({
            width: monitor.width,
            height: monitor.height,
        });
        this.add_child(this._backdrop);
        const stageGroup = new Clutter.Actor({
            translation_x: -monitor.x,
            translation_y: -monitor.y,
        });
        this._backdrop.add_child(stageGroup);
        this._bgGroup = new Meta.BackgroundGroup();
        stageGroup.add_child(this._bgGroup);
        this._bgManager = new Background.BackgroundManager({
            container: this._bgGroup,
            monitorIndex: monitor.index,
            vignette: false,
        });
        backgrounds.track(this._bgManager, () => this._workspace?.index() ??
            global.workspace_manager.get_active_workspace_index());
        this._backdrop.add_effect(new Shell.BlurEffect({
            radius: BACKGROUND_BLUR,
            brightness: BACKGROUND_BRIGHTNESS,
            mode: Shell.BlurMode.ACTOR,
        }));

        // tinted in the workspace's colour by the generated stylesheet
        this._tint = new St.Widget({
            style_class: 'lanes-expose-tint',
            width: monitor.width,
            height: monitor.height,
        });
        this.add_child(this._tint);

        this._heading = new St.Label({style_class: 'lanes-expose-heading'});
        this.add_child(this._heading);
        this._hint = new St.Label({style_class: 'lanes-expose-hint'});
        this.add_child(this._hint);

        this._windowsGroup = new Clutter.Actor();
        this.add_child(this._windowsGroup);

        this._ring = new St.Widget({
            style_class: 'lanes-expose-ring',
            visible: false,
        });
        this.add_child(this._ring);

        this._title = new St.Label({
            style_class: 'lanes-expose-title',
            visible: false,
        });
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        this.add_child(this._title);

        // over the windows, under the top bar and taskbar, which stay
        // usable: clicking the lane again is how you leave
        Main.uiGroup.add_child(this);
        Main.uiGroup.set_child_below_sibling(this, Main.layoutManager.panelBox);

        // GNOME's overview (Super, Activities) takes over from the exposé
        Main.overview.connectObject('showing', () => this.close(false), this);
        Main.sessionMode.connectObject('updated', () => this.close(false), this);
        global.workspace_manager.connectObject('active-workspace-changed', () => {
            this._switchedAt = GLib.get_monotonic_time();
            if (this.isOpen)
                this._follow(global.workspace_manager.get_active_workspace());
        }, this);
        global.display.connectObject('notify::focus-window',
            () => this._onFocusChanged(), this);

        this.connect('destroy', () => {
            if (this._focusIdleId)
                GLib.source_remove(this._focusIdleId);
            this._focusIdleId = 0;
            this._releaseGrab();
            this._bgManager.destroy();
            this._bgManager = null;
        });
    }

    get isOpen() {
        return this._mode !== Mode.CLOSED && !this._closing;
    }

    get workspace() {
        return this.isOpen ? this._workspace : null;
    }

    setColorsEnabled(enabled) {
        if (enabled)
            this.add_style_class_name('lanes-colors');
        else
            this.remove_style_class_name('lanes-colors');
    }

    toggle(workspace) {
        if (this.isOpen && this._workspace === workspace)
            this.close();
        else
            this.open(workspace);
    }

    open(workspace) {
        if (Main.overview.visible)
            return;

        if (this.isOpen) {
            this._follow(workspace);
            return;
        }

        // a close still animating is cut short
        this._generation++;
        this.remove_all_transitions();
        this._windowsGroup.destroy_all_children();
        this._items.clear();
        this._closing = false;
        this._mode = Mode.OPEN;
        this._setWorkspace(workspace);

        // the keyboard comes to the exposé; the shell's chrome (top bar,
        // taskbar) stays usable, and so do GNOME's shortcuts, Super
        // included
        this._grab = Main.pushModal(Main.uiGroup, {actionMode: Shell.ActionMode.NORMAL});
        global.stage.set_key_focus(this);

        this.visible = true;
        this._backdrop.opacity = 0;
        this._tint.opacity = 0;
        this._fadeChrome(255);

        this._sync(true);
        this.emit('opened');
    }

    // Leave the exposé. Windows glide back to where they really are,
    // unless @animate is false
    close(animate = true) {
        if (this._mode === Mode.CLOSED || this._closing)
            return;

        this._closing = true;
        this._releaseGrab();
        this._ring.visible = false;
        this._title.visible = false;
        this.emit('closed');

        const generation = ++this._generation;
        const done = () => {
            if (generation !== this._generation)
                return;
            this.visible = false;
            this._windowsGroup.destroy_all_children();
            this._items.clear();
            this._windows = [];
            this._selected = null;
            this._mode = Mode.CLOSED;
            this._closing = false;
        };

        if (!animate) {
            this.remove_all_transitions();
            done();
            return;
        }

        // the window being brought forward lands on top
        const focus = global.display.focus_window;
        const top = this._items.get(focus) ?? this._items.get(focus?.get_transient_for());
        if (top)
            this._windowsGroup.set_child_above_sibling(top, null);

        this._fadeChrome(0);
        let pending = this._items.size;
        if (!pending) {
            GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, OPEN_TIME, done);
            return;
        }
        for (const [window, item] of this._items) {
            this._moveItem(item, this._realSlot(window), OPEN_TIME, () => {
                if (--pending === 0)
                    done();
            });
        }
    }

    // Catch up with windows opening, closing or moving on the workspace
    refresh() {
        if (!this.isOpen)
            return;

        const windows = this._windowsToShow();
        if (windows.length === this._windows.length &&
            windows.every((w, i) => w === this._windows[i]))
            return;

        this._sync(false);
    }

    _setWorkspace(workspace) {
        if (this._wsClass)
            this.remove_style_class_name(this._wsClass);
        this._workspace = workspace;
        this._wsClass = `lanes-ws-${workspace.index()}`;
        this.add_style_class_name(this._wsClass);
        this._backgrounds.refresh(this._bgManager);
        this._heading.text = Meta.prefs_get_workspace_name(workspace.index());
        this._placeHeading();
    }

    // Switched workspace while open (by the taskbar, the keyboard or a
    // window being picked elsewhere): show the new one's windows
    _follow(workspace) {
        if (workspace === this._workspace)
            return;

        this._setWorkspace(workspace);
        this._windowsGroup.destroy_all_children();
        this._items.clear();
        this._selected = null;
        this._mode = Mode.OPEN;
        this._sync(true);
    }

    _releaseGrab() {
        if (!this._grab)
            return;
        Main.popModal(this._grab);
        this._grab = null;
    }

    _fadeChrome(opacity) {
        for (const actor of [this._backdrop, this._tint, this._heading, this._hint]) {
            actor.ease({
                opacity,
                duration: OPEN_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _windowsToShow() {
        const index = this._monitor.index;
        return this._workspace.list_windows().filter(w =>
            SHOWN_TYPES.includes(w.get_window_type()) &&
            !w.skip_taskbar &&
            !w.minimized &&
            !w.is_attached_dialog() &&
            w.get_monitor() === index &&
            w.get_compositor_private()).sort(compareSpatial);
    }

    // Rebuild the items for the current windows, then lay them out. New
    // items start where their window really is when @fromReal is set
    _sync(fromReal) {
        const windows = this._windowsToShow();
        for (const [window, item] of this._items) {
            if (!windows.includes(window)) {
                item.destroy();
                this._items.delete(window);
            }
        }
        for (const window of windows) {
            if (!this._items.has(window))
                this._items.set(window, this._createItem(window, fromReal));
        }
        this._windows = windows;

        if (!windows.includes(this._selected))
            this._selected = null;
        if (this._selected === null && fromReal) {
            const focus = global.display.focus_window;
            this._selected = windows.find(w => w === focus || w === focus?.get_transient_for()) ?? null;
        }

        this._updateHint();
        this._layout(OPEN_TIME);
    }

    _createItem(window, fromReal) {
        const actor = window.get_compositor_private();
        const frame = window.get_frame_rect();
        const buffer = window.get_buffer_rect();

        // the button covers the visible frame, the clone includes shadows
        const item = new St.Button({
            style_class: 'lanes-expose-window',
            button_mask: St.ButtonMask.ONE,
            reactive: true,
            track_hover: true,
            width: frame.width,
            height: frame.height,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        const holder = new Clutter.Actor();
        holder.add_child(new Clutter.Clone({
            source: actor,
            x: buffer.x - frame.x,
            y: buffer.y - frame.y,
            width: buffer.width,
            height: buffer.height,
        }));
        item.set_child(holder);
        item.metaWindow = window;

        item.connect('clicked', () => this._pick(window));
        item.connect('notify::hover', () => {
            if (item.hover && this.isOpen)
                this._select(window);
        });

        const slot = fromReal ? this._realSlot(window) : null;
        if (slot) {
            this._applySlot(item, slot);
        } else {
            // a window that turned up while open grows in at its place
            item.opacity = 0;
            item.set_scale(0.5, 0.5);
            item._fresh = true;
        }
        this._windowsGroup.add_child(item);
        return item;
    }

    _scale() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    // The work area, inside the top bar and the taskbar, in our own
    // coordinates
    _area() {
        const work = this._workspace.get_work_area_for_monitor(this._monitor.index);
        const margin = GRID_MARGIN * this._scale();
        const [, headingHeight] = this._heading.get_preferred_height(-1);
        const [, hintHeight] = this._hint.get_preferred_height(-1);
        const headingRoom = margin / 2 + headingHeight + hintHeight + margin / 2;
        return {
            x: work.x - this._monitor.x + margin,
            y: work.y - this._monitor.y + headingRoom,
            width: work.width - 2 * margin,
            height: work.height - headingRoom - margin,
        };
    }

    // Where the window really is: what the exposé opens from and closes to
    _realSlot(window) {
        const frame = window.get_frame_rect();
        return {
            cx: frame.x - this._monitor.x + frame.width / 2,
            cy: frame.y - this._monitor.y + frame.height / 2,
            scale: 1,
            opacity: 255,
        };
    }

    _layout(duration) {
        if (this._windows.length === 0) {
            this._ring.visible = false;
            this._title.visible = false;
            return;
        }

        const slots = gridSlots(this._windows.map(w => w.get_frame_rect()),
            this._area(), GRID_GAP * this._scale())
            .map(slot => ({...slot, opacity: 255}));
        this._slots = new Map(this._windows.map((w, i) => [w, slots[i]]));

        this._windows.forEach(w => {
            const item = this._items.get(w);
            const slot = this._slots.get(w);
            if (item._fresh) {
                item.set_position(Math.round(slot.cx - item.width / 2),
                    Math.round(slot.cy - item.height / 2));
                delete item._fresh;
            }
            this._moveItem(item, slot, duration);
        });
        this._syncSelection(duration);
    }

    _applySlot(item, slot) {
        item.set({
            x: Math.round(slot.cx - item.width / 2),
            y: Math.round(slot.cy - item.height / 2),
            scale_x: slot.scale,
            scale_y: slot.scale,
            opacity: slot.opacity,
        });
    }

    _moveItem(item, slot, duration, onComplete) {
        item.remove_all_transitions();
        item.ease({
            x: Math.round(slot.cx - item.width / 2),
            y: Math.round(slot.cy - item.height / 2),
            scale_x: slot.scale,
            scale_y: slot.scale,
            opacity: slot.opacity,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: onComplete,
        });
    }

    // The ring and title follow the selected window
    _syncSelection(duration) {
        const window = this._selected;
        const slot = window ? this._slots?.get(window) : null;
        if (!slot) {
            this._ring.visible = false;
            this._title.visible = false;
            return;
        }

        const frame = window.get_frame_rect();
        const width = frame.width * slot.scale;
        const height = frame.height * slot.scale;
        const scale = this._scale();

        const pad = RING_WIDTH * scale;
        const ring = {
            x: Math.round(slot.cx - width / 2 - pad),
            y: Math.round(slot.cy - height / 2 - pad),
            width: Math.round(width + 2 * pad),
            height: Math.round(height + 2 * pad),
        };
        if (!this._ring.visible) {
            this._ring.set(ring);
            this._ring.opacity = 0;
            this._ring.visible = true;
        }
        this._ring.ease({
            ...ring,
            opacity: 255,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });

        this._title.text = window.title ?? '';
        this._title.visible = true;
        const maxWidth = Math.max(width, 200 * scale);
        this._title.set_width(-1);
        const [, natWidth] = this._title.get_preferred_width(-1);
        const titleWidth = Math.min(natWidth, maxWidth);
        this._title.set_width(titleWidth);
        const [, titleHeight] = this._title.get_preferred_height(titleWidth);
        const area = this._area();
        const top = slot.cy + height / 2 + TITLE_GAP * scale;
        this._title.set_position(
            Math.round(Math.clamp(slot.cx - titleWidth / 2, 0, this.width - titleWidth)),
            Math.round(Math.min(top, area.y + area.height + GRID_MARGIN * scale - titleHeight)));
    }

    _select(window) {
        if (this._selected === window)
            return;
        this._selected = window;
        this._syncSelection(STEP_TIME / 2);
    }

    _updateHint() {
        if (this._windows.length === 0)
            this._hint.text = _('No windows on this workspace');
        else
            this._hint.text = _('Click a window to bring it forward · Scroll to switch workspace');
        this._placeHeading();
    }

    _placeHeading() {
        const work = this._workspace.get_work_area_for_monitor(this._monitor.index);
        const margin = GRID_MARGIN * this._scale() / 2;
        const top = work.y - this._monitor.y + margin;
        const middle = work.x - this._monitor.x + work.width / 2;
        const [, headingWidth] = this._heading.get_preferred_width(-1);
        const [, headingHeight] = this._heading.get_preferred_height(-1);
        const [, hintWidth] = this._hint.get_preferred_width(-1);
        this._heading.set_position(Math.round(middle - headingWidth / 2), Math.round(top));
        this._hint.set_position(Math.round(middle - hintWidth / 2),
            Math.round(top + headingHeight));
    }

    // Bring @window forward and leave
    _pick(window) {
        if (!this.isOpen)
            return;
        Main.activateWindow(window);
        this.close();
    }

    // Move the selection @diff windows on
    _step(diff) {
        const n = this._windows.length;
        if (n === 0)
            return;

        const index = this._windows.indexOf(this._selected);
        const next = index < 0
            ? (diff > 0 ? 0 : n - 1)
            : Math.clamp(index + diff, 0, n - 1);
        this._select(this._windows[next]);
    }

    // Up and down move by a row in the grid
    _rowStep(diff) {
        if (!this._selected) {
            this._step(diff);
            return;
        }

        const slot = this._slots.get(this._selected);
        const candidates = this._windows
            .map(w => [w, this._slots.get(w)])
            .filter(([, s]) => diff > 0 ? s.cy > slot.cy + 1 : s.cy < slot.cy - 1);
        if (candidates.length === 0)
            return;
        const rowY = diff > 0
            ? Math.min(...candidates.map(([, s]) => s.cy))
            : Math.max(...candidates.map(([, s]) => s.cy));
        const [nearest] = candidates
            .filter(([, s]) => Math.abs(s.cy - rowY) < 1)
            .sort((a, b) => Math.abs(a[1].cx - slot.cx) - Math.abs(b[1].cx - slot.cx));
        this._select(nearest[0]);
    }

    // Scrolling switches workspace, as on the taskbar; the exposé follows
    vfunc_scroll_event(event) {
        if (!this.isOpen)
            return Clutter.EVENT_PROPAGATE;
        Main.wm.handleWorkspaceScroll(event);
        return Clutter.EVENT_STOP;
    }

    // Empty space: leave the exposé
    vfunc_button_press_event(event) {
        if (!this.isOpen)
            return Clutter.EVENT_PROPAGATE;
        // presses on a window still reach us (St.Button uses a gesture),
        // but the window handles them
        this._pressedEmpty = !this._windowsGroup.contains(global.stage.get_event_actor(event));
        return this._pressedEmpty ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_release_event(event) {
        if (!this.isOpen || !this._pressedEmpty)
            return Clutter.EVENT_PROPAGATE;
        this._pressedEmpty = false;
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_STOP;

        this.close();
        return Clutter.EVENT_STOP;
    }

    vfunc_key_press_event(event) {
        if (!this.isOpen)
            return Clutter.EVENT_PROPAGATE;

        switch (event.get_key_symbol()) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_space: {
            if (this._selected)
                this._pick(this._selected);
            return Clutter.EVENT_STOP;
        }
        case Clutter.KEY_Right:
        case Clutter.KEY_Tab:
            this._step(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Left:
        case Clutter.KEY_ISO_Left_Tab:
            this._step(-1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
            this._rowStep(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
            this._rowStep(-1);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // Something else brought a window forward (the taskbar, Alt+Tab, a
    // new window): the exposé has done its job
    _onFocusChanged() {
        // looked at once things settle, as a workspace switch announces
        // itself and moves focus in either order
        if (!this.isOpen || this._focusIdleId)
            return;
        this._focusIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._focusIdleId = 0;
            this._checkFocus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _checkFocus() {
        if (!this.isOpen)
            return;
        const window = global.display.focus_window;
        if (!window)
            return;
        // focus moving because the workspace changed isn't a choice
        const sinceSwitch = (GLib.get_monotonic_time() - this._switchedAt) / 1000;
        if (sinceSwitch < SWITCH_FOCUS_GRACE)
            return;
        this.close();
    }
}
