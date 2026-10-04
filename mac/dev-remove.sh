#!/bin/bash
# dev-remove.sh — DEVELOPMENT ONLY. Stops and removes the Mac Lockout daemon
# (config, state and log stay in /usr/local/maclockout so a reinstall picks up
# where it left off). Delete this file when development is over.
#   sudo ./dev-remove.sh
set -u
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo:  sudo ./dev-remove.sh"; exit 1; }
launchctl bootout system/com.randy.maclockout 2>/dev/null
rm -f /Library/LaunchDaemons/com.randy.maclockout.plist /usr/local/bin/maclockout
echo "Mac Lockout daemon stopped and removed."
