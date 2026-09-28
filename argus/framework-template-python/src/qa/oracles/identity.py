"""Canonical identity-input vectors and the credential consistency oracle.

Every non-ASCII vector is written as a ``\\u`` or ``\\U`` escape so no editor, formatter, or
git filter can normalize it (an NFD vector folded to NFC is worthless) or hide it (a literal
bidi override is a Trojan-Source pattern). A comment names or shows each vector.

A RED raises AssertionError (product); every misuse raises TypeError (automation).
"""
from __future__ import annotations

import itertools
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, TypedDict

EmailPartitionLabel = Literal[
    "email.missing-at",
    "email.missing-domain",
    "email.missing-local-part",
    "email.double-at",
    "email.embedded-whitespace",
]

CredentialCheckName = Literal["byte-identical", "case-variant-email", "case-variant-password", "trailing-space-password"]
Verdict = Literal["accepted", "rejected"]


class Credentials(TypedDict):
    """What register and login receive: a fresh dict per call, ready to send as a JSON body."""

    email: str
    password: str


@dataclass(frozen=True)
class Whitespace:
    leading: str
    trailing: str
    internal: str
    tab: str
    space_only: str


@dataclass(frozen=True)
class UnicodeEdge:
    emoji: str
    rtl: str
    zero_width: str
    combining: str
    nfc: str
    nfd: str
    overlong: str


@dataclass(frozen=True)
class IdentityVectors:
    whitespace: Whitespace
    diacritics: tuple[str, ...]
    special: str
    unicode_edge: UnicodeEdge


@dataclass(frozen=True)
class InvalidEmail:
    """One invalid email and the email partition label it breaks."""

    label: EmailPartitionLabel
    value: str


@dataclass(frozen=True)
class CredentialCheck:
    name: CredentialCheckName
    expected: Verdict
    actual: Verdict


@dataclass(frozen=True)
class CredentialReport:
    """The registered email (never the password) and every login check in the order run."""

    email: str
    checks: tuple[CredentialCheck, ...]


IDENTITY_VECTORS = IdentityVectors(
    whitespace=Whitespace(
        leading=" Argus",
        trailing="Argus ",
        internal="Argus QA",
        tab="Argus\tQA",
        space_only="   ",
    ),
    diacritics=(
        "Żółć Ąćęłń",  # Żółć Ąćęłń
        "Zoë Saldaña",  # Zoë Saldaña
    ),
    special="!@#$%^&*()\"'<>",
    unicode_edge=UnicodeEdge(
        emoji="\U0001f600\U0001f44d\U0001f3fd",  # grinning face, thumbs up with a skin-tone modifier
        rtl="‮abc",  # RIGHT-TO-LEFT OVERRIDE, then abc
        zero_width="a​b",  # a, ZERO WIDTH SPACE, b
        combining="é",  # e, COMBINING ACUTE ACCENT
        nfc="é",  # e with acute, precomposed (NFC)
        nfd="é",  # e with acute, decomposed (NFD)
        overlong="a" * 1025,
    ),
)

#: One invalid email per email partition label, in label order; each must be rejected.
INVALID_EMAILS: tuple[InvalidEmail, ...] = (
    InvalidEmail("email.missing-at", "argus.qa.example.com"),
    InvalidEmail("email.missing-domain", "argus.qa@"),
    InvalidEmail("email.missing-local-part", "@example.com"),
    InvalidEmail("email.double-at", "argus.qa@@example.com"),
    InvalidEmail("email.embedded-whitespace", "argus qa@example.com"),
)

_SEQ_TOKEN = frozenset("abcdefghijklmnopqrstuvwxyz0123456789-")


def valid_email(seq: int | str) -> str:
    """The known-good email ``argus.qa+<seq>@example.com``, the positive oracle for every email field.

    ``seq`` is a non-negative integer or a lowercase ``[a-z0-9-]`` token of 1 to 32
    characters; against an environment that keeps accounts across runs, pass a run-unique
    token.
    """
    if isinstance(seq, bool):
        valid = False
    elif isinstance(seq, int):
        valid = seq >= 0
    else:
        valid = isinstance(seq, str) and 1 <= len(seq) <= 32 and set(seq) <= _SEQ_TOKEN
    if not valid:
        raise TypeError(f"valid_email: seq must be a non-negative integer or a lowercase [a-z0-9-] token, got {seq!r}")
    return f"argus.qa+{seq}@example.com"


