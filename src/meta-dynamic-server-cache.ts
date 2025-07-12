// meta-dynamic-server.ts
// ---------------------------------------------------------------------------
// A “meta” MCP server that exposes one SSE endpoint while federating multiple
// downstream MCP servers (any mix of SSE or streamed-HTTP transports).
// ---------------------------------------------------------------------------

import http from "http";
import { URL } from "url";
import { EventEmitter } from "events";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListToolsResultSchema,
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

/* ------------------------------------------------------------------------ */
/* Types                                                                    */
/* ------------------------------------------------------------------------ */

// Describe each remote MCP server we want to federate
export interface RemoteConfig {
  name: string;                         // local alias, e.g. "math"
  url: string;                          // base URL of the remote MCP server
  transport: "httpStream" | "sse";      // which client transport to use
}

/* ------------------------------------------------------------------------ */
/* Tiny cache helper (30-second TTL)                                        */
/* ------------------------------------------------------------------------ */

type CacheEntry<T> = { ts: number; data: T };
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry<any>>();

async function cached<T>(key: string, getter: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && now - hit.ts < CACHE_TTL_MS) return hit.data;

  const data = await getter();
  cache.set(key, { ts: now, data });
  return data;
}

/* ------------------------------------------------------------------------ */
/* Runtime type-guard so TS knows a transport has `.on()`                   */
/* ------------------------------------------------------------------------ */

function isEventEmitter(x: unknown): x is EventEmitter {
  return !!x && typeof (x as any).on === "function";
}

/* ------------------------------------------------------------------------ */
/* MetaDynamicServer                                                        */
/* ------------------------------------------------------------------------ */

export class MetaDynamicServerCache {
  // One MCP **Server** that upstream callers will connect to
  private server = new Server(
    { name: "meta-dynamic-sse", version: "1.0.0" },
    { capabilities: { resources: {}, tools: {}, prompts: {}, sampling: {} } }
  );

  // Map of alias ➜ connected MCP **Client**
  private clients = new Map<string, Client>();

  constructor(private remotes: RemoteConfig[]) {}

  /* ----------------------------- helpers -------------------------------- */

  /** Dial one remote MCP server, keep it in `this.clients`, auto-reconnect */
  private async connectRemote(cfg: RemoteConfig): Promise<void> {
    const url = new URL(cfg.url);
    const transport =
      cfg.transport === "sse"
        ? new SSEClientTransport(url)
        : new StreamableHTTPClientTransport(url);

    const client = new Client(
      { name: cfg.name, version: "1.0.0" },
      { capabilities: {} }
    );

    // Only SSE transports expose .on('close')
    if (isEventEmitter(transport)) {
      transport.on("close", () => {
        console.warn(`[${cfg.name}] disconnected – retrying in 5 s…`);
        setTimeout(() => this.connectRemote(cfg).catch(console.error), 5_000);
      });
    }

    await client.connect(transport);
    this.clients.set(cfg.name, client);
    console.log(`✓ Connected to remote [${cfg.name}]`);
  }

  /* ----------------------------- start() -------------------------------- */

  /** Boot the meta-server and expose a single SSE endpoint */
  public async start(port = 8081): Promise<void> {
    /* 1️⃣  Connect to every remote in parallel */
    await Promise.all(this.remotes.map((cfg) => this.connectRemote(cfg)));

    /* 2️⃣  Proxy / aggregate RESOURCE endpoints ----------------------- */

    this.server.setRequestHandler(ListResourcesRequestSchema, async () =>
      cached("resources:list", async () => {
        const aggregated: any[] = [];

        await Promise.all(
          [...this.clients.entries()].map(async ([alias, client]) => {
            const res = await client.request(
              { method: "resources/list" },
              ListResourcesResultSchema
            );
            aggregated.push(
              ...res.resources.map((r) => ({
                ...r,
                uri: `${alias}::${r.uri}`,
              }))
            );
          })
        );

        return { resources: aggregated };
      })
    );

    this.server.setRequestHandler(
      ReadResourceRequestSchema,
      async ({ params }) => {
        const [alias, path] = params.uri.split("::");
        const client = this.clients.get(alias!);
        if (!client) throw new Error(`Unknown alias: ${alias}`);

        const out = await client.request(
          { method: "resources/read", params: { uri: path } },
          ReadResourceResultSchema
        );
        return { contents: out.contents };
      }
    );

    /* 3️⃣  Proxy / aggregate TOOL endpoints --------------------------- */

    this.server.setRequestHandler(ListToolsRequestSchema, async () =>
      cached("tools:list", async () => {
        const aggregated: any[] = [];

        await Promise.all(
          [...this.clients.entries()].map(async ([alias, client]) => {
            const res = await client.request(
              { method: "tools/list" },
              ListToolsResultSchema
            );
            aggregated.push(
              ...res.tools.map((t) => ({
                ...t,
                name: `${alias}::${t.name}`,
              }))
            );
          })
        );

        return { tools: aggregated };
      })
    );

    this.server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const [alias, toolName] = params.name.split("::");
      const client = this.clients.get(alias!);
      if (!client) throw new Error(`Unknown alias: ${alias}`);

      return await client.request(
        {
          method: "tools/call",
          params: { name: toolName, arguments: params.arguments },
        },
        CallToolResultSchema
      );
    });

    /* 4️⃣  Expose a single SSE + /messages HTTP façade --------------- */

    let sseTransport: SSEServerTransport | null = null;

    const httpServer = http.createServer((req, res) => {
      const path = req.url ?? "";

      // Open SSE stream:  GET /sse
      if (req.method === "GET" && path === "/sse") {
        sseTransport = new SSEServerTransport("/messages", res);
        this.server
          .connect(sseTransport)
          .catch((err) => console.error("MCP connect error:", err));
        return;
      }

      // Receive POST messages:  POST /messages
      if (req.method === "POST" && path.startsWith("/messages")) {
        if (!sseTransport) {
          res.writeHead(400);
          res.end("No active SSE connection");
          return;
        }

        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", async () => {
          try {
            await sseTransport!.handlePostMessage(
              req,
              res,
              JSON.parse(body || "{}")
            );
          } catch (err) {
            console.error("Error handling POST:", err);
            if (!res.headersSent) {
              res.writeHead(500);
              res.end();
            }
          }
        });
        return;
      }

      // Anything else → 404
      res.writeHead(404);
      res.end();
    });

    httpServer.listen(port, () =>
      console.log(
        `🚀 Meta-dynamic MCP server listening → http://localhost:${port}/sse`
      )
    );
  }
}
