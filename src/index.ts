import { MetaDynamicServer, RemoteConfig } from "./meta-dynamic-server";
import { MetaDynamicServerCache } from "./meta-dynamic-server-cache";

(async () => {
  const remotes: RemoteConfig[] = [
    { name: "math", url: "http://localhost:8080/1234-5678-9101/sse", transport: "sse" },
    { name: "coingecko", url: "https://mcp.api.coingecko.com/sse", transport: "sse" },
    // add more remotes here
  ];

  const server = new MetaDynamicServerCache(remotes);
  await server.start();
  console.log("Meta‑dynamic MCP server is running (via SSE) on port 8080");
})();
