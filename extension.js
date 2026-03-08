import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import GObject from 'gi://GObject'
import Meta from 'gi://Meta'
import Shell from 'gi://Shell'
import St from 'gi://St'

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js'
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js'

const UUID = 'wayland-autoclicker@anotherone'

const KEY_CLICKS_PER_SECOND = 'clicks-per-second'
const KEY_MOUSE_BUTTON = 'mouse-button'
const KEY_RESTORE_TOKEN = 'restore-token'
const KEY_TOGGLE_SHORTCUT = 'toggle-shortcut'

const MIN_CPS = 1
const MAX_CPS = 50
const SPEED_PRESETS = [
    1, 2, 3, 4, 5,
    6, 7, 8, 9, 10,
    12, 15, 20, 25, 30, 40, 50,
]

const BUTTON_CODES = {
    left: 272,
    right: 273,
    middle: 274,
}

const PORTAL_DESTINATION = 'org.freedesktop.portal.Desktop'
const PORTAL_OBJECT_PATH = '/org/freedesktop/portal/desktop'
const PORTAL_REMOTE_DESKTOP_IFACE = 'org.freedesktop.portal.RemoteDesktop'
const PORTAL_REQUEST_IFACE = 'org.freedesktop.portal.Request'
const PORTAL_SESSION_IFACE = 'org.freedesktop.portal.Session'

const DEVICE_POINTER = 2
const BUTTON_RELEASED = 0
const BUTTON_PRESSED = 1

const STATUS = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    RUNNING: 'running',
    ERROR: 'error',
}

function describeError(error) {
    if (error instanceof Error)
        return error.message

    return String(error)
}

function clampClicksPerSecond(value) {
    return Math.max(MIN_CPS, Math.min(MAX_CPS, value))
}

function getClicksPerSecond(settings) {
    return clampClicksPerSecond(settings.get_int(KEY_CLICKS_PER_SECOND))
}

function getButtonId(settings) {
    const buttonId = settings.get_string(KEY_MOUSE_BUTTON)
    return BUTTON_CODES[buttonId] ? buttonId : 'left'
}

function formatClicksPerSecond(cps) {
    return `${cps} CPS`
}

function formatButtonLabel(buttonId) {
    switch (buttonId) {
    case 'right':
        return _('Right click')
    case 'middle':
        return _('Middle click')
    case 'left':
    default:
        return _('Left click')
    }
}

function unpackVariantDict(dict) {
    return Object.fromEntries(
        Object.entries(dict).map(([key, variant]) => [key, variant.unpack()]))
}

function callDBus(connection, destination, objectPath, interfaceName, methodName,
    parameters, replyType = null) {
    return new Promise((resolve, reject) => {
        connection.call(
            destination,
            objectPath,
            interfaceName,
            methodName,
            parameters,
            replyType,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (source, result) => {
                try {
                    resolve(source.call_finish(result))
                } catch (error) {
                    reject(error)
                }
            })
    })
}

class PortalRemoteDesktopSession {
    constructor(settings, onClosed) {
        this._settings = settings
        this._onClosed = onClosed
        this._connection = Gio.DBus.session
        this._sessionHandle = null
        this._sessionClosedSignalId = 0
        this._startPromise = null
        this._stopRequested = false
    }

    async start() {
        this._stopRequested = false

        if (this._sessionHandle)
            return

        if (!this._startPromise) {
            this._startPromise = this._startInternal().finally(() => {
                this._startPromise = null
            })
        }

        return this._startPromise
    }

    async stop() {
        this._stopRequested = true
        await this._closeSession()
    }

    async click(buttonCode) {
        if (!this._sessionHandle)
            throw new Error(_('No pointer access session is active.'))

        const parameters = state => new GLib.Variant('(oa{sv}iu)', [
            this._sessionHandle,
            {},
            buttonCode,
            state,
        ])

        await callDBus(
            this._connection,
            PORTAL_DESTINATION,
            PORTAL_OBJECT_PATH,
            PORTAL_REMOTE_DESKTOP_IFACE,
            'NotifyPointerButton',
            parameters(BUTTON_PRESSED),
            new GLib.VariantType('()'))

        await callDBus(
            this._connection,
            PORTAL_DESTINATION,
            PORTAL_OBJECT_PATH,
            PORTAL_REMOTE_DESKTOP_IFACE,
            'NotifyPointerButton',
            parameters(BUTTON_RELEASED),
            new GLib.VariantType('()'))
    }

    destroy() {
        this._onClosed = null
        void this.stop()
    }

