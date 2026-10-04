#!/bin/bash
# maclockoutd.sh — the Mac enforcer. Runs as root under launchd
# (com.randy.maclockout), from boot, forever.
#
# It does not decide anything about workouts or bedtime. It asks the server
# "may Randy use this Mac right now?" and acts on the answer:
#   allowed  → nothing.
#   denied   → whoever is logged in at the screen gets logged out, and logged
#              out again every time they log back in, until the answer changes.
#
# Fail closed: an ALLOW is only good for the lease the server attached to it
# (≤ 15 min). No fresh ALLOW → denied, reason "no_recent_allow".
#
# Mode (file $BASE/mode): "dryrun" only reports "YOU WOULD BE LOCKED OUT";
# "enforce" logs you out. Missing/unknown → dryrun.

set -u
BASE=${MACLOCKOUT_BASE:-/usr/local/maclockout}
CONF=$BASE/config          # root-only: URL, KEY
MODEF=$BASE/mode           # dryrun | enforce
STATE=$BASE/state          # last server answer (world-readable, no secrets)
LOG=$BASE/maclockout.log

TICK=${MACLOCKOUT_TICK:-5}             # seconds between checks of the screen
POLL_SECONDS=${MACLOCKOUT_POLL:-60}    # ask the server this often
DENY_POLL_SECONDS=10                   # …and this often while a logout is pending
GRACE_SECONDS=${MACLOCKOUT_GRACE:-60}  # allowed → denied while you're using it: time to save
RELOGIN_GRACE_SECONDS=${MACLOCKOUT_RELOGIN_GRACE:-10}  # logged in while denied: time to read why
REPORT_EVERY=300                       # dry run: repeat the report this often

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }
isnum() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; }

URL=""; KEY=""
load_conf() {
  [ -f "$CONF" ] && . "$CONF"
  MODE=$(cat "$MODEF" 2>/dev/null | tr -d '[:space:]')
  [ "$MODE" = enforce ] || MODE=dryrun
}

console_user() {
  local u
  u=$(stat -f %Su /dev/console 2>/dev/null)
  case "$u" in ''|root|_*|loginwindow) return 1 ;; esac
  echo "$u"
}

# ---- server ------------------------------------------------------------------
last_fetch=0; last_http=""
fetch() {
  local tmp code present=0
  [ -n "${1:-}" ] && present=1
  tmp=$(mktemp "$BASE/.resp.XXXXXX") || return 1
  code=$(curl -s -m 10 -H "Authorization: Bearer $KEY" -o "$tmp" -w '%{http_code}' \
    "$URL/api/permission?format=text&user_present=$present&mode=$MODE")
  last_fetch=$(date +%s)
  if [ "$code" = 200 ] && grep -qE '^allowed=(true|false)$' "$tmp"; then
    { grep -E '^[a-z_]+=' "$tmp"; echo "received_at=$last_fetch"; } > "$STATE.tmp"
    chmod 644 "$STATE.tmp"; mv -f "$STATE.tmp" "$STATE"
    [ "$last_http" != 200 ] && log "server reachable (http 200)"
  else
    [ "$last_http" != "$code" ] && log "server problem: http ${code:-none} — keeping last answer until its lease runs out"
  fi
  last_http=$code
  rm -f "$tmp"
}
field() { sed -n "s/^$1=//p" "$STATE" 2>/dev/null | head -n 1; }

# Sets ALLOWED (1/0) and REASON from the last server answer and its lease.
evaluate() {
  local allowed received lease now
  now=$(date +%s)
  allowed=$(field allowed); received=$(field received_at); lease=$(field lease_seconds)
  isnum "$received" || received=0
  isnum "$lease" || lease=0
  if [ "$allowed" = true ] && [ "$now" -ge "$received" ] && [ "$now" -lt $((received + lease)) ]; then
    ALLOWED=1; REASON=""
  elif [ "$allowed" = false ]; then
    ALLOWED=0; REASON=$(field reason)
  else
    ALLOWED=0; REASON=no_recent_allow
  fi
  case "$REASON" in *[!a-z_]*) REASON=unknown ;; esac
  [ "$ALLOWED" = 0 ] && [ -z "$REASON" ] && REASON=unknown
  return 0
}

