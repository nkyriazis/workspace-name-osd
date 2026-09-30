UUID = workspace-name-osd@nkyriazis.github.com
ZIP  = $(UUID).shell-extension.zip

.PHONY: pack install uninstall test shots shots-multi clean

# What goes in the zip for users and extensions.gnome.org. Plain zip, so the
# same command works here and on GitHub, where GNOME is not installed.
FILES = metadata.json extension.js stylesheet.css \
        schemas/org.gnome.shell.extensions.workspace-name-osd.gschema.xml

pack:
	rm -f $(ZIP)
	cd $(UUID) && zip -q -X ../$(ZIP) $(FILES)

install: pack
	gnome-extensions install --force $(ZIP)

uninstall:
	gnome-extensions uninstall $(UUID)

MULTI = 1920x1080 1280x1024 1600x900

test:
	tests/run.sh
	WSOSD_MONITORS="$(MULTI)" tests/run.sh

shots:
	tests/run.sh shots

shots-multi:
	WSOSD_MONITORS="$(MULTI)" tests/run.sh shots

clean:
	rm -f $(ZIP)