    async _startInternal() {
        const createToken = this._newToken('create')
        const sessionToken = this._newToken('session')
        const createResults = await this._callPortalRequest(
            'CreateSession',
            new GLib.Variant('(a{sv})', [{
                handle_token: new GLib.Variant('s', createToken),
                session_handle_token: new GLib.Variant('s', sessionToken),
            }]),
            new GLib.VariantType('(o)'),
            createToken)

        const sessionHandle = createResults.session_handle
        if (!sessionHandle)
            throw new Error(_('GNOME did not return a remote desktop session handle.'))

        this._sessionHandle = sessionHandle

        if (this._stopRequested) {
            await this._closeSession()
            throw new Error(_('Autoclicker start was cancelled.'))
        }

        const selectToken = this._newToken('select')
        const selectOptions = {
            handle_token: new GLib.Variant('s', selectToken),
            types: new GLib.Variant('u', DEVICE_POINTER),
            persist_mode: new GLib.Variant('u', 2),
        }

        const restoreToken = this._settings.get_string(KEY_RESTORE_TOKEN)
        if (restoreToken)
            selectOptions.restore_token = new GLib.Variant('s', restoreToken)

        await this._callPortalRequest(
            'SelectDevices',
            new GLib.Variant('(oa{sv})', [sessionHandle, selectOptions]),
            new GLib.VariantType('(o)'),
            selectToken)

        if (this._stopRequested) {
            await this._closeSession()
            throw new Error(_('Autoclicker start was cancelled.'))
        }

        const startToken = this._newToken('start')
        const startResults = await this._callPortalRequest(
            'Start',
            new GLib.Variant('(osa{sv})', [sessionHandle, '', {
                handle_token: new GLib.Variant('s', startToken),
            }]),
            new GLib.VariantType('(o)'),
            startToken)

        const devices = startResults.devices ?? 0
        if ((devices & DEVICE_POINTER) === 0) {
            await this._closeSession()
            throw new Error(_('GNOME did not grant pointer access.'))
        }

        if (startResults.restore_token)
            this._settings.set_string(KEY_RESTORE_TOKEN, startResults.restore_token)

        this._watchSession(sessionHandle)
    }

    _newToken(prefix) {
        const randomPart = GLib.uuid_string_random().replaceAll('-', '_')
        return `${prefix}_${randomPart}`
    }

    _makeRequestPath(token) {
        const sender = this._connection.get_unique_name()
            .replace(':', '')
            .replaceAll('.', '_')

        return `/org/freedesktop/portal/desktop/request/${sender}/${token}`
    }

    async _callPortalRequest(methodName, parameters, replyType, handleToken) {
        let requestPath = this._makeRequestPath(handleToken)

        return new Promise((resolve, reject) => {
            let subscriptionId = 0
            let completed = false

            const subscribe = path => {
                subscriptionId = this._connection.signal_subscribe(
                    PORTAL_DESTINATION,
                    PORTAL_REQUEST_IFACE,
                    'Response',
                    path,
                    null,
                    Gio.DBusSignalFlags.NONE,
                    (_connection, _sender, _path, _iface, _signal, responseParams) => {
                        if (completed)
                            return

                        completed = true
                        this._connection.signal_unsubscribe(subscriptionId)

                        const [response, responseResults] = responseParams.deepUnpack()
                        if (response === 0) {
                            resolve(unpackVariantDict(responseResults))
                            return
                        }

                        if (response === 1) {
                            reject(new Error(_('The GNOME permission prompt was cancelled.')))
                            return
                        }

                        reject(new Error(_('The GNOME remote desktop request failed.')))
                    })
            }

            subscribe(requestPath)

            callDBus(
                this._connection,
                PORTAL_DESTINATION,
                PORTAL_OBJECT_PATH,
                PORTAL_REMOTE_DESKTOP_IFACE,
                methodName,
                parameters,
                replyType)
                .then(result => {
                    const [returnedRequestPath] = result.deepUnpack()
                    if (returnedRequestPath === requestPath || completed)
                        return

                    this._connection.signal_unsubscribe(subscriptionId)
                    requestPath = returnedRequestPath
                    subscribe(requestPath)
                })
                .catch(error => {
                    if (completed)
                        return

                    completed = true
                    this._connection.signal_unsubscribe(subscriptionId)
                    reject(error)
                })
        })
    }

    _watchSession(sessionHandle) {
        this._unwatchSession()
        this._sessionClosedSignalId = this._connection.signal_subscribe(
            PORTAL_DESTINATION,
            PORTAL_SESSION_IFACE,
            'Closed',
            sessionHandle,
            null,
            Gio.DBusSignalFlags.NONE,
            () => {
                this._sessionHandle = null
                this._unwatchSession()

                if (this._onClosed)
                    this._onClosed()
            })
    }

    _unwatchSession() {
        if (!this._sessionClosedSignalId)
            return

        this._connection.signal_unsubscribe(this._sessionClosedSignalId)
        this._sessionClosedSignalId = 0
    }

