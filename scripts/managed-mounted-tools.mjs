#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, copyFile, chmod, cp, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadManagedToolsConfig } from "./managed-tools-config.mjs";
import { actionForState, diagnosticForState, formatFields, printCompareRow, printStatusRow } from "./managed-tools-output.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { manifest, policy } = await loadManagedToolsConfig(repoRoot);
const comparePolicy = policy.policy?.compare ?? {};
const command = process.argv[2] ?? "status";
const selectedTools = process.argv.slice(3);
const binRoot = normalizePath(process.env.MANAGED_RELEASE_BIN_DIR ?? "~/.local/bin");
const tempRoot = managedTempRoot();
const rustupFamily = manifest.families?.rustup;
if (!rustupFamily) throw new Error("managed-tools manifest missing rustup family");

const releaseFamilies = ["gh", "release_binaries", "llvm_tools", "cmake", "protobuf"];
const rustupInitTarget = "x86_64-unknown-linux-gnu";
const rustupInitUrl = `https://static.rust-lang.org/rustup/dist/${rustupInitTarget}/rustup-init`;

function normalizePath(value) {
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function managedTempRoot() {
  return normalizePath(process.env.OPENCHAMBER_MANAGED_TOOLS_TMPDIR
    ?? process.env.MANAGED_TOOLS_TMPDIR
    ?? process.env.TMPDIR
    ?? "~/.cache/openchamber-managed/tmp");
}

async function makeTempDir(prefix) {
  await mkdir(tempRoot, { recursive: true });
  return mkdtemp(path.join(tempRoot, prefix));
}

function selectedFilterLabel() {
  return selectedTools.length === 0 ? "all" : selectedTools.join(",");
}

function logRuntimeState() {
  console.log(`[state] ${formatFields({
    command,
    filters: selectedFilterLabel(),
    release_bin_root: binRoot,
    rustup_home: rustHome(),
    cargo_home: cargoHome(),
    temp_root: tempRoot,
  })}`);
}

function stripPrefix(version) {
  return String(version).replace(/^v/, "");
}

function compareVersions(left, right) {
  const leftParts = stripPrefix(left).split(/[.-]/);
  const rightParts = stripPrefix(right).split(/[.-]/);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? "0";
    const rightPart = rightParts[index] ?? "0";
    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);
    if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) {
      if (leftNumber > rightNumber) return 1;
      if (leftNumber < rightNumber) return -1;
      continue;
    }
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}

function compareState(installed, expected) {
  if (!installed) return "missing";
  const diff = compareVersions(installed, expected);
  if (diff === 0) return "equal";
  if (diff < 0) return "lower";
  return "higher";
}

function toolSelected(tool) {
  return selectedTools.length === 0 || selectedTools.includes(tool.name) || selectedTools.includes(binaryName(tool));
}

function rustSelected() {
  return selectedTools.length === 0 || selectedTools.some((name) => ["rust", "rustup", "rustc", "cargo"].includes(name));
}

function selectedReleaseTools() {
  return releaseFamilies.flatMap((familyName) => manifest.families?.[familyName]?.tools ?? []).filter(toolSelected);
}

async function exists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function releaseFamilyName(tool) {
  return releaseFamilies.find((name) => (manifest.families?.[name]?.tools ?? []).includes(tool));
}

function releaseFamily(tool) {
  const familyName = releaseFamilyName(tool);
  return familyName ? manifest.families?.[familyName] : null;
}

function releaseSetting(tool, key) {
  return tool[key] ?? releaseFamily(tool)?.[key];
}

