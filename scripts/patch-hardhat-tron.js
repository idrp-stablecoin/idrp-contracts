// postinstall: @layerzerolabs/hardhat-tron 3.0.168 imports its JSON artifacts with
// `{ assert: { type: 'json' } }`. Node 22 and later reject that (ERR_IMPORT_ATTRIBUTE_MISSING)
// the moment a hardhat-deploy helper runs; `{ with: { type: 'json' } }` works on Node 20, 22
// and 24. Idempotent, and silent when the package or the pattern is absent.
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "node_modules", "@layerzerolabs", "hardhat-tron", "dist", "helper.js");
if (!fs.existsSync(file)) process.exit(0);
const src = fs.readFileSync(file, "utf8");
const from = "{ assert: { type: 'json' } }";
const to = "{ with: { type: 'json' } }";
if (src.includes(from)) {
  fs.writeFileSync(file, src.split(from).join(to));
  console.log("patch-hardhat-tron: JSON imports use `with` (Node 22+ compatible)");
} else if (!src.includes(to)) {
  console.warn("patch-hardhat-tron: import pattern not found — check node_modules/@layerzerolabs/hardhat-tron/dist/helper.js by hand");
}
