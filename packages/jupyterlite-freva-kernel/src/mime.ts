// The mime-renderer extension: see `renderers.ts`.
import type { IRenderMime } from "@jupyterlab/rendermime-interfaces";

import { rendererFactory } from "./renderers.js";

const extension: IRenderMime.IExtension = {
  id: "@freva-org/jupyterlite-freva-kernel:renderers",
  description: "Sanitised HTML, SVG and PNG output, and the Freva notice card.",
  rendererFactory,
  rank: 0,
  dataType: "string",
};

export default extension;
