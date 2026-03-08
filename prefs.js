import Adw from 'gi://Adw'
import GObject from 'gi://GObject'
import Gtk from 'gi://Gtk'

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js'

const KEY_CLICKS_PER_SECOND = 'clicks-per-second'
const KEY_MOUSE_BUTTON = 'mouse-button'
const KEY_RESTORE_TOKEN = 'restore-token'
const KEY_TOGGLE_SHORTCUT = 'toggle-shortcut'

const BUTTON_OPTIONS = [
    'left',
    'right',
    'middle',
]

function buttonLabel(buttonId) {
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

function buttonIndexFromSettings(settings) {
    const value = settings.get_string(KEY_MOUSE_BUTTON)
    const index = BUTTON_OPTIONS.findIndex(option => option === value)
    return index >= 0 ? index : 0
}

const AutoclickerPreferencesPage = GObject.registerClass(
class AutoclickerPreferencesPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({
            title: _('Wayland Autoclicker'),
            icon_name: 'input-mouse-symbolic',
        })

        this._settings = settings

        const behaviorGroup = new Adw.PreferencesGroup({
            title: _('Behavior'),
        })
        this.add(behaviorGroup)

        const speedRow = new Adw.ActionRow({
            title: _('Clicks per second'),
            subtitle: _('How many clicks to send each second while the autoclicker is enabled'),
        })

        const speedAdjustment = new Gtk.Adjustment({
            lower: 1,
            upper: 50,
            step_increment: 1,
            page_increment: 5,
            value: this._settings.get_int(KEY_CLICKS_PER_SECOND),
        })

        const speedSpin = new Gtk.SpinButton({
            adjustment: speedAdjustment,
            digits: 0,
            numeric: true,
            valign: Gtk.Align.CENTER,
            width_chars: 4,
        })
        speedSpin.connect('value-changed', () => {
            this._settings.set_int(KEY_CLICKS_PER_SECOND, speedSpin.get_value_as_int())
        })
        this._settings.connectObject(
            `changed::${KEY_CLICKS_PER_SECOND}`,
            () => speedSpin.set_value(this._settings.get_int(KEY_CLICKS_PER_SECOND)),
            this)
        speedRow.add_suffix(speedSpin)
        speedRow.activatable_widget = speedSpin
        behaviorGroup.add(speedRow)

        const buttonRow = new Adw.ActionRow({
            title: _('Mouse button'),
            subtitle: _('Which button the autoclicker should press'),
        })

        const buttonLabels = BUTTON_OPTIONS.map(option => buttonLabel(option))
        const buttonDropdown = new Gtk.DropDown({
            model: Gtk.StringList.new(buttonLabels),
            valign: Gtk.Align.CENTER,
        })
        buttonDropdown.set_selected(buttonIndexFromSettings(this._settings))
        buttonDropdown.connect('notify::selected', () => {
            const selected = BUTTON_OPTIONS[buttonDropdown.get_selected()] ?? BUTTON_OPTIONS[0]
            this._settings.set_string(KEY_MOUSE_BUTTON, selected)
        })
        this._settings.connectObject(
            `changed::${KEY_MOUSE_BUTTON}`,
            () => buttonDropdown.set_selected(buttonIndexFromSettings(this._settings)),
            this)
        buttonRow.add_suffix(buttonDropdown)
        buttonRow.activatable_widget = buttonDropdown
        behaviorGroup.add(buttonRow)

        const portalGroup = new Adw.PreferencesGroup({
            title: _('Portal access'),
        })
        this.add(portalGroup)

        portalGroup.add(new Adw.ActionRow({
            title: _('Wayland-safe input injection'),
            subtitle: _('The first start asks GNOME for pointer access through the remote desktop portal.'),
        }))

        portalGroup.add(new Adw.ActionRow({
            title: _('Keyboard toggle'),
            subtitle: this._settings.get_strv(KEY_TOGGLE_SHORTCUT).join(', '),
        }))

        const tokenRow = new Adw.ActionRow({
            title: _('Stored permission'),
        })
        const clearButton = new Gtk.Button({
            label: _('Forget'),
            valign: Gtk.Align.CENTER,
        })
        clearButton.connect('clicked', () => {
            this._settings.set_string(KEY_RESTORE_TOKEN, '')
        })
        tokenRow.add_suffix(clearButton)
        tokenRow.activatable_widget = clearButton
        portalGroup.add(tokenRow)

        const syncTokenState = () => {
            const hasToken = this._settings.get_string(KEY_RESTORE_TOKEN).length > 0
            tokenRow.subtitle = hasToken
                ? _('GNOME can usually reuse your previous pointer grant.')
                : _('No stored grant. GNOME will ask again on the next start.')
            clearButton.sensitive = hasToken
        }
        this._settings.connectObject(
            `changed::${KEY_RESTORE_TOKEN}`,
            syncTokenState,
            this)
        syncTokenState()
    }
})

export default class WaylandAutoclickerPreferences extends ExtensionPreferences {
    getPreferencesWidget() {
        return new AutoclickerPreferencesPage(this.getSettings())
    }
}
