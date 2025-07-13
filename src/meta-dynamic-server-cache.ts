// src/meta-dynamic-server-cache.ts

import http from "http";
import { URL } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport }            from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport }          from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client }                        from "@modelcontextprotocol/sdk/client/index.js";

import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
  ListToolsResultSchema,
  CallToolResultSchema,
  ListPromptsRequestSchema,
  ListPromptsResultSchema,
  GetPromptRequestSchema,
  GetPromptResultSchema
} from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import { RemoteConfig }   from "./types";


// ── Types from the Zod schemas ───────────────────────────────────────────────

type ListResourcesResult = z.infer<typeof ListResourcesResultSchema>;
type ReadResourceResult  = z.infer<typeof ReadResourceResultSchema>;
type ListToolsResult     = z.infer<typeof ListToolsResultSchema>;
type CallToolResult      = z.infer<typeof CallToolResultSchema>;

// ── Prompt description constant ──────────────────────────────────────────────

const TOOL_HINT_DESCRIPTION =
  "When calling a tool, prefix with alias://toolName and emit exactly:\n" +
  `{"method":"tools/call","params":{"name":"<alias>://<TOOL_NAME>","arguments":{…}}}`;

// ── Generic TTL cache entry ──────────────────────────────────────────────────

interface CacheEntry<T> {
  expiry: number;
  value: T;
}

export class MetaDynamicServerCache {
  private server = new Server(
    { name: "meta-dynamic-sse-cache", version: "1.0.0" },
    {
      capabilities: {
        resources: {},
        tools:     {},
        prompts: {
          tool_hint: { description: TOOL_HINT_DESCRIPTION }
        },
        sampling: {}
      }
    }
  );

  private clients = new Map<string, Client>();
  private resourcesCache: CacheEntry<ListResourcesResult["resources"]> | null = null;
  private toolsCache:     CacheEntry<ListToolsResult["tools"]>         | null = null;

  constructor(
    private remotes: RemoteConfig[],
    private cacheTtlMs = 5 * 60 * 1000
  ) {}

