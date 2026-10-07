#!/bin/bash

echo "Setting up local environment for Vercel Blob access..."
echo ""
echo "This script will help you pull the proper environment variables from Vercel."
echo ""

# Check if vercel CLI is installed
if ! command -v vercel &> /dev/null; then
    echo "❌ Vercel CLI is not installed."
    echo "Please install it with: npm i -g vercel"
    exit 1
fi

echo "✅ Vercel CLI is installed"
echo ""

# Pull environment variables
echo "Pulling environment variables from Vercel..."
echo "You may need to authenticate if not already logged in."
echo ""

vercel env pull .env.local

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Successfully pulled environment variables!"
    echo ""
    echo "The following file was created:"
    echo "  - .env.local"
    echo ""
    echo "This file contains the proper BLOB_READ_WRITE_TOKEN and other"
    echo "environment variables needed for local development."
    echo ""
    echo "🎉 You're all set! Restart your development server to load the new variables."
else
    echo ""
    echo "❌ Failed to pull environment variables."
    echo "Please make sure you're logged in to Vercel and have access to this project."
    echo ""
    echo "Try running: vercel login"
fi