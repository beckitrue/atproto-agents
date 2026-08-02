#!/usr/bin/env bash
#
# demo.sh — the live BSidesLV run, one verb per beat.
#
# Runs ON THE EC2 HOST, inside an interactive SSM shell, from the repo root:
#     cd /home/ubuntu/atproto-agents && ./scripts/demo.sh <verb>
#
# Everything the beats need (engine auth, agent + guest PDS passwords,
# ANTHROPIC_API_KEY, FGA) already lives in infra/.env on this box, so nothing
# has to be forwarded or copied to a laptop. Each verb is self-contained: it
# re-sources the env, reads live game state, and figures out the off-turn team
# and an unrevealed word itself — you type the verb, nothing else.
#
# Verbs: check | start | beat2 | beat3 | beat4 | beat5 | grant | guest-guess
#        revoke | cleanup | status | relaunch
#
#aws ssm start-session --target i-0b952f691aa3efe83 --profile wrm-dev --region us-east-2
#sudo su - ubuntu
#cd /home/ubuntu/atproto-agents
#
#./scripts/demo.sh check     # T-1hr: everything green
#./scripts/demo.sh start     # Act 0 — game + 4 agents; beat 1 runs itself
#./scripts/demo.sh beat2     # off-turn spymaster clue        → ⛔
#./scripts/demo.sh beat3     # operative key ⛔, spymaster key ✅
#./scripts/demo.sh beat4     # spymaster guess                → ⛔
#./scripts/demo.sh beat5     # guest speaks, federates        → ⛔
#./scripts/demo.sh grant       # grant tuple only (before→after diff)
#./scripts/demo.sh guest-guess # imateapot submits             → ✅ (granted) / ⛔ (revoked)
#./scripts/demo.sh revoke      # revoke tuple only (before→after diff)
#./scripts/demo.sh cleanup     # stop agents + clean FGA
#
# Config (override via env if you must):
# The active game id, resolved in this order:
#   1. DEMO_GAME=... in the environment (explicit override, always wins)
#   2. the id `start` / `relaunch` last wrote to DEMO_STATE
#   3. DEMO_GAME_DEFAULT
#
# Why the state file: a game id is single-use until the engine restarts (games
# live in an in-memory Map with no DELETE route, so re-creating one returns
# 409 "game exists"). `relaunch` therefore moves the demo to a FRESH id, and
# every later verb — beats, grant, guest-guess, revoke, cleanup — has to follow
# it. Making the operator re-pass DEMO_GAME on each one is a footgun: a beat run
# against the dead game still prints ⛔, because FGA denies on a finished game
# just as readily, so the mistake looks exactly like success. Every banner
# echoes the active id, so this state is visible rather than hidden.
DEMO_GAME_DEFAULT="${DEMO_GAME_DEFAULT:-bsideslv-live}"
DEMO_STATE="${DEMO_STATE:-/tmp/demo-current-game}"
DEMO_SEED="${DEMO_SEED:-42}"                   # fixed seed => reproducible board across rehearsals
# Pace = artificial delay before each agent move. It STACKS on top of however
# long the move itself takes, so the right value depends on whether the agents
# are really reaching Claude:
#   live LLM  — a clue costs ~15s of real thinking, a guess ~5s. That is already
#               the pacing; only a little padding is wanted on top.
#   scripted  — the fallback brain decides in ~0ms, so the pace is the ONLY
#               thing slowing the game and has to carry the whole cadence.
# 'auto' pings the API in ./demo check|start and picks accordingly; set
# DEMO_PACE to a number to override.
DEMO_PACE="${DEMO_PACE:-auto}"
DEMO_PACE_LLM="${DEMO_PACE_LLM:-3000}"           # ms, when the LLM answers
DEMO_PACE_SCRIPTED="${DEMO_PACE_SCRIPTED:-9000}" # ms, when we've fallen back to scripted
GUEST_HANDLE="${GUEST_HANDLE:-imateapot.dev}"  # the foreign guest identity
GUEST_DID="${GUEST_DID:-did:plc:hwp2bnldopc4e6xgh34wz5yu}"
OBSERVER_URL="${OBSERVER_URL:-https://observer.beckitrue.com}"

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# --- environment: load the box's secrets, point scripts at the local stack ---
set -a
# shellcheck disable=SC1091
source infra/.env
set +a
export ENGINE_URL="${GAME_ENGINE_URL:-https://game.beckitrue.com}"
# FGA_API_URL defaults to http://localhost:8080 inside the scripts, which is the
# local OpenFGA on this box — no tunnel needed when running here.
export FGA_API_URL="${FGA_API_URL:-http://localhost:8080}"

