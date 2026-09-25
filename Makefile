UUID = workspace-name-osd@nkyriazis.github.com
ZIP  = $(UUID).shell-extension.zip

.PHONY: pack install test shots clean

pack:
	gnome-extensions pack $(UUID) --force

install: pack
	gnome-extensions install --force $(ZIP)

test:
	tests/run.sh

shots:
	tests/run.sh shots

clean:
	rm -f $(ZIP)
