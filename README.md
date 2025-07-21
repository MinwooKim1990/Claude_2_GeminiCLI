# Gemini CLI MCP Server

An MCP (Model Context Protocol) server that enables Claude and other AI assistants to interact with Gemini CLI through tmux sessions.

## Features

- **Seamless Integration**: Send messages to Gemini CLI and receive responses
- **Automatic Session Management**: Creates and manages tmux sessions automatically
- **Permission Handling**: Handles Gemini's permission prompts for web fetching and tool usage
- **Multiple Tools**: Send messages, check status, clear conversation, and close sessions
- **File Context Support**: Use @filename to reference files in your messages
- **Debug Mode**: Get detailed execution information for troubleshooting
- **Enhanced Response Detection**: Improved pattern matching for various response formats
- **Smart Timeout**: Auto-detects search queries and adjusts timeout accordingly
- **Detailed Session Status**: View conversation state, message count, and more

## Prerequisites

- Node.js v18 or higher
- tmux installed (`sudo apt install tmux` on Ubuntu/Debian)
- Gemini CLI installed and configured
- An MCP-compatible client (like Claude Desktop)

## Installation

### From Source

1. Clone the repository:
```bash
git clone <repository-url>
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
- `working_directory` (optional): Working directory for new sessions and file resolution
- `timeout` (optional): Response timeout in milliseconds
  - Auto-detected based on message type:
    - Search queries: 30 seconds (검색, search, find, news, latest)
    - Simple queries: 10 seconds
  - Can be manually set for specific needs
- `auto_permission` (optional): How to handle permission requests
  - `"once"` (default): Allow once
  - `"always"`: Allow always
  - `"no"`: Deny
- `debug` (optional): Enable debug mode for detailed execution information

**Examples:**
```
Use gemini_send to ask "What is the weather today?"
Use gemini_send with message "@src/index.ts explain this code" and debug true
```

### 2. `gemini_session_status`
Check if a Gemini CLI session is active and see detailed information.

**Parameters:**
- `lines` (optional): Number of recent output lines to show (default: 20)
- `full_output` (optional): Show full session output instead of recent lines
- `debug` (optional): Include detailed session information

**Session Details Include:**
- Current state (idle, processing, searching, waiting_permission)
- Message count in conversation
- Session creation time
- Pane size and attachment status

**Example:**
```
Check the Gemini session status with debug true
```

### 3. `gemini_clear`
Clear the current Gemini conversation history.

**Parameters:**
- `debug` (optional): Show debug information about the clear operation

**Example:**
```
Clear the Gemini conversation
```

### 4. `gemini_close`
Close the current Gemini CLI session.

**Example:**
```
Close the Gemini session
```

## How It Works

1. **Session Management**: The server creates a tmux session named `gemini-ai` when first sending a message
2. **Message Handling**: Messages are sent using `tmux send-keys` commands
   - File references (@filename) are automatically expanded to absolute paths
   - Messages are preprocessed before sending
3. **Response Capture**: The server captures the tmux pane output and extracts Gemini's response
   - Uses regex patterns to detect various response formats
   - Detects processing indicators (⠦, ⠴, ⠼, "Translating", "Searching")
   - Handles code blocks, boxes, and list formatting
   - Waits for response completion with intelligent timeout
   - Auto-adjusts timeout based on query type
4. **Permission Handling**: When Gemini asks for permissions (e.g., for web fetching), the server can automatically respond based on the `auto_permission` setting

## Important Notes

- **Automatic Session Cleanup**: The MCP server automatically cleans up any existing Gemini sessions when it starts, ensuring a fresh environment
- **Response Times**: 
  - Simple queries: 5-10 seconds
  - Search queries: 15-30 seconds (includes web searching)
  - The server automatically detects search queries and adjusts timeout
- **Asynchronous Nature**: Gemini CLI processes requests asynchronously, so patience is required
- **Debug Logs**: Check stderr output for detailed processing information
- **Tool Descriptions**: Each tool now includes detailed descriptions to help LLMs understand their purpose and usage

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

1. **"tmux: command not found"**
   - Install tmux: `sudo apt install tmux` (Ubuntu/Debian) or `brew install tmux` (macOS)

2. **"gemini: command not found"**
   - Ensure Gemini CLI is installed and in your PATH
   - Try running `gemini` in your terminal to verify

3. **Session Already Exists**
   - The server automatically cleans up old sessions on startup
   - Use `gemini_close` to manually close if needed

4. **Empty or No Response**
   - Check stderr logs for debugging information
   - Use `gemini_session_status` to see the actual session state
   - Increase timeout for complex queries (especially searches)
   - The server now has improved response detection (v1.3.0)

5. **Response Timeout**
   - Search queries need 20-30 seconds
   - Simple queries need 5-10 seconds
   - Manual timeout can be set if needed

### Debug Tips

- Check tmux sessions: `tmux ls`
- Attach to the session manually: `tmux attach -t gemini-ai`
- View server logs in your MCP client's debug console

## Security Considerations

- The server executes shell commands via tmux
- Only use in trusted environments
- Be cautious with the `working_directory` parameter
- Consider the implications of automatic permission handling

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## Changelog

### Version 1.4.0
- Added enhanced response detection with regex patterns
- Implemented debug mode for all tools
- Added file context support (@filename preprocessing) 
- Improved error handling with recovery suggestions
- Enhanced session status with detailed information
- Better handling of code blocks, boxes, and formatted content
- Smarter timeout detection based on query type

### Version 1.3.0
- Improved response capture logic
- Fixed issue where MCP wasn't waiting for responses
- Added better content detection and stability checks

### Version 1.2.0
- Added detailed tool descriptions
- Implemented automatic session cleanup on startup
- Fixed stale session issues

### Version 1.1.0
- Fixed message sending with proper quote escaping
- Added auto-detection for search queries with longer timeouts
- Improved processing indicator detection

## License

MIT

## Acknowledgments

- Built for use with [Claude Desktop](https://claude.ai)
- Uses the [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- Integrates with [Gemini CLI](https://gemini.google.com)