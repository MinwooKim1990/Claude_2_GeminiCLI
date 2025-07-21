#!/usr/bin/env node

// Simple test script to verify the MCP server works
const { spawn } = require('child_process');
const path = require('path');

console.log('Testing Gemini MCP Server...\n');

// Check if server.js exists
const serverPath = path.join(__dirname, 'dist', 'server.js');
const fs = require('fs');

if (!fs.existsSync(serverPath)) {
  console.error('Error: Server not built. Run "npm run build" first.');
  process.exit(1);
}

// Spawn the server
const server = spawn('node', [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe']
});

// Test message
const testMessage = {
  jsonrpc: '2.0',
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: {
      name: 'test-client',
      version: '1.0.0'
    }
  },
  id: 1
};

// Send test message
server.stdin.write(JSON.stringify(testMessage) + '\n');

// Handle responses
let output = '';
server.stdout.on('data', (data) => {
  output += data.toString();
  try {
    const lines = output.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        const response = JSON.parse(line);
        console.log('Response:', JSON.stringify(response, null, 2));
        
        if (response.id === 1 && response.result) {
          console.log('\n✅ Server initialized successfully!');
          console.log('Available tools:', response.result.capabilities?.tools ? 'Yes' : 'No');
          
          // Clean exit
          setTimeout(() => {
            server.kill();
            process.exit(0);
          }, 100);
        }
      }
    }
  } catch (e) {
    // Partial JSON, wait for more data
  }
});

// Error handling
server.stderr.on('data', (data) => {
  console.error('Server error:', data.toString());
});

server.on('error', (err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

// Timeout
setTimeout(() => {
  console.error('\n❌ Test timeout - no response from server');
  server.kill();
  process.exit(1);
}, 5000);