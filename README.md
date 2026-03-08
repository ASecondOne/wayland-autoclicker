# Wayland GNOME Autoclicker

This repo is now a GNOME Shell extension that adds a button to the top bar and opens a dropdown for:

- starting and stopping the autoclicker
- choosing clicks per second
- choosing left, right, or middle click
- toggling the autoclicker with `F8`
- opening a preferences window for finer settings

The click injection path is Wayland-safe for GNOME: it uses GNOME's remote desktop portal instead of X11-only tricks.

## Install on this machine

Run:

```bash
./scripts/install-local.sh
```

That script will:

- compile the GSettings schema
- build a GNOME extension bundle in `build/`
- install the bundle with `gnome-extensions install --force`
- try to enable it immediately
- fall back to marking it enabled for the next GNOME login if the running shell does not rescan newly installed extensions

## Notes

- The first time you start the autoclicker, GNOME may show a permission dialog for pointer access.
- The extension stores the portal restore token so later starts can be smoother.
- It clicks at the current pointer location; it does not move the cursor before clicking.
- If GNOME Shell does not discover the new extension live, log out and back in once.