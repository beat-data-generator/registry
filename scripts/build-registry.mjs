#!/usr/bin/env node
/**
 * Merge the per-plugin source files in `plugins/*.json` into the single
 * `registry.json` document that the Beat Data Generator client fetches.
 *
 * Source file shape (curated by humans):
 *   { id, repo, author?, homepage?, categories?, tags?, minAppVersion?,
 *     name, description, versions: { "<semver>": { url, sha256, size?, minAppVersion? } } }
 *
 * Output shape (matches src/shared/market.ts MarketIndex in the client):
 *   { schema, updatedAt, plugins: [ { ...source, latest, versions } ] }
 *
 * `versions` is maintained by scripts/sync-releases.mjs (from GitHub Releases),
 * everything else is edited by hand through pull requests. `latest` is always
 * derived here so it can never drift from the versions map.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_DIR = join(ROOT, "plugins");
const OUT_FILE = join(ROOT, "registry.json");
const SCHEMA_VERSION = 1;

const ID_RE = /^[A-Za-z0-9._-]+$/;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Parse a semver-ish string into numeric cores + prerelease tag. */
function parseVersion(v) {
  const clean = String(v).replace(/^v/, "");
  const dash = clean.indexOf("-");
  const main = dash >= 0 ? clean.slice(0, dash) : clean;
  const pre = dash >= 0 ? clean.slice(dash + 1) : "";
  return {
    nums: main.split(".").map((n) => Number.parseInt(n, 10) || 0),
    pre,
  };
}

/** Compare two versions; prerelease sorts before its release. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

function isLocaText(v) {
  if (typeof v === "string") return v.trim().length > 0;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const vals = Object.values(v);
    return (
      vals.length > 0 && vals.every((x) => typeof x === "string" && x.trim())
    );
  }
  return false;
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim());
}

function isHttpsUrl(v) {
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

/** Validate one source file; returns `{ ok, errors, plugin }`. */
export function validatePlugin(file, data) {
  const errors = [];
  const where = `plugins/${file}`;
  const bad = (msg) => errors.push(`${where}: ${msg}`);

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, errors: [`${where}: not a JSON object`], plugin: null };
  }

  const id = typeof data.id === "string" ? data.id.trim() : "";
  if (!id) bad("missing id");
  else if (!ID_RE.test(id)) bad(`invalid id "${id}"`);

  const repo = typeof data.repo === "string" ? data.repo.trim() : "";
  if (!repo) bad("missing repo");
  else if (!REPO_RE.test(repo))
    bad(`invalid repo "${repo}" (expected owner/name)`);

  if (!isLocaText(data.name)) bad("missing name (string or {locale: string})");
  if (!isLocaText(data.description)) bad("missing description");

  if (data.author !== undefined && typeof data.author !== "string")
    bad("author must be a string");
  if (data.homepage !== undefined && !isHttpsUrl(data.homepage))
    bad("homepage must be an https URL");
  if (data.categories !== undefined && !isStringArray(data.categories))
    bad("categories must be an array of strings");
  if (data.tags !== undefined && !isStringArray(data.tags))
    bad("tags must be an array of strings");
  if (
    data.minAppVersion !== undefined &&
    !SEMVER_RE.test(String(data.minAppVersion))
  )
    bad(`invalid minAppVersion "${data.minAppVersion}"`);

  const rawVersions =
    data.versions &&
    typeof data.versions === "object" &&
    !Array.isArray(data.versions)
      ? data.versions
      : null;
  if (!rawVersions) bad("missing versions object");

  const versions = {};
  if (rawVersions) {
    for (const [ver, info] of Object.entries(rawVersions)) {
      if (!SEMVER_RE.test(ver)) {
        bad(`invalid version key "${ver}"`);
        continue;
      }
      if (!info || typeof info !== "object") {
        bad(`version ${ver} must be an object`);
        continue;
      }
      if (!isHttpsUrl(info.url)) bad(`version ${ver}: url must be https`);
      if (typeof info.sha256 !== "string" || !SHA_RE.test(info.sha256))
        bad(`version ${ver}: sha256 must be 64 lowercase hex`);
      if (
        info.size !== undefined &&
        (!Number.isInteger(info.size) || info.size <= 0)
      )
        bad(`version ${ver}: size must be a positive integer`);
      if (
        info.minAppVersion !== undefined &&
        !SEMVER_RE.test(String(info.minAppVersion))
      )
        bad(`version ${ver}: invalid minAppVersion`);
      versions[ver] = {
        url: info.url,
        sha256:
          typeof info.sha256 === "string"
            ? info.sha256.toLowerCase()
            : info.sha256,
        ...(info.size !== undefined ? { size: info.size } : {}),
        ...(info.minAppVersion !== undefined
          ? { minAppVersion: info.minAppVersion }
          : {}),
      };
    }
  }

  if (errors.length) return { ok: false, errors, plugin: null };

  const sorted = Object.keys(versions).sort(compareVersions);
  const latest = sorted.length ? sorted[sorted.length - 1] : null;
  const ordered = {};
  for (const v of sorted) ordered[v] = versions[v];

  return {
    ok: true,
    errors: [],
    plugin: {
      id,
      latest,
      repo,
      ...(data.author !== undefined ? { author: data.author } : {}),
      ...(data.homepage !== undefined ? { homepage: data.homepage } : {}),
      categories: data.categories ?? [],
      tags: data.tags ?? [],
      ...(data.minAppVersion !== undefined
        ? { minAppVersion: data.minAppVersion }
        : {}),
      name: data.name,
      description: data.description,
      versions: ordered,
    },
  };
}

