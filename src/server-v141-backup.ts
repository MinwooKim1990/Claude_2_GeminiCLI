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
  version: "1.4.2",
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
    await execAsync(`tmux has-session -t ${SESSION_NAME} 2>&1`);
    return true;
  } catch (error) {
    return false;
  }
}

async function createSession(workingDir?: string): Promise<void> {
  const cwd = workingDir || process.cwd();
  
  try {
    // Create session with gemini command
    await execAsync(`tmux new-session -d -s ${SESSION_NAME} -c "${cwd}" 'gemini'`);
    console.error(`[Gemini MCP] Created new session in ${cwd}`);
    
    // Wait for Gemini to fully initialize
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Send an initial Enter to clear any startup messages
    await execAsync(`tmux send-keys -t ${SESSION_NAME} Enter`);
    await new Promise(resolve => setTimeout(resolve, 500));
    
  } catch (error) {
    console.error(`[Gemini MCP] Failed to create session: ${error}`);
    throw error;
  }
}

async function sendMessage(message: string, debug: boolean = false): Promise<void> {
  try {
    // Use -l flag for literal text - this handles all special characters properly
    const sendCmd = `tmux send-keys -t ${SESSION_NAME} -l "${message.replace(/"/g, '\\"')}"`;
    const enterCmd = `tmux send-keys -t ${SESSION_NAME} Enter`;
    
    if (debug) {
      trackCommand(sendCmd);
      trackCommand(enterCmd);
      console.error(`[Gemini MCP Debug] Sending message: "${message}"`);
    }
    
    // Execute and capture any errors
    const { stdout: sendOut, stderr: sendErr } = await execAsync(sendCmd);
    if (debug && sendErr) {
      console.error(`[Gemini MCP Debug] Send command stderr: ${sendErr}`);
    }
    
    const { stdout: enterOut, stderr: enterErr } = await execAsync(enterCmd);
    if (debug && enterErr) {
      console.error(`[Gemini MCP Debug] Enter command stderr: ${enterErr}`);
    }
    
    // Give tmux time to process the keys
    await new Promise(resolve => setTimeout(resolve, 100));
    
  } catch (error) {
    console.error(`[Gemini MCP] Error in sendMessage: ${error}`);
    throw error;
  }
}

