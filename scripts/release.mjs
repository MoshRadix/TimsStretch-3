#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const nextVersion = process.argv[2];
if (!nextVersion || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(nextVersion)) {
  console.error("Usage: node scripts/release.mjs <semver> (e.g., 1.0.0)");
  process.exit(1);
}

const rootDir = process.cwd();
const pkgPath = path.join(rootDir, "package.json");
const tauriConfPath = path.join(rootDir, "src-tauri", "tauri.conf.json");
const cargoTomlPath = path.join(rootDir, "src-tauri", "Cargo.toml");

// 1. Update package.json
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.version = nextVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");

// 2. Update src-tauri/tauri.conf.json
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, "utf8"));
tauriConf.version = nextVersion;
fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n", "utf8");

// 3. Update src-tauri/Cargo.toml
let cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
cargoToml = cargoToml.replace(
  /^version\s*=\s*"[^"]+"/m,
  `version = "${nextVersion}"`
);
fs.writeFileSync(cargoTomlPath, cargoToml, "utf8");

console.log(`Updated version to v${nextVersion} across package.json, tauri.conf.json, and Cargo.toml.`);

try {
  execSync(`git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml`, {
    stdio: "inherit",
  });
  const staged = execSync(`git status --porcelain`).toString().trim();
  if (staged.length > 0) {
    execSync(`git commit -m "chore(release): v${nextVersion}"`, {
      stdio: "inherit",
    });
  }
  execSync(`git tag -f v${nextVersion}`, { stdio: "inherit" });
  console.log(
    `Created/updated git tag v${nextVersion} at HEAD. Run 'git push origin main && git push origin v${nextVersion} --force' to publish.`
  );
} catch (err) {
  console.log("Version files updated (git commit/tag skipped):", err.message);
}
