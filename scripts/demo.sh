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
# Verbs: check | start | beat2 | beat3 | beat4 | beat5 | grant | kill
#        cleanup | status
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
#./scripts/demo.sh grant     # grant tuple (before→after), guest submits → ✅
#./scripts/demo.sh kill      # revoke, guest                  → ⛔
#./scripts/demo.sh cleanup   # stop agents + clean FGA
#
# Config (override via env if you must):
DEMO_GAME="${DEMO_GAME:-bsideslv-live}"       # game id
DEMO_SEED="${DEMO_SEED:-42}"                   # fixed seed => reproducible board across rehearsals
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

GAME="$DEMO_GAME"

# --- tiny helpers ------------------------------------------------------------
banner() { printf '\n\033[1;36m=== %s ===\033[0m\n' "$*"; }
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

WORDFILE="/tmp/demo-word-${DEMO_GAME}.txt"   # beat 5's word, reused by the closer

# The scripts import the workspace packages (@atproto-agents/lexicon, …) from
# their compiled dist/. The engine runs from its own Docker build, so a fresh
# checkout has no dist until this runs. Build only when missing — idempotent.
_ensure_build() {
  if [ -f packages/lexicon/dist/index.js ] && [ -f packages/agents/dist/index.js ]; then
    return 0
  fi
  echo "building workspace packages (first run; ~20s)…"
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

# ---------------------------------------------------------------------------
case "${1:-}" in

check)
  banner "PRE-FLIGHT"
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
  printf 'anthropic ANTHROPIC_API_KEY ... '
  [ -n "${ANTHROPIC_API_KEY:-}" ] && echo "set" || echo "MISSING (agents fall back to scripted)"
  printf 'build    packages/*/dist ... '
  { [ -f packages/lexicon/dist/index.js ] && [ -f packages/agents/dist/index.js ]; } \
    && echo "built" || echo "MISSING — './demo start' will build, or run 'npm run build'"
  printf 'registry guest ... '
  _ensure_guest_registry
  ;;

start)
  banner "ACT 0 — new game ($GAME, seed $DEMO_SEED)"
  _ensure_build || die "workspace build failed"
  _ensure_guest_registry
  rm -f "$WORDFILE"
  node scripts/new-game.mjs "$GAME" "$DEMO_SEED" || die "new-game failed"
  note "starting team is above; board is on the observer: $OBSERVER_URL/?game=$GAME"

  banner "ACT 0 — launch four LLM agents (detached; logs in /tmp/demo-agent-*.log)"
  for a in red-spymaster red-operative blue-spymaster blue-operative; do
    setsid bash -c "cd '$ROOT'; set -a; source infra/.env; set +a; \
      export ENGINE_URL='$ENGINE_URL'; \
      npm run agent -w @atproto-agents/agents -- --name $a --game $GAME --brain llm" \
      >"/tmp/demo-agent-$a.log" 2>&1 &
    echo "  started $a  (tail -f /tmp/demo-agent-$a.log)"
  done
  note "Beat 1 is automatic: watch the agent logs / observer for the first clue + 🧠 thinking."
  ;;

status)
  _require_game
  banner "STATUS — $GAME"
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

grant) # the closer: gate the tunnel, grant the tuple, guest submits -> accepted
  _require_game
  [ -n "${GUEST_AGENT_PDS_PASSWORD:-}" ] || die "GUEST_AGENT_PDS_PASSWORD not set in infra/.env"
  banner "CLOSER — gate FGA (must be 200)"
  code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/stores)
  echo "  localhost:8080/stores -> $code"
  [ "$code" = 200 ] || die "FGA not reachable — fix before granting."
  ph="$(_state phase)"
  [ "$ph" = "awaiting_guesses" ] || note "⚠ phase is '$ph', not awaiting_guesses — a guess needs an active clue; if the submit errors, wait for a clue on the observer and rerun './demo grant'."
  banner "CLOSER — grant the tuple (before -> after)"
  node scripts/grant-guest.mjs "$GAME" || die "grant failed"
  # Reuse beat 5's exact word if it's still unrevealed — same action, now allowed.
  word=""
  if [ -f "$WORDFILE" ]; then
    w="$(cat "$WORDFILE")"
    if _unrevealed_words | grep -qxF "$w"; then word="$w"; note "same word as beat 5: $w"; fi
  fi
  [ -n "$word" ] || word="$(_state unrevealed)"
  banner "CLOSER — the seat-holder submits (${word:-anchor})"
  node scripts/guest-move.mjs "$GAME" "${word:-anchor}"
  ;;

kill) # encore: revoke the tuple, next guest attempt dies at FGA
  _require_game
  [ -n "${GUEST_AGENT_PDS_PASSWORD:-}" ] || die "GUEST_AGENT_PDS_PASSWORD not set in infra/.env"
  banner "KILL SWITCH — revoke the tuple"
  node scripts/grant-guest.mjs "$GAME" --revoke || die "revoke failed"
  word="$(_state unrevealed)"
  banner "KILL SWITCH — guest tries again ($word) — dies at FGA"
  node scripts/guest-move.mjs "$GAME" "${word:-anchor}"
  ;;

cleanup)
  banner "POST-SHOW — stop agents"
  pkill -f "@atproto-agents/agents -- --name" 2>/dev/null && echo "  agents stopped" || echo "  no agents running"
  banner "POST-SHOW — clean FGA for $GAME (+ revoke guest)"
  node scripts/grant-guest.mjs "$GAME" --revoke 2>/dev/null || true
  node scripts/cleanup-fga-game.mjs "$GAME"
  ;;

*)
  cat >&2 <<EOF
demo.sh — live BSidesLV run, one verb per beat.

  ./demo check     pre-flight (engine, fga=200, guest pw, registry, anthropic key)
  ./demo start     new seeded game + 4 LLM agents (beat 1 runs itself)
  ./demo beat2     time-scoped authority   (off-turn spymaster clue -> denied)
  ./demo beat3     role-scoped data        (operative key denied, spymaster allowed)
  ./demo beat4     separation of duties    (spymaster guess -> denied)
  ./demo beat5     federation = voice      (guest speaks, then denied)
  ./demo grant     the closer              (grant tuple -> guest submits -> accepted)
  ./demo kill      encore                  (revoke tuple -> guest denied at fga)
  ./demo cleanup   stop agents + clean fga
  ./demo status    turn / phase / unrevealed count

game=$DEMO_GAME  guest=$GUEST_HANDLE
EOF
  exit 1
  ;;
esac
