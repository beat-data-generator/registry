#!/usr/bin/env node
/**
 * Pull model: scan the GitHub Releases of every plugin repo listed in
 * `plugins/*.json`, then add/refresh the `versions` map with the artifact URL,
 * size and SHA-256 digest. Metadata (name / description / categories / ...)
 * stays hand-curated; only `versions` is automated.
 *
 * Requires a token with `contents: read` over the plugin repos (the workflow
 * passes the default GITHUB_TOKEN). Artifact naming convention: `plugin.zip`.
 *
 * Usage:
 *   GH_TOKEN=... node scripts/sync-releases.mjs           # write changes
 *   GH_TOKEN=... node scripts/sync-releases.mjs --check   # fail if out of date
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry, compareVersions } from "./build-registry.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_DIR = join(ROOT, "plugins");

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const API = "https://api.github.com";
const ASSET_NAME = process.env.BDG_ASSET_NAME || "plugin.zip";
const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const CHECK = process.argv.includes("--check");
const PRUNE = process.argv.includes("--prune");

function slug(repo) {
  return repo.split("/")[1] ?? repo;
}

async function gh(path) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "bdg-registry-sync",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

/** sha256 for a release asset, preferring the API digest. */
async function sha256ForAsset(asset) {
  const digest = typeof asset.digest === "string" ? asset.digest : "";
  const m = /^sha256:([0-9a-f]{64})$/i.exec(digest);
  if (m) return m[1].toLowerCase();

  const res = await fetch(asset.browser_download_url, {
    headers: { "user-agent": "bdg-registry-sync" },
  });
  if (!res.ok) throw new Error(`download ${asset.name} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return createHash("sha256").update(buf).digest("hex");
}

async function versionsForRepo(repo) {
  const releases = await gh(`/repos/${repo}/releases?per_page=100`);
  const out = {};
  for (const rel of releases) {
    if (rel.draft) continue;
    const tag = rel.tag_name ?? "";
    if (!SEMVER_RE.test(tag)) continue;
    const version = tag.replace(/^v/, "");
    const asset = (rel.assets ?? []).find(
      (a) => a.name?.toLowerCase() === ASSET_NAME.toLowerCase(),
    );
    if (!asset) {
      console.warn(`  ! ${repo} ${tag}: no "${ASSET_NAME}" asset, skipped`);
      continue;
    }
    const sha256 = await sha256ForAsset(asset);
    out[version] = {
      url: asset.browser_download_url,
      sha256,
      ...(asset.size ? { size: asset.size } : {}),
    };
  }
  return out;
}

async function main() {
  if (!TOKEN) {
    console.error("✖ GH_TOKEN / GITHUB_TOKEN is required.");
    process.exit(1);
  }

  const files = readdirSync(PLUGINS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  let changed = 0;
  for (const file of files) {
    const path = join(PLUGINS_DIR, file);
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (!data.repo) continue;

    let versions;
    try {
      versions = await versionsForRepo(data.repo);
    } catch (err) {
      console.warn(`  ! ${data.repo}: ${err.message}`);
      continue;
    }

    const before = JSON.stringify(data.versions ?? {});
    const current = data.versions ?? {};
    // By default keep historical versions; --prune drops anything whose
    // release no longer exists.
    const next = PRUNE ? { ...versions } : { ...current, ...versions };

    const ordered = {};
    for (const v of Object.keys(next).sort(compareVersions))
      ordered[v] = next[v];

    if (JSON.stringify(ordered) !== before) {
      if (CHECK) {
        console.error(
          `✖ plugins/${file}: versions out of date (${data.repo}).`,
        );
        process.exitCode = 1;
        continue;
      }
      data.versions = ordered;
      writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
      const added = Object.keys(ordered).filter((v) => !(v in current));
      console.log(
        `✓ plugins/${file}: ${Object.keys(ordered).length} version(s)` +
          (added.length ? ` (+${added.join(", ")})` : " (refreshed)"),
      );
      changed++;
    } else {
      console.log(`· plugins/${file}: up to date`);
    }
  }

  if (CHECK) {
    if (process.exitCode)
      console.error("✖ run `node scripts/sync-releases.mjs` and commit.");
    else console.log("✓ release data is up to date.");
    return;
  }

  const result = buildRegistry();
  if (!result.ok) process.exit(1);
  console.log(changed ? `Changed ${changed} plugin file(s).` : "No changes.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
