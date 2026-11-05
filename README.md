# Nano Banana Render MCP

A remote MCP server that turns Claude into a remodeling render studio. Upload a SketchUp screenshot, a line drawing, or an existing-conditions photo, describe the finishes, and get back photoreal "after" renders that keep the room's geometry. Runs on Cloudflare Workers, uses Google's Imagen 4 and Gemini image models ("Nano Banana"), and ships an interactive widget that opens right inside claude.ai.

Built by a residential remodeler for its design team, then cleaned up so anyone can run their own copy.

## What you get

- **Structure-preserving room renders.** Reference images are treated as ground truth for walls, openings, fixtures, and camera angle. Only finishes change. The prompts include hard-won rules against the model's favorite failure: inventing windows.
- **An interactive widget in claude.ai** (MCP Apps). Gallery, before/after compare slider, refine, batch variations, pin style anchors, paint-to-edit a region, upscale to 4K, export a sheet, download.
- **A render library.** Every render and upload is stored in Cloudflare R2 with a stable URL, so Claude can find and edit past renders across chats.
- **General image mode** for anything that isn't a room: social posts, flyers, yard-sign mockups, product shots.
- **Optional JobTread integration.** Pick a job, pull the job's selected products (faucets, pulls, tile) in as references, and file finished renders on the job with consistent names and tags. Off unless you add a JobTread key.

## Tools

| Tool | What it does |
|---|---|
| `generate_render_interactive` | Main tool. Gemini image generation with structural, style, and product references, batches, and the widget. |
| `propose_render` | When a user attaches a photo in chat: opens the widget with Claude's prompt pre-filled; the user uploads the photo there. |
| `generate_render` | One-shot Imagen 4 text-to-image. |
| `build_render_prompt` | Composes a strong render prompt from room type, dimensions, materials, fixtures. No API call. |
| `upscale_render` | Re-renders a stored image at 4K. |
| `list_renders`, `list_reference_images`, `set_render_label` | Browse and label the library. |
| `find_job`, `list_job_selections`, `save_render_to_job` | JobTread. Registered only when `JOBTREAD_GRANT_KEY` is set. |

## What it costs to run

| Item | Cost |
|---|---|
| Gemini Flash image | ~$0.04 per image |
| Gemini Pro image (2K default) | ~$0.13 per image, ~$0.24 at 4K |
| Imagen 4 | $0.02 / $0.04 / $0.06 (fast / standard / ultra) |
| Cloudflare Workers Paid | $5/month (recommended; see SETUP.md) |
| R2 storage | Free tier covers thousands of renders |
| Custom domain | ~$1–15/year via Cloudflare Registrar, or a subdomain you already own |

Prices are Google's and Cloudflare's as of late 2026. Check their pricing pages.

## Setup

**The fast way:** open this folder in [Claude Code](https://claude.com/claude-code) and say:

> Set this project up for me. Follow SETUP.md.

Claude Code reads [CLAUDE.md](CLAUDE.md) and [SETUP.md](SETUP.md), runs the commands, and stops to ask you for the things only you can do (log in to Cloudflare, paste API keys, pick a domain).

**By hand:** follow [SETUP.md](SETUP.md) top to bottom. Plan on 30–60 minutes, most of it waiting on DNS.

You'll need:

- Node.js 20+ (pnpm comes with it through `corepack`)
- A Cloudflare account with R2 enabled
- A domain (or subdomain) managed by Cloudflare
- A Google AI Studio API key on a billing-enabled project
- A claude.ai plan that supports custom connectors (for the widget)
- Optional: a JobTread account with API access

## Configuration at a glance

| Name | Kind | Required | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | secret | yes | Google image models |
| `PUBLIC_ORIGIN` | var | yes | Your custom domain, e.g. `https://render.yourco.com` |
| `MCP_PATH_KEY` | secret | recommended | Hides the MCP endpoint at `/mcp/<key>` |
| `UPLOAD_TOKEN` | secret | recommended | Locks down `POST /upload` |
| `JOBTREAD_GRANT_KEY` | secret | no | Turns on the JobTread features |
| `TIME_ZONE`, `JOBTREAD_*` | var | no | JobTread file naming and filing rules |

Vars live in [wrangler.jsonc](wrangler.jsonc). Secrets go in with `npx wrangler secret put <NAME>`. Details in [SETUP.md](SETUP.md).

## Docs

- [SETUP.md](SETUP.md): install, deploy, connect to Claude
- [CLAUDE.md](CLAUDE.md): working notes for Claude Code (also a good map for humans)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pieces fit, storage layout, the lessons behind the odd-looking decisions
- [docs/JOBTREAD.md](docs/JOBTREAD.md): the optional JobTread integration
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md): symptoms and fixes

## Security model, briefly

There's no login. Access is controlled by two shared secrets: the MCP path key (whoever has the connector URL can generate images on your Google bill) and the upload token. Stored images are served publicly at unguessable 16-hex-character URLs. That fits a small team. If you need per-user auth, put Cloudflare Access or OAuth in front of it. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#security).

## License

MIT. See [LICENSE](LICENSE).
