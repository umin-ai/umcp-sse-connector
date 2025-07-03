import { MetaDynamicServer, RemoteConfig } from "./meta-dynamic-server";

(async () => {
  const remotes: RemoteConfig[] = [
    { name: "math", url: "http://localhost:8083/mcp", transport: "httpStream" },
    { name: "coingecko", url: "https://mcp.api.coingecko.com/sse", transport: "sse" },
    // add more remotes here
  ];

  const server = new MetaDynamicServer(remotes);
  await server.start();
  console.log("Meta‑dynamic MCP server is running (via SSE) on port 8080");
})();
