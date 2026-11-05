# Troubleshooting

Start with `npx wrangler tail` in one terminal while you reproduce the problem. Every `generate_render_interactive` call logs how many inline, URL, style, and product references actually arrived.

| Symptom | Likely cause | Fix |
|---|---|---|
| Connector won't connect in claude.ai | Wrong URL, or `MCP_PATH_KEY` changed | URL must be `https://<domain>/mcp/<MCP_PATH_KEY>`. Bare `/mcp` returns 404 by design when the gate is on. |
| Widget doesn't appear, just text | Host doesn't support MCP Apps (Claude Code, some clients), or the connector was added before a change | Widget needs claude.ai. Start a new chat; if still missing, remove and re-add the connector. |
| "Problem displaying content" in an old chat | Widget URI changed | Already handled by the `viewer-{version}` resource template. If you renamed the URI scheme, restore that template. |
| Widget shows but images are broken | `PUBLIC_ORIGIN` wrong or still the placeholder | `pnpm smoke` reports it. Fix `wrangler.jsonc`, `pnpm cf-typegen`, redeploy. |
| Widget upload fails with 401 | `UPLOAD_TOKEN` rotated but widget HTML cached | Start a new chat. |
| Widget upload or image load blocked (CSP error in browser console) | Origin mismatch: `PUBLIC_ORIGIN` differs from the domain actually serving | Make them identical, including `https://` and no trailing slash. |
| HTTP 403 from Cloudflare on `/img/` or `/upload` for server-side fetches | Bot Fight Mode or a WAF rule | Turn Bot Fight Mode off for the zone; exempt those paths. Don't use workers.dev as `PUBLIC_ORIGIN`. |
| Claude tries to send an attached photo inline and nothing happens | claude.ai's ~3 KB tool-argument cap | Expected. Claude should call `propose_render`; the tool descriptions say so. If it keeps trying, tell it to use the widget. |
| "Google auth failed (401/403)" | Bad key, or key lacks the image models | Re-create the key in a billing-enabled project; `wrangler secret put GEMINI_API_KEY`. |
| "Google rejected the request (400)" | Safety filter (real people, brand names) or bad parameter | Rephrase. Remove names of real people and trademarks. |
| 429 rate limit | Free-tier key or burst | Billing-enabled key; smaller batches. |
| 404 for the model name | Google renamed or retired a preview model | Update `MODEL_MAP` in `src/lib/nano-banana.ts` (or `src/lib/imagen.ts`). |
| "unable to process input image" | Reference too small | Use a larger image (the server already bounces tiny inline refs). |
| Renders add windows or move the camera | Prompt wording | Avoid "natural light", "daylight", "sunlit" for room renders; describe existing fixtures. See `prompts.ts` comments; re-test with `scripts/window-test.mjs`. |
| "exceeded CPU" / intermittent 503 | Workers Free plan CPU limit | Upgrade to Workers Paid. |
| New tools (JobTread) don't show up | claude.ai cached the old tool list | New chat, or remove and re-add the connector. |
| "JobTread rejected the grant key" | Key expired (3 months unused) or revoked | Issue a new grant key; `wrangler secret put JOBTREAD_GRANT_KEY`. |
| "JobTread file tag(s) not found" | Tag names in `vars` don't exist in your org | Create the tags in JobTread or change the vars. |
| JobTread 413 | Query asks for too-large nested pages | Keep the explicit nested `size` caps in `src/lib/jobtread.ts`. |
| `tsc` errors about `Env` / `PUBLIC_ORIGIN` | `worker-configuration.d.ts` missing or stale | `corepack pnpm cf-typegen`. |
| `pnpm deploy` does something odd | That's pnpm's built-in `deploy` command | Use `corepack pnpm run deploy`. |
| `pnpm` not found | pnpm not installed globally | `corepack pnpm ...` or `corepack enable`. |
