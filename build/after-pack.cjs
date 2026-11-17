// electron-builder afterPack hook.
//
// node-pty starts every shell on macOS through a small `spawn-helper` binary
// that sits next to its prebuilt pty.node. node-pty 1.1.0 publishes that file
// without the executable bit, so a packaged app fails to open any terminal
// ("posix_spawnp failed"). Set the bit on the unpacked copy inside the bundle.
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const prebuilds = path.join(
    context.appOutDir, appName, 'Contents', 'Resources',
    'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds',
  );
  const helpers = fs.existsSync(prebuilds)
    ? fs.readdirSync(prebuilds)
      .filter((dir) => dir.startsWith('darwin-'))
      .map((dir) => path.join(prebuilds, dir, 'spawn-helper'))
      .filter((file) => fs.existsSync(file))
    : [];

  if (helpers.length === 0) {
    throw new Error(`after-pack: no node-pty spawn-helper under ${prebuilds}`);
  }
  for (const file of helpers) {
    fs.chmodSync(file, 0o755);
    console.log(`after-pack: made executable ${path.relative(context.appOutDir, file)}`);
  }
};