# The CLI scripts (grant-guest, cleanup-fga-game) interpolate $FGA_STORE_ID
# straight into the request URL, but the box's infra/.env leaves it blank — the
# engine resolves the store by NAME instead. Do the same here so grant/kill/
# cleanup get a valid store id even when the env var is empty.
if [ -z "${FGA_STORE_ID:-}" ]; then
  FGA_STORE_ID="$(curl -s "$FGA_API_URL/stores" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      try { const j=JSON.parse(s); const st=(j.stores||[]).find(x=>x.name==="codenames")||(j.stores||[])[0];
            process.stdout.write(st ? st.id : ""); } catch { process.stdout.write(""); }
    });')"
  export FGA_STORE_ID
fi

if [ -n "${DEMO_GAME:-}" ]; then
  GAME="$DEMO_GAME";              GAME_SRC="DEMO_GAME override"
elif [ -s "$DEMO_STATE" ]; then
  GAME="$(cat "$DEMO_STATE")";    GAME_SRC="last start/relaunch, via $DEMO_STATE"
else
  GAME="$DEMO_GAME_DEFAULT";      GAME_SRC="default"
fi

# --- tiny helpers ------------------------------------------------------------
# Every banner carries the active game id — after a relaunch the demo is on a
# different game, and that must never be something you have to remember.
banner() { printf '\n\033[1;36m=== %s ===\033[0m \033[2m[game: %s]\033[0m\n' "$*" "$GAME"; }
note()   { printf '\033[2m%s\033[0m\n' "$*"; }
die()    { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

# Fetch live game state and extract one field via node (node is on the box).
#   _state turn            -> red|blue
#   _state offteam         -> the team NOT on turn
#   _state unrevealed      -> one currently-unrevealed board word
#   _state phase|winner    -> passthrough
_state() {
  curl -s "$ENGINE_URL/games/$GAME" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      let j; try { j = JSON.parse(s); } catch { process.exit(3); }
      if (j.error) { console.error(j.error); process.exit(4); }
      const field = process.argv[1];
      const board = j.board || [];
      const unrevealed = board.filter(c => !c.revealed).map(c => c.word);
      if (field === "turn")        return console.log(j.turn ?? "");
      if (field === "offteam")     return console.log(j.turn === "red" ? "blue" : "red");
      if (field === "onteam")      return console.log(j.turn ?? "");
      if (field === "unrevealed")  return console.log(unrevealed[0] ?? "");
      if (field === "phase")       return console.log(j.phase ?? "");
      if (field === "winner")      return console.log(j.winner ?? "");
      if (field === "unrevealed_n")return console.log(String(unrevealed.length));
      console.log(JSON.stringify(j));
    });' "$1"
}

_require_game() {
  local t; t="$(_state turn)" || die "game '$GAME' not found — run './demo start' first."
  [ -n "$t" ] || die "game '$GAME' not found — run './demo start' first."
}

# All currently-unrevealed board words, one per line.
_unrevealed_words() {
  curl -s "$ENGINE_URL/games/$GAME" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      let j; try { j = JSON.parse(s); } catch { process.exit(3); }
      (j.board||[]).filter(c=>!c.revealed).forEach(c=>console.log(c.word));
    });'
}

WORDFILE="/tmp/demo-word-${GAME}.txt"   # beat 5's word, reused by the closer

# The scripts import the workspace packages (@atproto-agents/lexicon, …) from
# their compiled dist/. The engine runs from its own Docker build, so a fresh
# checkout has no dist until this runs.
#
# Why the workspace needs (re)building, if it does. Empty output = dist is current.
#
# Presence alone is not enough: a dist compiled before the last source edit passes
# an existence check and then silently runs stale code — e.g. a dist predating the
# --pace commit would make the agents ignore pacing entirely, with no error. Same
# trap the old ANTHROPIC_API_KEY check fell into: checked that it was there, not
# that it was right. Compare mtimes instead.
#
# A `git checkout` rewrites source mtimes even when content is unchanged, so this
# errs toward rebuilding. That is the safe direction — the build is idempotent and
# takes ~20s.
_build_reason() {
  local p
  for p in lexicon agents; do
    [ -f "packages/$p/dist/index.js" ] || { echo "dist missing"; return; }
  done
  for p in lexicon agents; do
    if [ -n "$(find "packages/$p/src" -name '*.ts' -newer "packages/$p/dist/index.js" -print -quit 2>/dev/null)" ]; then
      echo "src newer than dist"
      return
    fi
  done
  echo ""
}

