#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

const execAsync = promisify(exec);

// Tmux session configuration
const SESSION_NAME = "gemini-ai";
const DEFAULT_TIMEOUT = 30000; // 30 seconds default timeout (for search queries)
const SIMPLE_TIMEOUT = 10000; // 10 seconds for simple queries
const PERMISSION_TIMEOUT = 3000; // 3 seconds for permission responses

// Create MCP server
const server = new McpServer({
  name: "gemini-cli",
  version: "1.4.0",
  description: "MCP server for interacting with Gemini CLI via tmux"
});

// Response detection patterns
const responsePatterns = {
  geminiStart: /^✦\s+/m,
  boxContent: /^│\s+/m,
  boxBorder: /^[╭╰─┤├]/m,
  codeBlock: /^```/m,
  listItem: /^[\d•\-]\.\s+/m,
  promptReturn: /^Using \d+ MCP/m,
  geminiPrompt: /gemini>/,
  processing: /[⠦⠴⠼⠹⠸⠧]/,
  searchingStatus: /(?:Searching|Translating|GoogleSearch|Processing|Thinking)/i,
  emptyLine: /^\s*$/
};

// Debug info interface
interface DebugInfo {
  rawOutput: string;
  tmuxCommands: string[];
  timings: Array<{ step: string; duration: number }>;
  sessionInfo: any;
}

// Debug tracking
let debugInfo: DebugInfo = {
  rawOutput: "",
  tmuxCommands: [],
  timings: [],
  sessionInfo: {}
};

function trackTiming(step: string, startTime: number) {
  debugInfo.timings.push({
    step,
    duration: Date.now() - startTime
  });
}

function trackCommand(command: string) {
  debugInfo.tmuxCommands.push(command);
}

// File context preprocessing
function preprocessMessage(message: string, workingDir: string = process.cwd()): string {
  // Replace @filename references with absolute paths
  return message.replace(/@(\S+)/g, (match, filename) => {
    // Skip if it's already an absolute path
    if (path.isAbsolute(filename)) {
      return match;
    }
    
    const absolutePath = path.resolve(workingDir, filename);
    
    // Check if file exists
    if (fs.existsSync(absolutePath)) {
      console.error(`[Gemini MCP] Expanded ${match} to ${absolutePath}`);
      return `@${absolutePath}`;
    } else {
      console.error(`[Gemini MCP] Warning: File not found for ${match}`);
      return match;
    }
  });
}

// Helper functions
async function checkSession(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`tmux has-session -t ${SESSION_NAME} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

async function createSession(workingDir?: string): Promise<void> {
  const cwd = workingDir || process.cwd();
  await execAsync(`tmux new-session -d -s ${SESSION_NAME} -c "${cwd}" 'gemini'`);
  
  // Wait for Gemini to fully initialize (3 seconds to be safe)
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Clear any initial output by sending a newline
  await execAsync(`tmux send-keys -t ${SESSION_NAME} Enter`);
  await new Promise(resolve => setTimeout(resolve, 500));
}

async function sendMessage(message: string, debug: boolean = false): Promise<void> {
  // Escape single quotes for shell command
  const escapedMessage = message.replace(/'/g, "'\\''");
  
  // Send the message text without quotes - tmux will handle the text as-is
  const sendCmd = `tmux send-keys -t ${SESSION_NAME} '${escapedMessage}'`;
  const enterCmd = `tmux send-keys -t ${SESSION_NAME} Enter`;
  
  if (debug) {
    trackCommand(sendCmd);
    trackCommand(enterCmd);
  }
  
  await execAsync(sendCmd);
  await execAsync(enterCmd);
}

async function captureResponse(timeout: number = DEFAULT_TIMEOUT, debug: boolean = false): Promise<string> {
  const startTime = Date.now();
  let lastOutput = "";
  let stableCount = 0;
  let hasSeenProcessing = false;
  let lastChangeTime = Date.now();
  let hasSeenGeminiResponse = false;
  
  while (Date.now() - startTime < timeout) {
    try {
      const captureCmd = `tmux capture-pane -t ${SESSION_NAME} -p`;
      if (debug) trackCommand(captureCmd);
      
      const { stdout } = await execAsync(captureCmd);
      if (debug && debugInfo.rawOutput.length < 50000) {
        debugInfo.rawOutput = stdout;
      }
      
      // Enhanced processing detection using patterns
      if (responsePatterns.processing.test(stdout) || 
          responsePatterns.searchingStatus.test(stdout)) {
        hasSeenProcessing = true;
        lastChangeTime = Date.now();
        console.error("[Gemini MCP] Processing detected, continuing to wait...");
      }
      
      // Check for Gemini response start
      if (responsePatterns.geminiStart.test(stdout)) {
        hasSeenGeminiResponse = true;
        console.error("[Gemini MCP] Gemini response started");
      }
      
      // Check if output has changed
      if (stdout !== lastOutput) {
        // Output changed, reset stability counter
        stableCount = 0;
        lastOutput = stdout;
        lastChangeTime = Date.now();
        
        // Enhanced response completion detection
        const lines = stdout.split('\n');
        const nonEmptyLines = lines.filter(l => l.trim());
        
        // Check for various response patterns
        let hasValidResponse = false;
        for (const line of lines) {
          if (responsePatterns.boxContent.test(line) ||
              responsePatterns.listItem.test(line) ||
              (line.trim() && !responsePatterns.processing.test(line) && 
               !responsePatterns.geminiPrompt.test(line))) {
            hasValidResponse = true;
            break;
          }
        }
        
        if (hasValidResponse && hasSeenProcessing) {
          console.error("[Gemini MCP] Valid response content detected");
        }
      } else {
        // Output stable
        stableCount++;
        
        // Enhanced stability requirements
        const requiredStableCount = hasSeenProcessing ? 4 : 2;
        const timeSinceLastChange = Date.now() - lastChangeTime;
        
        if (stableCount >= requiredStableCount && timeSinceLastChange > 3000) {
          // No active processing indicators
          if (!responsePatterns.processing.test(stdout) &&
              !responsePatterns.searchingStatus.test(stdout)) {
            
            // Verify we have actual content
            if (hasSeenGeminiResponse || hasSeenProcessing) {
              console.error("[Gemini MCP] Response appears complete");
              trackTiming("response_capture", startTime);
              return stdout;
            }
          }
        }
      }
      
      // Check for permission UI
      if (stdout.includes("Do you want to proceed?") || 
          stdout.includes("Yes, allow once") ||
          stdout.includes("Yes, allow always")) {
        return stdout;
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000)); // Check every second
    } catch (error) {
      console.error("Error capturing response:", error);
    }
  }
  
  console.error(`[Gemini MCP] Timeout reached after ${timeout}ms`);
  trackTiming("response_capture_timeout", startTime);
  return lastOutput;
}

async function handlePermissionRequest(allowance: "once" | "always" | "no" = "once"): Promise<void> {
  switch (allowance) {
    case "once":
      // Default selection, just press Enter
      await execAsync(`tmux send-keys -t ${SESSION_NAME} Enter`);
      break;
    case "always":
      // Navigate down and press Enter
      await execAsync(`tmux send-keys -t ${SESSION_NAME} Down`);
      await execAsync(`tmux send-keys -t ${SESSION_NAME} Enter`);
      break;
    case "no":
      // Navigate down twice or send Escape
      await execAsync(`tmux send-keys -t ${SESSION_NAME} Escape`);
      break;
  }
}

function extractGeminiResponse(fullOutput: string, userMessage: string, debug: boolean = false): string {
  const lines = fullOutput.split('\n');
  let messageIndex = -1;
  
  // Find where the user message appears (look for exact match or partial)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(userMessage) || 
        (userMessage.length > 20 && lines[i].includes(userMessage.substring(0, 20)))) {
      messageIndex = i;
      break;
    }
  }
  
  if (messageIndex === -1) {
    console.error("[Gemini MCP] User message not found in output, looking for response patterns...");
    
    // Look for Gemini response start pattern
    for (let i = lines.length - 1; i >= 0; i--) {
      if (responsePatterns.geminiStart.test(lines[i]) ||
          responsePatterns.processing.test(lines[i]) ||
          responsePatterns.searchingStatus.test(lines[i])) {
        messageIndex = i;
        console.error(`[Gemini MCP] Found response start at line ${i}`);
        break;
      }
    }
    
    if (messageIndex === -1) {
      // Last resort: look for content after the last "gemini>" prompt
      for (let i = lines.length - 1; i >= 0; i--) {
        if (responsePatterns.geminiPrompt.test(lines[i])) {
          messageIndex = i;
          break;
        }
      }
    }
  }
  
  if (messageIndex === -1 && debug) {
    console.error("[Gemini MCP] No reference point found, returning full output");
    return fullOutput.trim();
  }
  
  // Extract lines after the reference point
  const responseLines = [];
  let foundResponse = false;
  let emptyLineCount = 0;
  let inCodeBlock = false;
  let inBox = false;
  
  for (let i = messageIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    
    // Track code blocks
    if (responsePatterns.codeBlock.test(line)) {
      inCodeBlock = !inCodeBlock;
      foundResponse = true;
    }
    
    // Track box content
    if (responsePatterns.boxBorder.test(line)) {
      inBox = !inBox;
      foundResponse = true;
    }
    
    // Skip status indicators only if we haven't found response yet
    if (!foundResponse && (
      responsePatterns.processing.test(line) ||
      responsePatterns.searchingStatus.test(line) ||
      responsePatterns.geminiStart.test(line) ||
      (line.trim() === '' && !inCodeBlock && !inBox)
    )) {
      continue;
    }
    
    // Once we find content, include everything until the next prompt
    if (line.trim() !== '' || inCodeBlock || inBox) {
      foundResponse = true;
      emptyLineCount = 0;
    } else if (foundResponse) {
      emptyLineCount++;
    }
    
    // Stop at the next prompt or shell mode indicator
    if (!inCodeBlock && !inBox && (
        responsePatterns.geminiPrompt.test(line) || 
        line.includes('shell mode enabled') ||
        line.trim() === '!' ||
        responsePatterns.promptReturn.test(line))) {
      break;
    }
    
    // Stop if too many consecutive empty lines (unless in code block)
    if (!inCodeBlock && !inBox && emptyLineCount > 3) {
      break;
    }
    
    // If we've found response content, include it
    if (foundResponse) {
      responseLines.push(line);
    }
  }
  
  const response = responseLines.join('\n').trim();
  console.error(`[Gemini MCP] Extracted ${responseLines.length} lines of response`);
  
  if (debug && response.length === 0) {
    console.error("[Gemini MCP] Empty response extracted, check raw output in debug info");
  }
  
  return response;
}

