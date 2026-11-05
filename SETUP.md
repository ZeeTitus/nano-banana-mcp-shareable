# Setup

Step-by-step from a fresh clone to a working connector in claude.ai. Written so Claude Code can run it with you: each step says what to run, what the human has to do, and how to check it worked.

> **Claude Code:** work through these in order. Don't skip a **Check**. When a step says **Human**, stop and ask; never invent API keys, domains, or account IDs, and never paste a secret into a file that gets committed. Use `corepack pnpm` if `pnpm` isn't on PATH.

---

## 0. Prerequisites

| Need | How to check |
|---|---|
| Node.js 20 or newer | `node --version` |
| pnpm (via corepack) | `corepack pnpm --version` (if that fails: `corepack enable`) |
| Cloudflare account, **R2 enabled** | Dashboard → R2. Cloudflare asks for a payment method to enable R2, even on the free tier. |
| **Workers Paid plan** (recommended, $5/mo) | Dashboard → Workers & Pages → Plans. The free plan's 10 ms CPU limit is tight for base64-encoding multi-megabyte images; you'll see intermittent "exceeded CPU" failures. |
| A domain on Cloudflare | Dashboard → Websites. A subdomain of a domain you already run through Cloudflare works. Buying a cheap one through Cloudflare Registrar also works. |
| Google AI Studio API key | https://aistudio.google.com/apikey. Use a key from a **billing-enabled** Google Cloud project; free-tier keys hit rate limits fast and may lack the Pro image model. |
| claude.ai plan with custom connectors | Pro, Max, Team, or Enterprise. On Team/Enterprise an owner may need to add the connector. |

**Human:** gather the Google API key and decide on the hostname (for example `render.yourco.com`).

---

## 1. Install

```bash
corepack pnpm install
```

**Check:** finishes without errors; `node_modules/` exists.

---

## 2. Log in to Cloudflare

```bash
npx wrangler login
```

**Human:** this opens a browser to approve access. Then:

```bash
npx wrangler whoami
```

**Check:** shows the account you expect. If it lists more than one account, copy the right Account ID into `wrangler.jsonc` as `"account_id"` (uncomment the line).

---

## 3. Create the R2 bucket

The bucket name lives in `wrangler.jsonc` under `r2_buckets` (default `nano-banana-refs`). Rename it there first if you want.

```bash
npx wrangler r2 bucket create nano-banana-refs
```

**Check:** `npx wrangler r2 bucket list` shows it.

---

## 4. Run it locally

```bash
cp .dev.vars.example .dev.vars
```

**Human:** put the Google key in `.dev.vars` as `GEMINI_API_KEY`. Leave `MCP_PATH_KEY` commented out for local work. `.dev.vars` is gitignored.

```bash
corepack pnpm cf-typegen
corepack pnpm typecheck
corepack pnpm dev
```

`cf-typegen` writes `worker-configuration.d.ts` (gitignored), which the typecheck needs. Re-run it whenever `wrangler.jsonc` changes.

In a second terminal:

```bash
MCP_URL=http://localhost:8787/mcp corepack pnpm smoke
```

Add `--generate` to also make one real render (~$0.04).

**Check:** all PASS. Open http://localhost:8787/ and you should see the landing page. Local dev uses a local R2 simulation, so nothing lands in the real bucket yet.

> PowerShell: `$env:MCP_URL="http://localhost:8787/mcp"; corepack pnpm smoke`

---

## 5. Custom domain

