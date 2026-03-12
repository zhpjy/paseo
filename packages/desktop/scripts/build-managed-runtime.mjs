import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const desktopRoot = path.join(repoRoot, "packages", "desktop");
const resourcesRoot = path.join(desktopRoot, "src-tauri", "resources", "managed-runtime");
const cacheRoot = path.join(desktopRoot, ".cache", "managed-runtime");
const packageVersion = JSON.parse(
  await fs.readFile(path.join(desktopRoot, "package.json"), "utf8")
).version;

const workspaces = [
  { name: "@getpaseo/relay", root: path.join(repoRoot, "packages", "relay") },
  { name: "@getpaseo/server", root: path.join(repoRoot, "packages", "server") },
  { name: "@getpaseo/cli", root: path.join(repoRoot, "packages", "cli") },
];

const ripgrepPlatformDirMap = {
  darwin: {
    arm64: "arm64-darwin",
    x64: "x64-darwin",
  },
  linux: {
    arm64: "arm64-linux",
    x64: "x64-linux",
  },
  win32: {
    arm64: "arm64-win32",
    x64: "x64-win32",
  },
};

async function rmSafe(target) {
  await fs.rm(target, { recursive: true, force: true });
}

async function ensureDir(target) {
  await fs.mkdir(target, { recursive: true });
}

async function copyDir(source, target) {
  await ensureDir(path.dirname(target));
  await fs.cp(source, target, { recursive: true, dereference: true, force: true });
}

async function copyFile(source, target, mode) {
  await ensureDir(path.dirname(target));
  await fs.copyFile(source, target);
  if (mode != null) {
    await fs.chmod(target, mode);
  }
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function removeIfExists(target) {
  if (await pathExists(target)) {
    await rmSafe(target);
  }
}

async function readToolVersions() {
  const raw = await fs.readFile(path.join(repoRoot, ".tool-versions"), "utf8");
  const entries = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const [tool, ...rest] = trimmed.split(/\s+/);
    if (!tool || rest.length === 0) {
      continue;
    }
    entries.set(tool, rest.join(" "));
  }
  return entries;
}

function resolveNodeVersion(toolVersions) {
  const raw = toolVersions.get("nodejs");
  if (!raw) {
    throw new Error("Missing nodejs entry in .tool-versions.");
  }
  const version = raw.trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Unsupported nodejs version in .tool-versions: ${raw}`);
  }
  return version;
}

function resolveNodeArtifact(version) {
  const platformMap = {
    darwin: "darwin",
    linux: "linux",
    win32: "win",
  };
  const archMap = {
    arm64: "arm64",
    x64: "x64",
  };
  const platform = platformMap[process.platform];
  const arch = archMap[process.arch];
  if (!platform || !arch) {
    throw new Error(`Managed runtime is not implemented for ${process.platform}-${process.arch}.`);
  }
  const baseName = `node-v${version}-${platform}-${arch}`;
  const extension = process.platform === "win32" ? "zip" : process.platform === "linux" ? "tar.xz" : "tar.gz";
  return {
    version,
    baseName,
    archiveName: `${baseName}.${extension}`,
    extension,
    downloadUrl: `https://nodejs.org/dist/v${version}/${baseName}.${extension}`,
    checksumsUrl: `https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
  };
}

async function downloadFile(url, target) {
  await ensureDir(path.dirname(target));
  runCommand("curl", [
    "--fail",
    "--location",
    "--retry",
    "3",
    "--silent",
    "--show-error",
    "--output",
    target,
    url,
  ]);
}

async function sha256File(target) {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(target));
  return hash.digest("hex");
}

async function computeRuntimeContentHash(input) {
  const hash = createHash("sha256");
  hash.update(`packageVersion:${packageVersion}\n`);
  hash.update(`nodeVersion:${input.nodeVersion}\n`);
  hash.update(`platform:${process.platform}\n`);
  hash.update(`arch:${process.arch}\n`);
  for (const tarball of input.tarballs) {
    hash.update(`workspace:${tarball.name}\n`);
    hash.update(`filename:${path.basename(tarball.path)}\n`);
    hash.update(`sha256:${await sha256File(tarball.path)}\n`);
  }
  return hash.digest("hex").slice(0, 12);
}

async function ensureNodeArchive(nodeArtifact) {
  const versionCacheRoot = path.join(cacheRoot, `node-v${nodeArtifact.version}`);
  const archivePath = path.join(versionCacheRoot, nodeArtifact.archiveName);
  const checksumsPath = path.join(versionCacheRoot, "SHASUMS256.txt");
  if (!(await pathExists(archivePath))) {
    await downloadFile(nodeArtifact.downloadUrl, archivePath);
  }
  if (!(await pathExists(checksumsPath))) {
    await downloadFile(nodeArtifact.checksumsUrl, checksumsPath);
  }
  const checksums = await fs.readFile(checksumsPath, "utf8");
  const expectedLine = checksums
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.endsWith(` ${nodeArtifact.archiveName}`));
  if (!expectedLine) {
    throw new Error(`Missing checksum for ${nodeArtifact.archiveName} in SHASUMS256.txt`);
  }
  const expectedSha = expectedLine.split(/\s+/)[0];
  const actualSha = await sha256File(archivePath);
  if (actualSha !== expectedSha) {
    throw new Error(
      `Checksum mismatch for ${nodeArtifact.archiveName}: expected ${expectedSha}, got ${actualSha}`
    );
  }
  return archivePath;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "pipe",
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        result.error ? String(result.error) : null,
        result.signal ? `signal: ${result.signal}` : null,
        result.status != null ? `exit code: ${result.status}` : null,
        result.stdout?.trim(),
        result.stderr?.trim(),
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  return result;
}

function withManagedRuntimeNodeOptions(env = process.env) {
  const existing = env.NODE_OPTIONS?.trim() ?? "";
  if (existing.includes("--max-old-space-size")) {
    return env;
  }
  const nodeOptions = existing ? `${existing} --max-old-space-size=8192` : "--max-old-space-size=8192";
  return {
    ...env,
    NODE_OPTIONS: nodeOptions,
  };
}

async function extractNodeDistribution(archivePath, nodeArtifact) {
  const extractionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-managed-runtime-node-"));
  if (nodeArtifact.extension === "zip") {
    runCommand("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractionRoot.replace(/'/g, "''")}' -Force`,
    ]);
  } else {
    const tarFlag = nodeArtifact.extension === "tar.xz" ? "-xJf" : "-xzf";
    runCommand("tar", [tarFlag, archivePath, "-C", extractionRoot]);
  }
  return {
    extractionRoot,
    extractedRoot: path.join(extractionRoot, nodeArtifact.baseName),
  };
}

