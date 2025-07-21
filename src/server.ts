#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, execSync } from "child_process";

// Create MCP server
const server = new McpServer({
  name: "gemini-cli",
  version: "1.5.5",
  description: "MCP server for interacting with Gemini CLI (one-shot mode)"
});

// Check if Gemini CLI is available
function checkGeminiAvailable(): boolean {
  try {
    execSync('which gemini', { stdio: 'ignore' });
    console.error('[Gemini MCP] Gemini CLI found in PATH');
    return true;
  } catch {
    console.error('[Gemini MCP] Gemini CLI not found in PATH');
    try {
      // Try to run gemini directly
      execSync('gemini --version', { stdio: 'ignore' });
      console.error('[Gemini MCP] Gemini CLI is available');
      return true;
    } catch {
      console.error('[Gemini MCP] Cannot execute gemini command');
      return false;
    }
  }
}

// Helper function to send message and get response in one shot
async function sendOneShot(message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    console.error(`[Gemini MCP] Sending: ${message.substring(0, 50)}...`);
    
    // Spawn gemini process directly (no shell)
    const geminiProcess = spawn('gemini', [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      cwd: process.cwd()
    });
    
    let output = '';
    let error = '';
    let lastDataTime = Date.now();
    let timeoutHandle: NodeJS.Timeout;
    let hasReceivedData = false;
    
    // Handle stdin errors
    geminiProcess.stdin.on('error', (err) => {
      console.error(`[Gemini MCP] stdin error: ${err.message}`);
      reject(new Error(`Failed to write to Gemini process: ${err.message}`));
    });
    
    // Write message to stdin
    try {
      geminiProcess.stdin.write(message + '\n');
      geminiProcess.stdin.end();
    } catch (err) {
      console.error(`[Gemini MCP] Failed to write message: ${err}`);
      reject(new Error(`Failed to send message to Gemini: ${err}`));
      return;
    }
    
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
      hasReceivedData = true;
      lastDataTime = Date.now();
      resetTimeout();
      
      // Log first data received
      if (!hasReceivedData) {
        console.error(`[Gemini MCP] Started receiving response`);
      }
      
      // Log progress for long responses
      if (output.length % 1000 === 0) {
        console.error(`[Gemini MCP] Receiving data... ${output.length} chars so far`);
      }
    });
    
    geminiProcess.stderr.on('data', (data) => {
      const chunk = data.toString();
      error += chunk;
      console.error(`[Gemini MCP] stderr: ${chunk}`);
    });
    
    geminiProcess.on('close', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      
      const duration = Date.now() - lastDataTime;
      console.error(`[Gemini MCP] Process exited with code ${code} after ${duration}ms`);
      console.error(`[Gemini MCP] Total output length: ${output.length}`);
      console.error(`[Gemini MCP] Has received data: ${hasReceivedData}`);
      
      if (!hasReceivedData && error) {
        console.error(`[Gemini MCP] No output received. Error: ${error}`);
        reject(new Error(`Gemini failed to respond: ${error || 'No output received'}`));
      } else if (code !== 0 && code !== null && !hasReceivedData) {
        reject(new Error(`Gemini process failed (code ${code}): ${error || 'No output'}`));
      } else {
        // Parse the complex output from Gemini CLI
        console.error(`[Gemini MCP] Raw output first 500 chars: ${output.substring(0, 500)}`);
        console.error(`[Gemini MCP] Raw output last 500 chars: ${output.substring(output.length - 500)}`);
        
        let cleanedOutput = output;
        
        // Method 1: Find content after "Loaded cached credentials."
        const credentialsIndex = output.lastIndexOf('Loaded cached credentials.');
        if (credentialsIndex !== -1) {
          const afterCredentials = output.substring(credentialsIndex + 'Loaded cached credentials.'.length).trim();
          if (afterCredentials.length > 0) {
            cleanedOutput = afterCredentials;
            console.error(`[Gemini MCP] Found response after credentials: ${cleanedOutput.substring(0, 100)}...`);
          }
        }
        
        // Method 2: If output contains error but also has a response at the end
        if (cleanedOutput.includes('Quota exceeded') || cleanedOutput.includes('quota limit')) {
          // Look for the last substantial text block (not error messages)
          const lines = cleanedOutput.split('\n');
          let lastGoodContent = '';
          let collectingContent = false;
          
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            
            // Skip empty lines
            if (!line) continue;
            
            // Skip error-related lines
            if (line.includes('at async') || 
                line.includes('at process') || 
                line.includes('Error:') || 
                line.includes('node_modules') ||
                line.includes('{') || 
                line.includes('}') ||
                line.includes('[') || 
                line.includes(']')) {
              continue;
            }
            
            // If we find "Loaded cached credentials", we've gone too far back
            if (line.includes('Loaded cached credentials.')) {
              break;
            }
            
            // This looks like actual content
            if (line.length > 10) {
              lastGoodContent = line + (lastGoodContent ? '\n' + lastGoodContent : '');
              collectingContent = true;
            }
          }
          
          if (lastGoodContent) {
            cleanedOutput = lastGoodContent;
            console.error(`[Gemini MCP] Extracted content from error output: ${cleanedOutput.substring(0, 100)}...`);
          }
        }
        
        // Remove any remaining "Loaded cached credentials." if it's the only content
        if (cleanedOutput.trim() === 'Loaded cached credentials.') {
          cleanedOutput = '';
        }
        
        console.error(`[Gemini MCP] Final response length: ${cleanedOutput.length} chars`);
        
        if (!cleanedOutput || cleanedOutput.length < 5) {
          console.error(`[Gemini MCP] Warning: Response seems too short or empty`);
        }
        
        resolve(cleanedOutput);
      }
    });
    
    geminiProcess.on('error', (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      console.error(`[Gemini MCP] Process spawn error: ${err.message}`);
      console.error(`[Gemini MCP] Error details:`, err);
      
      // Check if gemini is installed
      if (err.message.includes('ENOENT')) {
        reject(new Error('Gemini CLI not found. Please ensure gemini is installed and in PATH'));
      } else {
        reject(new Error(`Failed to start Gemini process: ${err.message}`));
      }
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
      
      // Check if Gemini is available
      if (!checkGeminiAvailable()) {
        return {
          content: [{
            type: "text",
            text: "Gemini CLI is not installed or not in PATH. Please install Gemini CLI and ensure it's accessible."
          }]
        };
      }
      
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
  console.error("Gemini CLI MCP server v1.5.5 (one-shot mode) running");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});