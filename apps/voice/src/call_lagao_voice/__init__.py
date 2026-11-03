"""Call Lagao voice worker (LiveKit Agents)."""

from ._winfix import apply as _apply_winfix

# Must run before anything imports onnxruntime (livekit-agents does on import).
_apply_winfix()

__version__ = "0.1.0"
