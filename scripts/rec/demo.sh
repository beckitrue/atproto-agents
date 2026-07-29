#!/usr/bin/env bash
#
# Demo recording helper — the two things my shell can't do on Becki's desktop:
#   1. show commands + output ON SCREEN so ffmpeg captures them, and
#   2. drive a full-desktop screen recording I can start/stop.
#
# I don't share Becki's display, so beats run through a FIFO into a VISIBLE
# gnome-terminal: I write a command, it renders (prompt + output) on HDMI-1 for
# the camera. ffmpeg grabs the whole 4K monitor to ~/Notes/demo-take-N.mp4.
#
# Usage (from the repo root):
#   scripts/rec/demo.sh term          # open the on-screen "demo$" terminal (env pre-sourced)
#   scripts/rec/demo.sh run '<cmd>'   # run a beat in that terminal, e.g.
#                                     #   run 'node scripts/rogue-move.mjs blue-spymaster demo-rec-1 clue X 2'
#   scripts/rec/demo.sh rec-start     # start recording HDMI-1 → ~/Notes/demo-take-N.mp4
#   scripts/rec/demo.sh arm           # WAIT for Becki to switch to the demo workspace,
#                                     #   settle, THEN start recording (see below)
#   scripts/rec/demo.sh rec-stop      # stop recording (clean MP4 finalize)
#   scripts/rec/demo.sh on-demo-desktop  # exit 0 iff the demo workspace is foreground
#   scripts/rec/demo.sh status        # what's running + which take
#   scripts/rec/demo.sh clean         # tear down FIFO + terminal
#
# 'arm' exists because Becki drives me from a DIFFERENT workspace and loses all
# visibility of this session the moment she switches to the one being recorded.
# So the recorder waits for her, not the reverse: arm polls _NET_CURRENT_DESKTOP
# until the workspace holding the "AT Proto demo" terminal is foreground, waits
# REC_SETTLE seconds so the switch animation is off-camera, then starts ffmpeg.
# Corollary abort signal: switching AWAY from that workspace mid-take means "cut"
# — the take driver polls 'on-demo-desktop' and stops recording when it fails.
#
# Env overrides (defaults target HDMI-1 primary 3840x2160+0+0 on DISPLAY :1):
#   REC_DISPLAY=:1  REC_SIZE=3840x2160  REC_OFFSET=0,0  REC_FPS=30
#   REC_OUT=~/Notes/demo-take-3.mp4     # force an output path instead of auto-take-N
#   REC_DESKTOP=2                       # force the workspace index (else auto-detected)
#   REC_SETTLE=3  REC_ARM_TIMEOUT=300   # arm: post-switch settle / max wait, seconds
#   DEMO_FIFO=/tmp/demo.fifo            # FIFO path
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIFO="${DEMO_FIFO:-/tmp/demo.fifo}"
PIDFILE="/tmp/demo-ffmpeg.pid"
OUTFILE="/tmp/demo-ffmpeg.out"   # remembers the current take's path for status/stop
NOTES_DIR="${HOME}/Notes"

REC_DISPLAY="${REC_DISPLAY:-${DISPLAY:-:1}}"
REC_SIZE="${REC_SIZE:-3840x2160}"
REC_OFFSET="${REC_OFFSET:-0,0}"
REC_FPS="${REC_FPS:-30}"
REC_SETTLE="${REC_SETTLE:-3}"
REC_ARM_TIMEOUT="${REC_ARM_TIMEOUT:-300}"
DEMO_WIN_TITLE="AT Proto demo"

die() { echo "✗ $*" >&2; exit 1; }

# ── workspace helpers ────────────────────────────────────────────────────────
# The demo workspace is wherever the on-screen terminal lives — auto-detected so
# this keeps working if the window gets moved between sessions.
demo_desktop() {
  [ -n "${REC_DESKTOP:-}" ] && { echo "$REC_DESKTOP"; return; }
  local id
  id="$(DISPLAY="$REC_DISPLAY" xdotool search --name "^${DEMO_WIN_TITLE}$" 2>/dev/null | head -1)"
  [ -n "$id" ] || return 1
  DISPLAY="$REC_DISPLAY" xprop -id "$id" _NET_WM_DESKTOP 2>/dev/null | grep -o '[0-9]*$'
}

