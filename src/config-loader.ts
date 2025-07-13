// src/config-loader.ts
import fs from "fs";
import path from "path";
import type { RawMcpServerConfig, RemoteConfig } from "./types";

export function loadRemotesFromConfig(cfgPath = "./config.json"): RemoteConfig[] {
  const raw = JSON.parse(
    fs.readFileSync(path.resolve(cfgPath), "utf8")
  ) as { mcpServers: Record<string,RawMcpServerConfig> };

  return Object.entries(raw.mcpServers)
    .filter(([_, srv]) => !srv.disabled)
    .map(([name, srv]) => {
      const base = {
        name,
        transport:   srv.type,
        timeout:     srv.timeout,
        autoApprove: srv.autoApprove || []
      };

      if (srv.type === "stdio") {
        return {
          ...base,
          command: srv.command!,
          args:    srv.args    || [],
          env:     srv.env     || {}
        };
      } else {
        return {
          ...base,
          url:     srv.url!,
          env:     srv.env     || {}
        };
      }
    });
}
