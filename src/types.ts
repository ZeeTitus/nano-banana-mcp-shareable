// The wrangler-generated worker-configuration.d.ts declares a global `Env` from
// wrangler.jsonc (bindings plus the plain `vars` like PUBLIC_ORIGIN). Secrets
// aren't in wrangler.jsonc, so they are merged in here.
// Run `pnpm cf-typegen` after changing wrangler.jsonc.

declare global {
  interface Env {
    /** Google AI Studio API key. Set with: npx wrangler secret put GEMINI_API_KEY */
    GEMINI_API_KEY: string
    /** Optional upload gate. When set, /upload POST requires this token. Set with: npx wrangler secret put UPLOAD_TOKEN */
    UPLOAD_TOKEN?: string
    /**
     * Optional access gate for the MCP endpoints (capability URL). When set,
     * MCP is served ONLY at /mcp/<key> and /sse/<key>; bare /mcp, /sse, and the
     * landing page 404. Set with: npx wrangler secret put MCP_PATH_KEY
     */
    MCP_PATH_KEY?: string
    /**
     * Optional JobTread Pave grant key for the job picker, Selections, and
     * Save to JobTread. Unset = those features are off and their tools are not
     * registered. Set with: npx wrangler secret put JOBTREAD_GRANT_KEY.
     * Expires after 3 months unused.
     */
    JOBTREAD_GRANT_KEY?: string
  }
}

export {}
