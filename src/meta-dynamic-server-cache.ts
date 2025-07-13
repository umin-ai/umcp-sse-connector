// src/meta-dynamic-server-cache.ts

import http from "http";
import { URL } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport }             from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport }           from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client }                         from "@modelcontextprotocol/sdk/client/index.js";

import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
  ListToolsResultSchema,
  CallToolResultSchema
} from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import { RemoteConfig } from "./types";

// Extract the actual TS types from the Zod schemas
type ListResourcesResult = z.infer<typeof ListResourcesResultSchema>;
type ReadResourceResult  = z.infer<typeof ReadResourceResultSchema>;
type ListToolsResult     = z.infer<typeof ListToolsResultSchema>;
type CallToolResult      = z.infer<typeof CallToolResultSchema>;

// Generic TTL cache entry
interface CacheEntry<T> {
  expiry: number;
  value: T;
}

export class MetaDynamicServerCache {
  private server = new Server(
    { name: "meta-dynamic-sse-cache", version: "1.0.0" },
    { capabilities: { resources: {}, tools: {}, prompts: {}, sampling: {} } }
  );

  private clients = new Map<string, Client>();

  private resourcesCache: CacheEntry<ListResourcesResult["resources"]> | null = null;
  private toolsCache:     CacheEntry<ListToolsResult["tools"]>         | null = null;

  constructor(
    private remotes: RemoteConfig[],
    private cacheTtlMs: number = 5 * 60 * 1000
  ) {}

  public async start(port = 8080) {
    // 1) Connect each remote
    for (const cfg of this.remotes) {
      let transportClient: Transport;

      if (cfg.transport === "httpStream") {
        transportClient = new StreamableHTTPClientTransport(new URL(cfg.url!));
      } else if (cfg.transport === "sse") {
        transportClient = new SSEClientTransport(new URL(cfg.url!));
      } else if (cfg.transport === "stdio") {
        transportClient = new StdioClientTransport({
          command: cfg.command!,
          args:    cfg.args    || [],
          env:     cfg.env     || {}
        });
      } else {
        throw new Error(`Unsupported transport: ${cfg.transport}`);
      }

      const client = new Client(
        { name: cfg.name, version: "1.0.0" },
        { capabilities: {} }
      );
      await client.connect(transportClient);
      this.clients.set(cfg.name, client);
    }

    // 2) Cached resources/list
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

    // 3) Pass-through resources/read
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

    // 4) Cached tools/list
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

    // 5) Pass-through tools/call
    this.server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const [alias, toolName] = params.name.split("://");
      const client = this.clients.get(alias!);
      if (!client) throw new Error(`Unknown alias: ${alias}`);

      const result = await client.request(
        { method: "tools/call", params: { name: toolName, arguments: params.arguments } },
        CallToolResultSchema
      );
      return result as CallToolResult;
    });

    // 6) Single SSE endpoint downstream
    let sseTransport: SSEServerTransport | null = null;
    const httpServer = http.createServer((req, res) => {
      const url = req.url || "";
      if (url === "/sse" && req.method === "GET") {
        sseTransport = new SSEServerTransport("/messages", res);
        this.server.connect(sseTransport).catch(err => {
          console.error("MCP SSE connect error:", err);
          res.writeHead(500).end();
        });
      } else if (url.startsWith("/messages") && req.method === "POST") {
        if (!sseTransport) {
          res.writeHead(400).end("No active SSE connection");
          return;
        }
        let body = "";
        req.on("data", chunk => (body += chunk));
        req.on("end", async () => {
          try {
            await sseTransport!.handlePostMessage(req, res, JSON.parse(body));
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
