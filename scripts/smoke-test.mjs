// End-to-end smoke test against a running server (local `pnpm dev` or deployed).
//
//   MCP_URL=http://localhost:8787/mcp pnpm smoke             # free checks only
//   MCP_URL=https://render.example.com/mcp/<key> pnpm smoke --generate   # also makes 1 flash render (~$0.04)
//
// Checks: connects over Streamable HTTP, lists tools, reads the widget resource
// (and that its placeholders were filled in), calls build_render_prompt, and
// with --generate makes one render and fetches it back from /img/.
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const MCP_URL = process.env.MCP_URL
if (!MCP_URL) {
  console.error("Set MCP_URL, e.g. MCP_URL=http://localhost:8787/mcp pnpm smoke")
  process.exit(1)
}
const generate = process.argv.includes("--generate")
let failures = 0
const ok = (msg) => console.log(`  PASS  ${msg}`)
const bad = (msg) => {
  failures++
  console.log(`  FAIL  ${msg}`)
}

const c = new Client({ name: "smoke-test", version: "0" }, { capabilities: {} })
try {
  await c.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)))
  ok(`connected to ${MCP_URL.replace(/\/mcp\/[^/]+$/, "/mcp/<key>")}`)
} catch (e) {
  bad(`could not connect: ${e.message}. Is the server running, and does MCP_URL include /<MCP_PATH_KEY> when the gate is on?`)
  process.exit(1)
}

const { tools } = await c.listTools()
const names = tools.map((t) => t.name)
const core = ["generate_render", "generate_render_interactive", "propose_render", "upscale_render", "build_render_prompt", "list_renders"]
const missing = core.filter((n) => !names.includes(n))
missing.length ? bad(`missing core tools: ${missing.join(", ")}`) : ok(`${names.length} tools listed`)
const jt = names.includes("save_render_to_job")
console.log(`        JobTread tools: ${jt ? "ON" : "off (JOBTREAD_GRANT_KEY not set)"}`)

const { resources } = await c.listResources()
const widget = resources.find((r) => r.uri.startsWith("ui://nano-banana/viewer-"))
if (!widget) bad("widget resource not listed")
else {
  const read = await c.readResource({ uri: widget.uri })
  const html = read.contents[0]?.text ?? ""
  const leftovers = ["__WORKER_ORIGIN__", "__JOBTREAD_ENABLED__", "__UPLOAD_TOKEN__"].filter((p) => html.includes(p))
  leftovers.length ? bad(`widget placeholders not filled: ${leftovers.join(", ")}`) : ok(`widget ${widget.uri} served (${Math.round(html.length / 1024)} KB)`)
  const origin = html.match(/var WORKER_ORIGIN = "([^"]*)"/)?.[1]
  if (!origin) bad("widget WORKER_ORIGIN is empty — set PUBLIC_ORIGIN in wrangler.jsonc (or .dev.vars locally)")
  else if (origin.includes("example.com")) bad(`PUBLIC_ORIGIN is still the placeholder (${origin})`)
  else ok(`PUBLIC_ORIGIN = ${origin}`)
}

const p = await c.callTool({ name: "build_render_prompt", arguments: { room_type: "kitchen", style_direction: "transitional" } })
p.content?.[0]?.text?.includes("kitchen") ? ok("build_render_prompt works") : bad("build_render_prompt returned something unexpected")

if (generate) {
  console.log("        generating one flash render (~$0.04)...")
  const r = await c.callTool(
    { name: "generate_render_interactive", arguments: { prompt: "A bright transitional kitchen with white shaker cabinets and quartz counters", model: "flash", job_tag: "smoke-test" } },
    undefined,
    { timeout: 180000 },
  )
  const url = r.structuredContent?.archivedUrls?.[0]
  if (!url) bad(`no render came back: ${r.content?.[0]?.text?.slice(0, 300)}`)
  else {
    ok(`render stored at ${url}`)
    try {
      const res = await fetch(url)
      res.ok && (res.headers.get("content-type") ?? "").startsWith("image/")
        ? ok("render fetched back from /img/ (public URL works)")
        : bad(`fetching ${url} returned HTTP ${res.status}`)
    } catch (e) {
      bad(`fetching ${url} failed: ${e.message}`)
    }
  }
}

await c.close()
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.")
process.exit(failures ? 1 : 0)
