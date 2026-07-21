#!/bin/sh
# Source FGA IDs written by fga-init, but only if they weren't already
# provided as explicit env vars (explicit env takes precedence).
if [ -z "$FGA_STORE_ID" ] && [ -f /fga-config/fga.env ]; then
  . /fga-config/fga.env
fi
exec node packages/engine/dist/index.js