// Register main tool for sending messages
server.registerTool(
  "gemini_send",
  {
    title: "Send Message to Gemini CLI",
    description: `Send a message to Gemini CLI and receive the response. 
    
This tool manages a tmux session automatically:
- Creates a new session if none exists
- Sends your message to Gemini
- Waits for and captures the complete response
- Handles permission requests for web searches automatically
- Supports @filename references (automatically expands to absolute paths)

Response times vary:
- Simple queries: 5-10 seconds
- Search/web queries: 15-30 seconds (auto-detected)

Features:
- File context: Use @filename to reference files
- Debug mode: Returns detailed execution information
- Enhanced response detection with pattern matching

Example: Ask Gemini to search for news, explain concepts, or analyze @package.json.`,
    inputSchema: {
      message: z.string().describe("The message to send to Gemini. Supports @filename references"),
      working_directory: z.string().optional().describe("Working directory for the session and @filename resolution"),
      timeout: z.number().optional().describe("Response timeout in milliseconds (default: auto-detected based on message type)"),
      auto_permission: z.enum(["once", "always", "no"]).optional().describe("How to handle permission requests (default: once)"),
      debug: z.boolean().optional().describe("Enable debug mode to get detailed execution information")
    }
  },
  async ({ message, working_directory, timeout, auto_permission = "once", debug = false }) => {
    try {
      // Reset debug info for new request
      if (debug) {
        debugInfo = {
          rawOutput: "",
          tmuxCommands: [],
          timings: [],
          sessionInfo: {}
        };
      }
      
      const startTime = Date.now();
      
      // Preprocess message for file references
      const workDir = working_directory || process.cwd();
      const processedMessage = preprocessMessage(message, workDir);
      if (processedMessage !== message) {
        console.error("[Gemini MCP] Message preprocessed with file paths");
      }
      
      // Auto-detect timeout based on message content
      if (!timeout) {
        const lowerMessage = processedMessage.toLowerCase();
        if (lowerMessage.includes('search') || lowerMessage.includes('검색') || 
            lowerMessage.includes('find') || lowerMessage.includes('찾') ||
            lowerMessage.includes('news') || lowerMessage.includes('뉴스') ||
            lowerMessage.includes('latest') || lowerMessage.includes('최신')) {
          timeout = DEFAULT_TIMEOUT; // 30 seconds for search queries
          console.error("[Gemini MCP] Detected search query, using 30s timeout");
        } else {
          timeout = SIMPLE_TIMEOUT; // 10 seconds for simple queries
          console.error("[Gemini MCP] Using 10s timeout for simple query");
        }
      }
      
      // Check if session exists, create if not
      const sessionExists = await checkSession();
      if (!sessionExists) {
        console.error("[Gemini MCP] Creating new session...");
        await createSession(working_directory);
      }
      
      if (debug) {
        debugInfo.sessionInfo = {
          exists: sessionExists,
          workingDirectory: workDir,
          timeout: timeout
        };
      }
      
      // Log the message being sent
      console.error(`[Gemini MCP] Sending message: ${processedMessage}`);
      
      // Send the message
      await sendMessage(processedMessage, debug);
      
      // Wait a bit for processing to start
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Capture initial response
      let response = await captureResponse(timeout, debug);
      
      // Check if permission is needed
      if (response.includes("Do you want to proceed?")) {
        // Handle permission
        await handlePermissionRequest(auto_permission);
        
        // Wait for actual response after permission
        await new Promise(resolve => setTimeout(resolve, 2000));
        response = await captureResponse(timeout, debug);
      }
      
      // Extract just the Gemini response
      const geminiResponse = extractGeminiResponse(response, processedMessage, debug);
      
      // Debug log the response
      console.error(`[Gemini MCP] Raw response length: ${response.length}`);
      console.error(`[Gemini MCP] Extracted response length: ${geminiResponse.length}`);
      
      // If we got an empty response, log the full output for debugging
      if (!geminiResponse || geminiResponse.trim().length === 0) {
        console.error("[Gemini MCP] Empty response detected. Check debug info if enabled.");
      }
      
      trackTiming("total_execution", startTime);
      
      // Prepare response
      const responseText = geminiResponse || "No response captured. Check session status or increase timeout.";
      
      if (debug) {
        // Return debug information along with response
        return {
          content: [{
            type: "text",
            text: `Response:\n${responseText}\n\n--- Debug Information ---\n` +
                  `Total execution time: ${Date.now() - startTime}ms\n` +
                  `Timings: ${JSON.stringify(debugInfo.timings, null, 2)}\n` +
                  `Commands executed: ${debugInfo.tmuxCommands.length}\n` +
                  `Raw output length: ${debugInfo.rawOutput.length} chars\n` +
                  `Session info: ${JSON.stringify(debugInfo.sessionInfo, null, 2)}`
          }]
        };
      } else {
        return {
          content: [{
            type: "text",
            text: responseText
          }]
        };
      }
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Gemini MCP] Error: ${errorMsg}`);
      
      // Provide helpful error suggestions
      let suggestion = "";
      if (errorMsg.includes("tmux")) {
        suggestion = "\n\nSuggestion: Make sure tmux is installed (sudo apt install tmux)";
      } else if (errorMsg.includes("session")) {
        suggestion = "\n\nSuggestion: Try closing the session with gemini_close and retry";
      }
      
      return {
        content: [{
          type: "text",
          text: `Error: ${errorMsg}${suggestion}`
        }]
      };
    }
  }
);

// Helper function to get session details
async function getSessionDetails(): Promise<any> {
  try {
    // Get session info
    const { stdout: sessionInfo } = await execAsync(`tmux list-sessions -F "#{session_name}:#{session_created}:#{session_attached}" 2>/dev/null | grep "^${SESSION_NAME}:" || echo ""`);
    
    // Get pane info
    const { stdout: paneInfo } = await execAsync(`tmux list-panes -t ${SESSION_NAME} -F "#{pane_width}x#{pane_height}" 2>/dev/null || echo ""`);
    
    // Get full output to analyze
    const { stdout: fullOutput } = await execAsync(`tmux capture-pane -t ${SESSION_NAME} -p 2>/dev/null || echo ""`);
    
    // Count messages
    const messageCount = (fullOutput.match(/gemini>/g) || []).length;
    
    // Detect current state
    let currentState = "idle";
    if (responsePatterns.processing.test(fullOutput)) {
      currentState = "processing";
    } else if (responsePatterns.searchingStatus.test(fullOutput)) {
      currentState = "searching";
    } else if (fullOutput.includes("Do you want to proceed?")) {
      currentState = "waiting_permission";
    }
    
    // Parse session info
    const [name, created, attached] = sessionInfo.trim().split(':');
    
    return {
      active: true,
      sessionName: name || SESSION_NAME,
      created: created ? new Date(parseInt(created) * 1000).toISOString() : null,
      attached: attached === "1",
      paneSize: paneInfo.trim() || "unknown",
      messageCount: messageCount,
      currentState: currentState,
      lastActivity: new Date().toISOString()
    };
  } catch {
    return { active: false };
  }
}

// Register session status tool
server.registerTool(
  "gemini_session_status",
  {
    title: "Check Gemini Session Status",
    description: `Check if a Gemini CLI session is active and view detailed information.

This tool provides:
- Session existence and creation time
- Current state (idle, processing, searching, waiting_permission)
- Message count in conversation
- Pane size and attachment status
- Recent output (configurable lines)
- Debug information if enabled

Useful for debugging, monitoring long-running queries, and understanding session state.`,
    inputSchema: {
      lines: z.number().optional().describe("Number of recent output lines to show (default: 20)"),
      full_output: z.boolean().optional().describe("Show full session output instead of just recent lines"),
      debug: z.boolean().optional().describe("Include detailed session information")
    }
  },
  async ({ lines = 20, full_output = false, debug = false }) => {
    try {
      const exists = await checkSession();
      if (!exists) {
        return {
          content: [{
            type: "text",
            text: "No active Gemini session"
          }]
        };
      }
      
      // Get session details
      const details = await getSessionDetails();
      
      // Get output
      let output;
      if (full_output) {
        const { stdout } = await execAsync(`tmux capture-pane -t ${SESSION_NAME} -p`);
        output = stdout;
      } else {
        const { stdout } = await execAsync(`tmux capture-pane -t ${SESSION_NAME} -p | tail -${lines}`);
        output = stdout;
      }
      
      // Build response
      let response = "Session Status: ACTIVE\n";
      
      if (debug || details.currentState !== "idle") {
        response += `\nSession Details:\n`;
        response += `- State: ${details.currentState}\n`;
        response += `- Messages: ${details.messageCount}\n`;
        response += `- Created: ${details.created || "unknown"}\n`;
        response += `- Pane Size: ${details.paneSize}\n`;
        response += `- Attached: ${details.attached ? "Yes" : "No"}\n`;
      }
      
      response += `\n${full_output ? "Full" : `Last ${lines} lines of`} output:\n${"─".repeat(50)}\n${output}`;
      
      return {
        content: [{
          type: "text",
          text: response
        }]
      };
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        content: [{
          type: "text",
          text: `Error checking session: ${errorMsg}`
        }]
      };
    }
  }
);

// Register clear conversation tool
server.registerTool(
  "gemini_clear",
  {
    title: "Clear Gemini Conversation",
    description: `Clear the current Gemini conversation history while keeping the session active.

This tool:
- Sends the /clear command to Gemini
- Resets the conversation context
- Keeps the tmux session running
- Useful when starting a new topic or if context becomes confused

Note: This does NOT close the session, just clears the conversation.`,
    inputSchema: {
      debug: z.boolean().optional().describe("Show debug information about the clear operation")
    }
  },
  async ({ debug = false }) => {
    try {
      const startTime = Date.now();
      
      const exists = await checkSession();
      if (!exists) {
        return {
          content: [{
            type: "text",
            text: "No active session to clear"
          }]
        };
      }
      
      // Get before state if debug
      let beforeState;
      if (debug) {
        beforeState = await getSessionDetails();
      }
      
      // Send /clear command
      await sendMessage("/clear", debug);
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Get after state if debug
      let afterState;
      if (debug) {
        afterState = await getSessionDetails();
      }
      
      let response = "Conversation cleared";
      
      if (debug) {
        response += `\n\nDebug Info:\n`;
        response += `- Execution time: ${Date.now() - startTime}ms\n`;
        response += `- Messages before: ${beforeState.messageCount}\n`;
        response += `- Messages after: ${afterState.messageCount}\n`;
        response += `- State after: ${afterState.currentState}`;
      }
      
      return {
        content: [{
          type: "text",
          text: response
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error clearing conversation: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
);

// Register close session tool
server.registerTool(
  "gemini_close",
  {
    title: "Close Gemini Session",
    description: `Close the current Gemini CLI tmux session completely.

This tool:
- Terminates the tmux session named 'gemini-ai'
- Frees up system resources
- Should be used when done with Gemini interactions

Note: A new session will be automatically created on the next gemini_send call.
The MCP server automatically cleans up old sessions on startup, so manual closing is optional.`,
    inputSchema: {}
  },
  async () => {
    try {
      const exists = await checkSession();
      if (!exists) {
        return {
          content: [{
            type: "text",
            text: "No active session to close"
          }]
        };
      }
      
      // Kill the tmux session
      await execAsync(`tmux kill-session -t ${SESSION_NAME}`);
      
      return {
        content: [{
          type: "text",
          text: "Gemini session closed"
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error closing session: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
);

// Cleanup function to remove stale sessions
async function cleanupStaleSessions() {
  try {
    // Check if there's an existing session
    const sessionExists = await checkSession();
    if (sessionExists) {
      console.error("[Gemini MCP] Found existing session, cleaning up...");
      await execAsync(`tmux kill-session -t ${SESSION_NAME}`);
      console.error("[Gemini MCP] Previous session cleaned up");
    }
  } catch (error) {
    // Session doesn't exist or already cleaned, which is fine
    console.error("[Gemini MCP] No previous session found");
  }
}

// Start the server
async function main() {
  // Clean up any stale sessions on startup
  await cleanupStaleSessions();
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Gemini CLI MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});