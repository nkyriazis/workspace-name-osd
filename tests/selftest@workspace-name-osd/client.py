#!/usr/bin/env python3
# A plain window for the nested test shell: stays open until killed.
import sys
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import GLib, Gtk

Gtk.init()
win = Gtk.Window(title=sys.argv[1])
win.set_default_size(400, 300)
win.present()
GLib.MainLoop().run()
