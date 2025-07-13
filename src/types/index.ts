// src/types.ts
export interface RawMcpServerConfig {
  autoApprove: string[];
  disabled:    boolean;
  timeout:     number;                // seconds
  type:        "stdio" | "sse" | "httpStream";
  url?:        string;                // for SSE or HTTP‐stream
  command?:    string;                // for stdio
  args?:       string[];
  env?:        Record<string,string>;
}

export interface RemoteConfig {
  name:        string;
  transport:   "stdio" | "sse" | "httpStream";
  timeout:     number;                // seconds
  autoApprove: string[];              // tools to auto‐approve
  // then exactly one of:
  url?:        string;
  command?:    string;
  args?:       string[];
  env?:        Record<string,string>;
}