# ---- talking to / removing the person at the screen --------------------------
tell_user() {   # $1 user, $2 message (our own text only — no quotes in it)
  local uid
  uid=$(id -u "$1" 2>/dev/null) || return 0
  launchctl asuser "$uid" sudo -u "$1" osascript -e \
    "display dialog \"$2\" with title \"Mac Lockout\" buttons {\"OK\"} default button 1 with icon stop giving up after 60" \
    >/dev/null 2>&1 &
}

log_out() {     # $1 user
  local u=$1 uid i
  uid=$(id -u "$u" 2>/dev/null) || return 0
  log "LOGGING OUT $u (reason: $REASON)"
  # 1. Ask nicely (apps get to quit; no "are you sure" box).
  launchctl asuser "$uid" sudo -u "$u" osascript -e 'tell application "loginwindow" to «event aevtrlgo»' >/dev/null 2>&1 &
  for i in $(seq 1 15); do sleep 1; [ "$(console_user)" = "$u" ] || { log "logged out $u"; return 0; }; done
  # 2. Insist.
  log "polite logout didn't finish — ending the session"
  launchctl bootout "gui/$uid" >/dev/null 2>&1 &
  for i in $(seq 1 10); do sleep 1; [ "$(console_user)" = "$u" ] || { log "logged out $u"; return 0; }; done
  # 3. Last resort.
  pkill -9 -u "$uid" loginwindow
  log "killed loginwindow for $u"
}

# ---- main loop ---------------------------------------------------------------
mkdir -p "$BASE"; touch "$LOG"; chmod 644 "$LOG"
load_conf
log "started (pid $$, mode $MODE)"
prev_allowed=""; prev_key=""; logout_at=0; logout_user=""; last_report=0

while true; do
  load_conf
  [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 5000 ] && { tail -n 2000 "$LOG" > "$LOG.tmp"; mv -f "$LOG.tmp" "$LOG"; }
  now=$(date +%s)
  u=$(console_user) || u=""
  evaluate

  # Ask the server on schedule — and right away before acting against someone at the screen.
  if [ $((now - last_fetch)) -ge "$POLL_SECONDS" ] || [ "$now" -lt "$last_fetch" ] ||
     { [ "$ALLOWED" = 0 ] && [ -n "$u" ] && [ "$MODE" = enforce ] && [ $((now - last_fetch)) -ge "$DENY_POLL_SECONDS" ]; }; then
    fetch "$u"; evaluate
  fi

  key="$ALLOWED:$REASON:$MODE"
  if [ "$key" != "$prev_key" ]; then
    if [ "$ALLOWED" = 1 ]; then log "ALLOWED (lease $(field lease_seconds)s, mode $MODE)"
    else log "DENIED: $REASON (mode $MODE)"; fi
  fi

  if [ "$ALLOWED" = 1 ]; then
    [ "$logout_at" -gt 0 ] && log "allowed again — pending logout cancelled"
    logout_at=0
  elif [ -n "$u" ]; then
    if [ "$MODE" = dryrun ]; then
      if [ "$key" != "$prev_key" ] || [ $((now - last_report)) -ge "$REPORT_EVERY" ]; then
        log "YOU WOULD BE LOCKED OUT: $REASON (dry run — $u stays logged in)"
        tell_user "$u" "YOU WOULD BE LOCKED OUT: $REASON. (Dry run - nothing will happen.)"
        last_report=$now
      fi
      logout_at=0
    elif [ "$logout_at" -eq 0 ] || [ "$logout_user" != "$u" ]; then
      if [ "$prev_allowed" = 1 ]; then g=$GRACE_SECONDS; else g=$RELOGIN_GRACE_SECONDS; fi
      logout_at=$((now + g)); logout_user=$u
      log "DENIED with $u at the screen: $REASON — logging out in ${g}s"
      tell_user "$u" "This Mac is locked: $REASON. Logging out in $g seconds."
    elif [ "$now" -ge "$logout_at" ]; then
      log_out "$u"
      logout_at=0
    fi
  else
    logout_at=0
  fi

  prev_allowed=$ALLOWED; prev_key=$key
  sleep "$TICK"
done
