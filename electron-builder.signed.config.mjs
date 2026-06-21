import fs from "node:fs";

const packageJson = JSON.parse(fs.readFileSync(new URL("package.json", import.meta.url), "utf8"));
const baseBuild = packageJson.build;

const env = process.env;
const read = (name) => env[name]?.trim();

const isAzureTrustedSigningConfigured = Boolean(
  read("AZURE_TENANT_ID") &&
    read("AZURE_CLIENT_ID") &&
    read("AZURE_CLIENT_SECRET") &&
    read("AZURE_TRUSTED_SIGNING_ENDPOINT") &&
    read("AZURE_CODE_SIGNING_ACCOUNT_NAME") &&
    read("AZURE_CERTIFICATE_PROFILE_NAME") &&
    read("AZURE_PUBLISHER_NAME"),
);

const win = {
  ...baseBuild.win,
};

if (isAzureTrustedSigningConfigured) {
  win.azureSignOptions = {
    endpoint: read("AZURE_TRUSTED_SIGNING_ENDPOINT"),
    codeSigningAccountName: read("AZURE_CODE_SIGNING_ACCOUNT_NAME"),
    certificateProfileName: read("AZURE_CERTIFICATE_PROFILE_NAME"),
    publisherName: read("AZURE_PUBLISHER_NAME"),
    timestampRfc3161: read("WIN_TIMESTAMP_SERVER") || "http://timestamp.acs.microsoft.com",
  };
} else {
  const signtoolOptions = {
    signingHashAlgorithms: ["sha256"],
    rfc3161TimeStampServer: read("WIN_TIMESTAMP_SERVER") || "http://timestamp.digicert.com",
  };

  if (read("WIN_CSC_SUBJECT_NAME")) {
    signtoolOptions.certificateSubjectName = read("WIN_CSC_SUBJECT_NAME");
  }

  if (read("WIN_CSC_SHA1")) {
    signtoolOptions.certificateSha1 = read("WIN_CSC_SHA1");
  }

  if (read("WIN_PUBLISHER_NAME")) {
    signtoolOptions.publisherName = read("WIN_PUBLISHER_NAME");
  }

  win.signtoolOptions = signtoolOptions;
}

export default {
  ...baseBuild,
  forceCodeSigning: true,
  mac: {
    ...baseBuild.mac,
    hardenedRuntime: true,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    notarize: true,
  },
  win,
};
