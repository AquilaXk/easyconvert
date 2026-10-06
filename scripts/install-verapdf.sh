#!/usr/bin/env bash
# Installs a pinned veraPDF release, the PDF/A validator the PDF/A post-process requires.
# The release archive is verified against a fixed SHA-256 before anything in it runs.
#
# Usage: install-verapdf.sh [install-dir]   (default /opt/verapdf; needs a Java 11+ runtime on PATH)
set -euo pipefail

VERAPDF_VERSION="1.30.2"
VERAPDF_URL="https://software.verapdf.org/rel/1.30/verapdf-greenfield-${VERAPDF_VERSION}-installer.zip"
VERAPDF_SHA256="6cc6341cb1af644044054b81f00a6590a7918abb18f762243de115258bcad838"
INSTALL_DIR="${1:-/opt/verapdf}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL --retry 3 -o "$work/verapdf.zip" "$VERAPDF_URL"
echo "${VERAPDF_SHA256}  $work/verapdf.zip" | sha256sum -c -
unzip -q "$work/verapdf.zip" -d "$work"

# Unattended installer answers: command-line tools only (the GUI pack is required by the installer).
cat > "$work/auto.xml" <<XML
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<AutomatedInstallation langpack="eng">
<com.izforge.izpack.panels.htmlhello.HTMLHelloPanel id="welcome"/>
<com.izforge.izpack.panels.target.TargetPanel id="install_dir"><installpath>${INSTALL_DIR}</installpath></com.izforge.izpack.panels.target.TargetPanel>
<com.izforge.izpack.panels.packs.PacksPanel id="sdk_pack_select">
<pack index="0" name="veraPDF GUI" selected="true"/>
<pack index="1" name="veraPDF Batch files" selected="true"/>
<pack index="2" name="veraPDF Validation model" selected="false"/>
<pack index="3" name="veraPDF Documentation" selected="false"/>
<pack index="4" name="veraPDF Sample Plugins" selected="false"/>
</com.izforge.izpack.panels.packs.PacksPanel>
<com.izforge.izpack.panels.install.InstallPanel id="install"/>
<com.izforge.izpack.panels.finish.FinishPanel id="finish"/>
</AutomatedInstallation>
XML

java -jar "$work/verapdf-greenfield-${VERAPDF_VERSION}/verapdf-izpack-installer-${VERAPDF_VERSION}.jar" "$work/auto.xml"
ln -sf "${INSTALL_DIR}/verapdf" /usr/local/bin/verapdf
verapdf --version
