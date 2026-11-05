// JobTread (Pave API) client for filing renders on a job and reading a job's
// selection images. Filing convention (all names configurable in wrangler.jsonc
// "vars", see docs/JOBTREAD.md): folder JOBTREAD_RENDERS_FOLDER, tag
// JOBTREAD_RENDER_TAG, name `Render - {Room} - YYYY-MM-DD.ext`, Latest/Outdated
// tags only when asked, and never touch any other (e.g. client-visibility) tags.

const PAVE_URL = "https://api.jobtread.com/pave"

/** Filing settings, read from the Worker's env vars (defaults match wrangler.jsonc). */
export interface JobTreadConfig {
  rendersFolder: string
  selectionsFolder: string
  renderTag: string
  latestTag: string
  outdatedTag: string
  timeZone: string
}

export function jobTreadConfig(env: Partial<Record<string, unknown>>): JobTreadConfig {
  const str = (k: string, d: string) => (typeof env[k] === "string" && (env[k] as string).trim()) || d
  return {
    rendersFolder: str("JOBTREAD_RENDERS_FOLDER", "03 - Renders"),
    selectionsFolder: str("JOBTREAD_SELECTIONS_FOLDER", "04 - Selections"),
    renderTag: str("JOBTREAD_RENDER_TAG", "3D Render"),
    latestTag: str("JOBTREAD_LATEST_TAG", "Latest"),
    outdatedTag: str("JOBTREAD_OUTDATED_TAG", "Outdated"),
    timeZone: str("TIME_ZONE", "America/Chicago"),
  }
}

export class JobTreadError extends Error {
  // Plain fields (not parameter properties) so this file also runs under Node's type stripping.
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`JobTread API ${status}: ${body.slice(0, 300)}`)
    this.name = "JobTreadError"
    this.status = status
    this.body = body
  }
}

/** Plain-language message for anything the JT client throws. */
export function friendlyJobTreadError(e: unknown): string {
  if (e instanceof JobTreadError) {
    if (e.status === 401 || e.status === 403 || /grant|key is invalid|expired/i.test(e.body)) {
      return "JobTread rejected the grant key — it may have expired (keys lapse after 3 months unused). An admin needs to issue a new one in JobTread and run `wrangler secret put JOBTREAD_GRANT_KEY`."
    }
    return `JobTread returned an error (${e.status}): ${e.body.slice(0, 300)}`
  }
  return `JobTread request failed: ${e instanceof Error ? e.message : String(e)}`
}

async function pave<T>(grantKey: string, query: Record<string, unknown>): Promise<T> {
  const res = await fetch(PAVE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: { $: { grantKey }, ...query } }),
  })
  const body = await res.text()
  if (!res.ok) throw new JobTreadError(res.status, body)
  return JSON.parse(body) as T
}

// ---------- Org + tag lookup (cached per isolate) ----------

let orgIdCache: string | null = null
let tagCache: { at: number; byName: Map<string, string> } | null = null
const TAG_TTL_MS = 10 * 60 * 1000

async function orgId(grantKey: string): Promise<string> {
  if (orgIdCache) return orgIdCache
  const r = await pave<{ currentGrant: { organization: { id: string } } }>(grantKey, {
    currentGrant: { organization: { id: {} } },
  })
  orgIdCache = r.currentGrant.organization.id
  return orgIdCache
}

/**
 * Resolve file tag names to IDs. Looked up by name (not hardcoded) so a renamed
 * tag fails loudly instead of tagging the wrong thing.
 */
async function tagIds(grantKey: string, names: string[]): Promise<Map<string, string>> {
  if (!tagCache || Date.now() - tagCache.at > TAG_TTL_MS) {
    const r = await pave<{ organization: { fileTags: { nodes: { id: string; name: string }[] } } }>(grantKey, {
      organization: {
        $: { id: await orgId(grantKey) },
        fileTags: { $: { size: 100 }, nodes: { id: {}, name: {} } },
      },
    })
    tagCache = { at: Date.now(), byName: new Map(r.organization.fileTags.nodes.map((t) => [t.name, t.id])) }
  }
  const missing = names.filter((n) => !tagCache!.byName.has(n))
  if (missing.length) throw new Error(`JobTread file tag(s) not found: ${missing.join(", ")}`)
  return tagCache.byName
}

