const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const cp = require("child_process");

const ROOT = process.cwd();
const BOOTSTRAP_FILE = path.join(ROOT, "index.js");

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;

    const eq = s.indexOf("=");
    if (eq === -1) continue;

    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();

    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }

    if (!(key in process.env)) process.env[key] = val;
  }
}

loadDotEnv(path.join(ROOT, ".env"));

const REPO_URL = String(process.env.REPO_URL || "").trim();
const REPO_BRANCH = String(process.env.REPO_BRANCH || "main").trim();
const REPO_ENTRY = String(process.env.REPO_ENTRY || "index.js").trim();
const CLEAN_ROOT = String(process.env.BOOTSTRAP_CLEAN_ROOT || "1").trim() !== "0";

if (!REPO_URL) {
  console.error("Missing REPO_URL in .env");
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const res = cp.spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    stdio: "inherit",
    shell: false,
    env: process.env,
  });

  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with exit code ${res.status}`);
  }
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function rmSafe(p) {
  try {
    await fsp.rm(p, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  } catch {}
}

async function copyDir(src, dst, opts = {}) {
  const entries = await fsp.readdir(src, { withFileTypes: true });
  await fsp.mkdir(dst, { recursive: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);

    if (opts.skip && opts.skip(entry.name, srcPath, dstPath)) continue;

    if (entry.isDirectory()) {
      await copyDir(srcPath, dstPath, opts);
    } else if (entry.isSymbolicLink()) {
      const real = await fsp.readlink(srcPath);
      try {
        await fsp.symlink(real, dstPath);
      } catch {}
    } else {
      await fsp.mkdir(path.dirname(dstPath), { recursive: true });
      await fsp.copyFile(srcPath, dstPath);
    }
  }
}

async function cleanRootPreserve(activeTempBase) {
  if (!CLEAN_ROOT) return;

  const preserve = new Set([".env"]);
  const entries = await fsp.readdir(ROOT, { withFileTypes: true });
  const tempResolved = activeTempBase ? path.resolve(activeTempBase) : null;

  for (const entry of entries) {
    const name = entry.name;
    if (preserve.has(name)) continue;

    const full = path.join(ROOT, name);
    const fullResolved = path.resolve(full);

    // Keep bootstrap file until repo copy overwrites it.
    if (full === BOOTSTRAP_FILE) continue;

    // Some hosts (including KataBump) set TMPDIR inside ROOT, e.g.
    // /home/container/.tmp. Never delete the directory that currently
    // contains our cloned repository while cleaning ROOT.
    if (tempResolved && (tempResolved === fullResolved || tempResolved.startsWith(fullResolved + path.sep))) {
      continue;
    }

    await rmSafe(full);
  }
}

async function installDependencies() {
  const packagePath = path.join(ROOT, "package.json");
  if (!(await pathExists(packagePath))) {
    throw new Error("Copied repository but package.json is missing");
  }

  console.log("[bootstrap] installing dependencies...");
  const lockPath = path.join(ROOT, "package-lock.json");

  if (await pathExists(lockPath)) {
    run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: ROOT });
  } else {
    run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: ROOT });
  }

  console.log("[bootstrap] dependencies installed.");
}

function handoffToRealNode() {
  const entryPath = path.join(ROOT, REPO_ENTRY);

  const child = cp.spawn(process.execPath, [entryPath], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });

  child.on("error", (err) => {
    console.error("[bootstrap] handoff failed:", err?.message || err);
    process.exit(1);
  });
}

(async () => {
  const tempBase = await fsp.mkdtemp(path.join(os.tmpdir(), "bmedia-bootstrap-"));
  const cloneDir = path.join(tempBase, "repo");

  try {
    console.log("[bootstrap] cloning repo...");
    run("git", ["clone", "--depth", "1", "--branch", REPO_BRANCH, REPO_URL, cloneDir], {
      cwd: tempBase,
    });

    // Never allow the cloned repo's .env to replace the server's .env
    await rmSafe(path.join(cloneDir, ".env"));

    console.log("[bootstrap] cleaning root (preserving .env)...");
    await cleanRootPreserve(tempBase);

    console.log("[bootstrap] copying repo into root...");
    await copyDir(cloneDir, ROOT, {
      skip: (name) => name === ".git" || name === ".env",
    });

    const entryPath = path.join(ROOT, REPO_ENTRY);
    if (!(await pathExists(entryPath))) {
      throw new Error(`Copied repo but entry missing: ${REPO_ENTRY}`);
    }

    await installDependencies();

    console.log("[bootstrap] removing temp clone...");
    await rmSafe(tempBase);

    console.log("[bootstrap] handoff to cloned entry...");
        handoffToRealNode();
  } catch (err) {
    console.error("[bootstrap] failed:", err?.message || err);
    await rmSafe(tempBase);
    process.exit(1);
  }
})();