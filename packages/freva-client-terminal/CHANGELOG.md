# @freva-org/freva-client-terminal

## 2608.0.0

### Initial release

New package: a reusable, framework-free terminal window for freva-client commands, extracted from
the Freva Data Browser. Zero third-party runtime dependencies and its own scoped stylesheet.

It owns the window chrome, tabs, drag/resize/minimize, the completion menu, the highlighting
surface, copy feedback, the settings menu and the keyboard-escape contract; everything
domain-specific arrives through generic `TerminalTab` callbacks, so a second freva-client command
can register a tab without importing an application's state.

Two defects are fixed as part of the extraction:

- **Shell-line wrapping.** The prefix and the editable command now share ONE `pre-wrap` inline flow.
  The absolutely-positioned prefix layer, the `text-indent`, the 62%-of-width threshold and the
  `prefix-block` mode are gone - an indent only shifts the first line, so once the prefix itself
  wrapped, the painted prompt and the typed text disagreed.
- **The minimized settings menu.** A docked window is pinned to the bottom of its container, so its
  menu now opens above the title bar and is clamped within the container; the colour swatches,
  opacity control and host menu items stay visible and clickable while minimized.

Geometry is container-relative throughout, so the window stays inside its own component when a host
relocates the mount into a clipped or transformed container.

This is the terminal that already shipped inside `@freva-org/databrowser`, now published on its
own. The corrections made while extracting it - shell-line wrapping, the editing engine, the
minimized settings menu, the block cursor and the per-tab colours of immutable text - are described
per-defect in that package's changelog for the same release.