// ---------- Jobs ----------

export interface JobMatch {
  jobId: string
  number: string
  name: string
  customer: string | null
  status: string
  closed: boolean
}

interface JobNode {
  id: string
  name: string
  number: string
  status: string
  closedOn: string | null
  location?: { account?: { name?: string } | null } | null
}

const JOB_FIELDS = {
  id: {},
  name: {},
  number: {},
  status: {},
  closedOn: {},
  location: { account: { name: {} } },
}

function toMatch(j: JobNode): JobMatch {
  return {
    jobId: j.id,
    number: j.number,
    name: j.name,
    customer: j.location?.account?.name ?? null,
    status: j.status,
    closed: j.closedOn !== null,
  }
}

/** Search jobs by number, name, or customer name. Open jobs only unless includeClosed. */
export async function findJobs(
  grantKey: string,
  query: string,
  opts: { includeClosed?: boolean; limit?: number } = {},
): Promise<JobMatch[]> {
  const like = `%${query.trim().replace(/[%_]/g, "")}%`
  const textMatch = {
    or: [
      ["name", "like", like],
      ["number", "like", like],
      [["location", "account", "name"], "like", like],
    ],
  }
  const where = opts.includeClosed ? textMatch : { and: [["closedOn", null], textMatch] }
  const r = await pave<{ organization: { jobs: { nodes: JobNode[] } } }>(grantKey, {
    organization: {
      $: { id: await orgId(grantKey) },
      jobs: {
        $: { size: Math.min(opts.limit ?? 8, 25), where, sortBy: [{ field: "createdAt", order: "desc" }] },
        nodes: JOB_FIELDS,
      },
    },
  })
  return r.organization.jobs.nodes.map(toMatch)
}

/** Every open job, newest first, for the widget's pick list. */
export async function listOpenJobs(grantKey: string, max = 500): Promise<JobMatch[]> {
  const out: JobMatch[] = []
  let page: string | undefined
  while (out.length < max) {
    const r = await pave<{ organization: { jobs: { nodes: JobNode[]; nextPage?: string | null } } }>(grantKey, {
      organization: {
        $: { id: await orgId(grantKey) },
        jobs: {
          $: {
            size: 100,
            where: ["closedOn", null],
            sortBy: [{ field: "createdAt", order: "desc" }],
            ...(page ? { page } : {}),
          },
          nodes: JOB_FIELDS,
          nextPage: {},
        },
      },
    })
    out.push(...r.organization.jobs.nodes.map(toMatch))
    page = r.organization.jobs.nextPage ?? undefined
    if (!page) break
  }
  return out.slice(0, max)
}

export async function getJob(grantKey: string, jobId: string): Promise<JobMatch | null> {
  const r = await pave<{ job: JobNode | null }>(grantKey, { job: { $: { id: jobId }, ...JOB_FIELDS } })
  return r.job ? toMatch(r.job) : null
}

// ---------- Selections (product images to use as references) ----------

export interface SelectionImage {
  fileId: string
  /** Budget line the image is attached to ("Cabinet Pull Specification"), or the selections folder name for folder files. */
  item: string
  /** Budget group ("Cabinet Hardware"), null for folder files. */
  group: string | null
  fileName: string
  sizeKb: number
  /** ~256px version for the picker grid. */
  thumbUrl: string
  /** Up-to-1600px version for the model. Signed CDN URL — fetch it soon after listing. */
  url: string
}

interface SelectionFileNode {
  id: string
  name: string
  type: string | null
  size: number
  thumb: string | null
  full: string | null
}

const SELECTION_FILE_FIELDS = {
  id: {},
  name: {},
  type: {},
  size: {},
  // url(size) returns a resized version, or null for non-resizable files (PDF spec sheets).
  thumb: { _: "url", $: { size: 256 } },
  full: { _: "url", $: { size: 1600 } },
}

function toSelectionImage(f: SelectionFileNode, item: string, group: string | null): SelectionImage | null {
  if (!(f.type ?? "").startsWith("image/") || !f.full) return null
  return {
    fileId: f.id,
    item,
    group,
    fileName: f.name,
    sizeKb: Math.round(f.size / 1024),
    thumbUrl: f.thumb ?? f.full,
    url: f.full,
  }
}

