// Call one tool on the server with JSON args from stdin; print the result JSON.
//
//   echo '{"room_type":"kitchen"}' | MCP_URL=https://render.example.com/mcp/<MCP_PATH_KEY> node scripts/_call.mjs build_render_prompt
//
// MCP_URL is the full MCP endpoint (include /<MCP_PATH_KEY> when the gate is on).
// Local dev: MCP_URL=http://localhost:8787/mcp
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

if (!process.env.MCP_URL) {
  console.error("Set MCP_URL to the server's MCP endpoint, e.g. http://localhost:8787/mcp")
  process.exit(1)
}
let input = ""
for await (const chunk of process.stdin) input += chunk
const c = new Client({ name: "call", version: "0" }, { capabilities: {} })
await c.connect(new StreamableHTTPClientTransport(new URL(process.env.MCP_URL)))
const r = await c.callTool({ name: process.argv[2], arguments: JSON.parse(input || "{}") }, undefined, { timeout: 300000 })
process.stdout.write(JSON.stringify(r))
await c.close()
