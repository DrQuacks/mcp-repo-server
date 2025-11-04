import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import fg from "fast-glob";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";

const REPO_ROOT = process.env.REPO_ROOT || "";
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const PORT = parseInt(process.env.PORT || "3000", 10);

// ---- guards ----
if (!REPO_ROOT) {
  console.error("Set REPO_ROOT to your repository absolute path.");
  process.exit(1);
}
if (!path.isAbsolute(REPO_ROOT)) {
  console.error("REPO_ROOT must be an absolute path.");
  process.exit(1);
}
if (!fssync.existsSync(REPO_ROOT) || !fssync.statSync(REPO_ROOT).isDirectory()) {
  console.error("REPO_ROOT must exist and be a directory.");
  process.exit(1);
}

// ---- helpers ----
const MAX_FILE_BYTES = 256 * 1024; // 256 KB per read
const MAX_TREE_ENTRIES = 2000;
const MAX_SEARCH_MATCHES = 200;

const DENY_GLOBS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.next/**",
  "**/dist/**",
  "**/build/**",
  "**/*.lock",
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.pdf",
  "**/*.zip",
  "**/*.ico",
];
const DENY_FILES = [/^\.env/i];

function resolveInRepo(userPath: string): string {
  const abs = path.resolve(REPO_ROOT, userPath);
  const rel = path.relative(REPO_ROOT, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Path escapes repo root.");
  }
  return abs;
}

async function readTextFileSlice(absPath: string, startLine?: number, endLine?: number) {
  const stat = await fs.stat(absPath);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`File too large (> ${MAX_FILE_BYTES} bytes).`);
  }
  const buf = await fs.readFile(absPath);
  const txt = buf.toString("utf8");
  const lines = txt.split(/\r?\n/);
  const s = Math.max(1, startLine ?? 1);
  const e = Math.min(lines.length, endLine ?? lines.length);
  const slice = lines.slice(s - 1, e);
  return { text: slice.join("\n"), totalLines: lines.length, startLine: s, endLine: e };
}

function denyByName(p: string) {
  const base = path.basename(p);
  return DENY_FILES.some((rx) => rx.test(base));
}

// ---- MCP server ----
const server = new McpServer({
  name: "repo-mcp",
  version: "0.1.0",
});

// repo.tree
server.registerTool(
  "repo.tree",
  {
    title: "List repository structure",
    description:
      "Returns a depth-limited directory tree from the repo root. Skips large/binary folders.",
    inputSchema: z.object({
      depth: z.number().int().min(1).max(5).default(2),
      includeHidden: z.boolean().default(false),
    }),
  },
  async ({ depth, includeHidden }) => {
    const patterns = ["**/*"];
    const entries = await fg(patterns, {
      cwd: REPO_ROOT,
      onlyFiles: false,
      dot: includeHidden,
      unique: true,
      followSymbolicLinks: false,
      deep: depth,
      ignore: DENY_GLOBS,
    });

    const trimmed = entries
      .filter((p) => !denyByName(p))
      .slice(0, MAX_TREE_ENTRIES);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { root: REPO_ROOT, count: trimmed.length, entries: trimmed },
            null,
            2
          ),
        },
      ],
      structuredContent: { root: REPO_ROOT, entries: trimmed },
    };
  }
);

// repo.read
server.registerTool(
  "repo.read",
  {
    title: "Read a text file",
    description:
      "Read a UTF-8 text file within the repo. Supports line slicing and size caps.",
    inputSchema: z.object({
      path: z.string(),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
    }),
  },
  async ({ path: relPath, startLine, endLine }) => {
    const abs = resolveInRepo(relPath);
    if (denyByName(abs)) throw new Error("Access to this file is denied.");

    const res = await readTextFileSlice(abs, startLine, endLine);
    return {
      content: [{ type: "text", text: res.text }],
      structuredContent: {
        uri: `mcp://repo/${relPath}#L${res.startLine}-L${res.endLine}`,
        ...res,
      },
    };
  }
);

// repo.search (regex over glob)
server.registerTool(
  "repo.search",
  {
    title: "Regex search across files",
    description:
      "Search repo for a regex within files matched by a glob. Returns capped matches with line numbers.",
    inputSchema: z.object({
      query: z.string(), // JS regex (without flags) we’ll use with 'gmi'
      glob: z.string().default("**/*.{ts,tsx,js,jsx,md,json,css,scss,py,go}"),
      maxMatches: z.number().int().min(1).max(MAX_SEARCH_MATCHES).default(50),
    }),
  },
  async ({ query, glob, maxMatches }) => {
    const files = await fg(glob, {
      cwd: REPO_ROOT,
      onlyFiles: true,
      dot: false,
      unique: true,
      followSymbolicLinks: false,
      ignore: DENY_GLOBS,
    });

    const rx = new RegExp(query, "gmi");
    const results: Array<{
      path: string;
      line: number;
      preview: string;
    }> = [];

    for (const rel of files) {
      if (denyByName(rel)) continue;
      const abs = resolveInRepo(rel);

      const stat = await fs.stat(abs);
      if (stat.size > MAX_FILE_BYTES) continue; // skip big files

      const text = await fs.readFile(abs, "utf8");
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (rx.test(lines[i])) {
          results.push({ path: rel, line: i + 1, preview: lines[i].trim() });
          if (results.length >= maxMatches) break;
        }
      }
      if (results.length >= maxMatches) break;
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { count: results.length, matches: results },
            null,
            2
          ),
        },
      ],
      structuredContent: { matches: results },
    };
  }
);

// (Optional) git.meta would go here if you later want status/commit info.

// ---- HTTP wiring (MCP over Streamable HTTP) ----
const app = express();
app.use(express.json());

// simple bearer auth
app.use((req, res, next) => {
  if (!AUTH_TOKEN) return next();
  const auth = req.header("authorization") || "";
  if (auth !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/", (_req, res) => {
  res.type("text").send("repo-mcp: POST /mcp");
});

app.listen(PORT, () => {
  console.log(`repo-mcp on http://localhost:${PORT}/mcp (root: ${REPO_ROOT})`);
});
