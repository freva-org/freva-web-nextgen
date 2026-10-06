"""ClimateClaw (Freva) for JupyterLite and JupyterLab, as a prebuilt federated extension."""

from importlib.metadata import version

__version__ = version("jupyterlite-climateclaw")


def _jupyter_labextension_paths():
    return [{"src": "labextension", "dest": "@freva-org/jupyterlite-climateclaw"}]
