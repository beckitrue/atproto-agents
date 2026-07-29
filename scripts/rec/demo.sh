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
#   scripts/rec/demo.sh rec-stop      # stop recording (clean MP4 finalize)
#   scripts/rec/demo.sh status        # what's running + which take
#   scripts/rec/demo.sh clean         # tear down FIFO + terminal
#
# Env overrides (defaults target HDMI-1 primary 3840x2160+0+0 on DISPLAY :1):
#   REC_DISPLAY=:1  REC_SIZE=3840x2160  REC_OFFSET=0,0  REC_FPS=30
#   REC_OUT=~/Notes/demo-take-3.mp4     # force an output path instead of auto-take-N
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

die() { echo "✗ $*" >&2; exit 1; }

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
  rec-stop)  cmd_rec_stop ;;
  status)    cmd_status ;;
  clean)     cmd_clean ;;
  *) echo "usage: $0 {term|run '<cmd>'|rec-start|rec-stop|status|clean}" >&2; exit 1 ;;
esac
