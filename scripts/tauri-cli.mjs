#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const args = process.argv.slice(2);
const keyPath = path.resolve("src-tauri", "tauri-updater.key");
const signCmdPath = path.resolve("src-tauri", "sign.cmd");

let keyPassword = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || "";
if (!keyPassword && fs.existsSync(signCmdPath)) {
  const match = fs
    .readFileSync(signCmdPath, "utf8")
    .match(/set\s+"PFX_PASS=([^"]+)"/);
  if (match) keyPassword = match[1];
}

const env = {
  ...process.env,
  ...(fs.existsSync(keyPath) || process.env.TAURI_SIGNING_PRIVATE_KEY
    ? {
        TAURI_SIGNING_PRIVATE_KEY:
          process.env.TAURI_SIGNING_PRIVATE_KEY || keyPath,
      }
    : {}),
  ...(keyPassword ? { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: keyPassword } : {}),
};

const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(npxCmd, ["tauri", ...args], {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