_ensure_build() {
  local why; why="$(_build_reason)"
  [ -n "$why" ] || return 0
  echo "building workspace packages ($why; ~20s)…"
  npm run build >/tmp/demo-build.log 2>&1 || { echo "build failed — see /tmp/demo-build.log" >&2; return 1; }
  echo "build done."
}

# Ensure the registry's guest entry is the identity we're actually using, so
# guest-move.mjs logs in as GUEST_HANDLE with GUEST_AGENT_PDS_PASSWORD.
_ensure_guest_registry() {
  node -e '
    const fs=require("fs"), p="infra/agents.json";
    const j=JSON.parse(fs.readFileSync(p,"utf8"));
    const g=j.agents.find(a=>a.role==="guest");
    if(!g){ console.error("no guest entry in agents.json"); process.exit(1); }
    const H=process.argv[1], D=process.argv[2];
    if(g.handle===H && g.did===D){ console.log(`registry guest already ${H}`); process.exit(0); }
    g.handle=H; g.did=D;
    fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");
    console.log(`registry guest set -> ${H} (${D})`);
  ' "$GUEST_HANDLE" "$GUEST_DID"
}

# A real one-token call against the model the agents will actually use. Proves
# the key is VALID, not merely present: a stale key passes a non-empty check and
# then silently degrades every agent to the scripted brain (withFallback() in
# brain.ts swallows the error), which looks like a working demo with dull clues
# and no 🧠 thinking. Sets LLM_PING_ERR on failure. Never prints the key.
LLM_PING_ERR=""
LLM_PING_RC=""   # cached: key and model can't change mid-run, so ping only once
_llm_ping() {
  [ -z "$LLM_PING_RC" ] || return "$LLM_PING_RC"
  local model="${ANTHROPIC_MODEL:-claude-opus-4-8}"
  LLM_PING_ERR=""
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    LLM_PING_ERR="ANTHROPIC_API_KEY not set in infra/.env"
    LLM_PING_RC=1; return 1
  fi
  local out code body
  out="$(curl -s -m 20 -w '\n%{http_code}' https://api.anthropic.com/v1/messages \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H 'anthropic-version: 2023-06-01' \
    -H 'content-type: application/json' \
    -d "{\"model\":\"$model\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}")" \
    || { LLM_PING_ERR="could not reach api.anthropic.com"; LLM_PING_RC=1; return 1; }
  code="${out##*$'\n'}"
  body="${out%$'\n'*}"
  if [ "$code" = 200 ]; then LLM_PING_RC=0; return 0; fi
  LLM_PING_ERR="HTTP $code — $(printf '%s' "$body" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      try { const j = JSON.parse(s); process.stdout.write((j.error && j.error.message) || s.slice(0,200)); }
      catch { process.stdout.write(s.slice(0,200)); }
    });')"
  LLM_PING_RC=1
  return 1
}

# Pick the pace for ./demo start. See the DEMO_PACE comment above for why the
# live-LLM and scripted numbers differ by 3x.
RESOLVED_PACE=""
PACE_WHY=""
_resolve_pace() {
  if [ "$DEMO_PACE" != auto ]; then
    RESOLVED_PACE="$DEMO_PACE"
    PACE_WHY="DEMO_PACE override"
  elif _llm_ping; then
    RESOLVED_PACE="$DEMO_PACE_LLM"
    PACE_WHY="live LLM — ~15s/clue + ~5s/guess of real thinking lands on top"
  else
    RESOLVED_PACE="$DEMO_PACE_SCRIPTED"
    PACE_WHY="scripted fallback — pace carries the whole cadence"
  fi
}

