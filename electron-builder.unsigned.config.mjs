import fs from "node:fs";

const packageJson = JSON.parse(fs.readFileSync(new URL("package.json", import.meta.url), "utf8"));
const baseBuild = packageJson.build;
const { entitlements, entitlementsInherit, hardenedRuntime, identity, notarize, ...unsignedMacBase } = baseBuild.mac;

export default {
  ...baseBuild,
  mac: {
    ...unsignedMacBase,
    gatekeeperAssess: false,
    hardenedRuntime: false,
    identity: "-",
    notarize: false,
  },
};
