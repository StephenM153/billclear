#!/bin/bash
set -e

if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo ""
  echo "❌  ANTHROPIC_API_KEY is not set."
  echo "    Run: export ANTHROPIC_API_KEY=your_key_here"
  echo "    Then run this script again."
  echo ""
  exit 1
fi

echo ""
echo "🚀  Starting BillClear..."
echo ""
node "$(dirname "$0")/server.js"
