"""Character-set round-trip oracle.

A stored value must come back code point for code point: a byte-truncating column, a
stripped 4-byte character, or a silent NFC/NFD normalization is RED. A length limit counts
characters (code points), never UTF-8 bytes. A RED raises AssertionError (product); every
misuse raises TypeError (automation).
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from .identity import IDENTITY_VECTORS


@dataclass(frozen=True)
class I18nVector:
    label: str
    value: str


#: The vectors i18n_charset round-trips, in order.
I18N_VECTORS: tuple[I18nVector, ...] = (
    I18nVector("diacritics.0", IDENTITY_VECTORS.diacritics[0]),
    I18nVector("diacritics.1", IDENTITY_VECTORS.diacritics[1]),
    I18nVector("emoji", IDENTITY_VECTORS.unicode_edge.emoji),
    I18nVector("nfd", IDENTITY_VECTORS.unicode_edge.nfd),
)

# ż: one code point, one UTF-16 unit, two UTF-8 bytes, so every sane character count agrees
# and only a byte count differs.
_MULTI_BYTE = "ż"
_MAX_LISTED_CODE_POINTS = 24


def i18n_charset(
    *,
    submit: Callable[[str], bool],
    read_back: Callable[[], str],
    max_length: int | None = None,
) -> list[str]:
    """Round-trip every I18N_VECTORS entry and return the labels checked.

    ``submit(value)`` returns True when the product accepted the value, and ``read_back()``
    returns the value it stored (a closure over the created id or the profile read works).
    Each vector must be accepted and read back with exactly the same code points. With
    ``max_length``, max_length multi-byte characters must be accepted and read back intact,
    and max_length + 1 must be refused.
    """
    if not callable(submit) or not callable(read_back):
        raise TypeError("i18n_charset: submit and read_back must be callables")
    if max_length is not None and (isinstance(max_length, bool) or not isinstance(max_length, int) or max_length < 1):
        raise TypeError(f"i18n_charset: max_length must be a positive integer, got {max_length!r}")
    vectors = list(I18N_VECTORS)
    if max_length is not None:
        vectors.append(I18nVector(f"max-length.{max_length}", _MULTI_BYTE * max_length))
    failures: list[str] = []
    for vector in vectors:
        if not _accepted(submit, vector.value):
            failures.append(f"{vector.label}: refused {_describe(vector.value)}")
            continue
        stored = read_back()
        if not isinstance(stored, str):
            raise TypeError("i18n_charset: read_back must return the stored string")
        if _code_points(stored) != _code_points(vector.value):
            failures.append(f"{vector.label}: sent {_describe(vector.value)}, read back {_describe(stored)}")
    checked = [vector.label for vector in vectors]
    if max_length is not None:
        over = max_length + 1
        if _accepted(submit, _MULTI_BYTE * over):
            failures.append(f"max-length.{over}: accepted max_length + 1 = {over} characters")
        checked.append(f"max-length.{over}")
    if failures:
        raise AssertionError("i18n_charset: the value did not round-trip character for character\n" + "\n".join(failures))
    return checked


def _accepted(submit: Callable[[str], bool], value: str) -> bool:
    result = submit(value)
    if not isinstance(result, bool):
        raise TypeError("i18n_charset: submit must return True (accepted) or False (refused)")
    return result


def _code_points(value: str) -> list[str]:
    return [f"U+{ord(char):04X}" for char in value]


def _describe(value: str) -> str:
    """``5 code points (11 UTF-8 bytes): U+017B U+00F3 …``, never the raw value."""
    points = _code_points(value)
    listed = " ".join(points[:_MAX_LISTED_CODE_POINTS])
    more = " …" if len(points) > _MAX_LISTED_CODE_POINTS else ""
    # surrogatepass: a lone surrogate read back from a broken store still gets a byte count.
    return f"{len(points)} code points ({len(value.encode('utf-8', 'surrogatepass'))} UTF-8 bytes): {listed}{more}"
