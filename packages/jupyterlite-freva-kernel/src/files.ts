// Notebooks as files. One authority: Lite's contents store holds every notebook, and nothing syncs
// it to Python's `/workspace` behind the visitor's back.
//
//  - An uploaded `.ipynb` is checked (nbformat 4.x, bounded, well-formed cells) before it is
//    stored, and refused with the reason otherwise. Opening a notebook never runs it.
//  - "Save a Copy to Python's /workspace" is the one explicit way a notebook reaches Python's
//    files.

import type { JupyterFrontEnd, JupyterFrontEndPlugin } from "@jupyterlab/application";
import { Dialog, showDialog, showErrorMessage } from "@jupyterlab/apputils";
import { IKernelClient } from "@jupyterlite/services";
import { INotebookTracker } from "@jupyterlab/notebook";
import { IMainMenu } from "@jupyterlab/mainmenu";

import { FrevaKernel } from "./kernel.js";

export const SAVE_TO_WORKSPACE = "freva:save-notebook-to-workspace";

export { guardNotebookUploads } from "./upload-guard.js";
import { guardNotebookUploads } from "./upload-guard.js";

export const filesPlugin: JupyterFrontEndPlugin<void> = {
  id: "@freva-org/jupyterlite-freva-kernel:files",
  description: "Checks uploaded notebooks; saves a notebook copy to Python's /workspace.",
  autoStart: true,
  optional: [INotebookTracker, IKernelClient, IMainMenu],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker | null,
    client: IKernelClient | null,
    menu: IMainMenu | null,
  ): void => {
    guardNotebookUploads(app.serviceManager.contents);
    if (!tracker || !client) return;
    app.commands.addCommand(SAVE_TO_WORKSPACE, {
      label: "Save a Copy to Python's /workspace",
      caption: "Write this notebook into Freva Python's /workspace (Python starts if it has not).",
      isEnabled: () => !!tracker.currentWidget?.sessionContext.session?.kernel,
      execute: async () => {
        const panel = tracker.currentWidget;
        const id = panel?.sessionContext.session?.kernel?.id;
        const kernel = id ? await client.getModel(id) : undefined;
        if (!panel || !(kernel instanceof FrevaKernel)) {
          await showErrorMessage("Not saved", "This notebook is not running Freva Python.");
          return;
        }
        const name = panel.context.path.split("/").pop() ?? "notebook.ipynb";
        const json = JSON.stringify(panel.context.model.toJSON(), null, 1);
        // Through the kernel: it starts (or wakes) Python first, with its slot and kept files.
        const write = (overwrite: boolean) => {
          const blob = new Blob([json]);
          return kernel.writeWorkspaceFile(name, blob, { size: blob.size, overwrite });
        };
        try {
          await write(false);
        } catch (error) {
          const exists = error instanceof Error && error.message.includes("already exists");
          if (!exists) {
            await showErrorMessage(
              "Not saved",
              error instanceof Error ? error.message : String(error),
            );
            return;
          }
          const answer = await showDialog({
            title: "Replace the copy in /workspace?",
            body: `/workspace/${name} already exists.`,
            buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: "Replace" })],
          });
          if (!answer.button.accept) return;
          try {
            await write(true);
          } catch (again) {
            await showErrorMessage(
              "Not saved",
              again instanceof Error ? again.message : String(again),
            );
          }
        }
      },
    });
    menu?.fileMenu.addGroup([{ command: SAVE_TO_WORKSPACE }], 40);
  },
};
