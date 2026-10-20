package com.zmarn.once.lite;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import com.google.re2j.Matcher;
import com.google.re2j.Pattern;
import com.google.re2j.PatternSyntaxException;

/**
 * Tier 2's {@code declarativeNetRequest} matcher (docs/plans/once-lite-plan.md):
 * the subset Java can enforce from {@code shouldInterceptRequest} without
 * DevTools. A port of @once/core's {@code DnrMatcher} for the request-level
 * actions ({@code block}, {@code allow}, {@code allowAllRequests},
 * {@code redirect}, {@code upgradeScheme}); {@code modifyHeaders} rules are
 * not compiled (WebView cannot edit headers there). Plain Java, so the
 * semantics are unit-tested on the JVM.
 *
 * <p>Rules are grouped as the broker sends them (one group per extension)
 * and every group decides on its own; a block from any group wins, then a
 * redirect, as one extension's allow rule does not lift another's block in
 * Chrome. Within a group the highest priority wins, and at equal priority
 * allow beats block beats upgradeScheme beats redirect. A rule without
 * {@code resourceTypes} or {@code excludedResourceTypes} never matches a
 * top-level document.
 *
 * <p>uBlock Origin Lite's default rulesets run to 100k rules, so a group
 * indexes its {@code urlFilter} rules by one literal token each (a run of
 * letters, digits and {@code %} the pattern bounds on both sides) and a
 * request only tests the rules filed under the tokens of its URL, plus the
 * few that have none.
 */
public final class DnrEvaluator {
    public static final String[] RESOURCE_TYPES = {
        "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
        "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport", "webbundle", "other"
    };
    private static final Map<String, Integer> TYPE_BITS = new HashMap<>();
    private static final String[] METHODS = { "connect", "delete", "get", "head", "options", "patch", "post", "put", "other" };
    private static final Map<String, Integer> METHOD_BITS = new HashMap<>();
    static {
        for (int index = 0; index < RESOURCE_TYPES.length; index++) TYPE_BITS.put(RESOURCE_TYPES[index], 1 << index);
        for (int index = 0; index < METHODS.length; index++) METHOD_BITS.put(METHODS[index], 1 << index);
    }
    private static final int MAIN_FRAME = 1;
    private static final int ALL_TYPES = (1 << RESOURCE_TYPES.length) - 1;

    public enum Outcome { NONE, ALLOW, ALLOW_ALL_REQUESTS, BLOCK, UPGRADE_SCHEME, REDIRECT }

    private static final int ACTION_BLOCK = 0, ACTION_ALLOW = 1, ACTION_ALLOW_ALL = 2, ACTION_UPGRADE = 3, ACTION_REDIRECT = 4;
    /** Larger wins a tie at the same priority: allow, allowAllRequests, block, upgradeScheme, redirect, as Chrome orders them. */
    private static final int[] RANK = { 3, 5, 4, 2, 1 };

    /** One request as {@code shouldInterceptRequest} sees it. */
    public static final class Request {
        public final String url;
        public final String type;
        public final String method;
        /** The page making the request; null for a top-level navigation. */
        public final String initiator;
        public final int tabId;
        /** Per group: the priority of an allowAllRequests rule that matched the requesting document. */
        public final Map<String, Integer> frameAllow;

        public Request(String url, String type, String method, String initiator, int tabId, Map<String, Integer> frameAllow) {
            this.url = url;
            this.type = type;
            this.method = method == null ? "get" : method.toLowerCase(Locale.ROOT);
            this.initiator = initiator;
            this.tabId = tabId;
            this.frameAllow = frameAllow == null ? Collections.emptyMap() : frameAllow;
        }
    }

    /** What one group, or all of them, decided. */
    public static final class Decision {
        public static final Decision NONE = new Decision(Outcome.NONE, null, null, null, null, 0);
        public final Outcome outcome;
        public final String group;
        public final Integer ruleId;
        /** Where a redirect or upgrade goes, when it is a URL. */
        public final String redirectUrl;
        /** A redirect to a file of the group's package ({@code redirect.extensionPath}, leading slash). */
        public final String extensionPath;
        public final int priority;

