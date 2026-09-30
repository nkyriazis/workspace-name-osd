UUID = workspace-name-osd@nkyriazis.github.com
ZIP  = $(UUID).shell-extension.zip

.PHONY: pack install uninstall test shots shots-multi clean

pack:
	gnome-extensions pack $(UUID) --force

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
