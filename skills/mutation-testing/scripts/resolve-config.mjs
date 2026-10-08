// Prints the effective configuration of a run, see lib/config.mjs.
//
// Usage: node resolve-config.mjs <back-dir>
// Output: { effective, sources, report } as JSON on stdout. Exit 2 on a config it cannot use.
import { ConfigError, resolveConfig } from "./lib/config.mjs";

const [backDir] = process.argv.slice(2);
if (!backDir) {
  console.error("usage: node resolve-config.mjs <back-dir>");
  process.exit(2);
}

try {
  console.log(JSON.stringify(resolveConfig(backDir), null, 2));
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`ERROR: ${error.message}`);
  process.exit(2);
}