/**
 * Product images for a job: files attached to live budget line items (where the
 * designers put selections — "Tub Faucet Specification → Image 1"), then images
 * in the selections folder. PDFs and document-snapshot copies are skipped.
 */
export async function listJobSelectionImages(
  grantKey: string,
  jobId: string,
  cfg: JobTreadConfig,
): Promise<SelectionImage[]> {
  const out: SelectionImage[] = []
  const seen = new Set<string>()
  const add = (img: SelectionImage | null) => {
    if (img && !seen.has(img.fileId)) {
      seen.add(img.fileId)
      out.push(img)
    }
  }

  // Budget lines, 50 per page (nested file URLs make bigger pages 413).
  let page: string | undefined
  for (let i = 0; i < 30; i++) {
    const r = await pave<{
      job: {
        costItems: {
          nodes: {
            name: string
            document: { id: string } | null
            costGroup: { name: string } | null
            files: { nodes: SelectionFileNode[] }
          }[]
          nextPage?: string | null
        }
      }
    }>(grantKey, {
      job: {
        $: { id: jobId },
        costItems: {
          $: { size: 50, ...(page ? { page } : {}) },
          nodes: {
            name: {},
            document: { id: {} },
            costGroup: { name: {} },
            files: { $: { size: 6 }, nodes: SELECTION_FILE_FIELDS },
          },
          nextPage: {},
        },
      },
    })
    for (const c of r.job.costItems.nodes) {
      if (c.document) continue // document snapshot copy of a live line
      for (const f of c.files.nodes) add(toSelectionImage(f, c.name, c.costGroup?.name ?? null))
    }
    page = r.job.costItems.nextPage ?? undefined
    if (!page) break
  }

  const folder = await pave<{ job: { files: { nodes: SelectionFileNode[] } } }>(grantKey, {
    job: {
      $: { id: jobId },
      files: { $: { size: 50, where: ["folder", "=", cfg.selectionsFolder] }, nodes: SELECTION_FILE_FIELDS },
    },
  })
  for (const f of folder.job.files.nodes) add(toSelectionImage(f, cfg.selectionsFolder, null))

  return out
}

// ---------- Filing ----------

interface JobFile {
  id: string
  name: string
  folder: string | null
  fileTags: { nodes: { id: string; name: string }[] }
}

/** Every render-named file on the job (paged), filtered by name. */
async function renderFilesOnJob(grantKey: string, jobId: string): Promise<JobFile[]> {
  const out: JobFile[] = []
  let page: string | undefined
  for (let i = 0; i < 20; i++) {
    const r = await pave<{ job: { files: { nodes: JobFile[]; nextPage?: string | null } } }>(grantKey, {
      job: {
        $: { id: jobId },
        files: {
          // Pave prices nested connections by page size (100 files × default tag page → 413).
          // Files carry at most 10 tags, so cap that page explicitly.
          $: { size: 50, where: ["name", "like", "Render - %"], ...(page ? { page } : {}) },
          nodes: { id: {}, name: {}, folder: {}, fileTags: { $: { size: 10 }, nodes: { id: {}, name: {} } } },
          nextPage: {},
        },
      },
    })
    out.push(...r.job.files.nodes)
    page = r.job.files.nextPage ?? undefined
    if (!page) break
  }
  return out
}

