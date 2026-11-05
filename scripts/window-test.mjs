// Regression check for the "natural lighting adds windows" failure.
// Renders a reference room with deliberately window-baiting wording (default
// 'room' preset, structure mode, pro x2) so you can eyeball whether the model
// invented any windows. Saves to test-output/<label>-N.jpg.
//
//   MCP_URL=<endpoint> node scripts/window-test.mjs <label> <reference-image-url>
//
// Use a reference of a room with NO windows (a basement works well). Costs ~$0.27.
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { mkdirSync, writeFileSync } from "node:fs"

const [label = "run", refUrl] = process.argv.slice(2)
if (!process.env.MCP_URL || !refUrl) {
  console.error("Usage: MCP_URL=<endpoint> node scripts/window-test.mjs <label> <reference-image-url>")
  process.exit(1)
}
mkdirSync("test-output", { recursive: true })
const c = new Client({ name: "window-test", version: "0" }, { capabilities: {} })
await c.connect(new StreamableHTTPClientTransport(new URL(process.env.MCP_URL)))
const r = await c.callTool({
  name: "generate_render_interactive",
  arguments: {
    prompt: "Photorealistic remodel of this basement family room with bright natural lighting and natural light throughout. Warm modern finishes. Keep colors similar to what's shown. Only enhance realism.",
    reference_image_urls: [refUrl],
    model: "pro",
    batch_count: 2,
    job_tag: "zz-window-test",
  },
}, undefined, { timeout: 300000 })
let n = 0
for (const x of r.content) if (x.type === "image") writeFileSync(`test-output/${label}-${++n}.jpg`, Buffer.from(x.data, "base64"))
console.log(`${label}: ${n} image(s) — ${r.content[0].text.split("\n")[0]}`)
await c.close()
