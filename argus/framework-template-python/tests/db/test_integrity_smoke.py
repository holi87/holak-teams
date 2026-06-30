"""@db lane — GATED on DB_URL; read-only direct-DB integrity checks.

DB-level checks (state integrity, orphan rows, constraint enforcement) need a
direct connection the target may not expose. With no DB_URL the lane skips (the
common black-box case); with one set it verifies the prerequisite is usable.

READ-ONLY: this lane never writes to the app's database. Keep every query a SELECT.
No DB driver is vendored here (driver choice depends on the engine); add the right
one to the deps once DB access is confirmed and uncomment the example query.

ADAPT-ME: real integrity queries against the confirmed schema.
"""
from __future__ import annotations

import os
from urllib.parse import urlparse

import pytest

DB_URL = os.environ.get("DB_URL")

# Engines we know how to read once a driver is added; an unknown scheme is a config smell.
KNOWN_SCHEMES = {"postgres", "postgresql", "mysql", "mariadb", "sqlite", "mssql"}

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(
        DB_URL is None,
        reason="db lane disabled: set DB_URL to enable direct-DB integrity checks",
    ),
]


def test_db_url_is_a_parseable_connection_string():
    parsed = urlparse(DB_URL)
    assert parsed.scheme, "DB_URL must be a valid URL/DSN with a scheme"


def test_db_url_scheme_is_supported():
    scheme = urlparse(DB_URL).scheme.split("+", 1)[0]  # strip sqlalchemy 'postgresql+psycopg'
    assert scheme in KNOWN_SCHEMES, f"unsupported DB scheme {scheme!r}; add a driver + handler"


# Example read-only integrity check — uncomment once a driver is in the deps and the
# real schema is known. Kept here as executable documentation of the intended shape:
#
# def test_no_orphan_order_rows():
#     import psycopg  # add 'psycopg[binary]' to the deps
#     with psycopg.connect(DB_URL) as conn, conn.cursor() as cur:
#         cur.execute(
#             "SELECT count(*) FROM orders o "
#             "LEFT JOIN users u ON u.id = o.user_id WHERE u.id IS NULL"
#         )
#         (orphans,) = cur.fetchone()
#     assert orphans == 0, f"{orphans} orders reference a missing user"
