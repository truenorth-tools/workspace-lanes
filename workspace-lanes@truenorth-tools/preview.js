// SPDX-License-Identifier: GPL-2.0-or-later
//
// Hover preview of a whole workspace: wallpaper plus live window clones,
// laid out like the real screen. Click a window to jump to it, or the
// empty space to switch to the workspace.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Preview width as a fraction of the monitor width
const PREVIEW_FRACTION = 0.22;
const PREVIEW_GAP = 6;
const PREVIEW_MARGIN = 6;
const CLOSE_BUTTON_INSET = 4;

const FADE_TIME = 120;
const DIMMED_OPACITY = 165;

// Hover this long on a window with a cut-off title to see all of it
const FULL_TITLE_DELAY = 700;

const PREVIEW_WINDOW_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY,
];

export class WorkspacePreview extends St.BoxLayout {
    static [GObject.signals] = {
        'activated': {},
        'drag-begin': {},
        'drag-end': {},
        // window, x, y: dropped with its frame's top-left at stage x, y,
        // or centred on x, y when it has no position yet (centre: true)
        'window-dropped': {param_types: [
            Meta.Window.$gtype, GObject.TYPE_INT, GObject.TYPE_INT,
            GObject.TYPE_BOOLEAN,
        ]},
    };

    static {
        GObject.registerClass(this);
    }

