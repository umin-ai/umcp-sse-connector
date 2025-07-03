// Meta-Dynamic MCP Server over SSE
// Proxies multiple remote MCP servers (via HTTP‐stream or SSE) and exposes a single SSE endpoint

import http from "http";
import { URL } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListToolsResultSchema,
  CallToolResultSchema
} from "@modelcontextprotocol/sdk/types.js";

 // Describe each remote, including transport type
export interface RemoteConfig {
  name: string;
  url: string;
  transport: "httpStream" | "sse";
}

export class MetaDynamicServer {
  private server = new Server(
    { name: "meta-dynamic-sse", version: "1.0.0" },
    { capabilities: { resources: {}, tools: {}, prompts: {}, sampling: {} } }
  );
  private clients = new Map<string, Client>();

  constructor(private remotes: RemoteConfig[]) {}

  public async start(port = 8080) {
    // 1. Initialize remote clients based on transport
    for (const cfg of this.remotes) {
      let transportClient;
      if (cfg.transport === "httpStream") {
        transportClient = new StreamableHTTPClientTransport(new URL(cfg.url));
      } else if (cfg.transport === "sse") {
        transportClient = new SSEClientTransport(new URL(cfg.url));
      } else {
        throw new Error(`Unsupported transport: ${cfg.transport}`);
      }

      const client = new Client(
        { name: cfg.name, version: "1.0.0" },
        { capabilities: {} }
      );
      // Connect to remote
      await client.connect(transportClient);
      this.clients.set(cfg.name, client);
    }

    // 2. Proxy handlers for resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const aggregated: any[] = [];
      for (const [alias, client] of this.clients) {
        const res = await client.request(
          { method: "resources/list" },
          ListResourcesResultSchema
        );
        aggregated.push(
          ...res.resources.map(r => ({ ...r, uri: `${alias}://${r.uri}` }))
        );
      }
      return { resources: aggregated };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
      const [alias, path] = params.uri.split('://');
      const client = this.clients.get(alias!);
      if (!client) throw new Error(`Unknown alias: ${alias}`);
      const out = await client.request(
        { method: "resources/read", params: { uri: path } },
        ReadResourceResultSchema
      );
      return { contents: out.contents };
    });

    // 3. Proxy handlers for tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const aggregated: any[] = [];
      for (const [alias, client] of this.clients) {
        const res = await client.request(
          { method: "tools/list" },
          ListToolsResultSchema
        );
        aggregated.push(
          ...res.tools.map(t => ({ ...t, name: `${alias}://${t.name}` }))
        );
      }
      return { tools: aggregated };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const [alias, toolName] = params.name.split('://');
      const client = this.clients.get(alias!);
      if (!client) throw new Error(`Unknown alias: ${alias}`);
      const result = await client.request(
        { method: "tools/call", params: { name: toolName, arguments: params.arguments } },
        CallToolResultSchema
      );
      return result;
    });

    // 4. HTTP server for SSE endpoint
    let sseTransport: SSEServerTransport | null = null;
    const serverHttp = http.createServer((req, res) => {
      const url = req.url || "";
      if (url === "/sse" && req.method === "GET") {
        // Open SSE for incoming MCP traffic
        sseTransport = new SSEServerTransport("/messages", res);
        this.server.connect(sseTransport).catch(err => {
          console.error("MCP SSE connect error:", err);
          res.writeHead(500);
          res.end();
        });
      } else if (url.startsWith("/messages") && req.method === "POST") {
        if (!sseTransport) {
          res.writeHead(400);
          res.end("No active SSE connection");
          return;
        }
        let body = "";
        req.on("data", chunk => (body += chunk));
        req.on("end", async () => {
          try {
            await sseTransport!.handlePostMessage(req, res, JSON.parse(body));
          } catch (err) {
            console.error("Error handling SSE POST:", err);
            if (!res.headersSent) {
              res.writeHead(500);
              res.end();
            }
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    serverHttp.listen(port, () =>
      console.log(`Meta-dynamic SSE server running on http://localhost:${port}/sse`)
    );
  }
}

// Bootstrapped via src/index.ts
// Example usage in index.ts:
// import { MetaDynamicServer } from "./meta-dynamic-server";
// const remotes = [
//   { name: "math", url: "http://localhost:8083/mcp", transport: "httpStream" },
//   { name: "coingecko", url: "https://mcp.api.coingecko.com/sse", transport: "sse" }
// ];
// new MetaDynamicServer(remotes).start(8084);
