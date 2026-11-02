// SPDX-FileCopyrightText: 2011 Vamsi Krishna Brahmajosyula <vamsikrishna.brahmajosyula@gmail.com>
// SPDX-FileCopyrightText: 2011 Giovanni Campagna <gcampagna@src.gnome.org>
// SPDX-FileCopyrightText: 2013 Debarshi Ray <debarshir@gnome.org>
// SPDX-FileCopyrightText: 2013 Florian Müllner <fmuellner@gnome.org>
//
// SPDX-License-Identifier: GPL-2.0-or-later
//
// The applications menu at the start of the taskbar, like a Start menu:
// favourites, then apps by category. Adapted from GNOME Shell Extensions'
// Apps Menu, which sits on the top bar. Here it opens upwards from the
// bottom-left corner. Left out: its Alt+F1 shortcut (its own setting,
// which would clash while Apps Menu is also on) and dragging apps onto a
// desktop-icons desktop.

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GMenu from 'gi://GMenu';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const APPLICATION_ICON_SIZE = 32;
const HORIZ_FACTOR = 5;
// Extra height for the menu, so the app list is taller than the
// categories. It goes above the categories, keeping them right above the
// button, and leaves room there for something else (the header box).
const MENU_HEIGHT_OFFSET = 132;
const NAVIGATION_REGION_OVERSHOOT = 50;

class ApplicationMenuItem extends PopupMenu.PopupBaseMenuItem {
    static {
        GObject.registerClass(this);
    }

