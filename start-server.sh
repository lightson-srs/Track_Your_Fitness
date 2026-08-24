#!/bin/bash
echo "Starting Track Your Fitness..."
echo ""

# Try Python 3
if command -v python3 &>/dev/null; then
    echo "Server running at http://localhost:8080"
    echo "Opening browser..."
    open "http://localhost:8080" 2>/dev/null || xdg-open "http://localhost:8080" 2>/dev/null
    python3 -m http.server 8080
    exit 0
fi

# Try Python
if command -v python &>/dev/null; then
    echo "Server running at http://localhost:8080"
    open "http://localhost:8080" 2>/dev/null || xdg-open "http://localhost:8080" 2>/dev/null
    python -m http.server 8080
    exit 0
fi

echo "ERROR: Python not found. Install from https://python.org"