/** Read + validate every source file (sorted by file name). */
export function loadPlugins() {
  const errors = [];
  const plugins = [];
  const seen = new Map();

  if (!existsSync(PLUGINS_DIR)) {
    return { plugins, errors: ["plugins/ directory is missing"] };
  }

  const files = readdirSync(PLUGINS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  for (const file of files) {
    let data;
    try {
      data = JSON.parse(readFileSync(join(PLUGINS_DIR, file), "utf-8"));
    } catch (err) {
      errors.push(`plugins/${file}: ${err.message}`);
      continue;
    }
    const res = validatePlugin(file, data);
    if (!res.ok) {
      errors.push(...res.errors);
      continue;
    }
    if (seen.has(res.plugin.id)) {
      errors.push(
        `plugins/${file}: duplicate id "${res.plugin.id}" (also in ${seen.get(res.plugin.id)})`,
      );
      continue;
    }
    seen.set(res.plugin.id, file);
    // Plugins with no published version are valid source but are not yet
    // installable; keep them out of the generated index.
    if (!res.plugin.latest) continue;
    plugins.push(res.plugin);
  }

  plugins.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { plugins, errors };
}

export function buildRegistry({ check = false } = {}) {
  const { plugins, errors } = loadPlugins();
  if (errors.length) {
    for (const e of errors) console.error(`✖ ${e}`);
    console.error(
      `\n${errors.length} problem(s) found; registry not generated.`,
    );
    return { ok: false, errors };
  }

  const doc = {
    schema: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    plugins,
  };
  const text = `${JSON.stringify(doc, null, 2)}\n`;

  if (check) {
    const current = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, "utf-8") : "";
    const normalize = (s) => {
      try {
        const o = JSON.parse(s);
        if (o && typeof o === "object") delete o.updatedAt;
        return JSON.stringify(o, null, 2);
      } catch {
        return s.trim();
      }
    };
    if (normalize(current) !== normalize(text)) {
      console.error(
        "✖ registry.json is out of date; run `node scripts/build-registry.mjs`.",
      );
      return { ok: false, errors: ["registry.json out of date"] };
    }
    console.log(`✓ registry.json is up to date (${plugins.length} plugin(s)).`);
    return { ok: true, errors: [], doc };
  }

  writeFileSync(OUT_FILE, text, "utf-8");
  console.log(`✓ wrote registry.json (${plugins.length} plugin(s)).`);
  return { ok: true, errors: [], doc };
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = buildRegistry({ check: process.argv.includes("--check") });
  if (!result.ok) process.exit(1);
}
