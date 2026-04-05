#!/usr/bin/env bash
# fake-claude.sh — mock for the claude CLI used in tests.
# Parses the arguments passed by claude-runner.js and emits a minimal
# valid JSON response so that the real claude binary is never required.

SESSION_ID="fake-session-123"
STREAM=false
PROMPT=""
RESUME_ID=""

# --- Parse args --------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-format)
      if [[ "$2" == "stream-json" ]]; then
        STREAM=true
      fi
      shift 2
      ;;
    --resume)
      RESUME_ID="$2"
      shift 2
      ;;
    -p)
      PROMPT="$2"
      shift 2
      ;;
    --verbose)
      shift
      ;;
    *)
      shift
      ;;
  esac
done

# If resuming, echo back the same session ID so the server can track it.
if [[ -n "$RESUME_ID" ]]; then
  SESSION_ID="$RESUME_ID"
fi

# --- Emit response -----------------------------------------------------
if [[ "$STREAM" == "true" ]]; then
  # stream-json mode: emit newline-delimited JSON objects
  printf '{"type":"system","subtype":"init","session_id":"%s"}\n' "$SESSION_ID"
  printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello from fake claude"}]}}\n'
  printf '{"type":"result","subtype":"success","result":"Hello from fake claude","session_id":"%s","is_error":false}\n' "$SESSION_ID"
else
  # json mode: emit single JSON object
  printf '{"type":"result","subtype":"success","result":"Hello from fake claude","session_id":"%s","is_error":false}\n' "$SESSION_ID"
fi

exit 0
