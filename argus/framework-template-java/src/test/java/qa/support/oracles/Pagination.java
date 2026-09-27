package qa.support.oracles;

import com.fasterxml.jackson.databind.node.TextNode;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Collection conservation across pages, the Java port of pagination.ts. Walking a collection
 * twice at a small page size exposes the classic pagination defects: an unstable sort that
 * repeats one item and skips another at a page boundary, a total that drifts from the items
 * served, a page size that is ignored, and a cursor that loops. A RED throws
 * {@link AssertionError}; misuse throws {@link IllegalArgumentException}.
 */
public final class Pagination {

    /** Page mode sends {page, pageSize}; cursor mode sends {cursor, pageSize}, with a null cursor first. */
    public enum Mode { PAGE, CURSOR }

    /** One page request: {@code page} is null in cursor mode, {@code cursor} is null in page mode and on the first cursor page. */
    public record PageRequest(Integer page, String cursor, int pageSize) {}

    /** One page as the adapter maps it: the items, the reported total (null when none), and the next cursor (null or empty ends a cursor walk). */
    public record PageResult<T>(List<T> items, Long total, String nextCursor) {}

    /** Fetches one page. */
    @FunctionalInterface
    public interface PageFetcher<T> {
        PageResult<T> fetch(PageRequest request);
    }

    /**
     * What conservation needs: the distinct ids of the first walk in first-seen order, the
     * total reported by the first page that reports one (null when none does), ids served more
     * than once within one walk, ids served in one walk but not in the other, the pages the
     * first walk fetched, whether both walks served the same id sequence with no anomaly, and
     * the human-readable anomalies.
     */
    public record PaginationResult(List<Object> ids, Long total, List<Object> duplicates, List<Object> missing,
                                   int pages, boolean consistent, List<String> anomalies) {}

    public static final int DEFAULT_MAX_PAGES = 1000;
    public static final int DEFAULT_FIRST_PAGE = 1;

    private static final int MAX_LISTED_IDS = 20;

    private static final class Walk {
        final List<Object> ids = new ArrayList<>();
        final List<Long> totals = new ArrayList<>();
        final List<String> anomalies = new ArrayList<>();
        int pages;
    }

    private Pagination() {}

    public static <T> PaginationResult paginateAll(PageFetcher<T> fetchPage, Mode mode, int pageSize, Function<? super T, ?> idOf) {
        return paginateAll(fetchPage, mode, pageSize, idOf, DEFAULT_MAX_PAGES, DEFAULT_FIRST_PAGE);
    }

    /**
     * Walks the whole collection twice through {@code fetchPage} and collects what
     * conservation needs. Page mode starts at {@code firstPage} and ends on a page shorter
     * than {@code pageSize}; cursor mode ends when {@code nextCursor} is null or empty. A walk
     * that has not ended after {@code maxPages} pages, a repeated cursor, a page larger than
     * {@code pageSize}, an item without an id, reported totals that differ, and walks that
     * serve different id sequences are anomalies, never exceptions;
     * {@link #assertCollectionConservation} turns them into RED. {@code idOf} returns the
     * item's string or number id; 1 and "1" are different ids.
     */
    public static <T> PaginationResult paginateAll(PageFetcher<T> fetchPage, Mode mode, int pageSize, Function<? super T, ?> idOf,
                                                   int maxPages, int firstPage) {
        if (fetchPage == null || idOf == null) throw new IllegalArgumentException("paginateAll: fetchPage and idOf must not be null");
        if (mode == null) throw new IllegalArgumentException("paginateAll: mode must be PAGE or CURSOR, got null");
        if (pageSize < 1) throw new IllegalArgumentException("paginateAll: pageSize must be a positive integer, got " + pageSize);
        if (maxPages < 1) throw new IllegalArgumentException("paginateAll: maxPages must be a positive integer, got " + maxPages);
        if (firstPage < 0) throw new IllegalArgumentException("paginateAll: firstPage must be a non-negative integer, got " + firstPage);

        Walk first = walk(fetchPage, mode, pageSize, idOf, maxPages, firstPage);
        Walk second = walk(fetchPage, mode, pageSize, idOf, maxPages, firstPage);
        List<String> firstKeys = first.ids.stream().map(Pagination::key).toList();
        List<String> secondKeys = second.ids.stream().map(Pagination::key).toList();
        Set<String> firstSet = new HashSet<>(firstKeys);
        Set<String> secondSet = new HashSet<>(secondKeys);
        List<String> anomalies = new ArrayList<>();
        first.anomalies.forEach(note -> anomalies.add("walk 1: " + note));
        second.anomalies.forEach(note -> anomalies.add("walk 2: " + note));
        Set<Long> totals = new LinkedHashSet<>(first.totals);
        totals.addAll(second.totals);
        if (totals.size() > 1) anomalies.add("the reported totals differ: " + totals.stream().map(String::valueOf).collect(Collectors.joining(", ")));
        if (!firstKeys.equals(secondKeys)) anomalies.add("the two walks served different id sequences");
        List<Object> duplicates = new ArrayList<>(repeated(first.ids));
        duplicates.addAll(repeated(second.ids));
        List<Object> missing = new ArrayList<>(first.ids.stream().filter(id -> !secondSet.contains(key(id))).toList());
        missing.addAll(second.ids.stream().filter(id -> !firstSet.contains(key(id))).toList());
        Long total = !first.totals.isEmpty() ? first.totals.get(0) : !second.totals.isEmpty() ? second.totals.get(0) : null;
        return new PaginationResult(distinct(first.ids), total, distinct(duplicates), distinct(missing), first.pages,
                anomalies.isEmpty(), List.copyOf(anomalies));
    }