async function captureResponse(timeout: number = DEFAULT_TIMEOUT, debug: boolean = false): Promise<string> {
  const startTime = Date.now();
  let lastOutput = "";
  let stableCount = 0;
  let hasSeenProcessing = false;
  
  if (debug) {
    console.error(`[Gemini MCP Debug] Starting response capture with ${timeout}ms timeout`);
  }
  
  while (Date.now() - startTime < timeout) {
    try {
      // Changed: Remove -S - flag to capture current visible pane content
      // The -S - flag was capturing entire history which might be empty
      const captureCmd = `tmux capture-pane -t ${SESSION_NAME} -p`;
      if (debug) trackCommand(captureCmd);
      
      const { stdout } = await execAsync(captureCmd);
      
      // Store raw output for debug
      if (debug) {
        debugInfo.rawOutput = stdout;
      }
      
      // Simple processing detection
      if (stdout.includes("⠦") || stdout.includes("⠴") || stdout.includes("⠼") || 
          stdout.includes("Translating") || stdout.includes("Searching") || 
          stdout.includes("Processing") || stdout.includes("GoogleSearch") ||
          stdout.includes("✦") || stdout.includes("Pre-heating")) {
        hasSeenProcessing = true;
        if (debug) console.error("[Gemini MCP Debug] Processing indicators detected");
      }
      
      // Check if output has changed
      if (stdout !== lastOutput) {
        stableCount = 0;
        lastOutput = stdout;
        if (debug) console.error("[Gemini MCP Debug] Output changed, resetting stability counter");
      } else {
        stableCount++;
        
        // Simple completion check - if output is stable 
        if (stableCount >= 2) {
          // Check if we see the gemini> prompt which indicates completion
          if (stdout.includes("gemini>") && hasSeenProcessing) {
            if (debug) console.error("[Gemini MCP Debug] Found gemini> prompt, response complete");
            return stdout;
          }
          
          // If stable for longer and no active processing indicators
          if (stableCount >= 3 && hasSeenProcessing) {
            if (!stdout.includes("⠦") && !stdout.includes("⠴") && !stdout.includes("⠼") &&
                !stdout.includes("Translating") && !stdout.includes("Searching") &&
                !stdout.includes("Pre-heating")) {
              if (debug) console.error("[Gemini MCP Debug] Response appears complete (stable output)");
              return stdout;
            }
          }
        }
      }
      
      // Check for permission UI
      if (stdout.includes("Do you want to proceed?")) {
        if (debug) console.error("[Gemini MCP Debug] Permission prompt detected");
        return stdout;
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(`[Gemini MCP] Error capturing response: ${error}`);
      if (debug) throw error;
    }
  }
  
  if (debug) {
    console.error(`[Gemini MCP Debug] Timeout after ${Date.now() - startTime}ms`);
  }
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
  
  if (debug) {
    console.error(`[Gemini MCP Debug] Extracting response from ${lines.length} lines`);
    console.error(`[Gemini MCP Debug] Looking for message: "${userMessage}"`);
    console.error(`[Gemini MCP Debug] First 10 lines of output:`);
    lines.slice(0, 10).forEach((line, i) => {
      console.error(`  ${i}: ${line.substring(0, 80)}${line.length > 80 ? '...' : ''}`);
    });
  }
  
  // Find where the user message appears
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(userMessage)) {
      messageIndex = i;
      if (debug) console.error(`[Gemini MCP Debug] Found user message at line ${i}`);
      break;
    }
  }
  
  if (messageIndex === -1) {
    // Try partial match for long messages
    if (userMessage.length > 20) {
      const partial = userMessage.substring(0, 20);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(partial)) {
          messageIndex = i;
          if (debug) console.error(`[Gemini MCP Debug] Found partial message at line ${i}`);
          break;
        }
      }
    }
  }
  
  if (messageIndex === -1) {
    // Look for any Gemini response indicator from the end
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('✦') || lines[i].includes('⠴') || lines[i].includes('⠼') ||
          lines[i].includes('│') || lines[i].includes('╭') || lines[i].includes('```')) {
        messageIndex = i - 1; // Start from line before the indicator
        if (debug) console.error(`[Gemini MCP Debug] Found response indicator at line ${i}`);
        break;
      }
    }
  }
  
  if (messageIndex === -1) {
    if (debug) console.error("[Gemini MCP Debug] No reference point found, using fallback extraction");
    
    // Fallback: Look for content between last empty section and gemini> prompt
    let startIndex = -1;
    let endIndex = lines.length;
    
    // Find gemini> prompt from the end
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('gemini>')) {
        endIndex = i;
        break;
      }
    }
    
    // Find last substantial content before the prompt
    for (let i = endIndex - 1; i >= 0; i--) {
      if (lines[i].trim() !== '' && !lines[i].includes('⠦') && !lines[i].includes('⠴') && 
          !lines[i].includes('⠼') && !lines[i].includes('Using') && !lines[i].includes('MCP')) {
        startIndex = i;
        // Keep going up to find the start of the response
        while (startIndex > 0 && lines[startIndex - 1].trim() !== '') {
          startIndex--;
        }
        break;
      }
    }
    
    if (startIndex !== -1) {
      const response = lines.slice(startIndex, endIndex).join('\n').trim();
      if (debug) console.error(`[Gemini MCP Debug] Fallback extracted ${response.length} chars`);
      return response;
    }
    
    return fullOutput.trim();
  }
  
  // Extract response - simple approach
  const responseLines = [];
  let foundContent = false;
  
  for (let i = messageIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    
    // Skip initial processing indicators
    if (!foundContent && (
      line.includes('⠦') || line.includes('⠴') || line.includes('⠼') ||
      line.includes('✦') || line.includes('Translating') || 
      line.includes('Searching') || line.includes('GoogleSearch') ||
      line.includes('Pre-heating') || line.includes('Responding') ||
      line.trim() === ''
    )) {
      continue;
    }
    
    // Stop at next prompt
    if (line.includes('gemini>') || line.includes('shell mode enabled')) {
      break;
    }
    
    // We found actual content
    if (line.trim() !== '') {
      foundContent = true;
    }
    
    if (foundContent || line.trim() !== '') {
      responseLines.push(line);
    }
  }
  
  // Trim trailing empty lines
  while (responseLines.length > 0 && responseLines[responseLines.length - 1].trim() === '') {
    responseLines.pop();
  }
  
  const response = responseLines.join('\n');
  
  if (debug) {
    console.error(`[Gemini MCP Debug] Extracted ${responseLines.length} lines`);
    if (response.length === 0) {
      console.error("[Gemini MCP Debug] Empty response - check raw output");
    }
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
      
      // Wait longer for Gemini to start processing the message
      console.error("[Gemini MCP] Waiting for Gemini to start processing...");
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Check if Gemini received the message by looking for any activity
      const { stdout: initialCheck } = await execAsync(`tmux capture-pane -t ${SESSION_NAME} -p | tail -5`);
      if (debug) {
        console.error(`[Gemini MCP Debug] Initial check after sending:\n${initialCheck}`);
      }
      
      // If we see the message was received, wait a bit more for processing to start
      if (initialCheck.includes(processedMessage) || initialCheck.includes('✦') || initialCheck.includes('⠴')) {
        console.error("[Gemini MCP] Message received, waiting for response...");
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        // Message might not have been received, wait longer
        console.error("[Gemini MCP] Waiting for message reception...");
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      
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
        const debugText = [
          `Response:\n${responseText}`,
          `\n--- Debug Information ---`,
          `Total execution time: ${Date.now() - startTime}ms`,
          `Session existed: ${sessionExists}`,
          `Message sent: "${processedMessage}"`,
          `Timeout used: ${timeout}ms`,
          `\nCommands executed (${debugInfo.tmuxCommands.length}):`,
          ...debugInfo.tmuxCommands.map((cmd, i) => `  ${i+1}. ${cmd}`),
          `\nRaw output sample (last 500 chars):`,
          debugInfo.rawOutput.slice(-500),
          `\nExtracted response: ${geminiResponse.length} chars`
        ].join('\n');
        
        return {
          content: [{
            type: "text",
            text: debugText
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