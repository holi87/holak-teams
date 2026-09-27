package qa.support.argus;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.TextNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * In-process HTTP stub for oracle self-tests and counterfactual evidence passes
 * (TEMPLATE-CONTRACT.md SD-10). It binds {@code 127.0.0.1} on an ephemeral port, never
 * proxies to a real target, and keeps what it records in memory. A request is answered by
 * the optional {@link Handler}, else by the first loaded {@link Exchange} whose method and
 * path are equal and whose listed query parameters match, else with
 * {@code 501 {"argusStub":"unmatched"}}; callers decide whether that is a failure. An object,
 * array, number, boolean or null body is sent as JSON (default
 * {@code content-type: application/json}), a text body as {@code text/plain; charset=utf-8}.
 */
public final class StubServer implements AutoCloseable {

    /**
     * Tried before the exchanges; returning null falls through to them. A handler that throws
     * answers {@code 500 {"argusStub":"handler-error"}}.
     */
    @FunctionalInterface
    public interface Handler {
        StubResponse handle(RecordedRequest request) throws Exception;
    }

    /**
     * A recorded request. Header names are lowercase; a query parameter keeps its first value.
     * {@code matched} is the exchange id, {@code "handler"}, {@code "handler-error"}, or null
     * for an unmatched request.
     */
    public record RecordedRequest(String method, String path, Map<String, String> query,
                                  Map<String, String> headers, String body, String matched) {}

    /** The request side of an exchange: uppercase method, path without a query, parameters that must match. */
    public record ExchangeRequest(String method, String path, Map<String, String> query) {
        public ExchangeRequest {
            query = query == null ? Map.of() : Map.copyOf(query);
        }
    }

    /** A canned response; header names must be lowercase tokens. A null body sends no content. */
    public record StubResponse(int status, Map<String, String> headers, JsonNode body) {
        public StubResponse {
            headers = headers == null ? Map.of() : Map.copyOf(headers);
        }

        public static StubResponse status(int status) {
            return new StubResponse(status, Map.of(), null);
        }

        public static StubResponse json(int status, Object body) {
            return new StubResponse(status, Map.of(), MAPPER.valueToTree(body));
        }

        public static StubResponse text(int status, String body) {
            return new StubResponse(status, Map.of(), TextNode.valueOf(body));
        }

        /** A copy with one more header; the name is lowercased. */
        public StubResponse withHeader(String name, String value) {
            Map<String, String> next = new LinkedHashMap<>(headers);
            next.put(name.toLowerCase(Locale.ROOT), value);
            return new StubResponse(status, next, body);
        }

        public static StubResponse fromJson(JsonNode node) {
            Map<String, String> headers = new LinkedHashMap<>();
            node.path("headers").fields().forEachRemaining(h -> headers.put(h.getKey(), h.getValue().asText()));
            return new StubResponse(node.path("status").asInt(0), headers, node.get("body"));
        }

        void validate(String label) {
            if (status < 100 || status > 599) throw new IllegalArgumentException(label + ": response status must be an HTTP status code, got " + status);
            for (String name : headers.keySet()) {
                if (!HEADER_NAME.matcher(name).matches()) throw new IllegalArgumentException(label + ": header names must be lowercase tokens: " + name);
            }
        }

        byte[] bytes() {
            if (body == null || body.isMissingNode()) return new byte[0];
            if (body.isTextual()) return body.asText().getBytes(StandardCharsets.UTF_8);
            try {
                return MAPPER.writeValueAsBytes(body);
            } catch (JsonProcessingException e) {
                throw new UncheckedIOException(e);
            }
        }
    }

    /** One SD-10 exchange: {@code {id, request: {method, path, query?}, response: {status, headers, body}}}. */
    public record Exchange(String id, ExchangeRequest request, StubResponse response) {

        public static Exchange fromJson(JsonNode node) {
            JsonNode request = node.path("request");
            Map<String, String> query = new LinkedHashMap<>();
            request.path("query").fields().forEachRemaining(q -> query.put(q.getKey(), q.getValue().asText()));
            return new Exchange(node.path("id").asText(null),
                    new ExchangeRequest(request.path("method").asText(null), request.path("path").asText(null), query),
                    StubResponse.fromJson(node.path("response")));
        }

        public static List<Exchange> listFromJson(JsonNode array) {
            List<Exchange> out = new ArrayList<>();
            array.forEach(node -> out.add(fromJson(node)));
            return out;
        }

        public Exchange withResponse(StubResponse replacement) {
            return new Exchange(id, request, replacement);
        }

        void validate() {
            if (id == null || !EXCHANGE_ID.matcher(id).matches()) throw new IllegalArgumentException("invalid stub exchange id: " + id);
            if (request == null || request.method() == null || !request.method().matches("[A-Z]+")) {
                throw new IllegalArgumentException("stub exchange " + id + ": request.method must be an uppercase HTTP method");
            }
            if (request.path() == null || !request.path().startsWith("/") || request.path().contains("?")) {
                throw new IllegalArgumentException("stub exchange " + id + ": request.path must start with \"/\" and carry no query string");
            }
            if (response == null) throw new IllegalArgumentException("stub exchange " + id + ": response is required");
            response.validate("stub exchange " + id);
        }

        boolean matches(String method, String path, Map<String, String> query) {
            if (!request.method().equals(method) || !request.path().equals(path)) return false;
            for (Map.Entry<String, String> expected : request.query().entrySet()) {
                if (!expected.getValue().equals(query.get(expected.getKey()))) return false;
            }
            return true;
        }
    }

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Pattern EXCHANGE_ID = Pattern.compile("^[a-z0-9-]{1,40}$");
    private static final Pattern HEADER_NAME = Pattern.compile("^[a-z0-9!#$%&'*+.^_`|~-]+$");
    private static final StubResponse UNMATCHED = StubResponse.json(501, Map.of("argusStub", "unmatched"));
    private static final StubResponse HANDLER_ERROR = StubResponse.json(500, Map.of("argusStub", "handler-error"));