function resolveReleaseField(tool, key) {
  const raw = releaseSetting(tool, key);
  if (raw === null || raw === undefined) return raw;
  if (typeof raw !== "string") return raw;
  const expanded = expandTemplate(raw, tool);
  if (expanded.match(/\{[A-Za-z]/)) {
    throw new Error(`${tool.name}: unresolved template variables in ${key}=${expanded}`);
  }
  return expanded;
}

function templateValue(tool, key) {
  if (key === "version") return tool.version;
  if (key === "assetVersion") return tool.assetVersion ?? tool.version;
  if (key === "checksumVersion") return tool.checksumVersion ?? tool.assetVersion ?? tool.version;
  if (key === "releaseVersion") return tool.releaseVersion ?? tool.version;
  if (key === "name") return tool.name;
  if (key === "tag" || key === "releaseTag") {
    const tag = tool.releaseTag ?? `v${tool.version}`;
    return expandTemplate(tag, tool);
  }
  if (key === "asset") return assetName(tool);
  return tool[key];
}

function expandTemplate(template, tool) {
  return template.replaceAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, key) => {
    const value = templateValue(tool, key);
    if (value === undefined || value === null) throw new Error(`${tool.name} missing template value ${key}`);
    return value;
  });
}

function assetName(tool) {
  const resolved = resolveReleaseField(tool, "assetPattern");
  if (!resolved) throw new Error(`${tool.name} asset pattern missing`);
  return resolved;
}

function checksumName(tool) {
  const checksumAsset = resolveReleaseField(tool, "checksumAsset");
  return checksumAsset ?? null;
}

function checksumUrl(tool) {
  const resolved = resolveReleaseField(tool, "checksumUrl")
    ?? resolveReleaseField(tool, "checksumUrlPattern");
  return resolved;
}

function releaseAssetUrl(tool) {
  return resolveReleaseField(tool, "assetUrl");
}

function checksumFormat(tool) {
  return releaseSetting(tool, "checksumFormat") ?? "sha256sum";
}

function binaryName(tool) {
  return tool.binPath ? path.basename(tool.binPath) : tool.name === "protobuf-compiler" ? "protoc" : tool.name;
}

function installPath(tool) {
  return path.join(binRoot, binaryName(tool));
}

function installRoot(tool) {
  const root = releaseSetting(tool, "installRoot");
  return root ? normalizePath(expandTemplate(root, tool)) : null;
}

function installRootSource(tool) {
  const rootSource = releaseSetting(tool, "installRootSource");
  return rootSource ? expandTemplate(rootSource, tool) : null;
}

function supportPathEntries(tool) {
  return tool.supportPaths ?? [];
}

function supportPathTarget(tool, entry) {
  return normalizePath(expandTemplate(entry.target, tool));
}

function installRootBinaryPath(tool) {
  const root = installRoot(tool);
  if (!root || !tool.binPath) return null;
  const rootSource = installRootSource(tool);
  const expandedBinPath = expandTemplate(tool.binPath, tool);
  const relativeBinPath = rootSource && expandedBinPath.startsWith(`${rootSource}/`)
    ? expandedBinPath.slice(rootSource.length + 1)
    : expandedBinPath;
  return path.join(root, relativeBinPath);
}

async function missingSupportPath(tool) {
  for (const entry of supportPathEntries(tool)) {
    const target = supportPathTarget(tool, entry);
    if (!(await exists(target))) return target;
  }
  return null;
}

function isDirectBinaryAsset(tool) {
  return !assetName(tool).match(/\.(zip|tar\.gz|tar\.xz)$/);
}

