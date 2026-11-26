// Writes config/edge-firewall.vercel.json from config/edge-firewall.ts
// (through config/edge-firewall-vercel.ts). Run after any change to the rules:
//   npm run edge:firewall:config
// tests/unit/edge-firewall-vercel.test.ts fails while the file is out of date.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderVercelFirewallConfig } from "../config/edge-firewall-vercel";

const output = join(__dirname, "..", "config", "edge-firewall.vercel.json");
writeFileSync(output, renderVercelFirewallConfig());
console.log(`wrote ${output}`);
