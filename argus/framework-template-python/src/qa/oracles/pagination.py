"""Collection conservation across pages.

Walking a collection twice at a small page size exposes the classic pagination defects: an
unstable sort that repeats one item and skips another at a page boundary, a total that
drifts from the items served, a page size that is ignored, and a cursor that loops. A RED
raises AssertionError (product); every misuse raises TypeError (automation).
"""
from __future__ import annotations

import json
import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Generic, Literal, TypeVar, Union

T = TypeVar("T")
CollectionId = Union[str, int, float]
PageMode = Literal["page", "cursor"]

_MAX_LISTED_IDS = 20


@dataclass(frozen=True)
class PageRequest:
    """Page mode sends page and page_size; cursor mode sends cursor (None first) and page_size."""

    page: int | None
    cursor: str | None
    page_size: int


@dataclass(frozen=True)
class PageResult(Generic[T]):
    """One page as the adapter maps it: the items, the reported total, and the next cursor."""

    items: Sequence[T]
    total: int | float | None = None
    next_cursor: str | None = None


@dataclass(frozen=True)
class PaginationResult:
    #: Distinct ids of the first walk, in first-seen order.
    ids: list[CollectionId]
    #: The total reported by the first page that reports one; None when none does.
    total: int | float | None
    #: Ids served more than once within one walk.
    duplicates: list[CollectionId]
    #: Ids served in one walk but not in the other.
    missing: list[CollectionId]
    #: Pages fetched by the first walk.
    pages: int
    #: True when both walks served the same id sequence and nothing in ``anomalies`` occurred.
    consistent: bool
    #: Human-readable reasons for ``consistent=False``.
    anomalies: list[str] = field(default_factory=list)


@dataclass
class _Walk:
    ids: list[CollectionId] = field(default_factory=list)
    totals: list[int | float] = field(default_factory=list)
    pages: int = 0
    anomalies: list[str] = field(default_factory=list)


def paginate_all(
    *,
    fetch_page: Callable[[PageRequest], PageResult[T] | Mapping[str, Any]],
    mode: PageMode,
    page_size: int,
    id_of: Callable[[T], Any],
    max_pages: int = 1000,
    first_page: int = 1,
) -> PaginationResult:
    """Walk the whole collection twice through ``fetch_page`` and collect what conservation needs.

    ``fetch_page`` returns a PageResult or a mapping ``{"items": [...], "total"?, "nextCursor"?}``
    (``next_cursor`` is accepted too), so a decoded JSON page can be returned as is. Page mode
    starts at ``first_page`` (default 1) and ends on a page shorter than ``page_size``; cursor
    mode ends when the next cursor is None or empty. A walk that has not ended after
    ``max_pages`` pages (default 1000), a repeated cursor, a page larger than ``page_size``, an
    item without an id, reported totals that differ, and walks that serve different id
    sequences are anomalies, never exceptions; assert_collection_conservation turns them into
    RED. ``id_of(item)`` returns the item's string or number id.
    """
    if not callable(fetch_page) or not callable(id_of):
        raise TypeError("paginate_all: fetch_page and id_of must be callables")
    if mode not in ("page", "cursor"):
        raise TypeError(f"paginate_all: mode must be 'page' or 'cursor', got {mode!r}")
    _require_count(page_size, "page_size", 1)
    _require_count(max_pages, "max_pages", 1)
    _require_count(first_page, "first_page", 0)

    def walk() -> _Walk:
        result = _Walk()
        cursors: set[str] = set()
        page = first_page
        cursor: str | None = None
        while True:
            if result.pages >= max_pages:
                result.anomalies.append(f"the walk did not end within max_pages={max_pages}")
                return result
            if mode == "page":
                where, request = f"page {page}", PageRequest(page=page, cursor=None, page_size=page_size)
            else:
                where, request = f"page {result.pages + 1}", PageRequest(page=None, cursor=cursor, page_size=page_size)
            items, total, next_cursor = _read_page(fetch_page(request), where)
            result.pages += 1
            if total is not None:
                result.totals.append(total)
            if len(items) > page_size:
                result.anomalies.append(f"{where} served {len(items)} items for page_size {page_size}")
            for index, item in enumerate(items):
                item_id = id_of(item)
                if item_id is None or item_id == "":
                    result.anomalies.append(f"{where} item {index} has no id")
                elif _is_id(item_id):
                    result.ids.append(item_id)
                else:
                    raise TypeError(f"paginate_all: id_of must return a string or a finite number ({where} item {index})")
            if mode == "page":
                if len(items) < page_size:
                    return result
                page += 1
                continue
            if next_cursor is None or next_cursor == "":
                return result
            if not isinstance(next_cursor, str):
                raise TypeError(f"paginate_all: the next cursor must be a string or None ({where})")
            if next_cursor in cursors:
                result.anomalies.append(f"{where} repeated an earlier cursor")
                return result
            cursors.add(next_cursor)
            cursor = next_cursor

    first = walk()
    second = walk()
    first_keys = {_key(item_id) for item_id in first.ids}
    second_keys = {_key(item_id) for item_id in second.ids}
    anomalies = [f"walk 1: {note}" for note in first.anomalies] + [f"walk 2: {note}" for note in second.anomalies]
    totals = _distinct_numbers(first.totals + second.totals)
    if len(totals) > 1:
        anomalies.append(f"the reported totals differ: {', '.join(_show_number(total) for total in totals)}")
    if [_key(item_id) for item_id in first.ids] != [_key(item_id) for item_id in second.ids]:
        anomalies.append("the two walks served different id sequences")
    return PaginationResult(
        ids=_distinct(first.ids),
        total=first.totals[0] if first.totals else (second.totals[0] if second.totals else None),
        duplicates=_distinct(_repeated(first.ids) + _repeated(second.ids)),
        missing=_distinct(
            [item_id for item_id in first.ids if _key(item_id) not in second_keys]
            + [item_id for item_id in second.ids if _key(item_id) not in first_keys]
        ),
        pages=first.pages,
        consistent=not anomalies,
        anomalies=anomalies,
    )


