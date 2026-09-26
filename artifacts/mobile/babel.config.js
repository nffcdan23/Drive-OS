// babel-preset-expo comes with `expo` (it isn't a direct dependency), and
// pnpm's strict node_modules layout doesn't expose it to this folder. Resolve
// it through `expo` so the version always matches the installed SDK — on
// Windows, macOS, CI and EAS alike.
const presetExpo = require.resolve('babel-preset-expo', { paths: [require.resolve('expo/package.json')] });

module.exports = function (api) {
  api.cache(true);
  return {
    presets: [[presetExpo, { unstable_transformImportMeta: true }]],
  };
};
