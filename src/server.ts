#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "child_process";

// Create MCP server
const server = new McpServer({
  name: "gemini-cli",
  version: "1.5.1",
  description: "MCP server for interacting with Gemini CLI (one-shot mode)"
});

// Helper function to send message and get response in one shot
async function sendOneShot(message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    console.error(`[Gemini MCP] Sending: ${message.substring(0, 50)}...`);
    
    // Escape quotes and special characters for shell
    const escapedMessage = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
    
    // Use echo to pipe message into gemini
    const geminiProcess = spawn('sh', ['-c', `echo "${escapedMessage}" | gemini`]);
    
    let output = '';
    let error = '';
    let lastDataTime = Date.now();
    let timeoutHandle: NodeJS.Timeout;
    
    // Reset timeout whenever we receive data
    const resetTimeout = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      timeoutHandle = setTimeout(() => {
        console.error('[Gemini MCP] No data received for 60 seconds, assuming complete');
        geminiProcess.kill();
      }, 60000); // 60 second timeout since last data
    };
    
    resetTimeout();
    
    geminiProcess.stdout.on('data', (data) => {
      const chunk = data.toString();
      output += chunk;
      lastDataTime = Date.now();
      resetTimeout();
      
      // Log progress for long responses
      if (output.length % 1000 === 0) {
        console.error(`[Gemini MCP] Receiving data... ${output.length} chars so far`);
      }
    });
    
    geminiProcess.stderr.on('data', (data) => {
      error += data.toString();
    });
    
    geminiProcess.on('close', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      
      const duration = Date.now() - lastDataTime;
      console.error(`[Gemini MCP] Process exited with code ${code} after ${duration}ms`);
      
      if (code !== 0 && code !== null) {
        reject(new Error(`Gemini process failed (code ${code}): ${error}`));
      } else {
        // Clean the output - remove "Loaded cached credentials." if present
        const lines = output.split('\n');
        const cleanedLines = lines.filter(line => !line.includes('Loaded cached credentials.'));
        const cleanedOutput = cleanedLines.join('\n').trim();
        
        console.error(`[Gemini MCP] Response complete (${cleanedOutput.length} chars)`);
        resolve(cleanedOutput);
      }
    });
    
    geminiProcess.on('error', (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      console.error(`[Gemini MCP] Process error: ${err}`);
      reject(err);
    });
  });
}

// Register main tool for sending messages
server.registerTool(
  "gemini_send",
  {
    title: "Send Message to Gemini CLI",
    description: `Send a message to Gemini CLI and receive the response using one-shot execution.
    
This tool executes Gemini CLI in a stateless manner - each message is independent.
No session management or conversation history is maintained.

Features:
- Instant execution without tmux
- File context support with @filename  
- Handles Korean and English input
- Web search capabilities
- No session state to manage`,
    inputSchema: {
      message: z.string().describe("The message to send to Gemini")
    }
  },
  async ({ message }) => {
    try {
      console.error(`[Gemini MCP] Starting request at ${new Date().toISOString()}`);
      const startTime = Date.now();
      
      const response = await sendOneShot(message);
      
      const duration = Date.now() - startTime;
      console.error(`[Gemini MCP] Request completed in ${duration}ms`);
      
      if (!response) {
        return {
          content: [{
            type: "text",
            text: "No response received from Gemini. Please try again."
          }]
        };
      }
      
      return {
        content: [{
          type: "text",
          text: response
        }]
      };
      
    } catch (error) {
      console.error(`[Gemini MCP] Error: ${error}`);
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
);

// Register status tool
server.registerTool(
  "gemini_status",
  {
    title: "Check Gemini CLI Status",
    description: "Check if Gemini CLI is available and working",
    inputSchema: {}
  },
  async () => {
    try {
      // Send a simple test message
      const response = await sendOneShot("Hello");
      
      return {
        content: [{
          type: "text",
          text: `Gemini CLI is working. Test response: ${response.substring(0, 100)}...`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Gemini CLI is not responding: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Gemini CLI MCP server v1.5.1 (one-shot mode) running");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});