# Stop every running agent, whatever game it belongs to.
#
# The obvious pattern does NOT work: agents are launched as
#   npm run agent -w @atproto-agents/agents -- --name red-spymaster --game X …
# but npm rewrites its own argv, so the live process reads
#   npm run agent --name red-spymaster --game X …
# with `-w @atproto-agents/agents --` gone. Matching on that string found only
# the transient `bash -c` wrapper in the moment before bash exec'd into npm —
# so it appeared to work right after launch and silently matched nothing
# thereafter. `cleanup` printed "no agents running" while 28 agent processes
# were live across two games, still calling the API.
#
# --name/--game survives into every layer (npm, tsx, node), so match on that.
#
# Anchored to an npm/node argv[0] so the pattern can only ever match an actual
# agent. Without the anchor it also matches any *shell* whose command line
# happens to contain the pattern text — which is not theoretical: while testing
# this, a harness that inlined the pattern pkill'd its own shell. A script run
# as `bash ./scripts/demo.sh cleanup` is safe either way, but the anchor costs
# nothing and removes the footgun for anyone wrapping this in `bash -c`.
#
# Deliberately NOT scoped per-game: both callers want everything stopped, and a
# per-game match needs a boundary or `--game bsideslv-live` also kills
# `--game bsideslv-live-2` (verified on the box: 28 matches vs 16 with a boundary).
AGENT_PAT='^[^ ]*(npm|node) .*--name [a-z-]+ --game'
_stop_agents() {
  local n
  n="$(pgrep -fc -- "$AGENT_PAT" 2>/dev/null)" || n=0
  if [ "${n:-0}" -gt 0 ]; then
    pkill -f -- "$AGENT_PAT" 2>/dev/null
    sleep 2
    pkill -9 -f -- "$AGENT_PAT" 2>/dev/null   # npm children that ignored TERM
    local left; left="$(pgrep -fc -- "$AGENT_PAT" 2>/dev/null)" || left=0
    if [ "${left:-0}" -gt 0 ]; then
      echo "  WARNING: $left agent process(es) survived — check 'ps -ef | grep -- --game'" >&2
    else
      echo "  stopped $n agent process(es)"
    fi
  else
    echo "  no agents running"
  fi
}

# Launch the four agents against $GAME. Shared by `start` and `relaunch` so the
# contingency path can't drift from the one rehearsed.
_launch_agents() {
  _resolve_pace
  if [ "$DEMO_PACE" = auto ] && [ -n "$LLM_PING_ERR" ]; then
    printf '\n\033[1;31m!! LLM UNREACHABLE: %s\033[0m\n' "$LLM_PING_ERR" >&2
    note "   agents will run SCRIPTED — no 🧠 thinking, no real clues."
    note "   pacing to ${RESOLVED_PACE}ms so the game still reads at a human cadence."
  fi
  banner "launch four LLM agents (detached; logs in /tmp/demo-agent-*.log; pace ${RESOLVED_PACE}ms/move)"
  for a in red-spymaster red-operative blue-spymaster blue-operative; do
    setsid bash -c "cd '$ROOT'; set -a; source infra/.env; set +a; \
      export ENGINE_URL='$ENGINE_URL'; \
      npm run agent -w @atproto-agents/agents -- --name $a --game $GAME --brain llm --pace $RESOLVED_PACE" \
      >"/tmp/demo-agent-$a.log" 2>&1 &
    echo "  started $a  (tail -f /tmp/demo-agent-$a.log)"
  done
}

# Remember the active game so every later verb follows it without DEMO_GAME.
_remember_game() {
  printf '%s' "$GAME" > "$DEMO_STATE" \
    && note "active game is now $GAME — later verbs follow it automatically ($DEMO_STATE)" \
    || echo "WARNING: could not write $DEMO_STATE; pass DEMO_GAME=$GAME to every later verb" >&2
}

# The next unused id in the base-N series, given what the engine already holds.
_next_free_game() {
  local base existing cand n
  base="$(printf '%s' "$GAME" | sed -E 's/-[0-9]+$//')"
  existing="$(curl -s -m 15 "$ENGINE_URL/games" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      try { const j = JSON.parse(s); console.log((j.games||[]).map(g=>g.id).join("\n")); }
      catch { console.log(""); }
    });')"
  for n in 2 3 4 5 6 7 8 9 10 11 12; do
    cand="$base-$n"
    printf '%s\n' "$existing" | grep -qxF "$cand" || { printf '%s' "$cand"; return 0; }
  done
  return 1
}

# ---------------------------------------------------------------------------
case "${1:-}" in

