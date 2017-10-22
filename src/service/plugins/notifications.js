"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("gsconnect");
const _ = Gettext.gettext;

const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    let p = Gio.File.new_for_path(m[1]).get_parent().get_parent().get_parent();
    return p.get_path();
}

imports.searchPath.push(getPath());

const Common = imports.common;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;


var METADATA = {
    name: "notifications",
    summary: _("Notifications"),
    description: _("Sync notifications between devices"),
    wiki: "https://github.com/andyholmes/gnome-shell-extension-gsconnect/wiki/Notifications-Plugin",
    incomingPackets: [
        "kdeconnect.notification",
        "kdeconnect.notification.request"
    ],
    outgoingPackets: [
        "kdeconnect.notification",
        "kdeconnect.notification.reply",
        "kdeconnect.notification.request"
    ],
    settings: {
        receive: {
            enabled: true
        },
        send: {
            enabled: true,
            icons: true,
            applications: {
                GSConnect: {
                    iconName: "phone",
                    enabled: false
                }
            }
        }
    }
};


/**
 * Notification Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/notifications
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/sendnotifications
 *
 * Incoming Notifications
 *
 * There are several possible variables for an incoming notification:
 *
 *    body.id {string} - This is supposedly and "internal" Android Id, such as:
 *                      "0|org.kde.kdeconnect_tp|-256692160|null|10114"
 *    body.isCancel {boolean} - If true, the notification "id" was closed by the peer
 *    body.isClearable {boolean} - If true, we can reply with "cancel: <id>"
 *    body.appName {string} - The notifying application, just like libnotify
 *    body.ticker {string} - Like libnotify's "body", unless there's a summary
 *        (such as with an SMS where the summary would be the sender's name)
 *        the value would be "summary: body"
 *    body.silent {boolean} - KDE Connect seems to indicate this means "don't show"
 *    body.requestAnswer {boolean} - This is an answer to a "request"
 *    body.request {boolean} - If true, we're being asked to send a list of notifs
 * For icon syncing:
 *    body.payloadHash {string} - An MD5 hash of the payload data
 *    payloadSize {number} - the notification icon size in bytes
 *    payloadTransferInfo {object} - Just like regular (with a property 'port')
 *
 * The current beta seems to also send:
 *
 *    requestReplyId {string} - a UUID for replying (?)
 *    title {string} - The remote's title of the notification
 *    text {string} - The remote's body of the notification
 *
 * TODO: support payloadHash for uploaded icons
 *       convert themed SVG->PNG for icon uploads?
 *       requestAnswer usage?
 *       urgency filter (outgoing)?
 *       make "shared" notifications clearable (Can KDE Connect even do this?)
 *       consider option for notifications allowing clients to handle them
 *       use signals
 */
