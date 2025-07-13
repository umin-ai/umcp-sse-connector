// test.ts
import { URL } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  ListToolsRequestSchema,
  ListToolsResultSchema
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

async function main() {
  // 1. Create the MCP client
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  );

  // 2. Connect over SSE to your meta-dynamic server
  const transport = new SSEClientTransport(new URL("http://localhost:8080/sse"));
  await client.connect(transport);

  // 3. List the available tools
  const result = await client.request(
    { method: "tools/list" },
    ListToolsResultSchema
  );
  type ListToolsResult = z.infer<typeof ListToolsResultSchema>;

  console.log("Available MCP tools:");
  (result as ListToolsResult).tools.forEach(tool => {
    console.log(`- ${tool.name} -`, tool.title);
  });

  // Close connection (optional)
  transport.close();
}

main().catch(err => {
  console.error("Error in MCP client:", err);
  process.exit(1);
});
