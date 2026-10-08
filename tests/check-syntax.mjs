// Parses every browser ES module under js/ so a typo is caught before deploy.
//   node --experimental-vm-modules --no-warnings tests/check-syntax.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import vm from "node:vm";

const root = new URL("../js", import.meta.url).pathname;
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".js")) files.push(p);
  }
})(root);

let bad = 0;
for (const f of files) {
  try { new vm.SourceTextModule(readFileSync(f, "utf8"), { identifier: f }); }
  catch (e) { bad++; console.error(`✗ ${relative(root, f)}: ${e.message}`); }
}
console.log(bad ? `${bad} file(s) with syntax errors` : `✓ ${files.length} modules parse cleanly`);
process.exit(bad ? 1 : 0);
