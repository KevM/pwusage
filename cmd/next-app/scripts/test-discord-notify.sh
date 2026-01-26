#!/bin/bash

# Usage: ./test-discord-notify.sh <COMMIT_SHA> [DISCORD_WEBHOOK_URL]

COMMIT_SHA=$1
DISCORD_WEBHOOK=${2:-$DISCORD_WEBHOOK}

if [ -z "$COMMIT_SHA" ]; then
  echo "Usage: $0 <COMMIT_SHA> [DISCORD_WEBHOOK_URL]"
  exit 1
fi

if [ -z "$DISCORD_WEBHOOK" ]; then
  echo "Error: DISCORD_WEBHOOK environment variable or argument is required."
  exit 1
fi

REPO="kevm/pwusage" # Hardcoded for this script or could be dynamic
echo "Fetching details for commit $COMMIT_SHA in $REPO..."

# Fetch commit info
COMMIT_MSG=$(gh api repos/$REPO/commits/$COMMIT_SHA --jq '.commit.message')
COMMIT_AUTHOR=$(gh api repos/$REPO/commits/$COMMIT_SHA --jq '.commit.author.name')
COMMIT_URL=$(gh api repos/$REPO/commits/$COMMIT_SHA --jq '.html_url')

# Fetch PR Body (using fallback logic from CI)
echo "Fetching PR description..."
PR_BODY=$(gh api repos/$REPO/commits/$COMMIT_SHA/pulls --jq '.[0].body' || echo "No associated PR found.")

# Construct JSON payload
echo "Constructing payload..."
jq -n \
  --arg repo "$REPO" \
  --arg branch "manual-test" \
  --arg actor "$COMMIT_AUTHOR" \
  --arg commit "$COMMIT_MSG" \
  --arg url "$COMMIT_URL" \
  --arg body "${PR_BODY:-No description provided}" \
  '{
    embeds: [{
      title: "Success: Build Complete",
      color: 3066993,
      fields: [
        { name: "Branch", value: $branch, inline: true },
        { name: "Author", value: $actor, inline: true },
        { name: "Commit", value: $commit, inline: false },
        { name: "Description", value: $body, inline: false }
      ],
      footer: { text: "Powered by GitHub Actions" }
    }]
  }' > manual_discord_payload.json

echo "Sending webhook..."
curl -v -H "Content-Type: application/json" \
     -d @manual_discord_payload.json \
     "$DISCORD_WEBHOOK"

echo ""
echo "Done. Payload saved to manual_discord_payload.json"
