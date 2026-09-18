// The custom elements: the classes, and the only registration in this package.
//
// Importing this needs a DOM - the classes extend `HTMLElement` - and defines
// `<data-inspector>`, `<aggregation-config>` and `<zarr-loading-steps>`. Each define
// is guarded, so importing it twice, directly and through the package root, is fine.

import { AggregationConfigElement } from "./elements/aggregation-config";
import { DataInspectorElement } from "./elements/data-inspector";
import { ZarrLoadingStepsElement } from "./elements/zarr-loading-steps";

for (const [tag, ctor] of [
  ["data-inspector", DataInspectorElement],
  ["aggregation-config", AggregationConfigElement],
  ["zarr-loading-steps", ZarrLoadingStepsElement],
] as const) {
  if (!customElements.get(tag)) customElements.define(tag, ctor);
}

export { DataInspectorElement } from "./elements/data-inspector";
export { AggregationConfigElement } from "./elements/aggregation-config";
export { ZarrLoadingStepsElement } from "./elements/zarr-loading-steps";
