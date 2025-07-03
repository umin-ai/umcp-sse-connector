# Meta-Dynamic MCP Server

<div align="center">
  <strong>🎉 Built with curiousity by the uminai Team</strong>
</div>

A single **Model Context Protocol** (MCP) proxy that **aggregates** multiple remote MCP endpoints (via HTTP-stream or SSE) and exposes them through one unified SSE interface.  
Ideal for driving a single LLM client (e.g. Claude) while mixing in any number of specialized MCP servers (math, finance, etc.).

---

## 🔄 Why Meta-Dynamic vs Direct MCP Configuration

Traditionally, you would list each MCP server directly in your LLM client’s `mcpServers` config. While straightforward, that approach has drawbacks:

- **Tight coupling**: Every time you add or remove an MCP endpoint, you must update the client config and restart the LLM process.
- **Multiple connections**: The client has to manage separate HTTP/SSE transports for each server, increasing complexity.
- **No shared logic**: Common patterns like namespacing, error handling, or retries must be re-implemented in every client.

**Meta-Dynamic** centralizes these concerns in one proxy:

- **Single endpoint**: Your LLM client only talks to `http://localhost:8080/sse`, regardless of how many backends you add.
- **Dynamic remotes**: Remotes are configured in one place (your proxy), decoupled from the LLM—add/remove without touching the client.
- **Unified logic**: Namespacing, tool/resource aggregation, error handling, and transport selection live in a single codebase, reducing duplication.

---

## 🔧 Prerequisites

- **Node.js** ≥ v16
- **npm** (or Yarn)
- A set of running MCP servers you want to proxy (e.g. [FastMCP math server](#math-server) on `http://localhost:8083/mcp`, CoinGecko’s SSE-based MCP, etc.)

---

## 🏗️ Project Structure

```
meta-dynamic-server/
├── package.json         # scripts & dependencies
├── tsconfig.json        # TypeScript compiler options
├── .gitignore           # Node & dist ignores
├── README.md            # this document
└── src/
    ├── index.ts         # bootstrap entrypoint
    └── meta-dynamic-server.ts  # core proxy implementation
```

---

## 🚀 Installation & Development

1. **Clone & install**
    ```bash
    git clone <repo-url> meta-dynamic-server
    cd meta-dynamic-server
    npm install
    ```

2. **Run in watch mode**
    ```bash
    npm run dev
    # uses ts-node-dev to reload on changes
    ```

3. **Build & run**
    ```bash
    npm run build   # compiles to `dist/`
    npm start       # runs compiled `dist/index.js`
    ```

---

## ⚙️ Configuration: Adding Remotes

Edit `src/index.ts` to define the list of MCP servers you wish to proxy.  
Each remote needs:

- **name**: unique alias (used to namespace URIs & tool names)  
- **url**: full endpoint URL (HTTP-stream endpoints point to `/mcp`, SSE to the `/sse` path)  
- **transport**: either `httpStream` or `sse`

```ts
import { MetaDynamicServer } from "./meta-dynamic-server";

const remotes = [
  { name: "math",      url: "http://localhost:8083/mcp",         transport: "httpStream" },
  { name: "coingecko", url: "https://mcp.api.coingecko.com/sse", transport: "sse" },
  // add more MCP endpoints here
];

new MetaDynamicServer(remotes).start(8080);
```

> **Note:** The proxy exposes an SSE stream on port **8080** by default: `http://localhost:8080/sse`

---

## 📜 How It Works

1. **Remote Initialization**: connects to each MCP server using the specified transport.
2. **Request Handlers**:
   - **resources/list**, **resources/read** → fan-out & namespace by alias
   - **tools/list**, **tools/call** → aggregate & route tool invocations
3. **SSE Endpoint**: exposes a single SSE stream (`/sse`) and message POST path (`/messages`) for any MCP-capable LLM client.

---

## 🧪 Testing

You can verify connectivity with `curl` or your LLM’s built-in MCP client.  
Example with `curl` to list resources:
```bash
# 1. open an SSE stream:
curl -N http://localhost:8080/sse
# 2. in another shell, send a JSON-RPC over POST:
curl -X POST http://localhost:8080/messages \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"resources/list"}'
```

---

## 🚧 Contributing

1. Fork the repo  
2. Create a feature branch  
3. Submit a PR with tests/documentation  

---

## 📄 License

Released under the **MIT License**. See [LICENSE](https://github.com/umin-ai/umcp-sse-connector/blob/main/LICENSE.md) for details.
