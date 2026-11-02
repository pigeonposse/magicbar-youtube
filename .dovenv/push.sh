#!/bin/bash

# Check if a commit message was provided
if [ -z "$1" ]; then
    echo "❌ Error: Please provide a commit message."
    echo "Usage: ./push.sh \"Your commit message\""
    exit 1
fi

# Execute Git commands
git add . && \
git commit -m "$1" && \
git push -u origin main

echo "✅ Changes successfully pushed to main!"