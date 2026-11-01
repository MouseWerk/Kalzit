#!/usr/bin/env node
import { requirePackages } from "./packages.ts";

// The MCP server (src/server.ts), loaded once its packages are known to be installed.
requirePackages();
await import("./server.ts");
