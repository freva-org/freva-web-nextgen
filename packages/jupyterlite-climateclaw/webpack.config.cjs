// Merged into @jupyter/builder's configuration: ship the static login callback page beside the
// extension (labextension/static/), so a JupyterLab or JupyterLite deployment has a same-origin
// callback without another deployment step. The animated logo of the chat's first page goes there
// too, fetched only when that page shows, and DKRZ's running logo, fetched only while a cell runs.
const path = require("path");
const { CopyRspackPlugin } = require("@rspack/core");

module.exports = {
  plugins: [
    new CopyRspackPlugin({
      patterns: [
        { from: path.join(__dirname, "callback"), to: "." },
        { from: path.join(__dirname, "style", "logo", "climateclaw-animated.gif"), to: "." },
        { from: path.join(__dirname, "style", "logo", "dkrz-running.webp"), to: "." },
      ],
    }),
  ],
};
