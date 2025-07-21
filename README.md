# Gemini CLI MCP Server

An MCP (Model Context Protocol) server that enables Claude and other AI assistants to interact with Gemini CLI using one-shot execution mode.

## Features

- **One-Shot Execution**: Each message is sent independently without maintaining session state
- **Instant Responses**: Direct execution without tmux overhead
- **File Context Support**: Use @filename to reference files in your messages
- **Web Search**: Full support for Gemini's web search capabilities
- **Korean & English**: Handles both languages seamlessly
- **Simple & Reliable**: No complex session management or response capture issues

## Why One-Shot Mode?

Version 1.5.0 represents a major architectural change from tmux-based interactive sessions to one-shot execution:

- **Previous versions (1.0.0 - 1.4.4)** used tmux to maintain persistent Gemini CLI sessions, which proved unstable with frequent response capture failures
- **Version 1.5.0** executes each message independently using pipe input (`echo "message" | gemini`), eliminating session state complexity
- **Trade-off**: No conversation history between messages, but significantly improved reliability

## Prerequisites

- Node.js v18 or higher
- Gemini CLI installed and configured
- An MCP-compatible client (like Claude Desktop)

## Installation

### From Source

1. Clone the repository:
```bash
git clone https://github.com/MinwooKim1990/Claude_2_GeminiCLI.git
cd gemini-mcp-server
```

2. Install dependencies:
```bash
npm install
```

3. Build the project:
```bash
npm run build
```

### Global Installation

```bash
npm install -g gemini-mcp-server
```

## Configuration

### Claude Desktop

Add the following to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
**Linux**: `~/.config/claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "gemini-cli": {
      "command": "node",
      "args": ["/path/to/gemini-mcp-server/dist/server.js"]
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "gemini-cli": {
      "command": "gemini-mcp-server"
    }
  }
}
```

## Usage

Once configured, the following tools will be available in Claude:

### 1. `gemini_send`
Send a message to Gemini CLI and get the response.

**Parameters:**
- `message` (required): The message to send to Gemini
  - Supports @filename references (e.g., "@package.json explain this")
  - Supports web search queries in any language
  - Each message is independent (no conversation history)

**Examples:**
```
Use gemini_send to ask "What is the weather today?"
Use gemini_send with message "@src/index.ts explain this code"
Use gemini_send with message "최신 AI 뉴스 검색해줘"
```

### 2. `gemini_status`
Check if Gemini CLI is available and working.

**Example:**
```
Check if Gemini is working
```

## How It Works

1. **One-Shot Execution**: Each message is piped directly to Gemini CLI using shell command: `echo "message" | gemini`
2. **Message Handling**: Messages are passed as-is to Gemini
   - File references (@filename) work with relative paths from current directory
   - Special characters are properly escaped for shell execution
3. **Response Capture**: The server captures stdout from the Gemini process
   - Filters out "Loaded cached credentials." messages
   - Returns the complete response immediately
4. **No State Management**: Each execution is completely independent
   - No tmux sessions to manage
   - No conversation history maintained
   - No complex response detection needed

## Important Notes

- **No Conversation History**: Each message is independent - Gemini won't remember previous messages
- **Response Times**: 
  - Simple queries: 2-5 seconds
  - Search queries: 5-15 seconds (includes web searching)
  - File analysis: 3-10 seconds depending on file size
- **Current Directory**: File references (@filename) are resolved from the current working directory
- **Error Handling**: If Gemini CLI is not available or fails, clear error messages are returned

## Development

### Running in Development Mode

```bash
npm run dev
```

### Building

```bash
npm run build
```

### Project Structure

```
gemini-mcp-server/
├── src/
│   └── server.ts      # Main server implementation
├── dist/              # Compiled JavaScript (generated)
├── package.json
├── tsconfig.json
└── README.md
```

## Troubleshooting

### Common Issues

1. **"gemini: command not found"**
   - Ensure Gemini CLI is installed and in your PATH
   - Try running `gemini` in your terminal to verify
   - Check if you need to run `gemini auth` first

2. **No Response or Empty Response**
   - Check if Gemini CLI works manually: `echo "Hello" | gemini`
   - Ensure you have proper authentication
   - Check stderr logs for error messages

3. **File Not Found (@filename)**
   - File references are resolved from the current working directory
   - Use relative paths from where the MCP server is running
   - Absolute paths also work if needed

### Debug Tips

- Test Gemini CLI directly: `echo "test message" | gemini`
- Check MCP server logs in stderr output
- Use `gemini_status` tool to verify Gemini is working

## Security Considerations

- The server executes shell commands to run Gemini CLI
- Messages are escaped but still use shell execution
- Only use in trusted environments
- Be cautious with untrusted input

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## Changelog

### Version 1.5.1
- **Improved timeout handling**: Dynamic timeout that resets when data is received
- **Better long response support**: 60-second timeout between data chunks instead of total timeout
- **Progress logging**: Shows data received for long responses
- **More robust process handling**: Properly handles process exit codes including null
- **Added timing information**: Logs request duration for debugging

### Version 1.5.0 (Major Architecture Change)
- **Complete rewrite**: Switched from tmux-based sessions to one-shot execution
- **Removed tmux dependency**: Now uses direct pipe input (`echo "message" | gemini`)
- **Eliminated session management**: Each message is independent, no state maintained
- **Improved reliability**: No more response capture failures or timeout issues
- **Faster responses**: Direct execution without tmux overhead
- **Simplified codebase**: Removed complex response detection and session management
- **Trade-off**: No conversation history, but much more stable operation

### Previous Versions (1.0.0 - 1.4.4)
- Used tmux for persistent session management
- Attempted various fixes for response capture issues
- Complex pattern matching and timeout logic
- Frequent failures in message detection and response extraction
- Shell mode activation problems, especially with Korean input

## License

MIT

## Acknowledgments

- Built for use with [Claude Desktop](https://claude.ai)
- Uses the [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- Integrates with [Gemini CLI](https://gemini.google.com)