async function ensureWorkspaceBuilds() {
  const requiredPaths = [
    path.join(repoRoot, "packages", "relay", "dist"),
    path.join(repoRoot, "packages", "server", "dist"),
    path.join(repoRoot, "packages", "cli", "dist"),
  ];
  for (const requiredPath of requiredPaths) {
    if (!(await pathExists(requiredPath))) {
      throw new Error(
        `Managed runtime build is missing required path: ${requiredPath}. Run the daemon build first.`
      );
    }
  }
}

async function packWorkspace(packageRoot, tarballRoot) {
  await ensureDir(tarballRoot);
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) {
    throw new Error("Missing npm_execpath while building managed runtime.");
  }
  const result = runCommand(process.execPath, [
    npmExecPath,
    "pack",
    "--json",
    "--pack-destination",
    tarballRoot,
  ], {
    cwd: packageRoot,
    env: withManagedRuntimeNodeOptions(process.env),
  });
  const [{ filename }] = JSON.parse(result.stdout.trim());
  if (!filename) {
    throw new Error(`npm pack did not produce a filename for ${packageRoot}`);
  }
  return path.join(tarballRoot, filename);
}

async function installPackedWorkspaces(runtimeRoot, bundledNodeRoot, tarballs) {
  const nodeExecutable = process.platform === "win32"
    ? path.join(bundledNodeRoot, "node.exe")
    : path.join(bundledNodeRoot, "bin", "node");
  const npmCli = process.platform === "win32"
    ? path.join(bundledNodeRoot, "node_modules", "npm", "bin", "npm-cli.js")
    : path.join(bundledNodeRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const install = spawnSync(
    nodeExecutable,
    [
      npmCli,
      "install",
      "--include=optional",
      "--omit=dev",
      "--no-package-lock",
      "--no-save",
      ...tarballs,
    ],
    {
      cwd: runtimeRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_fund: "false",
      },
    }
  );
  if (install.status !== 0) {
    throw new Error(
      `Managed runtime dependency install failed with exit code ${install.status ?? 1}.`
    );
  }
}

