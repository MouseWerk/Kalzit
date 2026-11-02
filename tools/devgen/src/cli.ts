#!/usr/bin/env node
import { requirePackages } from "./packages.ts";

// The CLI (src/commands.ts), loaded once its packages are known to be installed.
requirePackages();
await import("./commands.ts");