current_desktop() {
  DISPLAY="$REC_DISPLAY" xprop -root _NET_CURRENT_DESKTOP 2>/dev/null | grep -o '[0-9]*$'
}

cmd_on_demo_desktop() {
  local want cur
  want="$(demo_desktop)" || die "can't find the '$DEMO_WIN_TITLE' window — run 'demo.sh term' first"
  cur="$(current_desktop)"
  [ -n "$want" ] && [ "$want" = "$cur" ]
}

# ── term: launch the visible FIFO-driven terminal ────────────────────────────
cmd_term() {
  command -v gnome-terminal >/dev/null || die "gnome-terminal not found"
  [ -p "$FIFO" ] || { rm -f "$FIFO"; mkfifo "$FIFO"; }
  # exec 3<> keeps the FIFO open read-write, so the reader never hits EOF when a
  # writer closes — many beats over one long-lived terminal. eval runs each line
  # in THIS shell so its output lands on screen. __quit__ ends the loop cleanly.
  gnome-terminal --geometry=120x40 --title="AT Proto demo" -- bash -c '
    cd "'"$REPO_ROOT"'"
    set -a; source infra/.env 2>/dev/null || true; set +a
    exec 3<> "'"$FIFO"'"
    printf "\033[2J\033[H\033[1;36m# on-screen demo terminal — driven over the FIFO\033[0m\n"
    while IFS= read -r cmd <&3; do
      [ "$cmd" = "__quit__" ] && break
      printf "\n\033[1;32mdemo$\033[0m %s\n" "$cmd"
      eval "$cmd" || true
    done
  ' &
  disown || true
  sleep 0.5
  echo "✓ on-screen terminal open (FIFO $FIFO). Drive it with: scripts/rec/demo.sh run '<cmd>'"
}

