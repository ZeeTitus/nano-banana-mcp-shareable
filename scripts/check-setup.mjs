// Offline pre-flight check: is this checkout configured enough to run/deploy?
//   pnpm setup:check
// Reads wrangler.jsonc and .dev.vars only. Never prints secret values.
import { existsSync, readFileSync } from "node:fs"

let problems = 0
const ok = (m) => console.log(`  OK    ${m}`)
const warn = (m) => console.log(`  WARN  ${m}`)
const bad = (m) => {
  problems++
  console.log(`  FIX   ${m}`)
}

// --- wrangler.jsonc (strip // comments, then parse) ---
const raw = readFileSync("wrangler.jsonc", "utf8")
const json = raw.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")
let cfg
try {
  cfg = JSON.parse(json)
  ok("wrangler.jsonc parses")
} catch (e) {
  bad(`wrangler.jsonc did not parse after stripping comments: ${e.message}`)
  process.exit(1)
}
const origin = cfg.vars?.PUBLIC_ORIGIN ?? ""
if (!origin) bad("vars.PUBLIC_ORIGIN is empty")
else if (origin.includes("example.com")) bad(`vars.PUBLIC_ORIGIN is still the placeholder (${origin}) — set it to your custom domain`)
else if (!origin.startsWith("https://")) bad(`vars.PUBLIC_ORIGIN must be https (${origin})`)
else if (origin.endsWith("/")) bad("vars.PUBLIC_ORIGIN must not end with a slash")
else if (origin.includes("workers.dev")) warn(`PUBLIC_ORIGIN is a workers.dev URL — claude.ai's sandbox and some fetchers get blocked there. Use a custom domain (SETUP.md step 5).`)
else ok(`PUBLIC_ORIGIN = ${origin}`)
const bucket = cfg.r2_buckets?.[0]?.bucket_name
bucket ? ok(`R2 bucket name: ${bucket} (create it with: npx wrangler r2 bucket create ${bucket})`) : bad("no r2_buckets entry")
cfg.account_id ? ok("account_id set") : warn("account_id not set — fine if your Cloudflare login has one account")

// --- .dev.vars (local only) ---
if (!existsSync(".dev.vars")) warn(".dev.vars missing — copy .dev.vars.example to .dev.vars for `pnpm dev`")
else {
  const vars = Object.fromEntries(
    readFileSync(".dev.vars", "utf8")
      .split(/\r?\n/)
      .filter((l) => /^\s*[A-Z_]+\s*=/.test(l))
      .map((l) => {
        const i = l.indexOf("=")
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]
      }),
  )
  const g = vars.GEMINI_API_KEY ?? ""
  !g || g.startsWith("your-") ? bad(".dev.vars GEMINI_API_KEY is not set") : ok(".dev.vars GEMINI_API_KEY set")
  vars.MCP_PATH_KEY ? ok(".dev.vars MCP_PATH_KEY set (local MCP lives at /mcp/<key>)") : ok(".dev.vars MCP_PATH_KEY unset (local MCP lives at /mcp)")
  vars.JOBTREAD_GRANT_KEY && !vars.JOBTREAD_GRANT_KEY.startsWith("your-") ? ok(".dev.vars JOBTREAD_GRANT_KEY set (JobTread features on)") : ok("JobTread features off locally")
}

// --- generated types ---
existsSync("worker-configuration.d.ts") ? ok("worker-configuration.d.ts present") : bad("run `pnpm cf-typegen` to generate worker-configuration.d.ts")
existsSync("node_modules") ? ok("dependencies installed") : bad("run `pnpm install` (or `corepack pnpm install`)")

console.log(problems ? `\n${problems} thing(s) to fix. Production secrets are checked with: npx wrangler secret list` : "\nLooks ready. Production secrets: npx wrangler secret list")
process.exit(problems ? 1 : 0)
