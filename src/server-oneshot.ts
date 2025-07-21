#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { exec, spawn } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Create MCP server
const server = new McpServer({
  name: "gemini-cli",
  version: "1.5.0",
  description: "MCP server for interacting with Gemini CLI (one-shot mode)"
});

// Helper function to send message and get response in one shot
async function sendOneShot(message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    console.error(`[Gemini MCP] Sending one-shot message: ${message.substring(0, 50)}...`);
    
    // Use echo to pipe message into gemini
    const geminiProcess = spawn('sh', ['-c', `echo "${message.replace(/"/g, '\\"')}" | gemini`]);
    
    let output = '';
    let error = '';
    
    geminiProcess.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    geminiProcess.stderr.on('data', (data) => {
      error += data.toString();
    });
    
    geminiProcess.on('close', (code) => {
      console.error(`[Gemini MCP] Process exited with code ${code}`);
      console.error(`[Gemini MCP] Raw output length: ${output.length}`);
      
      if (code !== 0 && error) {
        reject(new Error(`Gemini process failed: ${error}`));
      } else {
        // Clean the output - remove "Loaded cached credentials." if present
        const cleanedOutput = output
          .split('\n')
          .filter(line => !line.includes('Loaded cached credentials.'))
          .join('\n')
          .trim();
          
        resolve(cleanedOutput);
      }
    });
    
    geminiProcess.on('error', (err) => {
      reject(err);
    });
  });
}

// Register main tool for sending messages
server.registerTool(
  "gemini_send",
  {
    title: "Send Message to Gemini CLI",
    description: `Send a message to Gemini CLI and receive the response.
    
Features:
- One-shot execution (no persistent session)
- File context support with @filename
- Handles Korean and English input
- Instant response without session management`,
    inputSchema: {
      message: z.string().describe("The message to send to Gemini"),
      timeout: z.number().optional().describe("Response timeout in milliseconds (default: 30000)")
    }
  },
  async ({ message, timeout = 30000 }) => {
    try {
      console.error(`[Gemini MCP] Processing message: ${message}`);
      
      // Set up timeout
      const timeoutPromise = new Promise<string>((_, reject) => {
        setTimeout(() => reject(new Error('Response timeout')), timeout);
      });
      
      // Send message and get response
      const response = await Promise.race([
        sendOneShot(message),
        timeoutPromise
      ]);
      
      console.error(`[Gemini MCP] Response received: ${response.substring(0, 100)}...`);
      
      return {
        content: [{
          type: "text",
          text: response || "No response received from Gemini."
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

// Register clear tool (simplified for one-shot mode)
server.registerTool(
  "gemini_clear",
  {
    title: "Clear Gemini Conversation",
    description: "Note: In one-shot mode, each message is independent. This is a no-op.",
    inputSchema: {}
  },
  async () => {
    return {
      content: [{
        type: "text",
        text: "One-shot mode: Each message is independent, no conversation history to clear."
      }]
    };
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Gemini CLI MCP server v1.5.0 (one-shot mode) running");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});