async function githubRelease(tool) {
  const explicitTag = releaseSetting(tool, "releaseTag") ?? releaseSetting(tool, "tagPattern");
  const tags = explicitTag
    ? [expandTemplate(explicitTag, tool)]
    : [`v${tool.version}`, tool.version].filter((tag, index, list) => list.indexOf(tag) === index);
  let lastError = null;
  for (const tag of tags) {
    const repo = releaseSetting(tool, "repo");
    if (!repo) throw new Error(`${tool.name} repo missing`);
    const url = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "openchamber-managed-tools" };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
    console.log(`[fetch] ${formatFields({ tool: tool.name, repo, release_tag: tag, target: "github-release" })}`);
    const response = await fetch(url, { headers });
    if (response.ok) {
      const release = await response.json();
      console.log(`[fetch] ${formatFields({
        tool: tool.name,
        release_tag: release.tag_name ?? tag,
        assets: release.assets?.length ?? 0,
        target: "github-release",
      })}`);
      return release;
    }
    console.log(`[fetch] ${formatFields({ tool: tool.name, repo, release_tag: tag, result: "miss", status: response.status })}`);
    lastError = new Error(`failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  throw lastError;
}

function sha256FromJsonl(text, selectedAssetName) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry.dsseEnvelope?.payload ?? entry.payload;
    if (!payload) continue;
    let statement;
    try {
      statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    } catch {
      continue;
    }
    for (const subject of statement.subject ?? []) {
      const digest = subject.name === selectedAssetName ? subject.digest?.sha256 : null;
      if (typeof digest === "string" && digest.match(/^[a-f0-9]{64}$/i)) return digest.toLowerCase();
    }
    for (const dependency of statement.predicate?.buildDefinition?.resolvedDependencies ?? []) {
      const uri = dependency.uri ?? "";
      const digest = uri.endsWith(`/${selectedAssetName}`) ? dependency.digest?.sha256 : null;
      if (typeof digest === "string" && digest.match(/^[a-f0-9]{64}$/i)) return digest.toLowerCase();
    }
  }
  return null;
}

async function download(url, destination, fields = {}, { retries = 3, timeoutMs = 60000 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    if (attempt > 1) {
      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 10000);
      console.log(`[retry] ${formatFields({ ...fields, attempt, max_retries: retries, delay_ms: delayMs, target: destination })}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      console.log(`[download] ${formatFields({ ...fields, target: destination, attempt })}`);
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/octet-stream", "User-Agent": "openchamber-managed-tools" },
      });
      if (!response.ok) {
        lastError = new Error(`failed to download ${url}: ${response.status} ${response.statusText}`);
        continue;
      }
      await pipeline(response.body, createWriteStream(destination));
      console.log(`[download] ${formatFields({ ...fields, target: destination, status: "complete" })}`);
      return;
    } catch (error) {
      if (error.name === "AbortError") {
        lastError = new Error(`download timed out after ${timeoutMs}ms: ${url}`);
      } else {
        lastError = error;
      }
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError ?? new Error(`download failed: ${url}`);
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function expectedSha256(tool, release) {
  const asset = release.assets?.find((entry) => entry.name === assetName(tool));
  if (!asset) throw new Error(`${tool.name} asset missing from release metadata`);
  if (releaseSetting(tool, "checksumPolicy") === "allowGithubDigest") {
    const digest = asset.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1];
    if (!digest) throw new Error(`${tool.name} GitHub digest missing`);
    return digest.toLowerCase();
  }
  const checksum = checksumName(tool);
  const checksumDownloadUrl = checksumUrl(tool);
  if (!checksum && !checksumDownloadUrl) throw new Error(`${tool.name} checksum asset missing`);
  const checksumAsset = checksum ? release.assets?.find((entry) => entry.name === checksum) : null;
  if (checksum && !checksumAsset) throw new Error(`${tool.name} checksum asset ${checksum} missing`);
  const checksumSource = checksumAsset?.browser_download_url ?? checksumDownloadUrl;
  console.log(`[verify] ${formatFields({
    tool: tool.name,
    asset: assetName(tool),
    checksum_asset: checksum ?? checksumSource,
    checksum_format: checksumFormat(tool),
    target: "checksum-source",
  })}`);
  const response = await fetch(checksumSource, { headers: { Accept: "application/octet-stream", "User-Agent": "openchamber-managed-tools" } });
  if (!response.ok) throw new Error(`failed to download ${checksum ?? checksumSource}: ${response.status} ${response.statusText}`);
  const text = await response.text();
  if (checksumFormat(tool) === "jsonl-sha256") {
    const digest = sha256FromJsonl(text, assetName(tool));
    if (digest) return digest;
  }
  if (tool.name === "yq") {
    const line = text.split(/\r?\n/).find((entry) => entry.startsWith(`${assetName(tool)} `));
    const parts = line?.trim().split(/\s+/) ?? [];
    if (parts[18]) return parts[18].toLowerCase();
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes(assetName(tool))) continue;
    const match = line.match(/([a-f0-9]{64})/i);
    if (match) return match[1].toLowerCase();
  }
  throw new Error(`${tool.name} checksum for ${assetName(tool)} not found in ${checksum ?? checksumSource}`);
}