  public async start(port = 8080) {
    // — Prompt handlers —
    this.server.setRequestHandler(
      ListPromptsRequestSchema,
      async () /*: Promise<ListPromptsResultSchema>*/ => ({
        prompts: [
          { name: "tool_hint", description: TOOL_HINT_DESCRIPTION }
        ]
      })
    );

    this.server.setRequestHandler(
      GetPromptRequestSchema,
      async ({ params }) /*: Promise<GetPromptResultSchema>*/ => {
        if (params.name !== "tool_hint") {
          throw new Error(`Unknown prompt: ${params.name}`);
        }
        return {
          description: TOOL_HINT_DESCRIPTION,
          messages: [
            {
              role:    "user",
              content: {
                type: "text",
                text: TOOL_HINT_DESCRIPTION
              }
            }
          ]
        };
      }
    );

    // — Connect MCP remotes —
    for (const cfg of this.remotes) {
      let transport: Transport;
      if (cfg.transport === "httpStream") {
        transport = new StreamableHTTPClientTransport(new URL(cfg.url!));
      } else if (cfg.transport === "sse") {
        transport = new SSEClientTransport(new URL(cfg.url!));
      } else {
        transport = new StdioClientTransport({
          command: cfg.command!,
          args:    cfg.args    || [],
          env:     cfg.env     || {}
        });
      }

      const client = new Client(
        { name: cfg.name, version: "1.0.0" },
        { capabilities: {} }
      );
      await client.connect(transport);
      this.clients.set(cfg.name, client);
    }

    // — Cached resources/list —
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const now = Date.now();
      if (this.resourcesCache && this.resourcesCache.expiry > now) {
        return { resources: this.resourcesCache.value };
      }
      const aggregated: ListResourcesResult["resources"] = [];
      for (const [alias, client] of this.clients) {
        const res = await client.request(
          { method: "resources/list" },
          ListResourcesResultSchema
        );
        aggregated.push(
          ...res.resources.map(r => ({ ...r, uri: `${alias}://${r.uri}` }))
        );
      }
      this.resourcesCache = {
        expiry: now + this.cacheTtlMs,
        value:  aggregated
      };
      return { resources: aggregated };
    });

    // — Pass-through resources/read —
    this.server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
      const [alias, path] = params.uri.split("://");
      const client = this.clients.get(alias!);
      if (!client) throw new Error(`Unknown alias: ${alias}`);
      const out = await client.request(
        { method: "resources/read", params: { uri: path } },
        ReadResourceResultSchema
      );
      return { contents: out.contents };
    });

    // — Cached tools/list —
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const now = Date.now();
      if (this.toolsCache && this.toolsCache.expiry > now) {
        return { tools: this.toolsCache.value };
      }
      const aggregated: ListToolsResult["tools"] = [];
      for (const [alias, client] of this.clients) {
        const res = await client.request(
          { method: "tools/list" },
          ListToolsResultSchema
        );
        aggregated.push(
          ...res.tools.map(t => ({ ...t, name: `${alias}://${t.name}` }))
        );
      }
      this.toolsCache = {
        expiry: now + this.cacheTtlMs,
        value:  aggregated
      };
      return { tools: aggregated };
    });

    // 5) Pass-through (but forgiving) tools/call
    this.server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      // params.name might be "etherscan://ETHERSCAN_getEthBalance" or just "ETHERSCAN_getEthBalance"
      const [maybeAlias, maybeTool] = params.name.split("://");
      let alias: string;
      let tool: string;

      if (maybeTool) {
        // client did "alias://tool"
        alias = maybeAlias;
        tool  = maybeTool;
      } else {
        // client emitted bare "TOOLNAME"
        tool  = maybeAlias;
        // look in our cached tools for a tool ending with this name
        const allTools = this.toolsCache?.value
          ?? (await this.server.request({ method: "tools/list" }, ListToolsResultSchema)).tools;
        const matches = allTools.filter(t => t.name.endsWith(`://${tool}`));
        if (matches.length === 1) {
          // exactly one alias has that tool
          alias = matches[0].name.split("://")[0];
        } else {
          throw new Error(
            matches.length === 0
              ? `Unknown tool: ${tool}`
              : `Ambiguous tool "${tool}", matches: ${matches.map(m=>m.name).join(", ")}`
          );
        }
      }

      const client = this.clients.get(alias);
      if (!client) throw new Error(`Unknown alias: ${alias}`);

      const result = await client.request(
        { method: "tools/call", params: { name: tool, arguments: params.arguments } },
        CallToolResultSchema
      );
      return result as z.infer<typeof CallToolResultSchema>;
    });

    // — SSE endpoint downstream —
    let sse: SSEServerTransport | null = null;
    const httpServer = http.createServer((req, res) => {
      const url = req.url || "";
      if (url === "/sse" && req.method === "GET") {
        sse = new SSEServerTransport("/messages", res);
        this.server.connect(sse).catch(err => {
          console.error("MCP SSE connect error:", err);
          res.writeHead(500).end();
        });
      } else if (url.startsWith("/messages") && req.method === "POST") {
        if (!sse) {
          res.writeHead(400).end("No active SSE connection");
          return;
        }
        let body = "";
        req.on("data", chunk => (body += chunk));
        req.on("end", async () => {
          try {
            await sse!.handlePostMessage(req, res, JSON.parse(body));
          } catch (err) {
            console.error("Error handling SSE POST:", err);
            if (!res.headersSent) res.writeHead(500).end();
          }
        });
      } else {
        res.writeHead(404).end();
      }
    });

    httpServer.listen(port, () =>
      console.log(`Meta-dynamic MCP server (with cache) listening on http://localhost:${port}/sse`)
    );
  }
}