    /**
     * Requires collection conservation: no id served twice, no id served in only one walk,
     * total == ids.size() when a total is reported, and a consistent walk.
     */
    public static void assertCollectionConservation(PaginationResult result) {
        if (result == null || result.ids() == null || result.duplicates() == null || result.missing() == null) {
            throw new IllegalArgumentException("assertCollectionConservation: pass the result of paginateAll");
        }
        List<String> problems = new ArrayList<>();
        if (!result.duplicates().isEmpty()) problems.add(result.duplicates().size() + " id(s) served more than once: " + listIds(result.duplicates()));
        if (!result.missing().isEmpty()) problems.add(result.missing().size() + " id(s) served in one walk only: " + listIds(result.missing()));
        if (result.total() != null && result.total().longValue() != result.ids().size()) {
            problems.add("total " + result.total() + " reported, " + result.ids().size() + " distinct ids served");
        }
        if (!result.consistent()) {
            List<String> anomalies = result.anomalies() == null ? List.of() : result.anomalies();
            problems.add("inconsistent walk: " + (anomalies.isEmpty() ? "no anomaly recorded" : String.join("; ", anomalies)));
        }
        if (!problems.isEmpty()) throw new AssertionError("collection conservation: " + String.join("; ", problems));
    }

    private static <T> Walk walk(PageFetcher<T> fetchPage, Mode mode, int pageSize, Function<? super T, ?> idOf, int maxPages, int firstPage) {
        Walk result = new Walk();
        Set<String> cursors = new HashSet<>();
        int page = firstPage;
        String cursor = null;
        for (;;) {
            if (result.pages >= maxPages) {
                result.anomalies.add("the walk did not end within maxPages=" + maxPages);
                return result;
            }
            String where = "page " + (mode == Mode.PAGE ? page : result.pages + 1);
            PageResult<T> served = fetchPage.fetch(mode == Mode.PAGE ? new PageRequest(page, null, pageSize) : new PageRequest(null, cursor, pageSize));
            result.pages += 1;
            if (served == null || served.items() == null) {
                throw new IllegalArgumentException("paginateAll: fetchPage must return a PageResult with an items list (" + where + ")");
            }
            if (served.total() != null) result.totals.add(served.total());
            List<T> items = served.items();
            if (items.size() > pageSize) result.anomalies.add(where + " served " + items.size() + " items for pageSize " + pageSize);
            for (int index = 0; index < items.size(); index++) {
                Object id = idOf.apply(items.get(index));
                if (id == null || "".equals(id)) {
                    result.anomalies.add(where + " item " + index + " has no id");
                } else if (id instanceof String || finiteNumber(id)) {
                    result.ids.add(id);
                } else {
                    throw new IllegalArgumentException("paginateAll: idOf must return a string or a finite number (" + where + " item " + index + ")");
                }
            }
            if (mode == Mode.PAGE) {
                if (items.size() < pageSize) return result;
                page += 1;
                continue;
            }
            String next = served.nextCursor();
            if (next == null || next.isEmpty()) return result;
            if (!cursors.add(next)) {
                result.anomalies.add(where + " repeated an earlier cursor");
                return result;
            }
            cursor = next;
        }
    }

    private static boolean finiteNumber(Object id) {
        if (id instanceof Double || id instanceof Float) return Double.isFinite(((Number) id).doubleValue());
        return id instanceof Integer || id instanceof Long || id instanceof Short || id instanceof Byte
                || id instanceof BigInteger || id instanceof BigDecimal;
    }

    /** 1 and "1" are different ids; 1, 1L and 1.0 are the same number. */
    private static String key(Object id) {
        return id instanceof String text ? "string:" + text : "number:" + plainNumber(id);
    }

    private static String plainNumber(Object id) {
        BigDecimal value = id instanceof BigDecimal decimal ? decimal
                : id instanceof Double || id instanceof Float ? BigDecimal.valueOf(((Number) id).doubleValue())
                : new BigDecimal(id.toString());
        return Boundary.normalize(value).toPlainString();
    }

    private static List<Object> distinct(List<Object> ids) {
        Set<String> seen = new HashSet<>();
        return ids.stream().filter(id -> seen.add(key(id))).toList();
    }

    private static List<Object> repeated(List<Object> ids) {
        Set<String> seen = new HashSet<>();
        return ids.stream().filter(id -> !seen.add(key(id))).toList();
    }

    private static String listIds(List<Object> ids) {
        String shown = ids.stream().limit(MAX_LISTED_IDS)
                .map(id -> id instanceof String text ? TextNode.valueOf(text).toString() : plainNumber(id))
                .collect(Collectors.joining(", "));
        return ids.size() > MAX_LISTED_IDS ? shown + ", … " + (ids.size() - MAX_LISTED_IDS) + " more" : shown;
    }
}