check)
  banner "PRE-FLIGHT"
  printf 'game     active ... '
  echo "$GAME  ($GAME_SRC)"
  printf 'engine   %s ... ' "$ENGINE_URL"
  ecode=$(curl -s -o /dev/null -w '%{http_code}' "$ENGINE_URL/games")
  [ "$ecode" = 200 ] && echo "200 ok" || echo "UNREACHABLE ($ecode)"
  printf 'fga      localhost:8080 ... '
  code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/stores)
  [ "$code" = 200 ] && echo "200 ok" || echo "$code  <-- NOT 200"
  printf 'fga store FGA_STORE_ID ... '
  [ -n "${FGA_STORE_ID:-}" ] && echo "$FGA_STORE_ID" || echo "UNRESOLVED (grant/kill/cleanup will fail)"
  printf 'guest pw GUEST_AGENT_PDS_PASSWORD ... '
  [ -n "${GUEST_AGENT_PDS_PASSWORD:-}" ] && echo "set" || echo "MISSING (beat5/grant/kill will fail)"
  printf 'anthropic %s ... ' "${ANTHROPIC_MODEL:-claude-opus-4-8}"
  if _llm_ping; then
    echo "200 ok — live LLM"
  else
    CHECK_FAILED=1
    printf '\033[1;31mFAILED: %s\033[0m\n' "$LLM_PING_ERR"
    note "         agents would run SCRIPTED: no 🧠 thinking, no real clues."
  fi
  printf 'build    packages/*/dist ... '
  build_why="$(_build_reason)"
  [ -z "$build_why" ] && echo "current" \
    || echo "$build_why — './demo start' will rebuild, or run 'npm run build'"
  printf 'registry guest ... '
  _ensure_guest_registry
  printf 'pace     ./demo start would use ... '
  _resolve_pace
  echo "${RESOLVED_PACE}ms  ($PACE_WHY)"
  [ -z "${CHECK_FAILED:-}" ] || die "
PRE-FLIGHT FAILED — fix the above before going on stage."
  ;;

start)
  banner "ACT 0 — new game ($GAME, seed $DEMO_SEED)"
  _ensure_build || die "workspace build failed"
  _ensure_guest_registry
  rm -f "$WORDFILE"
  node scripts/new-game.mjs "$GAME" "$DEMO_SEED" || die "new-game failed
(409 'game exists' means this id is spent — ids are single-use until the engine
 restarts. Use './demo relaunch' to move to a fresh one.)"
  _remember_game
  note "starting team is above; board is on the observer: $OBSERVER_URL/?game=$GAME"
  _launch_agents
  note "Beat 1 is automatic: watch the agent logs / observer for the first clue + 🧠 thinking."
  ;;

relaunch) # contingency: the game ended mid-beats — same demo, fresh game id
  _ensure_build || die "workspace build failed"
  _ensure_guest_registry
  new="$(_next_free_game)" || die "no free id in this series — restart the engine container to reclaim them"
  banner "RELAUNCH — $GAME is spent, moving to $new"
  note "game ids are single-use until the engine restarts (in-memory store, no delete)."
  _stop_agents
  rm -f "$WORDFILE"                       # beat 5's word belonged to the old game
  GAME="$new"; WORDFILE="/tmp/demo-word-${GAME}.txt"; rm -f "$WORDFILE"
  node scripts/new-game.mjs "$GAME" "$DEMO_SEED" || die "new-game failed"
  _remember_game
  note "board: $OBSERVER_URL/?game=$GAME"
  _launch_agents
  note "beats resume on $GAME — no DEMO_GAME needed, they follow it."
  ;;

status)
  _require_game
  banner "STATUS"
  echo "game:        $GAME  ($GAME_SRC)"
  echo "turn:        $(_state turn)"
  echo "phase:       $(_state phase)"
  echo "winner:      $(_state winner)"
  echo "unrevealed:  $(_state unrevealed_n) words"
  ;;

beat2) # time-scoped authority: OFF-turn spymaster tries to give a clue
  _require_game
  off="$(_state offteam)"
  banner "BEAT 2 — time-scoped authority ($off-spymaster is off turn)"
  note "same valid token as beat 1 — authority is a tuple, and tuples follow turns."
  node scripts/rogue-move.mjs "$off-spymaster" "$GAME" clue sneaky 3
  ;;

beat3) # role-scoped data: on-turn operative denied the key, spymaster allowed
  _require_game
  on="$(_state onteam)"
  banner "BEAT 3 — role-scoped data ($on operative asks for the key)"
  node scripts/rogue-move.mjs "$on-operative" "$GAME" key
  banner "BEAT 3 — the positive case ($on spymaster asks for the key)"
  node scripts/rogue-move.mjs "$on-spymaster" "$GAME" key
  ;;

beat4) # separation of duties: on-turn spymaster knows all, still can't guess
  _require_game
  on="$(_state onteam)"; word="$(_state unrevealed)"
  banner "BEAT 4 — separation of duties ($on spymaster tries to guess)"
  note "insider threat, one line. knowledge != authority."
  node scripts/rogue-move.mjs "$on-spymaster" "$GAME" guess "${word:-anchor}"
  ;;

