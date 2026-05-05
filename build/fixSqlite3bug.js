const fs = require("fs");
const path = require("path");

// sqlite3 在新版本 Electron 中通过 N-API 适配，不应再强制覆盖 napi_versions。
const sqlite3Path = path.join(
  process.cwd(),
  "node_modules",
  "sqlite3",
  "package.json",
);
if (!fs.existsSync(sqlite3Path)) {
  console.log("[fixSqlite3bug] sqlite3 package.json not found, skip.");
  process.exit(0);
}

const sqlite3 = require(sqlite3Path);
if (!sqlite3.binary || !Array.isArray(sqlite3.binary.napi_versions)) {
  console.log("[fixSqlite3bug] sqlite3 has no binary.napi_versions, skip.");
  process.exit(0);
}

console.log(
  `[fixSqlite3bug] keep sqlite3 napi_versions: ${sqlite3.binary.napi_versions.join(", ")}`,
);
