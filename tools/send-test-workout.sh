#!/bin/bash
# send-test-workout.sh — post fake heart-rate readings through the same
# /api/workout path the iPhone Shortcut uses. For testing only.
#
#   tools/send-test-workout.sh URL PHONE_KEY            25 min at 130 bpm, ending now → qualifies
#   tools/send-test-workout.sh URL PHONE_KEY weak       15 min at 130 bpm → does NOT qualify
set -eu
URL=${1%/}; KEY=$2; KIND=${3:-good}
MINUTES=25; [ "$KIND" = weak ] && MINUTES=15
end=$(date +%s); start=$((end - MINUTES * 60))

iso() { date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
csv=""
for ((t = start; t <= end; t += 30)); do csv+="$(iso $t),130\\n"; done

curl -s -X POST "$URL/api/workout" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"samples_csv\":\"$csv\"}"
echo