    async _closeSession() {
        const sessionHandle = this._sessionHandle
        if (!sessionHandle)
            return

        this._sessionHandle = null
        this._unwatchSession()

        try {
            await callDBus(
                this._connection,
                PORTAL_DESTINATION,
                sessionHandle,
                PORTAL_SESSION_IFACE,
                'Close',
                null,
                new GLib.VariantType('()'))
        } catch (error) {
            logError(error, `${UUID}: failed to close portal session`)
        }
    }
}

const AutoclickerIndicator = GObject.registerClass(
class AutoclickerIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, _('Wayland Autoclicker'))

        this._extension = extension
        this._settings = extension.getSettings()
        this._session = new PortalRemoteDesktopSession(this._settings, () => {
            if (!this._targetActive && !this._active)
                return

            void this._stopFromError(new Error(_('GNOME closed the pointer access session.')))
        })

        this._active = false
        this._targetActive = false
        this._status = STATUS.IDLE
        this._lastError = ''
        this._clickTimerId = 0
        this._clickPromise = null
        this._toggleUpdateBlocked = false
        this._transitionSerial = 0

        this.add_style_class_name('autoclicker-panel-button')

        const buttonBox = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        })

        this._icon = new St.Icon({
            icon_name: 'input-mouse-symbolic',
            style_class: 'system-status-icon',
        })
        buttonBox.add_child(this._icon)

        this._dot = new St.Widget({
            style_class: 'autoclicker-active-dot',
        })
        buttonBox.add_child(this._dot)

        this.add_child(buttonBox)

        this._buildMenu()
        this._bindSettings()
        this._bindShortcut()
        this._syncUi()
    }

    _buildMenu() {
        this._statusItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        })

        const statusBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'autoclicker-menu-heading',
        })

        this._statusTitle = new St.Label({
            text: _('Wayland Autoclicker'),
            style_class: 'autoclicker-menu-title',
            x_expand: true,
        })
        statusBox.add_child(this._statusTitle)

        this._statusDescription = new St.Label({
            style_class: 'autoclicker-menu-subtitle',
            x_expand: true,
        })
        statusBox.add_child(this._statusDescription)

        this._statusItem.add_child(statusBox)
        this.menu.addMenuItem(this._statusItem)

        this._toggleItem = new PopupMenu.PopupSwitchMenuItem(_('Enabled'), false)
        this._toggleItem.connect('toggled', (_item, state) => {
            if (this._toggleUpdateBlocked)
                return

            void this._setRequestedActive(state)
        })
        this.menu.addMenuItem(this._toggleItem)

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem())

        this._speedMenu = new PopupMenu.PopupSubMenuMenuItem(_('Click speed'))
        this._speedItems = new Map()
        for (const cps of SPEED_PRESETS) {
            const item = new PopupMenu.PopupMenuItem(formatClicksPerSecond(cps))
            item.connect('activate', () => {
                this._settings.set_int(KEY_CLICKS_PER_SECOND, cps)
            })
            this._speedItems.set(cps, item)
            this._speedMenu.menu.addMenuItem(item)
        }
        this.menu.addMenuItem(this._speedMenu)

        this._buttonMenu = new PopupMenu.PopupSubMenuMenuItem(_('Mouse button'))
        this._buttonItems = new Map()
        for (const buttonId of Object.keys(BUTTON_CODES)) {
            const item = new PopupMenu.PopupMenuItem(formatButtonLabel(buttonId))
            item.connect('activate', () => {
                this._settings.set_string(KEY_MOUSE_BUTTON, buttonId)
            })
            this._buttonItems.set(buttonId, item)
            this._buttonMenu.menu.addMenuItem(item)
        }
        this.menu.addMenuItem(this._buttonMenu)

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem())

        this.menu.addAction(_('Forget stored access'), () => {
            this._settings.set_string(KEY_RESTORE_TOKEN, '')
            this._status = this._active ? STATUS.RUNNING : STATUS.IDLE
            this._syncUi()
        })

        this.menu.addAction(_('Preferences'), () => {
            this._extension.openPreferences()
        })
    }

    _bindSettings() {
        this._settings.connectObject(
            `changed::${KEY_CLICKS_PER_SECOND}`,
            () => {
                const cps = getClicksPerSecond(this._settings)
                if (cps !== this._settings.get_int(KEY_CLICKS_PER_SECOND))
                    this._settings.set_int(KEY_CLICKS_PER_SECOND, cps)

                if (this._active)
                    this._restartTimer()

                this._syncUi()
            },
            `changed::${KEY_MOUSE_BUTTON}`,
            () => {
                const buttonId = getButtonId(this._settings)
                if (buttonId !== this._settings.get_string(KEY_MOUSE_BUTTON))
                    this._settings.set_string(KEY_MOUSE_BUTTON, buttonId)

                this._syncUi()
            },
            `changed::${KEY_RESTORE_TOKEN}`,
            () => this._syncUi(),
            this)
    }

    _bindShortcut() {
        Main.wm.addKeybinding(
            KEY_TOGGLE_SHORTCUT,
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => {
                void this._setRequestedActive(!this._targetActive)
            })
    }

    async _setRequestedActive(wantActive) {
        this._targetActive = wantActive
        this._transitionSerial++
        const transitionSerial = this._transitionSerial

        if (!wantActive) {
            this._active = false
            this._status = STATUS.IDLE
            this._lastError = ''
            this._stopTimer()

            const clickPromise = this._clickPromise
            if (clickPromise)
                await clickPromise.catch(() => {})

            await this._session.stop()
            this._syncUi()
            return
        }

        this._status = STATUS.CONNECTING
        this._lastError = ''
        this._syncUi()

        try {
            await this._session.start()

            if (transitionSerial !== this._transitionSerial || !this._targetActive) {
                await this._session.stop()
                return
            }

            this._active = true
            this._status = STATUS.RUNNING
            this._restartTimer()
            this._queueClick()
            this._syncUi()
        } catch (error) {
            if (transitionSerial !== this._transitionSerial || !this._targetActive)
                return

            await this._stopFromError(error)
        }
    }

    async _stopFromError(error) {
        this._transitionSerial++
        this._targetActive = false
        this._active = false
        this._status = STATUS.ERROR
        this._lastError = describeError(error)
        this._stopTimer()
        await this._session.stop()
        this._syncUi()

        Main.notifyError(_('Autoclicker error'), this._lastError)
    }

    _restartTimer() {
        this._stopTimer()

        const intervalMs = Math.max(20, Math.round(1000 / getClicksPerSecond(this._settings)))
        this._clickTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
            this._queueClick()
            return GLib.SOURCE_CONTINUE
        })
    }

    _stopTimer() {
        if (!this._clickTimerId)
            return

        GLib.source_remove(this._clickTimerId)
        this._clickTimerId = 0
    }

    _queueClick() {
        if (!this._active || this._clickPromise)
            return

        const buttonId = getButtonId(this._settings)
        const buttonCode = BUTTON_CODES[buttonId]

        const clickPromise = this._session.click(buttonCode)
        this._clickPromise = clickPromise

        clickPromise
            .catch(error => {
                if (!this._active)
                    return

                void this._stopFromError(error)
            })
            .finally(() => {
                if (this._clickPromise === clickPromise)
                    this._clickPromise = null
            })
    }

    _statusText() {
        const cps = getClicksPerSecond(this._settings)
        const buttonLabel = formatButtonLabel(getButtonId(this._settings))

        switch (this._status) {
        case STATUS.CONNECTING:
            return _('Requesting GNOME pointer access...')
        case STATUS.RUNNING:
            return `${buttonLabel} at ${formatClicksPerSecond(cps)}`
        case STATUS.ERROR:
            return this._lastError
        case STATUS.IDLE:
        default:
            return _('Ready. First start may show a GNOME permission prompt.')
        }
    }

    _syncUi() {
        const cps = getClicksPerSecond(this._settings)
        const buttonId = getButtonId(this._settings)

        this._statusDescription.text = this._statusText()

        this._toggleUpdateBlocked = true
        this._toggleItem.setToggleState(this._targetActive)
        this._toggleUpdateBlocked = false

        this._speedMenu.label.text = `${_('Click speed')} - ${formatClicksPerSecond(cps)}`
        for (const [speed, item] of this._speedItems.entries()) {
            item.setOrnament(speed === cps
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE)
        }

        this._buttonMenu.label.text = `${_('Mouse button')} - ${formatButtonLabel(buttonId)}`
        for (const [id, item] of this._buttonItems.entries()) {
            item.setOrnament(id === buttonId
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE)
        }

        this.remove_style_class_name('autoclicker-connecting')
        this.remove_style_class_name('autoclicker-running')

        if (this._status === STATUS.CONNECTING)
            this.add_style_class_name('autoclicker-connecting')
        else if (this._status === STATUS.RUNNING)
            this.add_style_class_name('autoclicker-running')
    }

    destroy() {
        this._stopTimer()
        Main.wm.removeKeybinding(KEY_TOGGLE_SHORTCUT)
        this._settings.disconnectObject(this)
        this._session.destroy()
        super.destroy()
    }
})

export default class WaylandAutoclickerExtension extends Extension {
    enable() {
        this._indicator = new AutoclickerIndicator(this)
        Main.panel.addToStatusArea('wayland-autoclicker', this._indicator)
    }

    disable() {
        this._indicator.destroy()
        this._indicator = null
    }
}
