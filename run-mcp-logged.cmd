@echo off
cd /d "%~dp0"
bun run mcp:start > mcp-server.log 2>&1
