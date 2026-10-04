#!/bin/bash
# simulate-mac.sh — runs the real maclockoutd.sh against the local server, with
# the macOS-only commands (stat /dev/console, launchctl, pkill, id) faked.
# Not a substitute for the real Mac test; it checks the daemon's logic.
#   bash server/test/simulate-mac.sh      (from the repo root, on Linux or macOS)
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$(mktemp -d); FAKE=$W/fake; BIN=$W/bin; BASE=$W/maclockout
mkdir -p "$FAKE" "$BIN" "$BASE"
PORT=${PORT:-8799}; URL=http://127.0.0.1:$PORT
echo root > "$FAKE/console"

cat > "$BIN/stat" <<EOF
#!/bin/bash
[ "\$*" = "-f %Su /dev/console" ] && { cat "$FAKE/console"; exit 0; }
exec /usr/bin/stat "\$@"
EOF
cat > "$BIN/id" <<'EOF'
#!/bin/bash
[ "$1" = -u ] && [ -n "${2:-}" ] && { echo 501; exit 0; }
exec /usr/bin/id "$@"
EOF
cat > "$BIN/launchctl" <<EOF
#!/bin/bash
echo "launchctl \$*" >> "$FAKE/calls"
case "\$*" in
  *aevtrlgo*) [ -f "$FAKE/polite_works" ] && echo root > "$FAKE/console" ;;
  "bootout gui/"*) echo root > "$FAKE/console" ;;
esac
EOF
cat > "$BIN/pkill" <<EOF
#!/bin/bash
echo "pkill \$*" >> "$FAKE/calls"; echo root > "$FAKE/console"
EOF
chmod +x "$BIN"/*

pass=0; fail=0
ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail+1)); }
waitlog() { # pattern timeout
  local i; for i in $(seq 1 "$2"); do grep -q -- "$1" "$BASE/maclockout.log" 2>/dev/null && return 0; sleep 1; done; return 1; }
expect() { if waitlog "$1" "${3:-15}"; then ok "$2"; else bad "$2 (wanted: $1)"; fi; }
console() { echo "$1" > "$FAKE/console"; }
newlog() { : > "$BASE/maclockout.log"; }

# ── server ──
( cd "$ROOT/server" && PORT=$PORT MAC_KEY=m PHONE_KEY=p ADMIN_KEY=a DEV_RECOVERY=on node test/local-server.js > "$W/server.log" 2>&1 ) &
SPID=$!; sleep 1.5

printf 'URL="%s"\nKEY="m"\n' "$URL" > "$BASE/config"
echo dryrun > "$BASE/mode"
console randy

PATH="$BIN:$PATH" MACLOCKOUT_BASE=$BASE MACLOCKOUT_TICK=1 MACLOCKOUT_POLL=3 MACLOCKOUT_GRACE=4 MACLOCKOUT_RELOGIN_GRACE=2 \
  bash "$ROOT/mac/maclockoutd.sh" &
DPID=$!
trap 'kill $DPID $SPID 2>/dev/null; rm -rf "$W"' EXIT

NIGHT=$(curl -s "$URL/api/permission?key=a&format=text" | sed -n 's/^night_active=//p')
REASON=workout_noncompliance; [ "$NIGHT" = true ] && REASON=nightly_lockout
echo "(server says night_active=$NIGHT → expected reason $REASON)"

echo "Step 2 — dry run, noncompliant"
expect "YOU WOULD BE LOCKED OUT: $REASON" "dry run reports the lockout"
[ "$(cat "$FAKE/console")" = randy ] && ok "still logged in" || bad "was logged out in dry run"
grep -q 'aevtrlgo\|bootout gui' "$FAKE/calls" 2>/dev/null && bad "logout attempted in dry run" || ok "no logout attempted"
PATH="$BIN:$PATH" MACLOCKOUT_BASE=$BASE bash "$ROOT/mac/maclockout" status | grep -q "YOU WOULD BE LOCKED OUT" \
  && ok "maclockout status shows it" || bad "maclockout status"

echo "Recovery check — dev override flips to ALLOWED, clearing it flips back"
curl -s "$URL/api/admin?key=a&action=override&minutes=5" > /dev/null; newlog
expect "ALLOWED" "override → ALLOWED"
curl -s "$URL/api/admin?key=a&action=clear-override" > /dev/null; newlog
expect "DENIED: $REASON" "cleared → DENIED again"

echo "Step 3 — enforce"
newlog; : > "$FAKE/calls"; echo enforce > "$BASE/mode"
expect "logging out in" "logout scheduled"
expect "logged out randy" "randy logged out" 40
grep -q 'bootout gui/501' "$FAKE/calls" && ok "polite logout refused → bootout used" || bad "bootout not used"
newlog; console randy
expect "logged out randy" "logging back in → logged out again" 40

echo "Step 4/5 — workout"
newlog
R=$(bash "$ROOT/tools/send-test-workout.sh" "$URL" p weak)
echo "$R" | grep -q '"pass": false' && ok "weak workout doesn't qualify" || bad "weak workout: $R"
R=$(bash "$ROOT/tools/send-test-workout.sh" "$URL" p)
echo "$R" | grep -q '"pass": true' && ok "good workout qualifies" || bad "good workout: $R"
if [ "$NIGHT" = true ]; then
  echo "  (night in New York — skipping the ALLOW checks)"
else
  console randy; : > "$FAKE/calls"
  expect "ALLOWED" "server ALLOW reaches the Mac"
  sleep 6
  [ "$(cat "$FAKE/console")" = randy ] && ok "stays logged in after workout" || bad "logged out despite ALLOW"

  echo "Allowed → denied while in use gets the long grace"
  newlog; curl -s "$URL/api/admin?key=a&action=reset-workouts" > /dev/null
  expect "logging out in 4s" "long grace used"
  expect "logged out randy" "logged out after grace" 40
fi

echo "Events on the server"
curl -s "$URL/api/events?key=a" | grep -o '"type": "[a-z-]*"' | sort | uniq -c | sed 's/^/    /'

echo "Fail closed — server gone"
kill $DPID 2>/dev/null; wait $DPID 2>/dev/null
cat > "$BASE/state" <<EOF
allowed=true
reason=
lease_seconds=4
received_at=$(date +%s)
EOF
echo dryrun > "$BASE/mode"; newlog; console randy
printf 'URL="http://127.0.0.1:1"\nKEY="m"\n' > "$BASE/config"
PATH="$BIN:$PATH" MACLOCKOUT_BASE=$BASE MACLOCKOUT_TICK=1 MACLOCKOUT_POLL=2 bash "$ROOT/mac/maclockoutd.sh" &
DPID=$!
expect "ALLOWED" "cached ALLOW honored while the lease lasts" 5
expect "YOU WOULD BE LOCKED OUT: no_recent_allow" "lease expired → denied" 15

echo; echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
