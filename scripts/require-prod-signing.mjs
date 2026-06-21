import { execFileSync } from "node:child_process";

const targetArg = process.argv[2] || "all";
const targets =
  targetArg === "all" ? ["mac", "win"] : targetArg.split(",").map((target) => target.trim()).filter(Boolean);

const env = process.env;
const read = (name) => env[name]?.trim();
const has = (name) => Boolean(read(name));
const missing = [];
const notes = [];

function hasDeveloperIdIdentity() {
  if (process.platform !== "darwin") {
    return false;
  }

  try {
    const output = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return /Developer ID Application/i.test(output);
  } catch {
    return false;
  }
}

function requireAny(label, checks) {
  if (!checks.some((check) => check.ok)) {
    missing.push(`${label}: ${checks.map((check) => check.description).join(" OR ")}`);
  }
}

function checkMac() {
  if (process.platform !== "darwin") {
    missing.push("macOS signing/notarization must run on macOS with Xcode command line tools");
  }

  requireAny("macOS code signing identity", [
    {
      ok: has("CSC_LINK") && has("CSC_KEY_PASSWORD"),
      description: "CSC_LINK + CSC_KEY_PASSWORD",
    },
    {
      ok: has("CSC_NAME"),
      description: "CSC_NAME for an installed Developer ID Application certificate",
    },
    {
      ok: hasDeveloperIdIdentity(),
      description: "an installed Developer ID Application identity in the keychain",
    },
  ]);

  requireAny("Apple notarization credentials", [
    {
      ok: has("APPLE_API_KEY") && has("APPLE_API_KEY_ID") && has("APPLE_API_ISSUER"),
      description: "APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER",
    },
    {
      ok: has("APPLE_ID") && has("APPLE_APP_SPECIFIC_PASSWORD") && has("APPLE_TEAM_ID"),
      description: "APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID",
    },
    {
      ok: has("APPLE_KEYCHAIN_PROFILE"),
      description: "APPLE_KEYCHAIN_PROFILE, optionally APPLE_KEYCHAIN",
    },
  ]);
}

function checkWin() {
  const hasPfx = (has("WIN_CSC_LINK") || has("CSC_LINK")) && (has("WIN_CSC_KEY_PASSWORD") || has("CSC_KEY_PASSWORD"));
  const hasHardwareToken = process.platform === "win32" && (has("WIN_CSC_SUBJECT_NAME") || has("WIN_CSC_SHA1"));
  const hasAzureTrustedSigning =
    has("AZURE_TENANT_ID") &&
    has("AZURE_CLIENT_ID") &&
    has("AZURE_CLIENT_SECRET") &&
    has("AZURE_TRUSTED_SIGNING_ENDPOINT") &&
    has("AZURE_CODE_SIGNING_ACCOUNT_NAME") &&
    has("AZURE_CERTIFICATE_PROFILE_NAME") &&
    has("AZURE_PUBLISHER_NAME");

  requireAny("Windows code signing", [
    {
      ok: hasPfx,
      description: "WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD, or CSC_LINK + CSC_KEY_PASSWORD",
    },
    {
      ok: hasHardwareToken,
      description: "WIN_CSC_SUBJECT_NAME or WIN_CSC_SHA1 on Windows with the certificate in the certificate store",
    },
    {
      ok: hasAzureTrustedSigning,
      description:
        "AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET + AZURE_TRUSTED_SIGNING_ENDPOINT + AZURE_CODE_SIGNING_ACCOUNT_NAME + AZURE_CERTIFICATE_PROFILE_NAME + AZURE_PUBLISHER_NAME",
    },
  ]);

  if (has("WIN_CSC_SUBJECT_NAME") && !has("WIN_PUBLISHER_NAME")) {
    notes.push("WIN_CSC_SUBJECT_NAME is set; WIN_PUBLISHER_NAME is recommended so update signature verification uses the exact publisher.");
  }
}

for (const target of targets) {
  if (target === "mac") {
    checkMac();
  } else if (target === "win") {
    checkWin();
  } else {
    missing.push(`unknown signing target: ${target}`);
  }
}

if (missing.length > 0) {
  console.error("Production signing is not configured. Refusing to create a prod build.\n");
  for (const item of missing) {
    console.error(`- ${item}`);
  }
  if (notes.length > 0) {
    console.error("\nNotes:");
    for (const note of notes) {
      console.error(`- ${note}`);
    }
  }
  process.exit(1);
}

for (const note of notes) {
  console.warn(`Signing note: ${note}`);
}

console.log(`Production signing prerequisites look configured for: ${targets.join(", ")}`);