var Plugin = new Lang.Class({
    Name: "GSConnectNotificationsPlugin",
    Extends: PluginsBase.Plugin,
    Signals: {
        "received": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_STRING ]
        },
        "dismissed": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [ GObject.TYPE_STRING ]
        }
    },
    
    _init: function (device) {
        this.parent(device, "notifications");
        
        this._freeze = false;
        this._notifications = new Map();
        this._sms = new Map();
    },
    
    _getIconInfo: function (iconName) {
        let theme = Gtk.IconTheme.get_default();
        let sizes = theme.get_icon_sizes(iconName);
        
        return theme.lookup_icon(
            iconName,
            Math.max.apply(null, sizes),
            Gtk.IconLookupFlags.NO_SVG
        );
    },
    
    Notify: function (appName, replacesId, iconName, summary, body, actions, hints, timeout) {
        // Signature: str,     uint,       str,      str,     str,  array,   obj,   uint
        Common.debug("Notifications: Notify()");
        
        Common.debug("appName: " + appName);
        Common.debug("replacesId: " + replacesId);
        Common.debug("iconName: " + iconName);
        Common.debug("summary: " + summary);
        Common.debug("body: " + body);
        Common.debug("actions: " + actions);
        Common.debug("hints: " + JSON.stringify(hints));
        Common.debug("timeout: " + timeout);
        
        // New application
        if (!this.settings.send.applications.hasOwnProperty(appName)) {
            this.settings.send.applications[appName] = {
                iconName: iconName,
                enabled: true
            };
            
            Common.writeDeviceConfiguration(this.device.id, this.device.config);
        }
        
        if (this.settings.send.enabled) {
            if (this.settings.send.applications[appName].enabled) {
                let packet = new Protocol.Packet({
                    id: Date.now(),
                    type: "kdeconnect.notification",
                    body: {
                        appName: appName,
                        id: replacesId.toString(),  // TODO: clearable if !0?
                        isClearable: false,
                        ticker: body
                    }
                });
                
                let iconInfo;
                
                if (this.settings.send.icons) {
                    iconInfo = this._getIconInfo(iconName);
                }
                
                if (iconInfo) {
                    Common.debug("Icon Filename: " + iconInfo.get_filename());
                    
                    let file = Gio.File.new_for_path(iconInfo.get_filename());
                    let info = file.query_info("standard::size", 0, null);
                    
                    let channel = new Protocol.LanUploadChannel(
                        this.device.daemon,
                        this.device.identity,
                        file.read(null)
                    );
            
                    channel.connect("listening", (channel, port) => {
                        packet.payloadSize = info.get_size();
                        packet.payloadTransferInfo = { port: port };
                        
                        this.device._channel.send(packet);
                    });
                    
                    channel.connect("connected", (channel) => {
                        let transfer = new Protocol.Transfer(
                            channel,
                            info.get_size()
                        );
                        
                        transfer.connect("failed", (transfer) => {
                            channel.close();
                        });
                    
                        transfer.connect("succeeded", (transfer) => {
                            channel.close();
                        });
                
                        transfer.start();
                    });
            
                    channel.open();
                } else {
                    this.device._channel.send(packet);
                }
            }
        }
    },
    
    handlePacket: function (packet) {
        Common.debug("Notifications: handlePacket()");
        
        if (packet.type === "kdeconnect.notification" && this.settings.receive.enabled) {
            this._receiveNotification(packet);
        } else if (packet.type === "kdeconnect.notification.request") {
            // TODO: KDE Connect says this is unused...
        }
    },
    
    markReadSms: function (smsString) {
        if (this._sms.has(smsString)) {
            let duplicate = this._sms.get(smsString);
                
            if (duplicate.id) {
                this.close(duplicate.id);
            } else {
                duplicate.mark_read = true;
            }
        } else {
            this._sms.set(smsString, { mark_read: true });
        }
    },
    
    silenceSms: function (smsString) {
        if (this._sms.has(smsString)) {
            this._sms.get(smsString).silence = true;
        } else {
            this._sms.set(smsString, { silence: true });
        }
    },
    
    _receiveNotification: function (packet) {
        Common.debug("Notifications: _receiveNotification()");
        
        if (packet.body.isCancel) {
            this.close(packet.body.id);
        } else {
            let notif;
            
            // This is an update to a notification
            if (this._notifications.has(packet.body.id)) {
                notif = this._notifications.get(packet.body.id);
                notif.set_title(packet.body.appName);
                notif.set_body(packet.body.ticker);
            // This is a new notification
            } else {
                notif = new Gio.Notification();
                notif.set_title(packet.body.appName);
                notif.set_body(packet.body.ticker);
                notif.set_default_action(
                    "app.closeNotification(('" +
                    this._dbus.get_object_path() +
                    "','" +
                    escape(packet.body.id) +
                    "'))"
                );
                
                this._notifications.set(packet.body.id, notif);
            }
            
            if (packet.payloadSize) {
                let iconStream = Gio.MemoryOutputStream.new_resizable();
                
                let channel = new Protocol.LanDownloadChannel(
                    this.device.daemon,
                    this.device.identity,
                    iconStream
                );
                
                channel.connect("connected", (channel) => {
                    let transfer = new Protocol.Transfer(
                        channel,
                        packet.payloadSize,
                        packet.body.payloadHash
                    );
                    
                    transfer.connect("failed", (transfer) => {
                        channel.close();
                        notif.set_icon(
                            new Gio.ThemedIcon({ name: "phone-symbolic" })
                        );
                    });
                    
                    transfer.connect("succeeded", (transfer) => {
                        channel.close();
                        iconStream.close(null);
                        notif.set_icon(
                            Gio.BytesIcon.new(iconStream.steal_as_bytes())
                        );
                    });
                    
                    transfer.start();
                });
            
                let addr = new Gio.InetSocketAddress({
                    address: Gio.InetAddress.new_from_string(
                        this.device.identity.body.tcpHost
                    ),
                    port: packet.payloadTransferInfo.port
                });
                
                channel.open(addr);
            } else {
                notif.set_icon(new Gio.ThemedIcon({ name: "phone-symbolic" }));
            }
            
            if (packet.body.requestAnswer) {
                Common.debug("Notifications: this is an answer to a request");
            }
            
            // If this is an SMS we should check if it's a duplicate
            if (packet.body.id.indexOf("sms") > -1) {
                let smsString
                
                // kdeconnect-android 1.7+ only
                if (packet.body.hasOwnProperty("title")) {
                    smsString = packet.body.title + ": " + packet.body.text;
                } else {
                    smsString = packet.body.ticker;
                }
                
                if (this._sms.has(smsString)) {
                    let duplicate = this._sms.get(smsString);
                    
                    // We've been asked to mark this read (we'll close it)
                    if (duplicate.mark_read) {
                        this.close(packet.body.id);
                        this._sms.delete(smsString);
                    // We've been asked to silence this (we'll still track it)
                    } else if (duplicate.silence) {
                        duplicate.id = packet.body.id;
                    }
                // We can show this as normal
                } else {
                    this.device.daemon.send_notification(packet.body.id, notif);
                }
            // TODO: Apparently "silent" means don't show the notification, or
            //       maybe it just means "don't present" (aka low urgency)
            //} else if (!packet.body.silent) {
            } else {
                this.device.daemon.send_notification(packet.body.id, notif);
            }
        }
    },
    
    close: function (id) {
        let packet = new Protocol.Packet({
            id: 0,
            type: "kdeconnect.notification.request",
            body: { cancel: id }
        });
        
        this.device._channel.send(packet);
        
        if (this._notifications.has(id)) {
            this._notifications.delete(id);
        }
    },
    
    // TODO: ???
    reply: function () {
    },
    
    // TODO: request notifications
    update: function () {
    }
});


