"""SSRF guard for custom tool URLs.

Custom tools are configured by any org member and fetched by the worker, so a
tool URL must not reach the worker's own network: loopback, private ranges,
link-local (cloud metadata at 169.254.169.254), CGNAT, multicast, reserved.

Set ``ALLOW_PRIVATE_URLS=true`` to turn the guard off, e.g. for local
development against ``http://localhost`` tools.
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
import socket
from urllib.parse import urlsplit


class BlockedUrlError(ValueError):
    """The URL points at a non-public address."""


def private_urls_allowed() -> bool:
    return os.environ.get("ALLOW_PRIVATE_URLS", "").strip().lower() in {"1", "true", "yes"}


def is_public_ip(ip: str) -> bool:
    addr = ipaddress.ip_address(ip.split("%", 1)[0])
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return addr.is_global and not addr.is_multicast


async def ensure_public_url(url: str) -> None:
    """Raise :class:`BlockedUrlError` unless every address ``url`` resolves to is public."""
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        raise BlockedUrlError("only http(s) URLs are allowed")
    host = parts.hostname
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        ipaddress.ip_address(host.split("%", 1)[0])
        addrs = [host]
    except ValueError:
        try:
            infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except socket.gaierror as e:
            raise BlockedUrlError(f"cannot resolve {host}") from e
        addrs = [str(info[4][0]) for info in infos]
    if not addrs or not all(is_public_ip(a) for a in addrs):
        raise BlockedUrlError(f"{host} resolves to a private or reserved address")
