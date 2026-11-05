# JobTread integration (optional)

When the `JOBTREAD_GRANT_KEY` secret is set, the server registers four extra tools and the widget shows its job features. Without the key, none of this exists: no JobTread tools, the Job box is a free-text project tag, and the Selections and Save buttons are hidden.

## What it adds

| Where | Feature |
|---|---|
| `find_job` | Look up a job by number, name, or customer. Open jobs unless `include_closed`. |
| `list_open_jobs` | Widget-only (hidden from the model). Feeds the job pick list. |
| `list_job_selections` | Product images for a job: images attached to live budget line items, plus images in the selections folder. Use them as `product_reference_urls`. |
| `save_render_to_job` | File a render on a job with a consistent folder, tag, and name. |
| Widget | Job pick list, a **Selections** button that loads the job's products as references, **Save to JobTread** in each render's menu, a ✓ badge on saved renders. |

## Setup

1. **Dedicated user.** Create a JobTread user just for this (for example "AI Renders"). Saved files show this user as the uploader, which makes AI-filed files easy to spot.
2. **Grant key.** As that user, create an API grant (Settings → API grants). Copy it; it's shown once.
3. **Conventions.** Set these in `wrangler.jsonc` → `vars` to match how your company files things:

   | Var | Default | Meaning |
   |---|---|---|
   | `JOBTREAD_RENDERS_FOLDER` | `03 - Renders` | Folder renders are filed into |
   | `JOBTREAD_SELECTIONS_FOLDER` | `04 - Selections` | Folder also scanned for product images |
   | `JOBTREAD_RENDER_TAG` | `3D Render` | Tag on every saved render |
   | `JOBTREAD_LATEST_TAG` | `Latest` | Added when the user says a render supersedes earlier ones |
   | `JOBTREAD_OUTDATED_TAG` | `Outdated` | Moved onto the superseded renders |
   | `TIME_ZONE` | `America/Chicago` | Date used in file names |

   **The three tags must exist in your JobTread org.** They're looked up by name, and a missing tag makes the save fail with a clear error rather than mis-tagging. The folder is set by name on each file, so there is nothing to create up front.
4. **Set and deploy:**

   ```bash
   npx wrangler secret put JOBTREAD_GRANT_KEY
   corepack pnpm cf-typegen
   corepack pnpm run deploy
   ```

5. **Test on a throwaway job.** Create a test job in JobTread, then:

   ```bash
   echo '{"query":"<test job number>"}' | MCP_URL=<connector url> node scripts/_call.mjs find_job
   echo '{"render":"<a render URL>","job_id":"<id from find_job>","room":"Kitchen"}' | MCP_URL=<connector url> node scripts/_call.mjs save_render_to_job
   ```

   Open the job's Files tab and confirm the folder, name, and tag.

## How filing works

- **Name:** `Render - {Room} - YYYY-MM-DD.jpg`, using the render's creation date in `TIME_ZONE`. Room is Title Cased with filename-unsafe characters stripped. If the name is taken on the job, ` r2`, ` r3`… is appended.
- **Upload:** `createUploadRequest({ organizationId, url })` lets JobTread fetch the render from its public `/img/` URL, then `createFile` puts it in the folder with the tag. The Worker never streams the bytes, which is why `PUBLIC_ORIGIN` must be reachable from JobTread's servers.
- **Latest / Outdated:** only with `mark_latest: true`. The new file gets Latest; earlier same-room renders in the folder lose Latest and gain Outdated. All their other tags are carried forward.
- **Visibility:** the server never adds or removes any other tag, including whatever tags your org uses to share files with clients or subcontractors. Saving never makes a render client-visible. A person does that in JobTread.
- **Closed jobs:** refused unless `confirm_closed_job: true`, which the tool description tells Claude to set only after the user confirms.
- **No duplicates:** the save is recorded on the R2 object; saving the same render to the same job again is a no-op.

## Selections

Designers often attach product images to budget line items ("Tub Faucet Specification → Image 1") rather than dropping them in a folder, so `list_job_selections` reads both. Document-snapshot copies of budget lines are skipped. URLs come from `file.url(size: 1600)` and are signed and short-lived: list them, then use them right away. About a third of supplier images are ~100 px thumbnails; Gemini still matches their style and finish, and the widget marks them low-res.

## Pave gotchas

- **Grant keys expire after 3 months unused.** Regular saves keep them alive. An expired key produces a plain-language error telling an admin to issue a new one.
- **Nested connection pages are priced by size.** Asking for 100 files with each file's default tag page returns HTTP 413. The client caps nested pages explicitly (`fileTags: { $: { size: 10 } }`, budget lines 50 per page).
- **Schema reference:** https://app.jobtread.com/docs (JavaScript-rendered; open it in a browser).
- Some third-party JobTread MCP tools that "upload a file" actually post it as a comment attachment and ignore folder, name, and tags. This server calls Pave directly for that reason.