# ── run: send a beat to the on-screen terminal ───────────────────────────────
cmd_run() {
  [ $# -ge 1 ] || die "usage: demo.sh run '<command>'"
  [ -p "$FIFO" ] || die "no FIFO at $FIFO — run 'demo.sh term' first"
  printf '%s\n' "$*" > "$FIFO"
  echo "→ sent: $*"
}

# ── rec-start: full-desktop x11grab of HDMI-1 ────────────────────────────────
cmd_rec_start() {
  command -v ffmpeg >/dev/null || die "ffmpeg not found"
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    die "already recording (pid $(cat "$PIDFILE"), $(cat "$OUTFILE" 2>/dev/null))"
  fi
  local out
  if [ -n "${REC_OUT:-}" ]; then
    out="${REC_OUT/#\~/$HOME}"
  else
    mkdir -p "$NOTES_DIR"
    local n=1
    while [ -e "${NOTES_DIR}/demo-take-${n}.mp4" ]; do n=$((n + 1)); done
    out="${NOTES_DIR}/demo-take-${n}.mp4"
  fi
  echo "$out" > "$OUTFILE"
  # </dev/null so ffmpeg's stdin-'q' quit reader doesn't swallow the terminal;
  # we stop it with SIGINT, which finalizes the MP4 moov atom cleanly.
  ffmpeg -y -f x11grab -framerate "$REC_FPS" -video_size "$REC_SIZE" \
    -i "${REC_DISPLAY}+${REC_OFFSET}" \
    -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$out" \
    </dev/null >/tmp/demo-ffmpeg.log 2>&1 &
  echo $! > "$PIDFILE"
  sleep 1
  kill -0 "$(cat "$PIDFILE")" 2>/dev/null || { cat /tmp/demo-ffmpeg.log >&2; rm -f "$PIDFILE"; die "ffmpeg failed to start (see /tmp/demo-ffmpeg.log)"; }
  echo "● recording ${REC_SIZE} @${REC_FPS} of ${REC_DISPLAY}+${REC_OFFSET} → $out (pid $(cat "$PIDFILE"))"
}

# ── arm: wait for the demo workspace, settle, then record ────────────────────
cmd_arm() {
  local want cur waited=0
  want="$(demo_desktop)" || die "can't find the '$DEMO_WIN_TITLE' window — run 'demo.sh term' first"
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    die "already recording (pid $(cat "$PIDFILE"))"
  fi
  echo "⏳ armed — waiting for workspace ${want} (the demo workspace) to come to the front."
  echo "   Switch to it now; recording starts ${REC_SETTLE}s after you land. Ctrl-C here to cancel."
  while :; do
    cur="$(current_desktop)"
    [ "$cur" = "$want" ] && break
    waited=$((waited + 1))
    [ "$waited" -ge "$((REC_ARM_TIMEOUT * 2))" ] && die "timed out after ${REC_ARM_TIMEOUT}s waiting for workspace ${want} — nothing recorded"
    sleep 0.5
  done
  echo "✓ workspace ${want} is foreground — settling ${REC_SETTLE}s…"
  sleep "$REC_SETTLE"
  cmd_rec_start
}

# ── rec-stop: clean finalize ─────────────────────────────────────────────────
cmd_rec_stop() {
  [ -f "$PIDFILE" ] || die "not recording"
  local pid; pid="$(cat "$PIDFILE")"
  if kill -0 "$pid" 2>/dev/null; then
    kill -INT "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -0 "$pid" 2>/dev/null && { kill -9 "$pid" 2>/dev/null || true; echo "⚠ force-killed — file may be truncated"; }
  fi
  rm -f "$PIDFILE"
  local out; out="$(cat "$OUTFILE" 2>/dev/null || echo '?')"
  echo "■ stopped. Saved: $out"
  [ -f "$out" ] && ls -lh "$out" | awk '{print "   "$5"  "$9}'
}

# ── status ───────────────────────────────────────────────────────────────────
cmd_status() {
  if [ -p "$FIFO" ]; then echo "terminal: FIFO live at $FIFO"; else echo "terminal: (none — run 'demo.sh term')"; fi
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "recording: ● pid $(cat "$PIDFILE") → $(cat "$OUTFILE" 2>/dev/null)"
  else
    echo "recording: (idle)"
  fi
  local want cur
  if want="$(demo_desktop)"; then
    cur="$(current_desktop)"
    if [ "$want" = "$cur" ]; then
      echo "workspace: demo workspace ${want} is FOREGROUND (on camera)"
    else
      echo "workspace: demo=${want}, foreground=${cur} (demo workspace not on screen)"
    fi
  else
    echo "workspace: (demo terminal window not found)"
  fi
  echo "next auto take: $(next_take)"
}

next_take() {
  [ -n "${REC_OUT:-}" ] && { echo "${REC_OUT}"; return; }
  local n=1
  while [ -e "${NOTES_DIR}/demo-take-${n}.mp4" ]; do n=$((n + 1)); done
  echo "${NOTES_DIR}/demo-take-${n}.mp4"
}

# ── clean ────────────────────────────────────────────────────────────────────
cmd_clean() {
  [ -p "$FIFO" ] && printf '__quit__\n' > "$FIFO" 2>/dev/null || true
  sleep 0.3
  rm -f "$FIFO"
  echo "✓ FIFO removed, on-screen terminal told to quit"
  [ -f "$PIDFILE" ] && echo "  (recording still running — 'demo.sh rec-stop' to finalize)" || true
}

case "${1:-}" in
  term)      cmd_term ;;
  run)       shift; cmd_run "$@" ;;
  rec-start) cmd_rec_start ;;
  arm)       cmd_arm ;;
  rec-stop)  cmd_rec_stop ;;
  on-demo-desktop) cmd_on_demo_desktop ;;
  status)    cmd_status ;;
  clean)     cmd_clean ;;
  *) echo "usage: $0 {term|run '<cmd>'|rec-start|arm|rec-stop|on-demo-desktop|status|clean}" >&2; exit 1 ;;
esac