    constructor(monitor, backgrounds) {
        super({
            style_class: 'lanes-preview',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            track_hover: true,
            visible: false,
            opacity: 0,
        });

        this._monitor = monitor;
        this._backgrounds = backgrounds;
        this._workspace = null;
        this._items = new Map();
        this._stacking = [];
        this._highlight = null;
        this._fullTitleTimeoutId = 0;
        this._dragging = false;
        this._dragItem = null;

        const width = Math.round(monitor.width * PREVIEW_FRACTION);
        const height = Math.round(monitor.height * PREVIEW_FRACTION);

        // fixed width, so a long title can't stretch the preview
        this._title = new St.Label({
            style_class: 'lanes-preview-title',
            width,
        });
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        this.add_child(this._title);

        // the frame and the close button are siblings, so clicking the
        // close button never also activates the window under it
        const stack = new St.Widget({layout_manager: new Clutter.FixedLayout()});
        this.add_child(stack);

        this._frame = new St.Button({
            style_class: 'lanes-preview-frame',
            button_mask: St.ButtonMask.ONE,
        });
        stack.add_child(this._frame);

        // drop a dragged window anywhere in the preview to put it there
        this._frame._delegate = {
            handleDragOver: source => source?.metaWindow && this._workspace
                ? DND.DragMotionResult.MOVE_DROP
                : DND.DragMotionResult.CONTINUE,
            acceptDrop: (source, dragActor) => this._acceptDrop(source, dragActor),
        };

        this._closeTarget = null;
        this._closeButton = new St.Button({
            style_class: 'lanes-preview-close',
            accessible_name: _('Close'),
            visible: false,
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14}),
        });
        this._closeButton.connect('clicked',
            () => this._closeTarget?.delete(global.get_current_time()));
        stack.add_child(this._closeButton);

        const holder = new Clutter.Actor({clip_to_allocation: true});
        this._frame.set_child(holder);

        // Laid out at full monitor size in stage coordinates, then scaled
        this._contents = new Clutter.Actor();
        holder.add_child(this._contents);

        this._stageGroup = new Clutter.Actor({
            translation_x: -monitor.x,
            translation_y: -monitor.y,
        });
        this._contents.add_child(this._stageGroup);

        this._bgGroup = new Meta.BackgroundGroup();
        this._stageGroup.add_child(this._bgGroup);
        this._bgManager = new Background.BackgroundManager({
            container: this._bgGroup,
            monitorIndex: monitor.index,
            vignette: false,
        });
        // in the previewed workspace's colour, like the real desktop
        backgrounds.track(this._bgManager, () => this._workspace?.index() ??
            global.workspace_manager.get_active_workspace_index());

        this._windowsGroup = new Clutter.Actor();
        this._stageGroup.add_child(this._windowsGroup);

        // the window being dragged out survives rebuilds here, hidden
        this._parking = new Clutter.Actor({visible: false});
        this._stageGroup.add_child(this._parking);

        this._previewWidth = width;
        this._previewHeight = height;
        holder.set_size(width, height);
        this._contents.set_size(monitor.width, monitor.height);
        this._contents.set_scale(width / monitor.width, height / monitor.height);

        this._frame.connect('clicked', () => {
            this._workspace?.activate(global.get_current_time());
            this.emit('activated');
        });

        this.connect('destroy', () => {
            this._clearTimeouts();
            this._fullTitle.destroy();
            this._bgManager.destroy();
            this._bgManager = null;
        });

        Main.layoutManager.addTopChrome(this);

        // shown above the preview after a long hover
        this._fullTitle = new St.Label({
            style_class: 'dash-label lanes-preview-full-title',
            visible: false,
        });
        this._fullTitle.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        Main.uiGroup.add_child(this._fullTitle);
    }

    get workspace() {
        return this._workspace;
    }

    get highlight() {
        return this._highlight;
    }

    setColorsEnabled(enabled) {
        if (enabled)
            this.add_style_class_name('lanes-colors');
        else
            this.remove_style_class_name('lanes-colors');
    }

    // Show the preview for @workspace, centred above @anchor
    open(workspace, anchor, barY) {
        if (this._wsClass)
            this.remove_style_class_name(this._wsClass);
        this._wsClass = `lanes-ws-${workspace.index()}`;
        this.add_style_class_name(this._wsClass);

        this._workspace = workspace;
        this._backgrounds.refresh(this._bgManager);
        this._rebuild();
        this._position(anchor, barY);

        if (this.visible && this.opacity === 255)
            return;

        this.remove_all_transitions();
        this.visible = true;
        this.ease({
            opacity: 255,
            duration: FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    close() {
        if (!this._workspace)
            return;

        this._workspace = null;
        this._clearTimeouts();
        this._hideFullTitle();
        this.remove_all_transitions();
        this.ease({
            opacity: 0,
            duration: FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this.visible = false;
                // drop the clones so nothing keeps painting off-screen
                this._windowsGroup.destroy_all_children();
                this._items.clear();
                this._stacking = [];
                this._highlight = null;
            },
        });
    }

    // True while a window is being dragged out of the preview
    get dragging() {
        return this._dragging;
    }

    // Catch up with the workspace's windows: move the clones if the same
    // windows are there, else start over
    refresh() {
        if (!this._workspace)
            return;

        const windows = this._windowsToShow();
        if (windows.length !== this._items.size || !windows.every(w => this._items.has(w))) {
            this._rebuild();
            return;
        }

        windows.forEach(w => this._placeItem(this._items.get(w), w));
        this._stacking = windows;
        this._restack();
        this._syncCloseButton();
    }

    _setDragging(dragging, item = null) {
        this._dragging = dragging;
        if (dragging) {
            this._dragItem = item;
        } else {
            if (this._dragItem?.get_parent() === this._parking)
                this._dragItem.destroy();
            this._dragItem = null;
        }
        this.emit(dragging ? 'drag-begin' : 'drag-end');
    }

    // Map a stage point over the preview to the real screen
    _toScreen(stageX, stageY) {
        const m = this._monitor;
        const [, x, y] = this._frame.transform_stage_point(stageX, stageY);
        return [
            Math.round(m.x + x * m.width / this._previewWidth),
            Math.round(m.y + y * m.height / this._previewHeight),
        ];
    }

    _acceptDrop(source, dragActor) {
        const window = source?.metaWindow;
        if (!window || !this._workspace)
            return false;

        if (dragActor instanceof Clutter.Clone) {
            // a window picked up in the preview: its scaled copy shows
            // exactly where it should land
            const [ax, ay] = dragActor.get_transformed_position();
            const [x, y] = this._toScreen(ax, ay);
            const frame = window.get_frame_rect();
            const buffer = window.get_buffer_rect();
            this.emit('window-dropped', window,
                x + frame.x - buffer.x, y + frame.y - buffer.y, false);
        } else {
            const [px, py] = global.get_pointer();
            const [x, y] = this._toScreen(px, py);
            this.emit('window-dropped', window, x, y, true);
        }
        return true;
    }

    // Bring @windows to the front at full opacity and dim the rest; null
    // clears the highlight. Only the taskbar sets it: moving the pointer
    // over the preview never changes it, so the chosen window stays put
    // on the way up to it
    setHighlight(windows) {
        this._applyHighlight(windows, true);
    }

    _applyHighlight(windows, animate) {
        const same = windows?.length === this._highlight?.length &&
            (windows ?? []).every(w => this._highlight.includes(w));
        this._highlight = windows;

        this._restack();
        const lit = w => !windows || windows.includes(w);
        this._items.forEach((item, w) => {
            const opacity = lit(w) ? 255 : DIMMED_OPACITY;
            if (animate) {
                item.ease({
                    opacity,
                    duration: FADE_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                item.remove_all_transitions();
                item.opacity = opacity;
            }
        });

        this._updateTitle();
        this._syncCloseButton();
        if (!same)
            this._scheduleFullTitle();
    }

    // Highlighted windows go on top, the rest keep their real stacking
    _restack() {
        const windows = this._highlight;
        const lit = w => !windows || windows.includes(w);
        const order = windows
            ? [...this._stacking.filter(w => !lit(w)), ...this._stacking.filter(lit)]
            : this._stacking;
        order.forEach((w, i) =>
            this._windowsGroup.set_child_at_index(this._items.get(w), i));
    }

    // Put the close button in the top-right corner of the highlighted
    // window, if exactly one is highlighted
    _syncCloseButton() {
        const window = this._highlight?.length === 1 ? this._highlight[0] : null;
        if (!window || !this._items.has(window) || !window.can_close()) {
            this._closeTarget = null;
            this._closeButton.visible = false;
            return;
        }

        const m = this._monitor;
        const frame = window.get_frame_rect();
        const scaleX = this._previewWidth / m.width;
        const scaleY = this._previewHeight / m.height;
        const right = Math.min((frame.x + frame.width - m.x) * scaleX, this._previewWidth);
        const top = Math.max((frame.y - m.y) * scaleY, 0);
        const [, buttonWidth] = this._closeButton.get_preferred_width(-1);

        this._closeTarget = window;
        this._closeButton.set_position(
            Math.round(Math.max(right - buttonWidth - CLOSE_BUTTON_INSET, 0)),
            Math.round(top + CLOSE_BUTTON_INSET));
        this._closeButton.visible = true;
    }

    _updateTitle() {
        const windows = this._highlight;
        if (windows?.length === 1 && windows[0].title)
            this._title.text = windows[0].title;
        else if (this._workspace)
            this._title.text = Meta.prefs_get_workspace_name(this._workspace.index());
    }

    _scheduleFullTitle() {
        this._hideFullTitle();
        if (this._fullTitleTimeoutId)
            GLib.source_remove(this._fullTitleTimeoutId);
        this._fullTitleTimeoutId = 0;

        if (this._highlight?.length !== 1)
            return;

        this._fullTitleTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            FULL_TITLE_DELAY, () => {
                this._fullTitleTimeoutId = 0;
                this._showFullTitle();
                return GLib.SOURCE_REMOVE;
            });
    }

    _showFullTitle() {
        if (!this._workspace || !this._title.clutter_text.get_layout().is_ellipsized())
            return;

        const m = this._monitor;
        const label = this._fullTitle;
        label.text = this._title.text;
        label.set({width: -1, opacity: 0, visible: true});

        const maxWidth = m.width - 2 * PREVIEW_MARGIN;
        const [, natWidth] = label.get_preferred_width(-1);
        const width = Math.min(natWidth, maxWidth);
        label.width = width;
        const [, height] = label.get_preferred_height(width);

        const [x, y] = this.get_transformed_position();
        const [previewWidth] = this.get_transformed_size();
        label.set_position(
            Math.round(Math.clamp(x + (previewWidth - width) / 2,
                m.x + PREVIEW_MARGIN, m.x + m.width - width - PREVIEW_MARGIN)),
            Math.round(y - height - PREVIEW_GAP));
        label.ease({
            opacity: 255,
            duration: FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _hideFullTitle() {
        this._fullTitle.remove_all_transitions();
        this._fullTitle.visible = false;
    }

    _clearTimeouts() {
        if (this._fullTitleTimeoutId)
            GLib.source_remove(this._fullTitleTimeoutId);
        this._fullTitleTimeoutId = 0;
    }

    _rebuild() {
        // keep whatever is highlighted across a rebuild, so windows
        // moving while you hover don't make it flash
        const highlight = this._highlight;

        // destroying the window being dragged would break the drag
        if (this._dragItem?.get_parent() === this._windowsGroup) {
            this._windowsGroup.remove_child(this._dragItem);
            this._parking.add_child(this._dragItem);
        }
        this._windowsGroup.destroy_all_children();
        this._items.clear();

        const m = this._monitor;
        this._stacking = [];
        for (const window of this._windowsToShow()) {
            const actor = window.get_compositor_private();

            // the button covers the visible frame, the clone includes shadows
            const item = new St.Button({
                style_class: 'lanes-preview-window',
                button_mask: St.ButtonMask.ONE,
            });
            const holder = new Clutter.Actor();
            item._clone = new Clutter.Clone({source: actor});
            holder.add_child(item._clone);
            item.set_child(holder);
            this._placeItem(item, window);

            item.connect('clicked', () => {
                window.activate(global.get_current_time());
                this.emit('activated');
            });

            // drag a window onto another workspace's section in the bar
            const scale = this._previewWidth / m.width;
            item._delegate = {
                metaWindow: window,
                getDragActor: () => {
                    const buffer = window.get_buffer_rect();
                    return new Clutter.Clone({
                        source: actor,
                        width: Math.round(buffer.width * scale),
                        height: Math.round(buffer.height * scale),
                    });
                },
                getDragActorSource: () => item,
            };
            const draggable = DND.makeDraggable(item);
            draggable.connect('drag-begin', () => {
                this._applyHighlight(null, true);
                this._setDragging(true, item);
            });
            draggable.connect('drag-end', () => this._setDragging(false));

            this._windowsGroup.add_child(item);
            this._items.set(window, item);
            this._stacking.push(window);
        }

        const kept = highlight?.filter(w => this._items.has(w));
        this._highlight = kept?.length ? kept : null;
        this._applyHighlight(this._highlight, false);
    }

    // The workspace's windows that show on this monitor, bottom to top
    _windowsToShow() {
        const m = this._monitor;
        const monitorRect = new Mtk.Rectangle({
            x: m.x, y: m.y, width: m.width, height: m.height,
        });
        const windows = this._workspace.list_windows().filter(w =>
            PREVIEW_WINDOW_TYPES.includes(w.get_window_type()) &&
            w.showing_on_its_workspace() &&
            w.get_compositor_private() &&
            w.get_frame_rect().overlap(monitorRect));
        return global.display.sort_windows_by_stacking(windows);
    }

    _placeItem(item, window) {
        const frame = window.get_frame_rect();
        const buffer = window.get_buffer_rect();
        item.set_position(frame.x, frame.y);
        item.set_size(frame.width, frame.height);
        item._clone.set_position(buffer.x - frame.x, buffer.y - frame.y);
        item._clone.set_size(buffer.width, buffer.height);
    }

    _position(anchor, barY) {
        const m = this._monitor;
        const [anchorX] = anchor.get_transformed_position();
        const [anchorWidth] = anchor.get_transformed_size();
        const [, width] = this.get_preferred_width(-1);
        const [, height] = this.get_preferred_height(width);

        const x = Math.clamp(
            anchorX + (anchorWidth - width) / 2,
            m.x + PREVIEW_MARGIN,
            m.x + m.width - width - PREVIEW_MARGIN);
        const y = barY - height - PREVIEW_GAP;
        this.set_position(Math.round(x), Math.round(y));
    }
}
