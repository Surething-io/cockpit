// Ad-hoc sign the macOS bundle (`codesign --sign -`).
//
// Free and local; it is not a Developer ID signature and does not satisfy
// Gatekeeper for downloaded files. It is still required: Apple Silicon refuses
// to execute arm64 code with no valid signature, and electron-builder's
// renaming and Info.plist edits invalidate the one Electron ships with, which
// surfaces to users as "OpenCockpit is damaged and can't be opened".
const { execFileSync } = require('child_process');
const { join } = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