def case_variants(value: str) -> tuple[str, str, str]:
    """``(lower, UPPER, Mixed)``; Mixed alternates upper and lower case over the cased letters."""
    if not isinstance(value, str):
        raise TypeError("case_variants: value must be a string")
    letter = 0
    mixed: list[str] = []
    for char in value:
        upper, lower = char.upper(), char.lower()
        if upper == lower:
            mixed.append(char)
            continue
        mixed.append(upper if letter % 2 == 0 else lower)
        letter += 1
    return value.lower(), value.upper(), "".join(mixed)


# Argus!Żółć#Qa7 followed by one space: diacritics, special characters, a trailing space.
DEFAULT_PASSWORD = "Argus!Żółć#Qa7 "
_sequence = itertools.count(1)


@dataclass(frozen=True)
class _Step:
    name: CredentialCheckName
    credentials: Credentials
    expected: bool


def credential_consistency(
    *,
    register: Callable[[Credentials], bool],
    login: Callable[[Credentials], bool],
    email: str | None = None,
    password: str | None = None,
    password_case_sensitive: bool = True,
    email_case_insensitive: bool = True,
) -> CredentialReport:
    """The credential consistency oracle. Registers one account, then requires:

    * byte-identical: the exact registered email and password log in;
    * case-variant-email: an email case variant logs in (must be refused when
      ``email_case_insensitive`` is False);
    * case-variant-password: a password case variant is refused (must log in when
      ``password_case_sensitive`` is False);
    * trailing-space-password: the password plus one trailing space is refused.

    The default password carries diacritics, special characters, and a trailing space, so a
    silent trim, truncation, or charset strip on only one side (register or login) is RED.
    ``register`` and ``login`` return True when the product accepted the credentials. The
    default email is ``valid_email(<per-process sequence>)`` (each pytest-xdist worker has its
    own); pass ``email`` for a run-unique one and ``password`` when the product documents a
    stricter password policy. Messages name the checks only, never the credentials.
    """
    if not callable(register) or not callable(login):
        raise TypeError("credential_consistency: register and login must be callables")
    _require_flag(password_case_sensitive, "password_case_sensitive")
    _require_flag(email_case_insensitive, "email_case_insensitive")
    email = valid_email(next(_sequence)) if email is None else email
    password = DEFAULT_PASSWORD if password is None else password
    if not isinstance(email, str) or email == "" or not isinstance(password, str) or password == "":
        raise TypeError("credential_consistency: email and password must be non-empty strings")
    email_variant = _different_variant(email, "email")
    password_variant = _different_variant(password, "password")

    if not _accepted(register, email, password, "register"):
        raise AssertionError("credential_consistency: register refused the credential vector; nothing else can be checked")

    plan = [
        _Step("byte-identical", {"email": email, "password": password}, True),
        _Step("case-variant-email", {"email": email_variant, "password": password}, email_case_insensitive),
        _Step("case-variant-password", {"email": email, "password": password_variant}, not password_case_sensitive),
        _Step("trailing-space-password", {"email": email, "password": f"{password} "}, False),
    ]
    # Expected successes run before expected refusals, so a lockout policy cannot mask them.
    plan.sort(key=lambda step: not step.expected)
    checks: list[CredentialCheck] = []
    for step in plan:
        actual = _accepted(login, step.credentials["email"], step.credentials["password"], f"login ({step.name})")
        checks.append(CredentialCheck(step.name, _verdict(step.expected), _verdict(actual)))
    failures = [check for check in checks if check.expected != check.actual]
    if failures:
        raise AssertionError(
            "credential_consistency: "
            + "; ".join(f"{check.name} login expected {check.expected}, got {check.actual}" for check in failures)
        )
    return CredentialReport(email=email, checks=tuple(checks))


def _accepted(callback: Callable[[Credentials], bool], email: str, password: str, label: str) -> bool:
    result = callback({"email": email, "password": password})
    if not isinstance(result, bool):
        raise TypeError(f"credential_consistency: {label} must return True (accepted) or False (refused)")
    return result


def _different_variant(value: str, label: str) -> str:
    for candidate in case_variants(value):
        if candidate != value:
            return candidate
    raise TypeError(f"credential_consistency: the {label} has no cased letter, so its case handling cannot be checked")


def _require_flag(value: object, label: str) -> None:
    if not isinstance(value, bool):
        raise TypeError(f"credential_consistency: {label} must be a bool")


def _verdict(value: bool) -> Verdict:
    return "accepted" if value else "rejected"
