---
"@freva-org/browser-python": minor
---

`/ui` entry points for any page: the Python window and code figures (`/ui`, `/ui/bridge`, `/ui/chooser`, `/ui/code`, `/ui/copy`, `/ui/local`, `/ui/framed`, `/ui/code.css`, `/ui/code-figure.html`) and the notebook sheet (`/ui/notebook`, `/ui/notebook/sheet`, `/ui/notebook/embed`, `/ui/notebook.css`).

- `siteWheels: [{ url, sha256 }]` installs wheels a site pins and serves itself, each verified before any is installed and reported in `ready.siteWheels`; the console takes it as a property.
- `registerPythonBlock` returns the block's own `tryPython`, so on a page with several trees a press is bound by the tree that was pressed.
- The console no longer traps the keyboard: Escape with nothing open releases it so Tab moves on, and focus moved to a host control stays there.