    constructor(button, app) {
        super();
        this._app = app;
        this._button = button;

        this._icon = app.create_icon_texture(APPLICATION_ICON_SIZE);
        this._icon.style_class = 'icon-dropshadow';
        this.add_child(this._icon);

        const appLabel = new St.Label({
            text: app.get_name(),
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(appLabel);
        this.label_actor = appLabel;

        this.connect('notify::active', this._onActiveChanged.bind(this));
    }

    activate(event) {
        this._app.open_new_window(-1);
        this._button.selectCategory(null);
        this._button.menu.toggle();
        super.activate(event);

        Main.overview.hide();
    }

    _onActiveChanged() {
        if (!this.active)
            return;

        this._button.scrollToButton(this);
    }
}

class CategoryMenuItem extends PopupMenu.PopupBaseMenuItem {
    static {
        GObject.registerClass(this);
    }

    constructor(button, category) {
        super();
        this._category = category;
        this._button = button;

        this._oldX = -1;
        this._oldY = -1;

        const name = this._category ? this._category.get_name() : _('Favorites');

        const label = new St.Label({text: name});
        this.add_child(label);
        this.actor.label_actor = label;

        this.connect('motion-event', this._onMotionEvent.bind(this));
        this.connect('notify::active', this._onActiveChanged.bind(this));
    }

    activate(event) {
        this._button.selectCategory(this._category);
        this._button.scrollToCatButton(this);
        super.activate(event);
    }

    // Moving diagonally from a category towards its apps shouldn't switch
    // category on the way
    _isNavigatingSubmenu([x, y]) {
        const [posX, posY] = this.get_transformed_position();

        if (this._oldX === -1) {
            this._oldX = x;
            this._oldY = y;
            return true;
        }

        const deltaX = Math.abs(x - this._oldX);
        const deltaY = Math.abs(y - this._oldY);

        this._oldX = x;
        this._oldY = y;

        // If it lies outside the x-coordinates then it is definitely outside.
        if (posX > x || posX + this.width < x)
            return false;

        // If it lies inside the menu item then it is definitely inside.
        if (posY <= y && posY + this.height >= y)
            return true;

        // We want the keep-up triangle only if the movement is more
        // horizontal than vertical.
        if (deltaX * HORIZ_FACTOR < deltaY)
            return false;

        // Check whether the point lies inside triangle ABC, and a similar
        // triangle on the other side of the menu item.
        //
        //   +---------------------+
        //   | menu item           |
        // A +---------------------+ C
        //              P          |
        //                         B

        // Ensure that the point P always lies below line AC so that we can
        // only check for triangle ABC.
        if (posY > y) {
            const offset = posY - y;
            y = posY + this.height + offset;
        }

        // Ensure that A is (0, 0).
        x -= posX;
        y -= posY + this.height;

        // Check which side of line AB the point P lies on by taking the
        // cross-product of AB and AP.
        return this.width * y - NAVIGATION_REGION_OVERSHOOT * x <= 0;
    }

    _onMotionEvent(actor, event) {
        if (!this._grab) {
            this._oldX = -1;
            this._oldY = -1;
            this._grab = global.stage.grab(this);
        }
        this.hover = true;

        if (this._isNavigatingSubmenu(event.get_coords()))
            return Clutter.EVENT_STOP;

        this.hover = false;
        this._releaseGrab();

        const targetActor = global.stage.get_event_actor(event);
        if (targetActor instanceof St.Widget)
            targetActor.sync_hover();

        return Clutter.EVENT_PROPAGATE;
    }

    // The keep-up grab above holds the keyboard too while the pointer
    // rests on a category: let go of it so keys work as everywhere else in
    // the menu, and Esc closes it
    vfunc_key_press_event(event) {
        this._releaseGrab();
        if (event.get_key_symbol() === Clutter.KEY_Escape) {
            this._button.menu.close(true);
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }

    _releaseGrab() {
        this._oldX = -1;
        this._oldY = -1;
        this._grab?.dismiss();
        delete this._grab;
    }

    _onActiveChanged() {
        if (!this.active)
            return;

        this._button.selectCategory(this._category);
        this._button.scrollToCatButton(this);
    }
}

class ApplicationsMenu extends PopupMenu.PopupMenu {
    constructor(sourceActor, arrowAlignment, arrowSide, button) {
        super(sourceActor, arrowAlignment, arrowSide);
        this._button = button;
    }

    isEmpty() {
        return false;
    }

    toggle() {
        if (this.isOpen)
            this._button.selectCategory(null);
        super.toggle();
    }
}

class MainLayout extends Clutter.BoxLayout {
    static {
        GObject.registerClass(this);
    }

    vfunc_get_preferred_height(container, forWidth) {
        const [mainChild] = container;
        const [minHeight, natHeight] =
            mainChild.get_preferred_height(forWidth);

        return [minHeight, natHeight + MENU_HEIGHT_OFFSET];
    }
}

export class AppsMenuButton extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    // @menuManager: the taskbar's, so its menus close one another
    constructor(menuManager) {
        super(0.0, _('Applications'), true);

        // opens upwards from the button's left edge (so against the
        // screen's), putting the categories straight above the button
        this.setMenu(new ApplicationsMenu(this, 0.0, St.Side.BOTTOM, this));
        this.menu.setSourceAlignment(0.0);
        this.menu.actor.remove_style_class_name('panel-menu');
        this.menu.actor.add_style_class_name('lanes-apps-menu');
        menuManager.addMenu(this.menu);

        this.add_style_class_name('lanes-apps-button');
        // Not keyboard navigable as a menu, so not announced as one
        this.accessible_role = Atk.Role.LABEL;

        this.add_child(new St.Icon({
            icon_name: 'view-app-grid-symbolic',
            style_class: 'system-status-icon',
        }));

        this._appSys = Shell.AppSystem.get_default();

        this._tree = new GMenu.Tree({menu_basename: 'applications.menu'});
        this._tree.connectObject('changed',
            () => this._onTreeChanged(), this);

        this._applicationsButtons = new Map();
        this.reloadFlag = false;
        this._createLayout();
        this._display();
        this._appSys.connectObject('installed-changed',
            () => this._onTreeChanged(), this);
        global.settings.connectObject('changed::favorite-apps',
            () => this._onTreeChanged(), this);
    }

    _onTreeChanged() {
        if (this.menu.isOpen) {
            this._redisplay();
            this.mainBox.show();
        } else {
            this.reloadFlag = true;
        }
    }

    _onDestroy() {
        super._onDestroy();
        // apps from categories not on show aren't in the menu to go with it
        this._applicationsButtons.forEach(item => {
            if (!item.get_parent())
                item.destroy();
        });
        this._tree.disconnectObject(this);
        this._appSys.disconnectObject(this);
        global.settings.disconnectObject(this);
        delete this._tree;
    }

    _onMenuKeyPress(actor, event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Left || symbol === Clutter.KEY_Right) {
            const direction = symbol === Clutter.KEY_Left
                ? St.DirectionType.LEFT : St.DirectionType.RIGHT;
            if (this.menu.actor.navigate_focus(global.stage.key_focus, direction, false))
                return Clutter.EVENT_STOP;
        }
        return super._onMenuKeyPress(actor, event);
    }

    _onOpenStateChanged(menu, open) {
        if (open) {
            if (this.reloadFlag) {
                this._redisplay();
                this.reloadFlag = false;
            }
            this.mainBox.show();
        }
        super._onOpenStateChanged(menu, open);
    }

    _redisplay() {
        this.applicationsBox.destroy_all_children();
        this.categoriesBox.destroy_all_children();
        this._display();
    }

    _loadCategory(categoryId, dir) {
        const iter = dir.iter();
        let nextType;
        while ((nextType = iter.next()) !== GMenu.TreeItemType.INVALID) {
            if (nextType === GMenu.TreeItemType.ENTRY) {
                const entry = iter.get_entry();
                let id;
                try {
                    id = entry.get_desktop_file_id(); // catch non-UTF8 filenames
                } catch {
                    continue;
                }
                let app = this._appSys.lookup_app(id);
                if (!app)
                    app = new Shell.App({app_info: entry.get_app_info()});
                if (app.get_app_info().should_show())
                    this.applicationsByCategory[categoryId].push(app);
            } else if (nextType === GMenu.TreeItemType.SEPARATOR) {
                this.applicationsByCategory[categoryId].push('separator');
            } else if (nextType === GMenu.TreeItemType.DIRECTORY) {
                const subdir = iter.get_directory();
                if (!subdir.get_is_nodisplay())
                    this._loadCategory(categoryId, subdir);
            }
        }
    }

    _scrollIntoView(scrollView, button) {
        const adjustment = scrollView.get_vadjustment();
        const box = scrollView.get_allocation_box();
        const current = adjustment.get_value();
        const boxHeight = box.y2 - box.y1;
        // the button's place in what scrolls, which may hold it a level down
        let [y1, y2] = [button.y, button.y + button.height];
        for (let a = button.get_parent(); a && a.get_parent() !== scrollView; a = a.get_parent()) {
            y1 += a.y;
            y2 += a.y;
        }
        let value = current;
        if (current > y1 - 10)
            value = y1 - 10;
        if (boxHeight + current < y2 + 10)
            value = y2 - boxHeight + 10;
        if (value !== current)
            adjustment.set_value(value);
    }

    scrollToButton(button) {
        this._scrollIntoView(this.applicationsScrollBox, button);
    }

    scrollToCatButton(button) {
        this._scrollIntoView(this.categoriesScrollBox, button);
    }

    _createLayout() {
        const section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(section);
        this.mainBox = new St.BoxLayout({layoutManager: new MainLayout()});
        this.leftBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
        });
        // the space above the categories: empty for now, a place for a
        // logo or system information later
        this.headerBox = new St.BoxLayout({
            style_class: 'lanes-apps-header',
            orientation: Clutter.Orientation.VERTICAL,
            y_expand: true,
        });
        this.leftBox.add_child(this.headerBox);
        this.applicationsScrollBox = new St.ScrollView({
            style_class: 'lanes-apps-list vfade',
            x_expand: true,
        });
        this.categoriesScrollBox = new St.ScrollView({
            style_class: 'vfade',
        });
        this.leftBox.add_child(this.categoriesScrollBox);

