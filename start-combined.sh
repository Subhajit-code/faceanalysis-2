#!/bin/bash
set -e

echo "Starting face-engine (internal, 127.0.0.1:8000)..."
(cd /app/face-engine && python -m uvicorn main:app --host 127.0.0.1 --port 8000) &
FACE_ENGINE_PID=$!

echo "Waiting for face-engine to become healthy..."
i=0
until curl -sf http://127.0.0.1:8000/health > /dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "face-engine did not become healthy within 60s — exiting."
    kill "$FACE_ENGINE_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done
echo "face-engine is healthy. Starting API server..."

(cd /app/server && npm start) &
API_PID=$!

# If either process dies, bring the whole container down so Render's health
# check catches it and restarts both — a half-alive container (API up but
# face-engine dead, or vice versa) is worse than a clean restart.
wait -n "$FACE_ENGINE_PID" "$API_PID"
EXIT_CODE=$?
echo "One of the processes exited (code $EXIT_CODE) — shutting down the other."
kill "$FACE_ENGINE_PID" "$API_PID" 2>/dev/null || true
exit "$EXIT_CODE"
