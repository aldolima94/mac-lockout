#!/bin/bash
# install.sh — installs (or updates) the Mac Lockout daemon. From this folder:
#   sudo ./install.sh https://YOUR-APP.vercel.app MAC_KEY    first time
#   sudo ./install.sh                                        update scripts, keep URL/key/mode
# A fresh install always starts in dryrun mode.
set -eu

[ "$(uname)" = Darwin ] || { echo "This is for macOS."; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo:  sudo ./install.sh …"; exit 1; }

HERE=$(cd "$(dirname "$0")" && pwd)
BASE=/usr/local/maclockout
LABEL=com.randy.maclockout
PLIST=/Library/LaunchDaemons/$LABEL.plist

mkdir -p "$BASE" /usr/local/bin
if [ $# -ge 2 ]; then
  printf 'URL="%s"\nKEY="%s"\n' "${1%/}" "$2" > "$BASE/config"
elif [ ! -f "$BASE/config" ]; then
  echo "First install needs the server URL and MAC_KEY:  sudo ./install.sh https://YOUR-APP.vercel.app MAC_KEY"; exit 1
fi
. "$BASE/config"

echo "Checking the server…"
code=$(curl -s -m 10 -o /tmp/maclockout-check -w '%{http_code}' -H "Authorization: Bearer $KEY" "$URL/api/permission?format=text") || true
if [ "$code" != 200 ]; then
  echo "The server answered http ${code:-nothing} (expected 200). Check the URL and MAC_KEY. Nothing installed."; exit 1
fi
sed 's/^/  /' /tmp/maclockout-check; rm -f /tmp/maclockout-check

install -m 755 -o root -g wheel "$HERE/maclockoutd.sh" "$BASE/maclockoutd.sh"
install -m 755 -o root -g wheel "$HERE/maclockout" /usr/local/bin/maclockout
install -m 644 -o root -g wheel "$HERE/$LABEL.plist" "$PLIST"
[ -f "$BASE/mode" ] || echo dryrun > "$BASE/mode"
chown -R root:wheel "$BASE"
chmod 755 "$BASE"; chmod 600 "$BASE/config"; chmod 644 "$BASE/mode"

launchctl bootout "system/$LABEL" 2>/dev/null || true
launchctl bootstrap system "$PLIST"

echo
echo "Installed. Mode: $(cat "$BASE/mode")"
sleep 3
/usr/local/bin/maclockout status || true
