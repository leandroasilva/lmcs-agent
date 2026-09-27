import {
  decodeThirdPartyLicenseManifest,
  type ThirdPartyLicenseManifest,
} from "@lmcstools/shared/thirdPartyLicenses";

let cachedManifest: ThirdPartyLicenseManifest | undefined;

export function getMobileThirdPartyLicenses(): ThirdPartyLicenseManifest {
  if (cachedManifest) return cachedManifest;
  const generatedManifest: unknown = require("@lmcstools/mobile-third-party-licenses");
  cachedManifest = decodeThirdPartyLicenseManifest(generatedManifest);
  return cachedManifest;
}
