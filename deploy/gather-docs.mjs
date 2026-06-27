#!/usr/bin/env node
/**
 * gather-docs — stage the CURATED, LOCAL-ONLY repo docs into deploy/code-docs/ so
 * they can be COPY'd into the Docker image.
 *
 * Why: DOMAIN.md / CLAUDE.md / DECISIONS.md (and root SERVICES.md / FINDINGS.md) are
 * often git-IGNORED — they live only on this machine and are NOT in any git repo, so a
 * `git clone` in the image would never bring them. They are also the highest-value,
 * lowest-churn input for incident investigation. We bundle them; raw source code is read
 * fresh on demand from the mounted source volume, so it is NOT bundled.
 *
 * Usage:
 *   node deploy/gather-docs.mjs <srcRoot> [srcRoot ...]
 * Pass your own source roots (e.g. ~/code/team-a ~/code/shared). Each root is copied under
 * deploy/code-docs/<rootBasename>/<relpath>, preserving the tree. Set COPILOT_CODE_DIRS
 * in the image to /srv/code/<rootBasename> (see deploy/Dockerfile).
 */
import { readdirSync, statSync, mkdirSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { join, basename, dirname, relative, resolve } from "node:path";

const DOC_NAMES = new Set([
  "DOMAIN.md",
  "CLAUDE.md",
  "DECISIONS.md",
  "SERVICES.md",
  "FINDINGS.md",
]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", "target", "build", "dist", "out",
  ".gradle", ".idea", "vendor", "Library", "Temp", "bin", "obj",
]);

const roots = process.argv.slice(2);
if (roots.length === 0) {
  // Pass your own source roots as CLI args, or set them here.
  roots.push("./source");
}

const outBase = resolve(new URL("./code-docs", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
if (existsSync(outBase)) rmSync(outBase, { recursive: true, force: true });

let copied = 0;
let bytes = 0;

function walk(dir, onFile) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), onFile);
    } else if (e.isFile() && DOC_NAMES.has(e.name)) {
      onFile(join(dir, e.name));
    }
  }
}

for (const root of roots) {
  const absRoot = resolve(root);
  if (!existsSync(absRoot)) {
    console.warn(`  ! skip (missing): ${absRoot}`);
    continue;
  }
  const label = basename(absRoot);
  walk(absRoot, (file) => {
    const rel = relative(absRoot, file);
    const dest = join(outBase, label, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(file, dest);
    copied++;
    bytes += statSync(file).size;
  });
  console.log(`  ${label}: gathered docs from ${absRoot}`);
}

console.log(
  `\ngather-docs: ${copied} file(s), ${(bytes / 1024).toFixed(0)} KB → ${outBase}`,
);
if (copied === 0) {
  console.error("gather-docs: no docs found — is the source checked out locally?");
  process.exit(1);
}