Why not just use `*.workers.dev`? Cloudflare's bot protection runs on workers.dev and can't be turned off there. We got HTTP 403s from it on server-to-server fetches (claude.ai's code sandbox, JobTread pulling a render). On your own zone you control that setting.

1. **Human:** make sure the domain's zone is active in Cloudflare (Dashboard → Websites).
2. Add a route to `wrangler.jsonc` at the top level, using your hostname:

   ```jsonc
   "routes": [
     { "pattern": "render.yourco.com", "custom_domain": true }
   ],
   ```

   Wrangler creates the DNS record and certificate on deploy.
3. Set the same origin in `wrangler.jsonc` → `vars.PUBLIC_ORIGIN`, with `https://` and no trailing slash:

   ```jsonc
   "PUBLIC_ORIGIN": "https://render.yourco.com",
   ```

4. **Human:** in the Cloudflare dashboard for that zone, go to **Security → Bots** and turn **Bot Fight Mode off**. If you use WAF rules, make sure they don't challenge `/img/*` or `/upload`.

**Check:**

```bash
corepack pnpm cf-typegen
corepack pnpm setup:check
```

No `FIX` lines about `PUBLIC_ORIGIN`.

---

## 6. Production secrets

Generate the two access secrets (Claude Code can run these and show the output to the human, who should save them in a password manager):

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

The first is `MCP_PATH_KEY`, the second is `UPLOAD_TOKEN`. Then set them, plus the Google key. Each command prompts for the value:

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put MCP_PATH_KEY
npx wrangler secret put UPLOAD_TOKEN
```

**Human:** paste each value when prompted. Cloudflare secrets are write-only; if one is lost, generate a new one and put it again.

Note: `wrangler secret put` against a Worker that doesn't exist yet creates it. That's fine.

**Check:** `npx wrangler secret list` shows all three names.

---

## 7. Deploy

```bash
corepack pnpm run deploy
```

**Check:**

- The output lists your custom domain.
- `https://render.yourco.com/` returns **404**. That's correct: with `MCP_PATH_KEY` set, the landing page and bare `/mcp` are hidden.
- Smoke test against production:

  ```bash
  MCP_URL=https://render.yourco.com/mcp/<MCP_PATH_KEY> corepack pnpm smoke --generate
  ```

  All PASS, including "render fetched back from /img/".

New custom domains can take a few minutes for DNS and certificates. If the first smoke test fails to connect, wait and retry.

---

## 8. Connect it to Claude

Your connector URL is:

```
https://render.yourco.com/mcp/<MCP_PATH_KEY>
```

Treat it like a password. Anyone with it can spend your Google credits.

**claude.ai (where the widget works):** **Human:** Settings → Connectors → Add custom connector → paste the URL, no auth. Then in a new chat, enable the connector and try:

> Render a transitional kitchen with white shaker cabinets, quartz counters, and a herringbone tile backsplash.

You should see the render widget appear inline. Attach a room photo and ask for a render to test the `propose_render` → widget upload path.

**Claude Code (tools only, no widget):**

```bash
claude mcp add --transport http nano-banana https://render.yourco.com/mcp/<MCP_PATH_KEY>
```

**Reference upload page for people:** `https://render.yourco.com/upload?token=<UPLOAD_TOKEN>` gives a drag-and-drop page that returns a URL to use as `reference_image_urls`.

---

## 9. Optional: JobTread

Skip unless you use JobTread. Full details in [docs/JOBTREAD.md](docs/JOBTREAD.md). Short version:

1. **Human:** in JobTread, create a dedicated user (for example "AI Renders") with access to jobs and files, then create an API grant key for that user (Settings → API grants). It's shown once.
2. Make sure your org has the file tags named in `wrangler.jsonc` → `vars` (`JOBTREAD_RENDER_TAG`, `JOBTREAD_LATEST_TAG`, `JOBTREAD_OUTDATED_TAG`), or change the vars to tags you already use. Adjust `JOBTREAD_RENDERS_FOLDER`, `JOBTREAD_SELECTIONS_FOLDER`, and `TIME_ZONE` to match your file conventions.
3. Set the key and redeploy:

   ```bash
   npx wrangler secret put JOBTREAD_GRANT_KEY
   corepack pnpm run deploy
   ```

**Check:** `corepack pnpm smoke` reports `JobTread tools: ON`. Then:

```bash
echo '{"query":"<a job number>"}' | MCP_URL=https://render.yourco.com/mcp/<MCP_PATH_KEY> node scripts/_call.mjs find_job
```

returns the job. Test a save on a throwaway test job before using it on real ones.

claude.ai caches a connector's tool list. After turning JobTread on, start a new chat (or remove and re-add the connector) to see the new tools.

---

## 10. Hand it to your team

- Share the connector URL privately (password manager, not a public channel).
- Share the upload page link if people will upload references outside the widget.
- To rotate access: `npx wrangler secret put MCP_PATH_KEY` with a new value, then send everyone the new URL. Same for `UPLOAD_TOKEN`.
- Watch logs live with `npx wrangler tail`.

## Updating later

```bash
git pull
corepack pnpm install
corepack pnpm cf-typegen
corepack pnpm typecheck
corepack pnpm run deploy
```

If you change the widget HTML (`src/lib/render-widget.ts`), bump the version in `RENDER_WIDGET_URI` so claude.ai fetches the new copy. See [CLAUDE.md](CLAUDE.md).
