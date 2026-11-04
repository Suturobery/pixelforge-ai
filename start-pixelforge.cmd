@echo off
rem PixelForge AI - start both servers in their own minimized windows.
rem Web studio:  http://localhost:3000
rem MCP server:  http://127.0.0.1:3030  (Settings -> MCP shows "connected")
rem Close a window (or Ctrl+C inside it) to stop that server.

cd /d "%~dp0"

start "PixelForge Web" /min cmd /c "bun run dev"
start "PixelForge MCP" /min cmd /c "bun run mcp:start"

echo Both servers are starting.
echo   Web : http://localhost:3000  (ready after a few seconds)
echo   MCP : http://127.0.0.1:3030/health
echo You can close THIS window - the servers keep running in their own.