        Decision(Outcome outcome, String group, Integer ruleId, String redirectUrl, String extensionPath, int priority) {
            this.outcome = outcome;
            this.group = group;
            this.ruleId = ruleId;
            this.redirectUrl = redirectUrl;
            this.extensionPath = extensionPath;
            this.priority = priority;
        }

        @Override public String toString() {
            return outcome + (ruleId == null ? "" : " #" + ruleId) + (redirectUrl == null ? "" : " -> " + redirectUrl)
                + (extensionPath == null ? "" : " -> " + extensionPath);
        }
    }

    /** The groups' decisions for one request: the one that applies, and the documents' allowAllRequests per group. */
    public static final class Result {
        public final Decision decision;
        public final Map<String, Integer> allowAllRequests;

        Result(Decision decision, Map<String, Integer> allowAllRequests) {
            this.decision = decision;
            this.allowAllRequests = allowAllRequests;
        }
    }

    // --------------------------------------------------------------------
    // Rules

    static final class Rule {
        int id;
        int priority = 1;
        int action;
        int types;
        int methods;
        boolean anyMethod = true;
        int domainType; // 0 any, 1 first party, 2 third party
        String[] requestDomains, excludedRequestDomains, initiatorDomains, excludedInitiatorDomains;
        int[] tabIds, excludedTabIds;
        DnrUrlFilter filter;
        Pattern regex;
        String redirectUrl, extensionPath, regexSubstitution;
        Map<String, Object> transform;
    }

    /** Thrown for a rule this evaluator cannot enforce; the caller counts it as skipped. */
    public static final class Unsupported extends Exception {
        Unsupported(String reason) { super(reason); }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value, String what) throws Unsupported {
        if (!(value instanceof Map)) throw new Unsupported(what + " must be an object");
        return (Map<String, Object>) value;
    }

    private static String[] strings(Map<String, Object> condition, String key, boolean lower) throws Unsupported {
        Object value = condition.get(key);
        if (value == null) return null;
        if (!(value instanceof List)) throw new Unsupported(key + " must be a list");
        List<?> list = (List<?>) value;
        String[] out = new String[list.size()];
        for (int index = 0; index < out.length; index++) {
            Object entry = list.get(index);
            if (!(entry instanceof String)) throw new Unsupported(key + " must hold strings");
            out[index] = lower ? ((String) entry).toLowerCase(Locale.ROOT) : (String) entry;
        }
        return out;
    }

    private static String[] domains(Map<String, Object> condition, String key) throws Unsupported {
        String[] list = strings(condition, key, true);
        if (list == null) return null;
        for (int index = 0; index < list.length; index++) {
            String domain = list[index];
            list[index] = domain.endsWith(".") ? domain.substring(0, domain.length() - 1) : domain;
        }
        Arrays.sort(list);
        return list;
    }

    private static int[] ints(Map<String, Object> condition, String key) throws Unsupported {
        Object value = condition.get(key);
        if (value == null) return null;
        if (!(value instanceof List)) throw new Unsupported(key + " must be a list");
        List<?> list = (List<?>) value;
        int[] out = new int[list.size()];
        for (int index = 0; index < out.length; index++) {
            if (!(list.get(index) instanceof Number)) throw new Unsupported(key + " must hold numbers");
            out[index] = ((Number) list.get(index)).intValue();
        }
        Arrays.sort(out);
        return out;
    }

    private static int bits(String[] names, Map<String, Integer> table, String key) throws Unsupported {
        int mask = 0;
        for (String name : names) {
            Integer bit = table.get(name);
            if (bit == null) throw new Unsupported("unknown " + key + " " + name);
            mask |= bit;
        }
        return mask;
    }

