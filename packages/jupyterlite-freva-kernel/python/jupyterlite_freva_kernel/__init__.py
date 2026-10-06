"""The "Freva Python" JupyterLite kernel, as a prebuilt federated extension."""

from importlib.metadata import version

__version__ = version("jupyterlite-freva-kernel")


def _jupyter_labextension_paths():
    return [{"src": "labextension", "dest": "@freva-org/jupyterlite-freva-kernel"}]