var SettingsDialog = new Lang.Class({
    Name: "GSConnectNotificationsSettingsDialog",
    Extends: PluginsBase.SettingsDialog,
    
    _init: function (devicePage, pluginName, window) {
        this.parent(devicePage, pluginName, window);
        
        // Receiving
        let receivingSection = this.content.addSection(_("Receiving"));
        
        let receiveSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this.settings.receive.enabled
        });
        receiveSwitch.connect("notify::active", (widget) => {
            this.settings.receive.enabled = receiveSwitch.active;
        });
        this.content.addItem(
            receivingSection,
            _("Receive Notifications"),
            // TRANSLATORS: eg. Enable to receive notifications from Google Pixel
            _("Enable to receive notifications from %s").format(this._page.device.name),
            receiveSwitch
        );
        
        // Sending
        let sendingSection = this.content.addSection(_("Sending"));
        
        let sendSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this.settings.send.enabled
        });
        sendSwitch.connect("notify::active", (widget) => {
            this.settings.send.enabled = sendSwitch.active;
        });
        this.content.addItem(
            sendingSection,
            _("Send Notifications"),
            // TRANSLATORS: eg. Enable to send notifications to Google Pixel
            _("Enable to send notifications to %s").format(this._page.device.name),
            sendSwitch
        );
        
        let iconsSwitch = new Gtk.Switch({
            visible: true,
            can_focus: true,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            active: this.settings.send.icons
        });
        iconsSwitch.connect("notify::active", (widget) => {
            this.settings.send.icons = iconsSwitch.active;
        });
        this.content.addItem(
            sendingSection,
            _("Send Icons"),
            _("Include icons in notifications"),
            iconsSwitch
        );
        
        // Applications TreeView/Model
        let appRow = this.content.addRow(sendingSection);
        appRow.grid.row_spacing = 12;
        
        this.treeview = new Gtk.TreeView({
            enable_grid_lines: true,
            headers_visible: true,
            hexpand: true,
            vexpand: true,
            margin_top: 6,
            height_request: 100
        });
        
        let listStore = new Gtk.ListStore();
        listStore.set_column_types([
            GdkPixbuf.Pixbuf,       // iconName
            GObject.TYPE_STRING,    // appName
            GObject.TYPE_BOOLEAN    // enabled
        ]);
        this.treeview.model = listStore;
        
        // Name column.
        this.appCell = new Gtk.CellRendererText({ editable: false });
        let appCol = new Gtk.TreeViewColumn({
            title: _("Application"),
            expand: true
        });
        
        // Icon
        let iconCell = new Gtk.CellRendererPixbuf();
        appCol.pack_start(iconCell, false);
        appCol.add_attribute(iconCell, "pixbuf", 0);
        appCol.pack_start(this.appCell, true);
        appCol.add_attribute(this.appCell, "text", 1);
        this.treeview.append_column(appCol);
        
        // Enabled column.
        this.sendCell = new Gtk.CellRendererToggle();
        let sendCol = new Gtk.TreeViewColumn({ title: _("Enabled") });
        sendCol.pack_start(this.sendCell, true);
        sendCol.add_attribute(this.sendCell, "active", 2);
        this.treeview.append_column(sendCol);
        this.sendCell.connect("toggled", Lang.bind(this, this._editSend));
        
        let treeScroll = new Gtk.ScrolledWindow({
            height_request: 150,
            can_focus: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        treeScroll.add(this.treeview);
        appRow.grid.attach(treeScroll, 0, 0, 1, 1);
        
        // Buttons
        let buttonBox = new Gtk.ButtonBox({ halign: Gtk.Align.END });
        appRow.grid.attach(buttonBox, 0, 1, 1, 1);
        
        let removeButton = new Gtk.Button({ label: _("Remove") });
        removeButton.connect("clicked", Lang.bind(this, this._remove));
        buttonBox.add(removeButton);
        
        this._populate();
        
        this.content.show_all();
    },
    
    _remove: function (button) {
        //
        let [has, model, iter] = this.treeview.get_selection().get_selected();
        
        if (has) {
            let name = this.treeview.model.get_value(iter, 1);
            delete this.settings.send.applications[name];
            this.treeview.model.remove(iter);
        }
    },
    
    _populate: function () {
        let theme = Gtk.IconTheme.get_default()
        
        for (let name in this.settings.send.applications) {
            let pixbuf;
            
            try {
                pixbuf = theme.load_icon(
                    this.settings.send.applications[name].iconName, 0, 0
                );
            } catch (e) {
                pixbuf = theme.load_icon("application-x-executable", 0, 0);
            }
        
            this.treeview.model.set(
                this.treeview.model.append(),
                [0, 1, 2], 
                [pixbuf,
                name,
                this.settings.send.applications[name].enabled]
            );
        }
    },
    
    _editSend: function (renderer, path, user_data) {
        path = Gtk.TreePath.new_from_string(path);
        let [success, iter] = this.treeview.model.get_iter(path);
        
        if (success) {
            let enabled = this.treeview.model.get_value(iter, 2);
            this.treeview.model.set_value(iter, 2, !enabled);
            let name = this.treeview.model.get_value(iter, 1);
            this.settings.send.applications[name].enabled = !enabled;
        }
    }
});


