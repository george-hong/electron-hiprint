const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ELECTRON_VERSION = "17.4.11";
const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);

function getArg(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const arch = getArg("arch");
const tag = getArg("tag");

if (!["ia32", "x64"].includes(arch) || !tag) {
  console.error("Usage: node ./tools/build-win --arch <ia32|x64> --tag <tag>");
  process.exit(1);
}

const runtimeDir = path.join(root, ".runtime");
const runtimeHome = path.join(runtimeDir, "home");
const electronGypDir = path.join(runtimeDir, "electron-gyp");
fs.mkdirSync(runtimeHome, { recursive: true });
fs.mkdirSync(electronGypDir, { recursive: true });

function commandExists(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  return result.status === 0;
}

function pythonVersion(command, commandArgs) {
  const result = spawnSync(command, [...commandArgs, "--version"], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    return null;
  }
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const match = output.match(/Python\s+(\d+)\.(\d+)\.(\d+)/);
  return match
    ? {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
      }
    : null;
}

function isSupportedPython(version) {
  if (!version) {
    return false;
  }
  return version.major === 3 && version.minor >= 8 && version.minor < 14;
}

function findPython() {
  if (process.env.npm_config_python) {
    return process.env.npm_config_python;
  }

  const candidates = [];
  const codexPython = path.join(
    os.homedir(),
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "python",
    "python.exe",
  );
  if (fs.existsSync(codexPython)) {
    candidates.push([codexPython, []]);
  }

  if (process.platform === "win32") {
    const where = spawnSync("where.exe", ["python"], {
      cwd: root,
      encoding: "utf8",
      shell: false,
    });
    if (where.status === 0) {
      candidates.push(
        ...where.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((command) => [command, []]),
      );
    }
    candidates.push(["py", ["-3"]]);
  } else {
    candidates.push(["python3", []], ["python", []]);
  }

  const fallback = candidates.find(([command, commandArgs]) =>
    commandExists(command, commandArgs),
  );

  const supported = candidates.find(([command, commandArgs]) =>
    isSupportedPython(pythonVersion(command, commandArgs)),
  );

  return supported ? supported[0] : fallback && fallback[0];
}

const env = {
  ...process.env,
  HOME: runtimeHome,
  USERPROFILE: runtimeHome,
  npm_package_config_node_gyp_devdir: electronGypDir,
  PATH: `${path.join(root, "node_modules", ".bin")}${path.delimiter}${process.env.PATH || ""}`,
};

const python = findPython();
if (python) {
  env.npm_config_python = python;
  console.log(`[build-win] using Python: ${python}`);
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

run("electron-rebuild", [
  "--version",
  ELECTRON_VERSION,
  "--arch",
  arch,
  "--module-dir",
  ".",
  "--force",
]);
run("electron-builder", ["-w", `nsis:${arch}`]);
run("node", ["./tools/rename", "--tag", tag]);
