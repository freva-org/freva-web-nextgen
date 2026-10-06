// Merged into @jupyter/builder's configuration. Two jobs:
//  1. Do NOT bundle the engine's Worker. It is an ES-module worker graph; webpack-style bundling
//     would rewrite it into a classic chunk. The kernel passes `workerURL` instead.
//  2. Ship the engine's own `dist/` modules as static files beside the extension, so that URL
//     resolves on the playground origin with no other deployment step.
const path = require("path");
const { CopyRspackPlugin } = require("@rspack/core");

const engine = path.dirname(require.resolve("@freva-org/browser-python/package.json"));

module.exports = {
  module: { parser: { javascript: { worker: false, url: false } } },
  plugins: [
    new CopyRspackPlugin({
      patterns: [
        {
          from: path.join(engine, "dist"),
          to: "browser-python",
          globOptions: {
            ignore: [
              "**/console/**",
              "**/embed/**",
              "**/display/**",
              "**/session/**",
              "**/*.map",
              "**/*.d.ts",
              "**/*.d.ts.map",
              "**/*.css",
              "**/.build-stamp*",
            ],
          },
        },
      ],
    }),
  ],
};