async function expectedSha256Direct(tool) {
  const checksumDownloadUrl = checksumUrl(tool);
  if (!checksumDownloadUrl) throw new Error(`${tool.name} direct checksum URL missing`);
  console.log(`[verify] ${formatFields({
    tool: tool.name,
    asset: assetName(tool),
    checksum_asset: checksumDownloadUrl,
    checksum_format: checksumFormat(tool),
    target: "checksum-source",
  })}`);
  const response = await fetch(checksumDownloadUrl, { headers: { Accept: "application/octet-stream", "User-Agent": "openchamber-managed-tools" } });
  if (!response.ok) throw new Error(`failed to download checksum from ${checksumDownloadUrl}: ${response.status} ${response.statusText}`);
  const text = await response.text();
  if (checksumFormat(tool) === "jsonl-sha256") {
    const digest = sha256FromJsonl(text, assetName(tool));
    if (digest) return digest;
  }
  if (tool.name === "yq") {
    const line = text.split(/\r?\n/).find((entry) => entry.startsWith(`${assetName(tool)} `));
    const parts = line?.trim().split(/\s+/) ?? [];
    if (parts[18]) return parts[18].toLowerCase();
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes(assetName(tool))) continue;
    const match = line.match(/([a-f0-9]{64})/i);
    if (match) return match[1].toLowerCase();
  }
  throw new Error(`${tool.name} checksum for ${assetName(tool)} not found in ${checksumDownloadUrl}`);
}

async function extractArchive(archivePath, extractDir) {
  await mkdir(extractDir, { recursive: true });
  console.log(`[extract] ${formatFields({ archive: path.basename(archivePath), target: extractDir })}`);
  if (archivePath.endsWith(".zip")) {
    await execFileAsync("unzip", ["-q", archivePath, "-d", extractDir], { env: { ...process.env } });
    console.log(`[extract] ${formatFields({ archive: path.basename(archivePath), target: extractDir, status: "complete" })}`);
    return;
  }
  if (archivePath.endsWith(".tar.gz")) {
    await execFileAsync("tar", ["-xzf", archivePath, "-C", extractDir], { env: { ...process.env } });
    console.log(`[extract] ${formatFields({ archive: path.basename(archivePath), target: extractDir, status: "complete" })}`);
    return;
  }
  if (archivePath.endsWith(".tar.xz")) {
    await execFileAsync("tar", ["-xJf", archivePath, "-C", extractDir], { env: { ...process.env } });
    console.log(`[extract] ${formatFields({ archive: path.basename(archivePath), target: extractDir, status: "complete" })}`);
    return;
  }
  throw new Error(`unsupported archive ${archivePath}`);
}

async function findBinary(root, name) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await findBinary(fullPath, name));
    if (entry.isFile() && entry.name === name) files.push(fullPath);
  }
  return files;
}

async function extractedBinary(tool, archivePath, tempDir) {
  if (!archivePath.match(/\.(zip|tar\.gz|tar\.xz)$/)) return archivePath;
  const extractDir = path.join(tempDir, "extract");
  await extractArchive(archivePath, extractDir);
  if (tool.binPath) {
    const direct = path.join(extractDir, expandTemplate(tool.binPath, tool));
    if (await exists(direct)) return direct;
  }
  const matches = await findBinary(extractDir, binaryName(tool));
  if (matches.length !== 1) throw new Error(`expected one ${tool.name} binary in ${assetName(tool)}, found ${matches.length}`);
  return matches[0];
}

