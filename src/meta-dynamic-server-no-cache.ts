// src/meta-dynamic-server.ts

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

// Inferred result types
type ListResourcesResult = z.infer<typeof ListResourcesResultSchema>;
type ReadResourceResult  = z.infer<typeof ReadResourceResultSchema>;
type ListToolsResult     = z.infer<typeof ListToolsResultSchema>;
type CallToolResult      = z.infer<typeof CallToolResultSchema>;
type ListPromptsResult   = z.infer<typeof ListPromptsResultSchema>;
type GetPromptResult     = z.infer<typeof GetPromptResultSchema>;

// Hint for users
const TOOL_HINT =
  "When calling a tool, prefix with <alias>_<toolName> and emit exactly:\n" +
  `{"method":"tools/call","params":{"name":"<alias>_<toolName>","arguments":{…}}}`;

export class MetaDynamicServer {
  private server = new Server(
    { name: "meta-dynamic-sse", version: "1.0.0" },
    {
      capabilities: {
        resources: {},
        tools:     {},
        prompts: {
          tool_hint: { description: TOOL_HINT }
        },
        sampling: {}
      }
    }
  );

  private clients = new Map<string, Client>();

  constructor(private remotes: RemoteConfig[]) {}

  public async start(port = 8080) {
    // ─── Prompt Handlers ───────────────────────────────────────────────────────

    this.server.setRequestHandler(
      ListPromptsRequestSchema,
      async (): Promise<ListPromptsResult> => ({
        prompts: [{ name: "tool_hint", description: TOOL_HINT }]
      })
    );

    this.server.setRequestHandler(
      GetPromptRequestSchema,
      async ({ params }): Promise<GetPromptResult> => {
        if (params.name !== "tool_hint") {
          throw new Error(`Unknown prompt: ${params.name}`);
        }
        return {
          description: TOOL_HINT,
          messages: [
            {
              role: "user",
              content: { type: "text", text: TOOL_HINT }
            }
          ]
        };
      }
    );

    // ─── Connect to remotes ─────────────────────────────────────────────────────

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

    // ─── Resources ─────────────────────────────────────────────────────────────

    // list
    this.server.setRequestHandler(
      ListResourcesRequestSchema,
      async (): Promise<ListResourcesResult> => {
        const aggregated: ListResourcesResult["resources"] = [];
        for (const [alias, client] of this.clients) {
          const res: ListResourcesResult = await client.request(
            { method: "resources/list" },
            ListResourcesResultSchema
          );
          aggregated.push(
            ...res.resources.map(r => ({
              ...r,
              uri: `${alias}_${r.uri}`
            }))
          );
        }
        return { resources: aggregated };
      }
    );

    // read
    this.server.setRequestHandler(
      ReadResourceRequestSchema,
      async ({ params }): Promise<ReadResourceResult> => {
        const rawUri = params.uri;
        const idx = rawUri.indexOf("_");
        if (idx < 0) {
          throw new Error(`Invalid resource URI, expected "<alias>_<path>", got "${rawUri}"`);
        }
        const alias = rawUri.slice(0, idx);
        const path  = rawUri.slice(idx + 1);

        const client = this.clients.get(alias);
        if (!client) throw new Error(`Unknown alias: ${alias}`);

        const out: ReadResourceResult = await client.request(
          { method: "resources/read", params: { uri: path } },
          ReadResourceResultSchema
        );
        return { contents: out.contents };
      }
    );

    // ─── Tools ─────────────────────────────────────────────────────────────────

    // list
    this.server.setRequestHandler(
      ListToolsRequestSchema,
      async (): Promise<ListToolsResult> => {
        const aggregated: ListToolsResult["tools"] = [];
        for (const [alias, client] of this.clients) {
          const res: ListToolsResult = await client.request(
            { method: "tools/list" },
            ListToolsResultSchema
          );
          aggregated.push(
            ...res.tools.map(t => ({ ...t, name: `${alias}_${t.name}` }))
          );
        }
        return { tools: aggregated };
      }
    );

    // call
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async ({ params }): Promise<CallToolResult> => {
        const raw = params.name;

        const idx = raw.indexOf("_");
        if (idx < 0) {
          throw new Error(
            `Invalid tool name, expected "<alias>_<toolName>", got "${raw}"`
          );
        }
        const alias = raw.slice(0, idx);
        const tool  = raw.slice(idx + 1);

        const client = this.clients.get(alias);
        if (!client) {
          throw new Error(`Unknown alias: ${alias}`);
        }

        const result: CallToolResult = await client.request(
          {
            method: "tools/call",
            params: { name: tool, arguments: params.arguments }
          },
          CallToolResultSchema
        );
        return result;
      }
    );

    // ─── SSE endpoint ─────────────────────────────────────────────────────────

    let sse: SSEServerTransport | null = null;
    const httpServer = http.createServer((req, res) => {
      const url = req.url || "";
      if (url === "/sse" && req.method === "GET") {
        sse = new SSEServerTransport("/messages", res);
        const hb = setInterval(() => {
          try { res.write(":\n\n"); } catch {}
        }, 15_000);
        req.on("close", () => clearInterval(hb));

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

    httpServer.keepAliveTimeout = 0;
    httpServer.headersTimeout   = 0;
    httpServer.timeout          = 0;

    httpServer.listen(port, () =>
      console.log(`Meta-dynamic MCP server listening on http://localhost:${port}/sse`)
    );
  }
}
