"""``python -m call_lagao_voice dev|start|console|download-files``.

Uses the livekit-agents CLI (``cli.run_app``). In 1.8 that CLI is flagged as
deprecated in favour of ``lk agent ...`` but remains fully functional.
"""

from __future__ import annotations

import warnings


def main() -> None:
    from livekit.agents import cli

    from .agent import worker_options

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        cli.run_app(worker_options())


if __name__ == "__main__":
    main()