        this.applicationsBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
        });
        // a spacer above the apps lines a short list up with the bottom,
        // next to the categories and the button
        const applicationsColumn = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
        });
        applicationsColumn.add_child(new St.Widget({y_expand: true}));
        applicationsColumn.add_child(this.applicationsBox);
        this.applicationsScrollBox.set_child(applicationsColumn);
        this.categoriesBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
        });
        this.categoriesScrollBox.set_child(this.categoriesBox);

        this.mainBox.add_child(this.leftBox);
        this.mainBox.add_child(this.applicationsScrollBox);
        section.actor.add_child(this.mainBox);
    }

    _display() {
        this._applicationsButtons.clear();
        this.mainBox.hide();

        // Load categories
        this.applicationsByCategory = {};
        this._tree.load_sync();
        const root = this._tree.get_root_directory();
        // listed bottom up, so Favourites is nearest the button and the
        // rest follow upwards
        this.categoriesBox.add_child(new CategoryMenuItem(this, null));
        const iter = root.iter();
        let nextType;
        while ((nextType = iter.next()) !== GMenu.TreeItemType.INVALID) {
            if (nextType !== GMenu.TreeItemType.DIRECTORY)
                continue;

            const dir = iter.get_directory();
            if (dir.get_is_nodisplay())
                continue;

            const categoryId = dir.get_menu_id();
            this.applicationsByCategory[categoryId] = [];
            this._loadCategory(categoryId, dir);
            if (this.applicationsByCategory[categoryId].length > 0)
                this.categoriesBox.insert_child_at_index(new CategoryMenuItem(this, dir), 0);
        }

        // Load applications
        this._displayButtons(this._listApplications(null));
    }

    selectCategory(dir) {
        this.applicationsBox.get_children().forEach(c => {
            if (c._delegate instanceof PopupMenu.PopupSeparatorMenuItem)
                c._delegate.destroy();
            else
                this.applicationsBox.remove_child(c);
        });

        this._displayButtons(this._listApplications(dir?.get_menu_id() ?? null));
    }

    _displayButtons(apps) {
        for (const app of apps) {
            let item;
            if (app instanceof Shell.App)
                item = this._applicationsButtons.get(app);
            else
                item = new PopupMenu.PopupSeparatorMenuItem();
            if (!item) {
                item = new ApplicationMenuItem(this, app);
                this._applicationsButtons.set(app, item);
            }
            if (!item.get_parent())
                this.applicationsBox.add_child(item);
        }
    }

    _listApplications(categoryMenuId) {
        if (categoryMenuId)
            return this.applicationsByCategory[categoryMenuId];

        return global.settings.get_strv('favorite-apps')
            .map(id => this._appSys.lookup_app(id))
            .filter(app => app);
    }
}