async function writeRuntimePackageJson(runtimeRoot) {
  await fs.writeFile(
    path.join(runtimeRoot, "package.json"),
    JSON.stringify(
      {
        name: "paseo-managed-runtime",
        private: true,
        version: packageVersion,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

async function pruneChildrenExcept(parent, keepNames) {
  if (!(await pathExists(parent))) {
    return;
  }
  const entries = await fs.readdir(parent);
  await Promise.all(
    entries
      .filter((entry) => !keepNames.has(entry))
      .map((entry) => rmSafe(path.join(parent, entry)))
  );
}

async function pruneNodeDistribution(runtimeRoot) {
  const nodeRoot = path.join(runtimeRoot, "node");
  await Promise.all([
    removeIfExists(path.join(nodeRoot, "include")),
    removeIfExists(path.join(nodeRoot, "share")),
    removeIfExists(path.join(nodeRoot, "CHANGELOG.md")),
  ]);

  const nodeGlobalModulesRoot = path.join(nodeRoot, "lib", "node_modules");
  if (await pathExists(nodeGlobalModulesRoot)) {
    const keepNames = new Set(["npm"]);
    await pruneChildrenExcept(nodeGlobalModulesRoot, keepNames);
  }
}

async function pruneOnnxRuntime(runtimeRoot) {
  const onnxRoot = path.join(runtimeRoot, "node_modules", "onnxruntime-node", "bin", "napi-v6");
  if (!(await pathExists(onnxRoot))) {
    return;
  }
  if (process.platform === "darwin") {
    await removeIfExists(path.join(onnxRoot, "linux"));
    await removeIfExists(path.join(onnxRoot, "win32"));
    await pruneChildrenExcept(path.join(onnxRoot, "darwin"), new Set([process.arch]));
    return;
  }
  if (process.platform === "linux") {
    await removeIfExists(path.join(onnxRoot, "darwin"));
    await removeIfExists(path.join(onnxRoot, "win32"));
    await pruneChildrenExcept(path.join(onnxRoot, "linux"), new Set([process.arch]));
    const archDir = path.join(onnxRoot, "linux", process.arch);
    if (await pathExists(archDir)) {
      const entries = await fs.readdir(archDir);
      await Promise.all(
        entries
          .filter((name) => name.includes("cuda") || name.includes("tensorrt"))
          .map((name) => fs.rm(path.join(archDir, name), { force: true }))
      );
    }
    return;
  }
  if (process.platform === "win32") {
    await removeIfExists(path.join(onnxRoot, "darwin"));
    await removeIfExists(path.join(onnxRoot, "linux"));
    await pruneChildrenExcept(path.join(onnxRoot, "win32"), new Set([process.arch]));
    return;
  }
}

async function pruneNodePty(runtimeRoot) {
  const prebuildsRoot = path.join(runtimeRoot, "node_modules", "node-pty", "prebuilds");
  const keepName = `${process.platform}-${process.arch}`;
  await pruneChildrenExcept(prebuildsRoot, new Set([keepName]));

  if (process.platform !== "win32") {
    await removeIfExists(path.join(runtimeRoot, "node_modules", "node-pty", "third_party"));
  }
}

async function pruneClaudeAgentSdk(runtimeRoot) {
  const vendorRoot = path.join(
    runtimeRoot,
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
    "vendor"
  );
  const ripgrepRoot = path.join(vendorRoot, "ripgrep");
  const keepName = ripgrepPlatformDirMap[process.platform]?.[process.arch];
  if (keepName) {
    await pruneChildrenExcept(ripgrepRoot, new Set(["COPYING", keepName]));
  }

  const treeSitterBashRoot = path.join(vendorRoot, "tree-sitter-bash");
  if (keepName) {
    await pruneChildrenExcept(treeSitterBashRoot, new Set([keepName]));
  }
}

async function pruneCodexCli(runtimeRoot) {
  const codexTargetTriple = {
    darwin: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" },
    linux: { arm64: "aarch64-unknown-linux-musl", x64: "x86_64-unknown-linux-musl" },
    win32: { arm64: "aarch64-pc-windows-msvc", x64: "x86_64-pc-windows-msvc" },
  };
  const codexPlatformPackages = [
    "@openai/codex-darwin-arm64",
    "@openai/codex-darwin-x64",
    "@openai/codex-linux-arm64",
    "@openai/codex-linux-x64",
    "@openai/codex-win32-arm64",
    "@openai/codex-win32-x64",
  ];
  const currentTriple = codexTargetTriple[process.platform]?.[process.arch];
  const currentPackage = currentTriple
    ? `@openai/codex-${process.platform === "win32" ? "win32" : process.platform}-${process.arch}`
    : null;

  const openaiScope = path.join(runtimeRoot, "node_modules", "@openai");
  for (const pkg of codexPlatformPackages) {
    const pkgName = pkg.replace("@openai/", "");
    if (currentPackage && pkg === currentPackage) {
      continue;
    }
    await removeIfExists(path.join(openaiScope, pkgName));
  }
}

async function pruneOpenCodeCli(runtimeRoot) {
  const opencodePlatformPackages = [
    "opencode-darwin-arm64",
    "opencode-darwin-x64",
    "opencode-linux-arm64",
    "opencode-linux-x64",
    "opencode-linux-x64-baseline",
    "opencode-linux-arm64-musl",
    "opencode-linux-x64-musl",
    "opencode-linux-x64-baseline-musl",
    "opencode-windows-x64",
    "opencode-windows-arm64",
  ];
  const platformMap = { darwin: "darwin", linux: "linux", win32: "windows" };
  const currentPlatform = platformMap[process.platform];
  const currentPackage = currentPlatform
    ? `opencode-${currentPlatform}-${process.arch}`
    : null;

  const nodeModules = path.join(runtimeRoot, "node_modules");
  for (const pkg of opencodePlatformPackages) {
    if (currentPackage && pkg === currentPackage) {
      continue;
    }
    await removeIfExists(path.join(nodeModules, pkg));
  }
}

async function pruneManagedRuntime(runtimeRoot) {
  await Promise.all([
    pruneNodeDistribution(runtimeRoot),
    pruneOnnxRuntime(runtimeRoot),
    pruneNodePty(runtimeRoot),
    pruneClaudeAgentSdk(runtimeRoot),
    pruneCodexCli(runtimeRoot),
    pruneOpenCodeCli(runtimeRoot),
  ]);
}

async function main() {
  await ensureWorkspaceBuilds();

  const toolVersions = await readToolVersions();
  const nodeVersion = resolveNodeVersion(toolVersions);
  const nodeArtifact = resolveNodeArtifact(nodeVersion);

  await rmSafe(resourcesRoot);
  await ensureDir(resourcesRoot);

  const archivePath = await ensureNodeArchive(nodeArtifact);
  const { extractionRoot, extractedRoot } = await extractNodeDistribution(archivePath, nodeArtifact);
  const tarballRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-managed-runtime-pack-"));

  try {
    const tarballs = [];
    for (const workspace of workspaces) {
      tarballs.push({
        name: workspace.name,
        path: await packWorkspace(workspace.root, tarballRoot),
      });
    }
    const runtimeContentHash = await computeRuntimeContentHash({
      nodeVersion,
      tarballs,
    });
    const runtimeId =
      `${packageVersion}-node-${nodeVersion}-${process.platform}-${process.arch}-${runtimeContentHash}`;
    const runtimeRoot = path.join(resourcesRoot, runtimeId);

    await ensureDir(runtimeRoot);
    await copyDir(extractedRoot, path.join(runtimeRoot, "node"));
    await writeRuntimePackageJson(runtimeRoot);
    await installPackedWorkspaces(
      runtimeRoot,
      path.join(runtimeRoot, "node"),
      tarballs.map((entry) => entry.path)
    );
    await pruneManagedRuntime(runtimeRoot);

    const nodeRelativePath = process.platform === "win32"
      ? path.join("node", "node.exe")
      : path.join("node", "bin", "node");
    const manifest = {
      runtimeId,
      runtimeVersion: packageVersion,
      platform: process.platform,
      arch: process.arch,
      createdAt: new Date().toISOString(),
      nodeRelativePath,
      cliEntrypointRelativePath: path.join(
        "node_modules",
        "@getpaseo",
        "cli",
        "dist",
        "index.js"
      ),
      cliShimRelativePath: path.join("node_modules", "@getpaseo", "cli", "bin", "paseo"),
      serverRunnerRelativePath: path.join(
        "node_modules",
        "@getpaseo",
        "server",
        "dist",
        "scripts",
        "daemon-runner.js"
      ),
    };

    await fs.writeFile(
      path.join(runtimeRoot, "runtime-manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8"
    );

    await fs.writeFile(
      path.join(resourcesRoot, "current-runtime.json"),
      JSON.stringify(
        {
          runtimeId,
          runtimeVersion: packageVersion,
          relativeRoot: runtimeId,
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    if (process.platform !== "win32") {
      await fs.chmod(path.join(runtimeRoot, nodeRelativePath), 0o755);
    }
  } finally {
    await rmSafe(extractionRoot);
    await rmSafe(tarballRoot);
  }
}

await main();
