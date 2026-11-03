"""Windows-only workaround for an outdated system MSVC runtime.

onnxruntime >= 1.2x (pulled in by livekit-agents / silero / turn-detector) is built
with MSVC 14.40+ and crashes with an *access violation* on import when the
system ``msvcp140.dll`` is older (e.g. 14.28). The proper fix is installing the
current "Microsoft Visual C++ Redistributable (x64)":
https://aka.ms/vs/17/release/vc_redist.x64.exe

Until then, this preloads a newer ``msvcp140.dll`` that some wheels already
bundle (numpy ships 14.40 in ``numpy.libs``). It is copied into the venv as
``msvcp140.dll`` so that later loads by module name reuse it. No-op on other
platforms, when the system runtime is new enough, or when
``CALL_LAGAO_NO_VCRT_SHIM=1``.
"""

from __future__ import annotations

import ctypes
import os
import shutil
import sys
from pathlib import Path

MIN_VERSION = (14, 40)


def _file_version(path: str) -> tuple[int, int, int, int] | None:
    try:
        ver = ctypes.windll.version  # type: ignore[attr-defined]
        size = ver.GetFileVersionInfoSizeW(path, None)
        if not size:
            return None
        buf = ctypes.create_string_buffer(size)
        if not ver.GetFileVersionInfoW(path, 0, size, buf):
            return None
        ptr = ctypes.c_void_p()
        length = ctypes.c_uint()
        if not ver.VerQueryValueW(buf, "\\", ctypes.byref(ptr), ctypes.byref(length)):
            return None
        # VS_FIXEDFILEINFO: dwSignature, dwStrucVersion, dwFileVersionMS, dwFileVersionLS, ...
        info = ctypes.cast(ptr, ctypes.POINTER(ctypes.c_uint32 * 4)).contents
        ms, ls = info[2], info[3]
        return (ms >> 16, ms & 0xFFFF, ls >> 16, ls & 0xFFFF)
    except Exception:
        return None


def apply() -> None:
    if sys.platform != "win32" or os.environ.get("CALL_LAGAO_NO_VCRT_SHIM") == "1":
        return
    system_dll = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "msvcp140.dll")
    system_ver = _file_version(system_dll)
    if system_ver is not None and system_ver[:2] >= MIN_VERSION:
        return

    best: tuple[tuple[int, int, int, int], Path] | None = None
    for site in map(Path, sys.path):
        if not site.is_dir() or not site.name.endswith("site-packages"):
            continue
        for cand in site.glob("*.libs/msvcp140*.dll"):
            if cand.name.lower().startswith("msvcp140_"):
                continue  # msvcp140_1/_2 etc. are different libraries
            v = _file_version(str(cand))
            if v is not None and v[:2] >= MIN_VERSION and (best is None or v > best[0]):
                best = (v, cand)
    if best is None:
        return

    target_dir = Path(sys.prefix) / "call-lagao-vcrt"
    target = target_dir / "msvcp140.dll"
    try:
        if not target.exists() or _file_version(str(target)) != best[0]:
            target_dir.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(best[1], target)
        ctypes.WinDLL(str(target))
    except OSError:
        pass
