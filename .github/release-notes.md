Automatisch erzeugt beim Push auf `main`. Vor der Veröffentlichung wurde das gepackte Programm auf jeder Plattform gestartet und hat eine lokale Shell sowie eine SSH-Sitzung gegen den Testserver aufgebaut. Die Installer selbst wurden dabei nicht ausgeführt.

**Nicht signiert:** Windows SmartScreen und macOS Gatekeeper warnen beim ersten Start.

| Plattform | Datei |
| --- | --- |
| Windows x64 | `RYFT.Setup.<Version>.exe` |
| macOS Apple Silicon | `RYFT-<Version>-arm64.dmg` |
| Linux x64 | `RYFT-<Version>.AppImage`, `ryft_<Version>_amd64.deb` |