beat5) # federation grants voice, not authority: guest speaks, then denied
  _require_game
  [ -n "${GUEST_AGENT_PDS_PASSWORD:-}" ] || die "GUEST_AGENT_PDS_PASSWORD not set in infra/.env"
  word="$(_state unrevealed)"; word="${word:-anchor}"
  echo "$word" > "$WORDFILE"   # the closer reuses this exact word
  banner "BEAT 5 — federation = voice, not authority ($GUEST_HANDLE)"
  note "it signs its own token on its own PDS; it speaks to the whole network, then the engine says no."
  node scripts/guest-move.mjs "$GAME" "$word" --why "I reveal the assassin"
  ;;

grant) # the closer, authority only: grant the guest's tuple, show before -> after
  _require_game
  banner "CLOSER — gate FGA (must be 200)"
  code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/stores)
  echo "  localhost:8080/stores -> $code"
  [ "$code" = 200 ] || die "FGA not reachable — fix before granting."
  banner "CLOSER — grant the tuple (before -> after)"
  node scripts/grant-guest.mjs "$GAME" || die "grant failed"
  note "seat granted — run './demo guest-guess' to have $GUEST_HANDLE actually submit."
  ;;

revoke) # the kill switch, authority only: revoke the tuple, show before -> after
  _require_game
  banner "KILL SWITCH — revoke the tuple (before -> after)"
  node scripts/grant-guest.mjs "$GAME" --revoke || die "revoke failed"
  note "authority removed — './demo guest-guess' now dies at FGA (voice remains)."
  ;;

guest-guess) # the action: the guest actually submits (accepted if granted, else denied)
  _require_game
  [ -n "${GUEST_AGENT_PDS_PASSWORD:-}" ] || die "GUEST_AGENT_PDS_PASSWORD not set in infra/.env"
  # Reuse beat 5's exact word if it's still unrevealed — same action, now (dis)allowed.
  word=""
  if [ -f "$WORDFILE" ]; then
    w="$(cat "$WORDFILE")"
    if _unrevealed_words | grep -qxF "$w"; then word="$w"; note "same word as beat 5: $w"; fi
  fi
  [ -n "$word" ] || word="$(_state unrevealed)"
  ph="$(_state phase)"
  [ "$ph" = "awaiting_guesses" ] || note "⚠ phase is '$ph', not awaiting_guesses — an ACCEPTED guess needs an active clue (a denial works regardless)."
  banner "GUEST GUESS — $GUEST_HANDLE submits (${word:-anchor})"
  node scripts/guest-move.mjs "$GAME" "${word:-anchor}"
  ;;

cleanup)
  banner "POST-SHOW — stop agents"
  _stop_agents
  banner "POST-SHOW — clean FGA for $GAME (+ revoke guest)"
  node scripts/grant-guest.mjs "$GAME" --revoke 2>/dev/null || true
  node scripts/cleanup-fga-game.mjs "$GAME"
  ;;

*)
  cat >&2 <<EOF
demo.sh — live BSidesLV run, one verb per beat.

  ./demo check     pre-flight (engine, fga=200, guest pw, registry, LIVE anthropic ping)
                   exits non-zero if the LLM ping fails — a stale key otherwise
                   degrades every agent to the scripted brain, silently.
  ./demo start     new seeded game + 4 LLM agents (beat 1 runs itself)
  ./demo beat2     time-scoped authority   (off-turn spymaster clue -> denied)
  ./demo beat3     role-scoped data        (operative key denied, spymaster allowed)
  ./demo beat4     separation of duties    (spymaster guess -> denied)
  ./demo beat5       federation = voice      (guest speaks, then denied)
  ./demo grant       the closer              (grant tuple only -> before/after diff)
  ./demo guest-guess the action              (guest submits: accepted if granted, else denied)
  ./demo revoke      the kill switch         (revoke tuple only -> before/after diff)
  ./demo cleanup     stop agents + clean fga (for the ACTIVE game)
  ./demo status      game / turn / phase / unrevealed count
  ./demo relaunch    game died mid-beats: fresh id, new game, agents relaunched.
                     Later verbs follow the new id automatically — no DEMO_GAME.

game=$GAME ($GAME_SRC)  guest=$GUEST_HANDLE
pace=$DEMO_PACE (auto => ${DEMO_PACE_LLM}ms live LLM / ${DEMO_PACE_SCRIPTED}ms scripted fallback)
EOF
  exit 1
  ;;
esac