def assert_collection_conservation(result: PaginationResult) -> None:
    """Require collection conservation.

    No id served twice, no id served in only one walk, total == len(ids) when a total is
    reported, and a consistent walk.
    """
    if not isinstance(result, PaginationResult):
        raise TypeError("assert_collection_conservation: pass the result of paginate_all")
    problems: list[str] = []
    if result.duplicates:
        problems.append(f"{len(result.duplicates)} id(s) served more than once: {_list_ids(result.duplicates)}")
    if result.missing:
        problems.append(f"{len(result.missing)} id(s) served in one walk only: {_list_ids(result.missing)}")
    if result.total is not None and result.total != len(result.ids):
        problems.append(f"total {_show_number(result.total)} reported, {len(result.ids)} distinct ids served")
    if not result.consistent:
        problems.append(f"inconsistent walk: {'; '.join(result.anomalies) or 'no anomaly recorded'}")
    if problems:
        raise AssertionError(f"collection conservation: {'; '.join(problems)}")


def _read_page(served: Any, where: str) -> tuple[Sequence[Any], int | float | None, Any]:
    if isinstance(served, PageResult):
        items, total, next_cursor = served.items, served.total, served.next_cursor
    elif isinstance(served, Mapping) and "items" in served:
        if "nextCursor" in served and "next_cursor" in served:
            raise TypeError(f"paginate_all: a page must not carry both nextCursor and next_cursor ({where})")
        items, total = served["items"], served.get("total")
        next_cursor = served["nextCursor"] if "nextCursor" in served else served.get("next_cursor")
    else:
        raise TypeError(f'paginate_all: fetch_page must return a PageResult or {{"items": [...], "total"?, "nextCursor"?}} ({where})')
    if not isinstance(items, (list, tuple)):
        raise TypeError(f"paginate_all: a page's items must be a list ({where})")
    if total is not None and (isinstance(total, bool) or not isinstance(total, (int, float))):
        raise TypeError(f"paginate_all: a reported total must be a number ({where})")
    return items, total, next_cursor


def _is_id(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    return isinstance(value, str) or isinstance(value, int) or (isinstance(value, float) and math.isfinite(value))


# 1 and '1' are different ids; 1 and 1.0 are the same number.
def _key(item_id: CollectionId) -> tuple[str, CollectionId]:
    return ("string" if isinstance(item_id, str) else "number", item_id)


def _distinct(ids: list[CollectionId]) -> list[CollectionId]:
    seen: set[tuple[str, CollectionId]] = set()
    result: list[CollectionId] = []
    for item_id in ids:
        key = _key(item_id)
        if key not in seen:
            seen.add(key)
            result.append(item_id)
    return result


def _repeated(ids: list[CollectionId]) -> list[CollectionId]:
    seen: set[tuple[str, CollectionId]] = set()
    result: list[CollectionId] = []
    for item_id in ids:
        key = _key(item_id)
        if key in seen:
            result.append(item_id)
        seen.add(key)
    return result


def _distinct_numbers(values: list[int | float]) -> list[int | float]:
    result: list[int | float] = []
    for value in values:
        if value not in result:
            result.append(value)
    return result


def _show_number(value: int | float) -> str:
    return str(int(value)) if isinstance(value, float) and value.is_integer() else str(value)


def _list_ids(ids: list[CollectionId]) -> str:
    shown = ", ".join(json.dumps(item_id, ensure_ascii=False) for item_id in ids[:_MAX_LISTED_IDS])
    return f"{shown}, … {len(ids) - _MAX_LISTED_IDS} more" if len(ids) > _MAX_LISTED_IDS else shown


def _require_count(value: Any, label: str, minimum: int) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        kind = "a positive integer" if minimum == 1 else "a non-negative integer"
        raise TypeError(f"paginate_all: {label} must be {kind}, got {value!r}")