/** Room token for the file name: Title Case, forbidden characters stripped, short. */
export function cleanRoom(room: string): string {
  const cleaned = room
    .replace(/[\/\\:*?"<>|$#%]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
  return cleaned || "Room"
}

/** YYYY-MM-DD in the configured time zone (the render's own date, not the upload day in UTC). */
export function localDate(d: Date, timeZone: string): string {
  return d.toLocaleDateString("en-CA", { timeZone })
}

/** `Render - {Room} - {date}.ext`, with ` r2`, ` r3`… if that name is taken on the job. */
export function renderFileName(room: string, date: string, ext: string, taken: Set<string>): string {
  const base = `Render - ${room} - ${date}`
  if (!taken.has(`${base}.${ext}`.toLowerCase())) return `${base}.${ext}`
  for (let n = 2; n < 100; n++) {
    const candidate = `${base} r${n}.${ext}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${base} r${Date.now()}.${ext}`
}

export interface FileRenderInput {
  jobId: string
  /** Public URL JobTread fetches the image from (our /img/ archive URL). */
  imageUrl: string
  room: string
  createdAt: Date
  ext: "jpg" | "png"
  description: string
  markLatest?: boolean
}

export interface FileRenderResult {
  fileId: string
  fileName: string
  folder: string
  markedLatest: boolean
  /** Prior same-room renders retagged Outdated. */
  outdated: string[]
  /** Non-fatal problems (e.g. a retag that failed after the upload succeeded). */
  warnings: string[]
}

/**
 * File one render on a job: createUploadRequest (JobTread fetches the URL) →
 * createFile in the renders folder with the render tag. With markLatest, the new
 * file also gets the Latest tag and every earlier same-room render in the folder
 * moves to Outdated (other tags carried forward — tags are additive).
 */
export async function fileRenderOnJob(
  grantKey: string,
  input: FileRenderInput,
  cfg: JobTreadConfig,
): Promise<FileRenderResult> {
  const RENDERS_FOLDER = cfg.rendersFolder
  const RENDER_TAG = cfg.renderTag
  const LATEST_TAG = cfg.latestTag
  const OUTDATED_TAG = cfg.outdatedTag
  const tags = await tagIds(grantKey, [RENDER_TAG, LATEST_TAG, OUTDATED_TAG])
  const room = cleanRoom(input.room)
  const existing = await renderFilesOnJob(grantKey, input.jobId)
  const fileName = renderFileName(
    room,
    localDate(input.createdAt, cfg.timeZone),
    input.ext,
    new Set(existing.map((f) => f.name.toLowerCase())),
  )

  const up = await pave<{ createUploadRequest: { createdUploadRequest: { id: string } } }>(grantKey, {
    createUploadRequest: {
      $: { organizationId: await orgId(grantKey), url: input.imageUrl },
      createdUploadRequest: { id: {} },
    },
  })

  const newTagIds = [tags.get(RENDER_TAG)!, ...(input.markLatest ? [tags.get(LATEST_TAG)!] : [])]
  const created = await pave<{ createFile: { createdFile: { id: string; name: string; folder: string | null } } }>(
    grantKey,
    {
      createFile: {
        $: {
          targetType: "job",
          targetId: input.jobId,
          uploadRequestId: up.createUploadRequest.createdUploadRequest.id,
          name: fileName,
          folder: RENDERS_FOLDER,
          fileTagIds: newTagIds,
          description: input.description.slice(0, 1000),
        },
        createdFile: { id: {}, name: {}, folder: {} },
      },
    },
  )
  const file = created.createFile.createdFile

  const outdated: string[] = []
  const warnings: string[] = []
  if (input.markLatest) {
    const roomPrefix = `render - ${room} - `.toLowerCase()
    const latestId = tags.get(LATEST_TAG)!
    const outdatedId = tags.get(OUTDATED_TAG)!
    const priors = existing.filter(
      (f) =>
        f.folder === RENDERS_FOLDER &&
        f.name.toLowerCase().startsWith(roomPrefix) &&
        !f.fileTags.nodes.some((t) => t.id === outdatedId),
    )
    for (const prior of priors) {
      // Full-replace input: carry every existing tag forward except Latest, add Outdated.
      const nextTags = [
        ...prior.fileTags.nodes.map((t) => t.id).filter((id) => id !== latestId),
        outdatedId,
      ].slice(0, 10)
      try {
        await pave(grantKey, { updateFile: { $: { id: prior.id, fileTagIds: nextTags } } })
        outdated.push(prior.name)
      } catch (e) {
        warnings.push(`Couldn't mark "${prior.name}" Outdated — fix it in JobTread. (${friendlyJobTreadError(e)})`)
      }
    }
  }

  return {
    fileId: file.id,
    fileName: file.name,
    folder: file.folder ?? RENDERS_FOLDER,
    markedLatest: !!input.markLatest,
    outdated,
    warnings,
  }
}

/** Link to a job's Files tab in the JobTread web app. */
export function jobFilesUrl(jobId: string): string {
  return `https://app.jobtread.com/jobs/${jobId}/files`
}
