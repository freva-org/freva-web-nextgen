// The package root: the whole API, and the custom elements registered.
//
// The bare import is what registers them, and it has to be a statement rather than
// a consequence of the re-export below: `export *` is shakeable, so a bundler asked
// for one named function would drop the registration and a consumer's `<data-inspector>`
// would never be defined. `sideEffects` in package.json names this entry for the
// same reason.
//
// `./core` is the data side with no DOM requirement; `./elements` is the element
// classes and their registration.

import "./elements";

export * from "./core";
export * from "./elements";