    private final HttpServer server;
    private final ExecutorService executor;
    private final Handler handler;
    private volatile List<Exchange> exchanges = List.of();
    private final List<RecordedRequest> log = new CopyOnWriteArrayList<>();

    private StubServer(Handler handler) throws IOException {
        this.handler = handler;
        this.server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        this.executor = Executors.newCachedThreadPool(task -> {
            Thread thread = new Thread(task, "argus-stub");
            thread.setDaemon(true);
            return thread;
        });
        server.createContext("/", this::serve);
        server.setExecutor(executor);
        server.start();
    }

    public static StubServer start() {
        return start(null);
    }

    public static StubServer start(Handler handler) {
        try {
            return new StubServer(handler);
        } catch (IOException e) {
            throw new UncheckedIOException("cannot bind the stub to 127.0.0.1", e);
        }
    }

    /** The stub origin, for example {@code http://127.0.0.1:53121}. */
    public String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    /** Replaces the exchange set and clears the request log. Invalid or duplicate exchanges throw. */
    public void load(List<Exchange> next) {
        Set<String> ids = new HashSet<>();
        for (Exchange exchange : next) {
            exchange.validate();
            if (!ids.add(exchange.id())) throw new IllegalArgumentException("duplicate stub exchange id: " + exchange.id());
        }
        exchanges = List.copyOf(next);
        log.clear();
    }

    /**
     * Resolves a request against the loaded exchanges without the network (for a Playwright
     * {@code route} handler). The method is uppercased and a query string in {@code path} is
     * merged under {@code query}. The request is recorded like a served one; null means
     * unmatched (answer it with 501).
     */
    public StubResponse resolve(String method, String path, Map<String, String> query) {
        int mark = path.indexOf('?');
        Map<String, String> merged = mark < 0 ? new LinkedHashMap<>() : query(path.substring(mark + 1));
        if (query != null) merged.putAll(query);
        String target = mark < 0 ? path : path.substring(0, mark);
        String upper = method.toUpperCase(Locale.ROOT);
        Exchange exchange = match(upper, target, merged);
        log.add(new RecordedRequest(upper, target, Map.copyOf(merged), Map.of(), null, exchange == null ? null : exchange.id()));
        return exchange == null ? null : exchange.response();
    }

    /** Every request received or resolved since the last load, in order. */
    public List<RecordedRequest> requests() {
        return List.copyOf(log);
    }

    /** The requests that got the 501 unmatched response. */
    public List<RecordedRequest> unmatched() {
        return log.stream().filter(record -> record.matched() == null).toList();
    }

    public void stop() {
        server.stop(0);
        executor.shutdownNow();
    }

    @Override
    public void close() {
        stop();
    }

    private Exchange match(String method, String path, Map<String, String> query) {
        for (Exchange exchange : exchanges) if (exchange.matches(method, path, query)) return exchange;
        return null;
    }

    private void serve(HttpExchange http) throws IOException {
        try (http) {
            String body = new String(http.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            Map<String, String> headers = new LinkedHashMap<>();
            http.getRequestHeaders().forEach((name, values) -> headers.put(name.toLowerCase(Locale.ROOT), String.join(", ", values)));
            String method = http.getRequestMethod().toUpperCase(Locale.ROOT);
            String path = http.getRequestURI().getRawPath();
            Map<String, String> query = Map.copyOf(query(http.getRequestURI().getRawQuery()));
            RecordedRequest request = new RecordedRequest(method, path, query, Map.copyOf(headers), body, null);
            StubResponse response = null;
            String matched = null;
            if (handler != null) {
                try {
                    response = handler.handle(request);
                    if (response != null) response.validate("stub handler response");
                    matched = response == null ? null : "handler";
                } catch (Exception e) {
                    response = HANDLER_ERROR;
                    matched = "handler-error";
                }
            }
            if (response == null) {
                Exchange exchange = match(method, path, query);
                response = exchange == null ? UNMATCHED : exchange.response();
                matched = exchange == null ? null : exchange.id();
            }
            log.add(new RecordedRequest(method, path, query, request.headers(), body, matched));
            write(http, method, response);
        }
    }

    private static void write(HttpExchange http, String method, StubResponse response) throws IOException {
        byte[] bytes = response.bytes();
        response.headers().forEach((name, value) -> http.getResponseHeaders().set(name, value));
        if (bytes.length > 0 && !response.headers().containsKey("content-type")) {
            http.getResponseHeaders().set("content-type", response.body().isTextual() ? "text/plain; charset=utf-8" : "application/json");
        }
        boolean empty = bytes.length == 0 || "HEAD".equals(method) || response.status() == 204 || response.status() == 304;
        http.sendResponseHeaders(response.status(), empty ? -1 : bytes.length);
        if (!empty) {
            try (OutputStream out = http.getResponseBody()) {
                out.write(bytes);
            }
        }
    }

    private static Map<String, String> query(String raw) {
        Map<String, String> out = new LinkedHashMap<>();
        if (raw == null || raw.isEmpty()) return out;
        for (String pair : raw.split("&")) {
            if (pair.isEmpty()) continue;
            int eq = pair.indexOf('=');
            String name = URLDecoder.decode(eq < 0 ? pair : pair.substring(0, eq), StandardCharsets.UTF_8);
            out.putIfAbsent(name, eq < 0 ? "" : URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8));
        }
        return out;
    }
}
