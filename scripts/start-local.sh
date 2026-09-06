#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3000}"
URL="http://127.0.0.1:${PORT}"

npm run start &
SERVER_PID=$!

cleanup() {
  kill "${SERVER_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 30); do
  if curl --silent --fail --output /dev/null "${URL}"; then
    break
  fi
  sleep 0.25
done

if ! curl --silent --fail --output /dev/null "${URL}"; then
  echo "The server did not become ready at ${URL}." >&2
  exit 1
fi

if command -v open >/dev/null 2>&1; then
  open "${URL}"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "${URL}" >/dev/null 2>&1 &
else
  echo "Open ${URL} in your browser."
fi

echo "PersonalPaperLibrary is running at ${URL}"
echo "Press Ctrl-C to stop the server."
wait "${SERVER_PID}"