async function installSupportPaths(tool, extractDir) {
  for (const entry of supportPathEntries(tool)) {
    const source = path.join(extractDir, expandTemplate(entry.source, tool));
    const target = supportPathTarget(tool, entry);
    if (!(await exists(source))) throw new Error(`${tool.name} support path missing in ${assetName(tool)}: ${entry.source}`);
    await mkdir(path.dirname(target), { recursive: true });
    await rm(target, { recursive: true, force: true });
    console.log(`[install] ${formatFields({ tool: tool.name, source, target })}`);
    await cp(source, target, { recursive: true });
  }
}

async function installTreeRoot(tool, extractDir) {
  const root = installRoot(tool);
  if (!root) return null;
  const rootSource = installRootSource(tool);
  if (!rootSource) throw new Error(`${tool.name} installRoot requires installRootSource`);
  const source = path.join(extractDir, rootSource);
  if (!(await exists(source))) throw new Error(`${tool.name} install root missing in ${assetName(tool)}: ${rootSource}`);
  await mkdir(path.dirname(root), { recursive: true });
  await rm(root, { recursive: true, force: true });
  console.log(`[install] ${formatFields({ tool: tool.name, source, target: root })}`);
  await cp(source, root, { recursive: true });
  return root;
}

async function installedReleaseVersion(tool) {
  const binary = installPath(tool);
  if (!(await exists(binary))) return null;
  for (const args of [["--version"], ["version"]]) {
    let stdout = "";
    let stderr = "";
    try {
      ({ stdout, stderr } = await execFileAsync(binary, args, { env: { ...process.env } }));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      stdout = error.stdout ?? "";
      stderr = error.stderr ?? "";
    }
    const text = `${stdout}\n${stderr}`;
    const version = tool.name === "gh"
      ? text.match(/gh version ([^\s]+)/i)?.[1]
      : tool.name === "protobuf-compiler"
        ? text.match(/libprotoc ([^\s]+)/i)?.[1]
        : text.match(/(\d{4}-\d{2}-\d{2}|\d+\.\d+(?:\.\d+)?(?:[-.]\d+)?)/)?.[1];
    if (version) return version;
  }
  return "unparseable";
}

async function releaseRow(tool) {
  const installed = await installedReleaseVersion(tool);
  const versionState = installed === "unparseable" ? "unparseable" : compareState(installed, tool.version);
  const missingSupport = versionState === "equal" ? await missingSupportPath(tool) : null;
  const state = missingSupport ? "missing" : versionState;
  return {
    family: releaseFamilies.find((familyName) => (manifest.families?.[familyName]?.tools ?? []).includes(tool)) ?? "release_binaries",
    tool: tool.name,
    desired: tool.version,
    actual: installed,
    path: installPath(tool),
    state,
    action: actionForState(comparePolicy, state),
    diagnostic: missingSupport ? `support-path-missing:${missingSupport}` : diagnosticForState(state, "release-binary"),
    source: "release-binary-version-command",
  };
}

