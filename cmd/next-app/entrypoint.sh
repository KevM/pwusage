#!/bin/sh
set -e

# Start the worker in the background
echo "Starting worker process..."
npm run worker &

# Start the Next.js server
echo "Starting Next.js server..."
exec node server.js
