#!/bin/bash
# install.sh — installs (or updates) the Mac Lockout daemon. From this folder:
#   sudo ./install.sh https://YOUR-APP.vercel.app MAC_KEY HEALTHCHECK_PING_URL    first time
#   sudo ./install.sh                                        update scripts, keep URL/keys/mode
# A fresh install always starts in dryrun mode.
set -eu

[ "$(uname)" = Darwin ] || { echo "This is for macOS."; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo:  sudo ./install.sh …"; exit 1; }

HERE=$(cd "$(dirname "$0")" && pwd)
BASE=/usr/local/maclockout
LABEL=com.randy.maclockout
PLIST=/Library/LaunchDaemons/$LABEL.plist

mkdir -p "$BASE" /usr/local/bin
if [ $# -ge 3 ]; then
  printf 'URL="%s"\nKEY="%s"\nHC_URL="%s"\n' "${1%/}" "$2" "${3%/}" > "$BASE/config"
elif [ ! -f "$BASE/config" ]; then
  echo "First install needs:  sudo ./install.sh https://YOUR-APP.vercel.app MAC_KEY HEALTHCHECK_PING_URL"; exit 1
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

# Restart the daemon. bootout returns before macOS has finished removing the
# service, and bootstrapping too soon fails with "Bootstrap failed: 5", leaving
# it stopped. So wait until it's gone, retry the bootstrap, and check it's running.
launchctl bootout "system/$LABEL" 2>/dev/null || true
for _ in $(seq 20); do launchctl print "system/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
for try in 1 2 3 4 5; do
  launchctl bootstrap system "$PLIST" 2>/dev/null && break
  [ "$try" = 5 ] || sleep 2
done
running=no
for _ in $(seq 10); do pgrep -f "$BASE/maclockoutd.sh" >/dev/null && { running=yes; break; }; sleep 1; done
if [ "$running" != yes ]; then
  echo "The daemon didn't start. Start it with:"
  echo "  sudo launchctl bootstrap system $PLIST"
  exit 1
fi

echo
echo "Installed. Mode: $(cat "$BASE/mode")"
sleep 3
/usr/local/bin/maclockout status || true
