import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const releaseDir = path.resolve("release");
const productName = "ChunkKeeper";
const failures = [];
const checks = [];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const error = new Error(`${command} exited with status ${result.status}`);
    error.stdout = result.stdout || "";
    error.stderr = result.stderr || "";
    throw error;
  }

  return `${result.stdout || ""}${result.stderr || ""}`;
}

function exists(filePath) {
  return fs.existsSync(filePath);
}

function findFirst(dir, predicate) {
  if (!exists(dir)) {
    return null;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (predicate(fullPath, entry)) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const match = findFirst(fullPath, predicate);
      if (match) {
        return match;
      }
    }
  }
  return null;
}

function decodeXml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function attachDmg(dmgPath) {
  const plist = run("hdiutil", ["attach", "-nobrowse", "-readonly", "-plist", dmgPath]);
  const mountMatch = plist.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/);
  const deviceMatch = plist.match(/<key>dev-entry<\/key>\s*<string>([^<]+)<\/string>/);

  if (!mountMatch || !deviceMatch) {
    throw new Error(`could not find mount point for ${dmgPath}`);
  }

  return {
    mountPoint: decodeXml(mountMatch[1]),
    device: decodeXml(deviceMatch[1]),
  };
}

function detachDmg(device) {
  try {
    run("hdiutil", ["detach", device]);
  } catch (error) {
    failures.push(`could not detach ${device}: ${error.stderr || error.message}`);
  }
}

function verifyMac() {
  if (process.platform !== "darwin") {
    checks.push("macOS signing verification skipped: not running on macOS");
    return;
  }

  let mountedDevice = null;
  let appPath = findFirst(releaseDir, (fullPath, entry) => entry.isDirectory() && entry.name === `${productName}.app`);

  if (!appPath) {
    const dmgPath = findFirst(releaseDir, (fullPath, entry) => entry.isFile() && /\.dmg$/i.test(entry.name));
    if (!dmgPath) {
      checks.push("macOS app verification skipped: release app bundle or dmg not found");
      return;
    }

    try {
      const mounted = attachDmg(dmgPath);
      mountedDevice = mounted.device;
      appPath = path.join(mounted.mountPoint, `${productName}.app`);
      checks.push(`mounted dmg for app verification: ${dmgPath}`);
    } catch (error) {
      failures.push(`could not mount dmg for macOS verification: ${error.stderr || error.message}`);
      return;
    }
  }

  try {
    try {
      run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
      const details = run("codesign", ["-dv", "--verbose=4", appPath], { stdio: ["ignore", "pipe", "pipe"] });
      const combined = details.toString();
      if (!/Developer ID Application/i.test(combined)) {
        failures.push(`macOS app is signed, but not with a Developer ID Application identity: ${appPath}`);
      }
      checks.push(`codesign verified: ${appPath}`);
    } catch (error) {
      failures.push(`codesign verification failed for ${appPath}: ${error.stderr || error.message}`);
    }

    try {
      run("spctl", ["--assess", "--verbose=4", "--type", "exec", appPath]);
      checks.push(`Gatekeeper accepted app bundle: ${appPath}`);
    } catch (error) {
      failures.push(`Gatekeeper rejected app bundle ${appPath}: ${error.stderr || error.message}`);
    }

    try {
      run("xcrun", ["stapler", "validate", appPath]);
      checks.push(`notarization staple validated: ${appPath}`);
    } catch (error) {
      failures.push(`notarization staple validation failed for ${appPath}: ${error.stderr || error.message}`);
    }
  } finally {
    if (mountedDevice) {
      detachDmg(mountedDevice);
    }
  }
}

function verifyWin() {
  const exePath = findFirst(releaseDir, (fullPath, entry) => entry.isFile() && /Setup-.*\.exe$/i.test(entry.name));
  if (!exePath) {
    checks.push("Windows installer verification skipped: setup exe not found");
    return;
  }

  if (process.platform === "win32") {
    try {
      const output = run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-AuthenticodeSignature -LiteralPath ${JSON.stringify(exePath)}).Status`,
      ]);
      if (!/Valid/i.test(output)) {
        failures.push(`Windows Authenticode status is not Valid for ${exePath}: ${output.trim()}`);
      }
      checks.push(`Authenticode signature valid: ${exePath}`);
      return;
    } catch (error) {
      failures.push(`Windows Authenticode verification failed for ${exePath}: ${error.stderr || error.message}`);
      return;
    }
  }

  try {
    run("osslsigncode", ["verify", "-in", exePath]);
    checks.push(`osslsigncode verified: ${exePath}`);
  } catch (error) {
    failures.push(
      `Windows signature could not be verified for ${exePath}. Install osslsigncode on macOS/Linux or run this script on Windows. ${error.stderr || error.message}`,
    );
  }
}

verifyMac();
verifyWin();

for (const check of checks) {
  console.log(check);
}

if (failures.length > 0) {
  console.error("\nRelease signing verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Release signing verification completed.");
