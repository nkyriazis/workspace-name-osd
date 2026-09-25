UUID = workspace-name-osd@nkyriazis.github.com
ZIP  = $(UUID).shell-extension.zip

.PHONY: pack install uninstall test shots clean

pack:
	gnome-extensions pack $(UUID) --force

install: pack
	gnome-extensions install --force $(ZIP)

uninstall:
	gnome-extensions uninstall $(UUID)

test:
	tests/run.sh

shots:
	tests/run.sh shots

clean:
	rm -f $(ZIP)
