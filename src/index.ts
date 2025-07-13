// src/index.ts
import { MetaDynamicServer } from "./meta-dynamic-server-no-cache";
import type { RemoteConfig }      from "./types";

// 1) Raw JSON config types
interface RawStdIOConfig {
  autoApprove: string[];
  disabled:    boolean;
  timeout:     number;
  type:        "stdio";
  command:     string;
  args:        string[];
  env:         Record<string,string>;
}

interface RawHTTPConfig {
  autoApprove: string[];
  disabled:    boolean;
  timeout:     number;
  type:        "sse" | "httpStream";
  url:         string;
  env:         Record<string,string>;
}

type RawServerConfig = RawStdIOConfig | RawHTTPConfig;

// 2) Inline JSON
const json: { mcpServers: Record<string,RawServerConfig> } = {
  mcpServers: {
    "github.com/GLips/Figma-Context-MCP": {
      autoApprove: [],
      disabled:     true,
      timeout:      60,
      type:         "stdio",
      command:      "npx",
      args: [
        "-y",
        "figma-developer-mcp",
        "--figma-api-key=<token>",
        "--stdio"
      ],
      env: {}
    },
    "coingecko": {
      autoApprove: [],
      disabled:     false,
      timeout:      60,
      type:         "sse",
      url:          "https://mcp.api.coingecko.com/sse",
      env: {}
    },
    "etherscan": {
      disabled:    false,
      autoApprove: [],
      timeout:     60,
      type:        "stdio",
      command: "npx",
      args: ["-y", "@aurracloud/etherscan-mcp"],
      env: {
        "ETHERSCAN_API_KEY": "<token>"
      }
    }
    // …add more servers here…
  }
};

// 3) Map into RemoteConfig[], filtering disabled and preserving timeout & autoApprove

const remotes: RemoteConfig[] = Object.entries(json.mcpServers)
  .filter(([, cfg]) => !cfg.disabled)
  .map(([name, cfg]) => {
    if (cfg.type === "stdio") {
      return {
        name,
        transport:   "stdio",
        command:     cfg.command,
        args:        cfg.args,
        // restore PATH so "npx" is found:
        env:         { ...cfg.env, PATH: process.env.PATH! },
        timeout:     cfg.timeout,
        autoApprove: cfg.autoApprove
      };
    } else {
      return {
        name,
        transport:   cfg.type,
        url:         cfg.url,
        timeout:     cfg.timeout,
        autoApprove: cfg.autoApprove
      };
    }
  });

// 4) Bootstrap the meta‐server
(async () => {
  const server = new MetaDynamicServer(remotes);
  await server.start(8080);
  console.log("Meta-dynamic MCP server running on http://localhost:8080/sse");
})();