async function installReleaseTool(tool) {
  const installed = await installedReleaseVersion(tool);
  const state = installed === "unparseable" ? "unparseable" : compareState(installed, tool.version);
  const missingSupport = state === "equal" ? await missingSupportPath(tool) : null;
  if (state === "equal") {
    if (missingSupport) {
      console.warn(`[repair] ${formatFields({ tool: tool.name, diagnostic: "support-path-missing", path: missingSupport })}`);
    } else {
      console.log(`[skip] ${tool.name} already ${tool.version}`);
      return;
    }
  }
  if (state === "higher") {
    console.warn(`[warn] ${tool.name} ${installed} higher than pinned ${tool.version}; skip downgrade`);
    return;
  }
  if (state === "unparseable") {
    console.warn(`[warn] ${tool.name} version unparseable from release binary; skip`);
    return;
  }
  const assetUrl = releaseAssetUrl(tool);

  if (assetUrl) {
    // Direct URL path — no GitHub API needed
    const assetNameStr = assetName(tool);
    console.log(`[fetch] ${formatFields({
      tool: tool.name,
      release_tag: resolveReleaseField(tool, "releaseTag") ?? `v${tool.version}`,
      asset: assetNameStr,
      target: installPath(tool),
    })}`);
    const expected = await expectedSha256Direct(tool);
    const tempDir = await makeTempDir("managed-release-");
    const archivePath = path.join(tempDir, assetNameStr);
    try {
      await download(assetUrl, archivePath, { tool: tool.name, asset: assetNameStr });
      const actual = await sha256File(archivePath);
      if (actual !== expected) throw new Error(`${tool.name} sha256 mismatch: expected ${expected}, got ${actual}`);
      console.log(`[verify] ${formatFields({ tool: tool.name, asset: assetNameStr, sha256: expected, target: archivePath })}`);
      const source = await extractedBinary(tool, archivePath, tempDir);
      await mkdir(path.dirname(installPath(tool)), { recursive: true });
      const installedRoot = await installTreeRoot(tool, path.join(tempDir, "extract"));
      const binarySource = installedRoot ? installRootBinaryPath(tool) : source;
      if (!binarySource) throw new Error(`${tool.name} install binary path missing`);
      console.log(`[install] ${formatFields({ tool: tool.name, version: tool.version, source: binarySource, target: installPath(tool) })}`);
      await rm(installPath(tool), { recursive: true, force: true });
      if (installedRoot) {
        await symlink(binarySource, installPath(tool));
      } else {
        await copyFile(binarySource, installPath(tool));
        await chmod(installPath(tool), 0o755);
      }
      if (!isDirectBinaryAsset(tool) && !installedRoot) await installSupportPaths(tool, path.join(tempDir, "extract"));
      console.log(`[install] ${tool.name} ${tool.version} installed to ${installPath(tool)}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
    return;
  }

  // Fallback: GitHub API release metadata discovery
  const release = await githubRelease(tool);
  const asset = release.assets?.find((entry) => entry.name === assetName(tool));
  if (!asset) throw new Error(`${tool.name} asset missing from release metadata`);
  console.log(`[fetch] ${formatFields({
    tool: tool.name,
    release_tag: release.tag_name ?? tool.version,
    asset: asset.name,
    size: asset.size,
    target: installPath(tool),
  })}`);
  const expected = await expectedSha256(tool, release);
  const tempDir = await makeTempDir("managed-release-");
  const archivePath = path.join(tempDir, assetName(tool));
  try {
    await download(asset.browser_download_url, archivePath, { tool: tool.name, asset: asset.name, size: asset.size });
    const actual = await sha256File(archivePath);
    if (actual !== expected) throw new Error(`${tool.name} sha256 mismatch: expected ${expected}, got ${actual}`);
    console.log(`[verify] ${formatFields({ tool: tool.name, asset: asset.name, sha256: expected, target: archivePath })}`);
    const source = await extractedBinary(tool, archivePath, tempDir);
    await mkdir(path.dirname(installPath(tool)), { recursive: true });
    const installedRoot = await installTreeRoot(tool, path.join(tempDir, "extract"));
    const binarySource = installedRoot ? installRootBinaryPath(tool) : source;
    if (!binarySource) throw new Error(`${tool.name} install binary path missing`);
    console.log(`[install] ${formatFields({ tool: tool.name, version: tool.version, source: binarySource, target: installPath(tool) })}`);
    await rm(installPath(tool), { recursive: true, force: true });
    if (installedRoot) {
      await symlink(binarySource, installPath(tool));
    } else {
      await copyFile(binarySource, installPath(tool));
      await chmod(installPath(tool), 0o755);
    }
    if (!isDirectBinaryAsset(tool) && !installedRoot) await installSupportPaths(tool, path.join(tempDir, "extract"));
    console.log(`[install] ${tool.name} ${tool.version} installed to ${installPath(tool)}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function validateReleaseMetadata(tool) {
  const assetUrl = releaseAssetUrl(tool);
  if (assetUrl) {
    const assetNameStr = assetName(tool);
    const expected = await expectedSha256Direct(tool);
    console.log(`[fetch] ${formatFields({
      tool: tool.name,
      release_tag: resolveReleaseField(tool, "releaseTag") ?? `v${tool.version}`,
      asset: assetNameStr,
      target: "metadata",
    })}`);
    console.log(`[verify] ${formatFields({ tool: tool.name, asset: assetNameStr, sha256: expected, target: "metadata" })}`);
    return;
  }
  const release = await githubRelease(tool);
  const asset = release.assets?.find((entry) => entry.name === assetName(tool));
  if (!asset) throw new Error(`${tool.name} asset missing from release metadata`);
  const expected = await expectedSha256(tool, release);
  console.log(`[fetch] ${formatFields({
    tool: tool.name,
    release_tag: release.tag_name ?? tool.version,
    asset: asset.name,
    size: asset.size,
    lz: "metadata",
    pt: "metadata",
  })}`);
  console.log(`[verify] ${formatFields({ tool: tool.name, asset: assetName(tool), sha256: expected, target: "metadata" })}`);
}

async function runReleaseStatus() {
  for (const tool of selectedReleaseTools()) {
    printStatusRow(await releaseRow(tool));
  }
}

async function runReleaseCompare() {
  for (const tool of selectedReleaseTools()) {
    printCompareRow(await releaseRow(tool));
  }
}

async function runReleaseMetadata() {
  for (const tool of selectedReleaseTools()) {
    await validateReleaseMetadata(tool);
  }
}

function rustHome() {
  return normalizePath(process.env.MANAGED_RUSTUP_HOME ?? rustupFamily.installPath);
}

function cargoHome() {
  return normalizePath(process.env.MANAGED_CARGO_HOME ?? rustupFamily.cargoHome);
}

function rustEnv() {
  return {
    ...process.env,
    RUSTUP_HOME: rustHome(),
    CARGO_HOME: cargoHome(),
    PATH: `${path.join(cargoHome(), "bin")}:${process.env.PATH ?? ""}`,
  };
}

function rustupPath() {
  return path.join(cargoHome(), "bin", "rustup");
}

async function rustupInitSha256() {
  const checksumUrl = `${rustupInitUrl}.sha256`;
  console.log(`[verify] ${formatFields({ tool: "rustup", asset: "rustup-init", checksum_asset: checksumUrl, checksum_format: "sha256sum", target: "checksum-source" })}`);
  const response = await fetch(checksumUrl, { headers: { Accept: "text/plain", "User-Agent": "openchamber-managed-tools" } });
  if (!response.ok) throw new Error(`failed to download ${checksumUrl}: ${response.status} ${response.statusText}`);
  const match = (await response.text()).match(/([a-f0-9]{64})/i);
  if (!match) throw new Error(`rustup-init checksum not found in ${checksumUrl}`);
  return match[1].toLowerCase();
}

async function ensureRustupInstalled() {
  const rustup = rustupPath();
  if (await exists(rustup)) return rustup;

  await mkdir(rustHome(), { recursive: true });
  await mkdir(cargoHome(), { recursive: true });
  const expectedSha256 = await rustupInitSha256();
  const tempDir = await makeTempDir("managed-rustup-");
  const initPath = path.join(tempDir, "rustup-init");
  try {
    await download(rustupInitUrl, initPath, { tool: "rustup", asset: "rustup-init" });
    const actualSha256 = await sha256File(initPath);
    if (actualSha256 !== expectedSha256) {
      throw new Error(`rustup-init sha256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
    }
    console.log(`[verify] ${formatFields({ tool: "rustup", asset: "rustup-init", sha256: expectedSha256, target: initPath })}`);
    await chmod(initPath, 0o755);
    console.log(`[install] ${formatFields({ tool: "rustup", source: initPath, target: rustup })}`);
    await execFileAsync(initPath, ["-y", "--no-modify-path", "--default-toolchain", "none"], { env: rustEnv(), maxBuffer: 10 * 1024 * 1024 });
    if (!(await exists(rustup))) throw new Error(`rustup bootstrap did not create ${rustup}`);
    return rustup;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function installedRustVersion() {
  const rustc = path.join(cargoHome(), "bin", "rustc");
  if (!(await exists(rustc))) return null;
  try {
    const { stdout } = await execFileAsync(rustc, ["--version"], { env: rustEnv() });
    return stdout.match(/rustc ([^\s]+)/)?.[1] ?? null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function installedRustReport() {
  const version = await installedRustVersion();
  const rustup = rustupPath();
  if (!(await exists(rustup))) return { version, source: "rustc-version-command" };
  try {
    await execFileAsync(rustup, ["--version"], { env: rustEnv() });
    return { version, source: "rustc-version-command+rustup-version-command" };
  } catch (error) {
    if (error.code === "ENOENT") return { version, source: "rustc-version-command" };
    throw error;
  }
}

async function installRustupToolchain() {
  const installed = await installedRustVersion();
  const target = rustupFamily.tools?.[0]?.version;
  const state = compareState(installed, target);
  if (state === "equal") {
    console.log(`[skip] rust toolchain already ${target}`);
    return;
  }
  if (state === "higher") {
    console.warn(`[warn] rust toolchain ${installed} higher than pinned ${target}; skip downgrade`);
    return;
  }
  const rustup = await ensureRustupInstalled();
  const profile = rustupFamily.tools?.[0]?.profile ?? "default";
  await execFileAsync(rustup, ["toolchain", "install", target, "--profile", profile, "--no-self-update"], { env: rustEnv(), maxBuffer: 10 * 1024 * 1024 });
  await execFileAsync(rustup, ["default", target], { env: rustEnv(), maxBuffer: 10 * 1024 * 1024 });
  console.log(`[install] rust toolchain ${target} installed to ${rustHome()} and ${cargoHome()}`);
}

async function runRustStatus() {
  const report = await installedRustReport();
  const installed = report.version;
  const target = rustupFamily.tools?.[0]?.version;
  const state = compareState(installed, target);
  for (const tool of rustupFamily.tools ?? []) {
    printStatusRow({
      family: "rustup",
      tool: tool.name,
      desired: target,
      actual: installed,
      path: path.join(cargoHome(), "bin", tool.name),
      state,
      action: actionForState(comparePolicy, state),
      diagnostic: diagnosticForState(state, "rust-toolchain"),
      source: report.source,
    });
  }
}

async function runRustCompare() {
  const report = await installedRustReport();
  const installed = report.version;
  const target = rustupFamily.tools?.[0]?.version;
  const state = compareState(installed, target);
  printCompareRow({
    family: "rustup",
    tool: "rust-toolchain",
    desired: target,
    actual: installed,
    path: rustHome(),
    state,
    action: actionForState(comparePolicy, state),
    diagnostic: diagnosticForState(state, "rust-toolchain"),
    source: report.source,
  });
}

async function runReleaseInit() {
  for (const tool of selectedReleaseTools()) {
    await installReleaseTool(tool);
  }
}

if (command === "init") {
  logRuntimeState();
  await runReleaseInit();
  if (rustSelected()) await installRustupToolchain();
} else if (command === "status") {
  logRuntimeState();
  await runReleaseStatus();
  if (rustSelected()) await runRustStatus();
} else if (command === "compare") {
  logRuntimeState();
  await runReleaseCompare();
  if (rustSelected()) await runRustCompare();
} else if (command === "metadata") {
  logRuntimeState();
  await runReleaseMetadata();
} else {
  throw new Error(`unknown command: ${command}`);
}
