// scripts/mcp.ts
import "dotenv/config";
import fs from "node:fs/promises";

const PORT = process.env.PORT ?? "2091";
const TOKEN = process.env.AUTH_TOKEN ?? "dev-secret-token";
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}/mcp`;
const SESSION_FILE = process.env.SESSION_FILE ?? ".mcp_session";

const baseHeaders: Record<string, string> = {
  "Authorization": `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
  "Accept": "application/json, text/event-stream",
};

async function saveSession(id: string) {
  await fs.writeFile(SESSION_FILE, id, "utf8");
}
async function loadSession(): Promise<string> {
  return fs.readFile(SESSION_FILE, "utf8").then(s => s.trim());
}

async function init() {
  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: true } },
        clientInfo: { name: "mcp.ts", version: "0.1.0" }
      }
    }),
  });

  const sessionId = res.headers.get("mcp-session-id");
  const body = await res.text();

  if (!res.ok) {
    throw new Error(`initialize failed: ${res.status} ${res.statusText} — ${body}`);
  }
  if (!sessionId) {
    throw new Error(`initialize succeeded but no Mcp-Session-Id header was returned. Body: ${body}`);
  }

  await saveSession(sessionId);

  // notifications/initialized (JSON-RPC notification; no id)
  const res2 = await fetch(BASE_URL, {
    method: "POST",
    headers: { ...baseHeaders, "Mcp-Session-Id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  if (!res2.ok) {
    const t = await res2.text();
    throw new Error(`initialized notification failed: ${res2.status} ${res2.statusText} — ${t}`);
  }

  console.log(`SESSION=${sessionId}`);
}

async function rpc(method: string, params?: any, id = 2) {
  const session = await loadSession();
  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: { ...baseHeaders, "Mcp-Session-Id": session },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} failed: ${res.status} ${res.statusText} — ${text}`);
  }
  console.log(text);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "init":
      return init();

    case "list":
      return rpc("tools/list", undefined, 2);

    case "tree": {
      const depth = Number(args[0] ?? 2);
      const includeHidden = String(args[1] ?? "false") === "true";
      return rpc("tools/call", {
        name: "repo.tree",
        arguments: { depth, includeHidden },
      }, 3);
    }

    case "read": {
      const [p, s, e] = args;
      if (!p) throw new Error("Usage: read <path> [startLine=1] [endLine=120]");
      const startLine = Number(s ?? 1);
      const endLine = Number(e ?? 120);
      return rpc("tools/call", {
        name: "repo.read",
        arguments: { path: p, startLine, endLine },
      }, 4);
    }

    case "search": {
      const query = args[0];
      const glob = args[1] ?? "**/*.{ts,tsx,js,jsx,md}";
      const maxMatches = Number(args[2] ?? 20);
      if (!query) throw new Error("Usage: search <regex> [glob] [maxMatches]");
      return rpc("tools/call", {
        name: "repo.search",
        arguments: { query, glob, maxMatches },
      }, 5);
    }

    default:
      console.log(`Usage:
  npx tsx scripts/mcp.ts init
  npx tsx scripts/mcp.ts list
  npx tsx scripts/mcp.ts tree [depth=2] [includeHidden=false]
  npx tsx scripts/mcp.ts read <path> [startLine=1] [endLine=120]
  npx tsx scripts/mcp.ts search <regex> [glob="**/*.{ts,tsx,js,jsx,md}"] [maxMatches=20]`);
  }
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