    /** Compiles one rule as the broker or a ruleset file has it. */
    static Rule compile(Object json) throws Unsupported {
        Map<String, Object> source = object(json, "rule");
        Rule rule = new Rule();
        if (source.get("id") instanceof Number) rule.id = ((Number) source.get("id")).intValue();
        if (source.get("priority") instanceof Number) rule.priority = Math.max(1, ((Number) source.get("priority")).intValue());
        Map<String, Object> action = object(source.get("action"), "action");
        Map<String, Object> condition = source.get("condition") == null ? new HashMap<>() : object(source.get("condition"), "condition");
        String type = String.valueOf(action.get("type"));
        switch (type) {
            case "block": rule.action = ACTION_BLOCK; break;
            case "allow": rule.action = ACTION_ALLOW; break;
            case "allowAllRequests": rule.action = ACTION_ALLOW_ALL; break;
            case "upgradeScheme": rule.action = ACTION_UPGRADE; break;
            case "redirect": {
                rule.action = ACTION_REDIRECT;
                Map<String, Object> redirect = object(action.get("redirect"), "redirect");
                if (redirect.get("url") instanceof String) rule.redirectUrl = (String) redirect.get("url");
                else if (redirect.get("extensionPath") instanceof String) {
                    String path = (String) redirect.get("extensionPath");
                    rule.extensionPath = path.startsWith("/") ? path : "/" + path;
                } else if (redirect.get("regexSubstitution") instanceof String) rule.regexSubstitution = (String) redirect.get("regexSubstitution");
                else if (redirect.get("transform") instanceof Map) rule.transform = object(redirect.get("transform"), "transform");
                else throw new Unsupported("redirect needs url, extensionPath, regexSubstitution or transform");
                break;
            }
            case "modifyHeaders": throw new Unsupported("modifyHeaders is not available without DevTools");
            default: throw new Unsupported("unknown action " + type);
        }
        String[] types = strings(condition, "resourceTypes", false);
        String[] excludedTypes = strings(condition, "excludedResourceTypes", false);
        if (types != null) rule.types = bits(types, TYPE_BITS, "resourceType");
        else if (excludedTypes != null) rule.types = ALL_TYPES & ~bits(excludedTypes, TYPE_BITS, "resourceType");
        else rule.types = ALL_TYPES & ~MAIN_FRAME;
        if (types != null && excludedTypes != null) rule.types &= ~bits(excludedTypes, TYPE_BITS, "resourceType");
        String[] methods = strings(condition, "requestMethods", true);
        String[] excludedMethods = strings(condition, "excludedRequestMethods", true);
        if (methods != null || excludedMethods != null) {
            rule.anyMethod = false;
            rule.methods = methods != null ? bits(methods, METHOD_BITS, "method") : ~0;
            if (excludedMethods != null) rule.methods &= ~bits(excludedMethods, METHOD_BITS, "method");
        }
        Object domainType = condition.get("domainType");
        if ("firstParty".equals(domainType)) rule.domainType = 1;
        else if ("thirdParty".equals(domainType)) rule.domainType = 2;
        rule.requestDomains = domains(condition, "requestDomains");
        rule.excludedRequestDomains = domains(condition, "excludedRequestDomains");
        rule.initiatorDomains = domains(condition, "initiatorDomains");
        if (rule.initiatorDomains == null) rule.initiatorDomains = domains(condition, "domains");
        rule.excludedInitiatorDomains = domains(condition, "excludedInitiatorDomains");
        if (rule.excludedInitiatorDomains == null) rule.excludedInitiatorDomains = domains(condition, "excludedDomains");
        rule.tabIds = ints(condition, "tabIds");
        rule.excludedTabIds = ints(condition, "excludedTabIds");
        boolean caseSensitive = Boolean.TRUE.equals(condition.get("isUrlFilterCaseSensitive"));
        Object urlFilter = condition.get("urlFilter");
        Object regexFilter = condition.get("regexFilter");
        if (urlFilter instanceof String && regexFilter != null) throw new Unsupported("urlFilter and regexFilter are exclusive");
        if (urlFilter instanceof String) rule.filter = new DnrUrlFilter((String) urlFilter, caseSensitive);
        if (regexFilter instanceof String) {
            try {
                rule.regex = Pattern.compile((String) regexFilter, caseSensitive ? 0 : Pattern.CASE_INSENSITIVE);
            } catch (PatternSyntaxException error) {
                throw new Unsupported("regexFilter does not compile: " + error.getDescription());
            }
        }
        if (rule.regexSubstitution != null && rule.regex == null) throw new Unsupported("regexSubstitution needs a regexFilter");
        return rule;
    }

