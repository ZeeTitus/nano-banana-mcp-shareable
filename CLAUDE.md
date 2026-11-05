# CLAUDE.md

Notes for Claude Code working in this repo. Read this first, then [SETUP.md](SETUP.md) if the task is setup or deploy.

## What this is

A remote MCP server on Cloudflare Workers that generates remodeling renders with Google's image models and serves an interactive MCP Apps widget to claude.ai. TypeScript, no build step beyond Wrangler's bundler. One Durable Object (the MCP session), one R2 bucket (images).

## If the user asks you to set it up

Follow [SETUP.md](SETUP.md) step by step and run each **Check**. Ground rules:

- **Never invent values.** API keys, domains, Cloudflare account IDs, JobTread keys: ask the user. Placeholders like `render.example.com` in this repo are placeholders, not defaults to deploy.
- **The human does the interactive bits:** `wrangler login` (browser), pasting secret values at `wrangler secret put` prompts, dashboard settings (Bot Fight Mode, R2 enablement, plan upgrades), adding the connector in claude.ai.
- **Secrets never go in tracked files.** They belong in `.dev.vars` (gitignored, local) or `wrangler secret put` (production). If you generate `MCP_PATH_KEY` / `UPLOAD_TOKEN`, show them to the user once so they can save them, and don't write them anywhere else.
- **Spending money:** `pnpm smoke --generate` and the scripts in `scripts/` that call `generate_render_interactive` cost real Google credits (cents each). Ask before running them in a loop.
- `pnpm` may not be on PATH. Use `corepack pnpm ...`. Use `corepack pnpm run deploy`, not `pnpm deploy` (that's a different, built-in pnpm command).
- On Windows PowerShell, set env vars as `$env:MCP_URL="..."; corepack pnpm smoke`.

## Commands

| Command | What |
|---|---|
| `corepack pnpm install` | Install deps |
| `corepack pnpm cf-typegen` | Regenerate `worker-configuration.d.ts` from `wrangler.jsonc` (gitignored, needed for typecheck) |
| `corepack pnpm typecheck` | `tsc --noEmit`. Run after every code change. |
| `corepack pnpm dev` | Local server at http://localhost:8787 (reads `.dev.vars`) |
| `corepack pnpm run deploy` | Deploy to Cloudflare |
| `corepack pnpm setup:check` | Offline config check (never prints secrets) |
| `MCP_URL=... corepack pnpm smoke` | Live checks against a running server; `--generate` adds one paid render |
| `npx wrangler tail` | Live production logs |

There are no unit tests. Verification is typecheck + smoke test + looking at real renders.

## Map

```
src/
  index.ts              HTTP entry: capability-URL gate (/mcp/<key>), /upload (page + POST), /img/<file>, landing
  mcp.ts                NanoBananaMCP (McpAgent): every tool, widget resource registration, R2 library helpers
  types.ts              Secret declarations merged into the generated Env
  lib/
    prompts.ts          Style preambles + structure-preservation preamble. The quality lever.
    nano-banana.ts      Gemini image API client (model IDs in MODEL_MAP), labeled multi-ref requests
    imagen.ts           Imagen 4 client
    google.ts           Shared types, friendly error messages
    render-widget.ts    The whole widget: one HTML/CSS/JS string served as ui://nano-banana/viewer-vN.html
    jobtread.ts         JobTread Pave client: find jobs, selection images, file a render
scripts/
  smoke-test.mjs        Post-deploy checks
  check-setup.mjs       Pre-flight config checks
  _call.mjs             Call any tool: echo '{...}' | MCP_URL=... node scripts/_call.mjs <tool>
  window-test.mjs       Regression check for the model inventing windows
  area-edit-test.py     Reproduces the widget's crop → edit → stitch pipeline outside the browser
docs/                   ARCHITECTURE, JOBTREAD, TROUBLESHOOTING
```

## Config flow

- `wrangler.jsonc` `vars` → plain settings (`PUBLIC_ORIGIN`, `TIME_ZONE`, `JOBTREAD_*`). Typed by `cf-typegen`.
- Secrets → `GEMINI_API_KEY`, `MCP_PATH_KEY`, `UPLOAD_TOKEN`, `JOBTREAD_GRANT_KEY`. Typed in `src/types.ts`.
- `NanoBananaMCP.init()` reads env once: sets the module-level `WORKER_ORIGIN`, decides whether JobTread tools are registered, builds the widget CSP, and fills the widget's `__WORKER_ORIGIN__`, `__JOBTREAD_ENABLED__`, and `__UPLOAD_TOKEN__` placeholders.

## Rules for changing things

- **Widget changes → bump the version.** `RENDER_WIDGET_URI` in `src/lib/render-widget.ts` is `ui://nano-banana/viewer-vN.html`. claude.ai caches the widget by URI, so any HTML/JS change needs N+1. The `ResourceTemplate` in `mcp.ts` answers old versions with the current HTML, so old chats don't break.
- **The widget is a TypeScript template literal.** Inside it: no backticks, no `${`, and escapes are doubled (write `\\u2014` to get `—` in the browser's JS, `\\n` for `\n`). Plain ES5-style JS, no build step.
- **Tool descriptions are prompts.** Claude decides what to call from them. When behavior changes, update the description in the same edit.
- **Prompt wording is load-bearing.** Read the comments in `prompts.ts` before touching lighting or variation wording; several innocent phrases ("natural daylight", "distinctly different design") were proven to make the model add windows or move the camera. Re-test with `scripts/window-test.mjs` after changes.
- **R2 metadata edits re-put the object**, which resets `uploaded`. Sort and date by `customMetadata.created_at` (see `createdTime()`), never by `uploaded`.
- **Never accept arbitrary URLs where a render is expected.** `save_render_to_job` and `store_edited_render` only act on objects already in our own R2 bucket.
- **Keep JobTread optional.** Anything JobTread-specific must stay behind `jtEnabled` on the server and `JOBTREAD_ENABLED` in the widget.

## Known platform limits (don't rediscover these)

- **claude.ai caps tool-call arguments at roughly 3 KB, silently.** A chat-attached image can't be passed as base64. That's why `propose_render` exists: Claude writes the prompt, the widget opens, the user uploads in the widget.
- **claude.ai's code sandbox can't reach most outbound hosts**, so "have Claude upload the attachment itself" doesn't work either.
- **workers.dev has bot protection you can't disable.** Use a custom domain with Bot Fight Mode off.
- **claude.ai caches the connector's tool list.** New tools or changed schemas show up in new chats, sometimes only after re-adding the connector.
- **Gemini image models are preview models.** If Google renames or retires one, update `MODEL_MAP` in `src/lib/nano-banana.ts`. Pro sometimes rejects `thinkingConfig`; the client retries without it.
- **Gemini rejects tiny images** (below roughly thumbnail size) with "unable to process input image". `MIN_INLINE_REF_B64_CHARS` guards this.

More background in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
