#!/usr/bin/env node
import { runCli } from "./cli.js";

try {
  await runCli(process.argv.slice(2));
} catch {
  process.stderr.write("Collector command failed; check configuration and status.\n");
  process.exitCode = 1;
}