    static boolean isTokenChar(char c) {
        return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '%';
    }

    /** Chrome's separator: not a letter, a digit or one of {@code _ - . %}. */
    static boolean isSeparator(char c) {
        return !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.' || c == '%');
    }

    // --------------------------------------------------------------------
    // Hosts

    static String hostOf(String url) {
        if (url == null) return null;
        int scheme = url.indexOf("://");
        if (scheme <= 0) return null;
        int start = scheme + 3;
        int end = start;
        while (end < url.length() && "/?#".indexOf(url.charAt(end)) < 0) end++;
        int at = url.lastIndexOf('@', end - 1);
        if (at >= start) start = at + 1;
        String host = url.substring(start, end);
        if (host.startsWith("[")) {
            int close = host.indexOf(']');
            host = close > 0 ? host.substring(0, close + 1) : host;
        } else {
            int colon = host.indexOf(':');
            if (colon >= 0) host = host.substring(0, colon);
        }
        host = host.toLowerCase(Locale.ROOT);
        if (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        return host.isEmpty() ? null : host;
    }

    /** Whether {@code host} is one of the sorted domains or a subdomain of one. */
    static boolean inDomains(String host, String[] domains) {
        String candidate = host;
        while (true) {
            if (Arrays.binarySearch(domains, candidate) >= 0) return true;
            int dot = candidate.indexOf('.');
            if (dot < 0) return false;
            candidate = candidate.substring(dot + 1);
        }
    }

    /** The last two labels stand in for the registrable domain, as in @once/core. */
    static String site(String host) {
        // An address is its own site.
        if (host.startsWith("[")) return host;
        boolean address = !host.isEmpty();
        for (int index = 0; address && index < host.length(); index++) {
            char c = host.charAt(index);
            address = c == '.' || c >= '0' && c <= '9';
        }
        if (address) return host;
        int last = host.lastIndexOf('.');
        if (last <= 0) return host;
        int previous = host.lastIndexOf('.', last - 1);
        return previous < 0 ? host : host.substring(previous + 1);
    }

    static boolean thirdParty(String requestHost, String initiatorHost) {
        if (requestHost == null || initiatorHost == null) return false;
        return !site(requestHost).equals(site(initiatorHost));
    }

    // --------------------------------------------------------------------
    // Groups

    /** One extension's compiled rules with their token index. */
    /** One rule list filed by token; built once per compiled list, so a group is cheap to rebuild. */
    static final class Index {
        private final Map<String, List<Rule>> byToken = new HashMap<>();
        /** Rules whose literals a `*` bounds (`*%2ftrack%2f…`), by the first three characters of one. */
        private final Map<String, List<Rule>> byTrigram = new HashMap<>();
        private final List<Rule> fallback = new ArrayList<>();
        final int size;

        Index(List<Rule> rules) {
            for (Rule rule : rules) {
                String token = rule.filter == null ? null : rule.filter.token();
                Map<String, List<Rule>> index = byToken;
                if (token == null && rule.filter != null) { token = rule.filter.trigram(); index = byTrigram; }
                if (token == null) { fallback.add(rule); continue; }
                List<Rule> bucket = index.get(token);
                if (bucket == null) index.put(token, bucket = new ArrayList<>(2));
                bucket.add(rule);
            }
            size = rules.size();
        }

        Rule best(Rule best, Request request, String lowerUrl, Set<String> tokens, Set<String> trigrams, int typeBit, String requestHost, String initiatorHost, boolean thirdParty) {
            for (String token : tokens) {
                List<Rule> bucket = byToken.get(token);
                if (bucket != null) for (Rule rule : bucket) best = better(best, rule, request, lowerUrl, typeBit, requestHost, initiatorHost, thirdParty);
            }
            if (!byTrigram.isEmpty()) for (String trigram : trigrams) {
                List<Rule> bucket = byTrigram.get(trigram);
                if (bucket != null) for (Rule rule : bucket) best = better(best, rule, request, lowerUrl, typeBit, requestHost, initiatorHost, thirdParty);
            }
            for (Rule rule : fallback) best = better(best, rule, request, lowerUrl, typeBit, requestHost, initiatorHost, thirdParty);
            return best;
        }
    }

    /** Every three token characters in a row of a lower-cased URL. */
    static Set<String> trigrams(String lowerUrl) {
        Set<String> trigrams = new HashSet<>();
        int run = 0;
        for (int index = 0; index < lowerUrl.length(); index++) {
            run = isTokenChar(lowerUrl.charAt(index)) ? run + 1 : 0;
            if (run >= 3) trigrams.add(lowerUrl.substring(index - 2, index + 1));
        }
        return trigrams;
    }

    public static final class Group {
        public final String id;
        /** The package redirects with {@code extensionPath} are served from. */
        public final String directory;
        private final List<Index> parts = new ArrayList<>();
        private int size;

        Group(String id, String directory) {
            this.id = id;
            this.directory = directory;
        }

        public int size() { return size; }

        void add(Index index) {
            parts.add(index);
            size += index.size;
        }

        Decision evaluate(Request request, String lowerUrl, Set<String> tokens, Set<String> trigrams, String requestHost, String initiatorHost, boolean thirdParty) {
            Rule best = null;
            int typeBit = TYPE_BITS.containsKey(request.type) ? TYPE_BITS.get(request.type) : TYPE_BITS.get("other");
            for (Index part : parts) best = part.best(best, request, lowerUrl, tokens, trigrams, typeBit, requestHost, initiatorHost, thirdParty);
            Integer frameAllow = request.frameAllow.get(id);
            if (frameAllow != null && (best == null || best.priority <= frameAllow)) return new Decision(Outcome.ALLOW, id, null, null, null, frameAllow);
            if (best == null) return Decision.NONE;
            switch (best.action) {
                case ACTION_ALLOW: return new Decision(Outcome.ALLOW, id, best.id, null, null, best.priority);
                case ACTION_ALLOW_ALL: return new Decision(Outcome.ALLOW_ALL_REQUESTS, id, best.id, null, null, best.priority);
                case ACTION_BLOCK: return new Decision(Outcome.BLOCK, id, best.id, null, null, best.priority);
                case ACTION_UPGRADE: {
                    String target = upgraded(request.url);
                    return target == null ? Decision.NONE : new Decision(Outcome.UPGRADE_SCHEME, id, best.id, target, null, best.priority);
                }
                default: {
                    if (best.extensionPath != null) return new Decision(Outcome.REDIRECT, id, best.id, null, best.extensionPath, best.priority);
                    String target = redirectTarget(best, request.url);
                    return target == null || target.equals(request.url) ? Decision.NONE
                        : new Decision(Outcome.REDIRECT, id, best.id, target, null, best.priority);
                }
            }
        }
    }

    private static Rule better(Rule best, Rule rule, Request request, String lowerUrl, int typeBit, String requestHost, String initiatorHost, boolean thirdParty) {
        if (best != null && (rule.priority < best.priority || (rule.priority == best.priority && RANK[rule.action] <= RANK[best.action]))) return best;
        return matches(rule, request, lowerUrl, typeBit, requestHost, initiatorHost, thirdParty) ? rule : best;
    }

    private static boolean matches(Rule rule, Request request, String lowerUrl, int typeBit, String requestHost, String initiatorHost, boolean thirdParty) {
        if ((rule.types & typeBit) == 0) return false;
        if (!rule.anyMethod) {
            Integer bit = METHOD_BITS.get(request.method);
            if ((rule.methods & (bit == null ? METHOD_BITS.get("other") : bit)) == 0) return false;
        }
        if (request.tabId >= 0) {
            if (rule.tabIds != null && Arrays.binarySearch(rule.tabIds, request.tabId) < 0) return false;
            if (rule.excludedTabIds != null && Arrays.binarySearch(rule.excludedTabIds, request.tabId) >= 0) return false;
        }
        if (rule.domainType != 0 && (rule.domainType == 2) != thirdParty) return false;
        if (rule.requestDomains != null && (requestHost == null || !inDomains(requestHost, rule.requestDomains))) return false;
        if (rule.excludedRequestDomains != null && requestHost != null && inDomains(requestHost, rule.excludedRequestDomains)) return false;
        // A request without an initiator matches no domain list, and no exclusion list excludes it, as in Chrome.
        if (rule.initiatorDomains != null && (initiatorHost == null || !inDomains(initiatorHost, rule.initiatorDomains))) return false;
        if (rule.excludedInitiatorDomains != null && initiatorHost != null && inDomains(initiatorHost, rule.excludedInitiatorDomains)) return false;
        if (rule.filter != null && !rule.filter.matches(request.url, lowerUrl)) return false;
        // An upgrade of a URL that is secure already, or a redirect to the URL itself, does not apply, as in Chrome.
        if (rule.action == ACTION_UPGRADE && upgraded(request.url) == null) return false;
        if (rule.regex != null && !rule.regex.matcher(request.url).find()) return false;
        if (rule.action == ACTION_REDIRECT && rule.extensionPath == null) {
            String target = redirectTarget(rule, request.url);
            if (target == null || target.equals(request.url)) return false;
        }
        return true;
    }

    static String upgraded(String url) {
        if (url.startsWith("http://")) return "https://" + url.substring(7);
        if (url.startsWith("ws://")) return "wss://" + url.substring(5);
        return null;
    }

    private static String redirectTarget(Rule rule, String url) {
        if (rule.redirectUrl != null) return rule.redirectUrl;
        if (rule.regexSubstitution != null) {
            Matcher matcher = rule.regex.matcher(url);
            if (!matcher.find()) return null;
            StringBuilder out = new StringBuilder(url.substring(0, matcher.start()));
            String template = rule.regexSubstitution;
            for (int index = 0; index < template.length(); index++) {
                char c = template.charAt(index);
                if (c == '\\' && index + 1 < template.length() && Character.isDigit(template.charAt(index + 1))) {
                    int group = template.charAt(++index) - '0';
                    if (group <= matcher.groupCount() && matcher.group(group) != null) out.append(matcher.group(group));
                } else out.append(c);
            }
            out.append(url.substring(matcher.end()));
            return out.toString();
        }
        if (rule.transform != null) return transformed(url, rule.transform);
        return null;
    }

    /** {@code redirect.transform} on a URL split into its parts; null when the URL does not split. */
    @SuppressWarnings("unchecked")
    static String transformed(String url, Map<String, Object> transform) {
        int schemeEnd = url.indexOf("://");
        if (schemeEnd <= 0) return null;
        String scheme = url.substring(0, schemeEnd);
        int authorityStart = schemeEnd + 3;
        int authorityEnd = authorityStart;
        while (authorityEnd < url.length() && "/?#".indexOf(url.charAt(authorityEnd)) < 0) authorityEnd++;
        String authority = url.substring(authorityStart, authorityEnd);
        String rest = url.substring(authorityEnd);
        int hash = rest.indexOf('#');
        String fragment = hash >= 0 ? rest.substring(hash) : "";
        if (hash >= 0) rest = rest.substring(0, hash);
        int question = rest.indexOf('?');
        String query = question >= 0 ? rest.substring(question) : "";
        String path = question >= 0 ? rest.substring(0, question) : rest;
        String userinfo = "";
        int at = authority.lastIndexOf('@');
        if (at >= 0) { userinfo = authority.substring(0, at + 1); authority = authority.substring(at + 1); }
        String host = authority;
        String port = "";
        int colon = authority.lastIndexOf(':');
        if (colon >= 0 && authority.indexOf(']') < colon) { host = authority.substring(0, colon); port = authority.substring(colon + 1); }
        if (transform.get("username") instanceof String || transform.get("password") instanceof String) {
            String existing = userinfo.isEmpty() ? "" : userinfo.substring(0, userinfo.length() - 1);
            int colonAt = existing.indexOf(':');
            String user = colonAt >= 0 ? existing.substring(0, colonAt) : existing;
            String password = colonAt >= 0 ? existing.substring(colonAt + 1) : "";
            if (transform.get("username") instanceof String) user = (String) transform.get("username");
            if (transform.get("password") instanceof String) password = (String) transform.get("password");
            userinfo = user.isEmpty() && password.isEmpty() ? "" : user + (password.isEmpty() ? "" : ":" + password) + "@";
        }
        if (transform.get("scheme") instanceof String) scheme = (String) transform.get("scheme");
        if (transform.get("host") instanceof String) host = (String) transform.get("host");
        if (transform.get("port") instanceof String) port = (String) transform.get("port");
        if (transform.get("path") instanceof String) path = (String) transform.get("path");
        if (transform.get("query") instanceof String) query = (String) transform.get("query");
        if (transform.get("fragment") instanceof String) fragment = (String) transform.get("fragment");
        if (transform.get("queryTransform") instanceof Map) query = transformQuery(query, (Map<String, Object>) transform.get("queryTransform"));
        if (!path.isEmpty() && !path.startsWith("/")) path = "/" + path;
        if (!query.isEmpty() && !query.startsWith("?")) query = "?" + query;
        if (query.equals("?")) query = "";
        if (!fragment.isEmpty() && !fragment.startsWith("#")) fragment = "#" + fragment;
        return scheme + "://" + userinfo + host + (port.isEmpty() ? "" : ":" + port) + (path.isEmpty() ? "/" : path) + query + fragment;
    }

    @SuppressWarnings("unchecked")
    private static String transformQuery(String query, Map<String, Object> transform) {
        List<String[]> params = new ArrayList<>();
        String body = query.startsWith("?") ? query.substring(1) : query;
        if (!body.isEmpty()) for (String part : body.split("&", -1)) {
            int equals = part.indexOf('=');
            params.add(equals >= 0 ? new String[] { part.substring(0, equals), part.substring(equals + 1) } : new String[] { part, null });
        }
        Object remove = transform.get("removeParams");
        if (remove instanceof List) {
            Set<Object> names = new HashSet<>((List<Object>) remove);
            params.removeIf(param -> names.contains(param[0]));
        }
        Object add = transform.get("addOrReplaceParams");
        if (add instanceof List) for (Object entry : (List<Object>) add) {
            if (!(entry instanceof Map)) continue;
            Map<String, Object> param = (Map<String, Object>) entry;
            String key = String.valueOf(param.get("key"));
            String value = String.valueOf(param.get("value"));
            boolean replaced = false;
            for (String[] existing : params) if (existing[0].equals(key)) { existing[1] = value; replaced = true; break; }
            if (!replaced && !Boolean.TRUE.equals(param.get("replaceOnly"))) params.add(new String[] { key, value });
        }
        if (params.isEmpty()) return "";
        StringBuilder out = new StringBuilder("?");
        for (int index = 0; index < params.size(); index++) {
            if (index > 0) out.append('&');
            out.append(params.get(index)[0]);
            if (params.get(index)[1] != null) out.append('=').append(params.get(index)[1]);
        }
        return out.toString();
    }

    // --------------------------------------------------------------------
    // The evaluator

    private final List<Group> groups;
    private final boolean usesTrigrams;

    public DnrEvaluator(List<Group> groups) {
        this.groups = new ArrayList<>(groups);
        boolean needed = false;
        for (Group group : groups) for (Index part : group.parts) needed |= !part.byTrigram.isEmpty();
        usesTrigrams = needed;
    }

    public static final DnrEvaluator EMPTY = new DnrEvaluator(Collections.emptyList());

    public List<Group> groups() { return Collections.unmodifiableList(groups); }

    /** Compiled rules per group. */
    public Map<String, Integer> counts() {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (Group group : groups) counts.put(group.id, group.size());
        return counts;
    }

    /** The tokens of a lower-cased URL, as the rules are filed. */
    static Set<String> tokens(String lowerUrl) {
        Set<String> tokens = new HashSet<>();
        int index = 0;
        while (index < lowerUrl.length()) {
            if (!isTokenChar(lowerUrl.charAt(index))) { index++; continue; }
            int start = index;
            while (index < lowerUrl.length() && isTokenChar(lowerUrl.charAt(index))) index++;
            if (index - start >= 2) tokens.add(lowerUrl.substring(start, index));
        }
        return tokens;
    }

    public Result evaluate(Request request) {
        if (groups.isEmpty()) return new Result(Decision.NONE, Collections.emptyMap());
        String lowerUrl = request.url.toLowerCase(Locale.ROOT);
        Set<String> tokens = tokens(lowerUrl);
        // Shared by all ruleset parts and extensions, rather than allocating a set per part.
        Set<String> trigrams = usesTrigrams ? trigrams(lowerUrl) : Collections.emptySet();
        String requestHost = hostOf(request.url);
        String initiatorHost = hostOf(request.initiator);
        boolean thirdParty = thirdParty(requestHost, initiatorHost);
        Decision block = null, redirect = null, allow = null;
        Map<String, Integer> allowAll = new HashMap<>();
        for (Group group : groups) {
            Decision decision = group.evaluate(request, lowerUrl, tokens, trigrams, requestHost, initiatorHost, thirdParty);
            switch (decision.outcome) {
                case BLOCK: if (block == null) block = decision; break;
                case REDIRECT: case UPGRADE_SCHEME: if (redirect == null) redirect = decision; break;
                case ALLOW_ALL_REQUESTS: allowAll.put(group.id, decision.priority); if (allow == null) allow = decision; break;
                case ALLOW: if (allow == null) allow = decision; break;
                default: break;
            }
        }
        Decision winner = block != null ? block : redirect != null ? redirect : allow != null ? allow : Decision.NONE;
        return new Result(winner, allowAll);
    }

    // --------------------------------------------------------------------
    // Loading

    /** Rules compiled from a JSON array, with the count of those this evaluator cannot enforce. */
    public static final class Compiled {
        public final List<Rule> rules = new ArrayList<>();
        public int skipped;
        private Index index;

        synchronized Index index() {
            if (index == null) index = new Index(rules);
            return index;
        }
    }

    /** Compiles the rules of a JSON array text (a ruleset file). */
    public static Compiled compileArray(String json) {
        Compiled compiled = new Compiled();
        MiniJson.forEachElement(json, element -> {
            try { compiled.rules.add(compile(element)); } catch (Unsupported error) { compiled.skipped++; }
        });
        return compiled;
    }

    /** Compiles parsed rules (a list of maps). */
    public static Compiled compileList(List<?> rules) {
        Compiled compiled = new Compiled();
        for (Object element : rules) {
            try { compiled.rules.add(compile(element)); } catch (Unsupported error) { compiled.skipped++; }
        }
        return compiled;
    }

    /** A group from compiled parts; order only settles ties of equal priority and action. */
    public static Group group(String id, String directory, List<Compiled> parts) {
        Group group = new Group(id, directory);
        for (Compiled part : parts) group.add(part.index());
        return group;
    }
}
