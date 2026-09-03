import { Story } from "@once/core"
import * as genyMatch from "./collectors/genyMatch"
import * as hackerNewsHtml from "./collectors/hackerNewsHtml"
import * as jsonSelect from "./collectors/jsonSelect"
import * as lobstersHtml from "./collectors/lobstersHtml"
import * as redditJson from "./collectors/redditJson"
import * as redditRss from "./collectors/redditRss"
import * as twitterHtml from "./collectors/twitterHtml"
import * as vanillaRss from "./collectors/vanillaRss"

/** Everything a collector needs to know about the source being parsed. */
export interface ParseContext {
  /** The URL that was fetched. */
  url: string
  /**
   * Collector configuration, already validated by the collector's own
   * `normalizeConfig`. Only the configurable collectors read it.
   */
  config?: unknown
}

export declare interface StoryParser {
  options: {
    /**
     * Stable identifier, and a public one: it is stored in every source that
     * names its collector explicitly. Renaming one needs an alias and a
     * migration of stored sources. `type` cannot serve this purpose — the two
     * Reddit collectors deliberately share `re`.
     */
    id: string
    type: string
    description: string
    /** URL patterns for detecting this collector. Empty means never detected. */
    pattern: string | string[]
    collects: "dom" | "json" | "xml"
    colors: [string, string]
    /**
     * How long a fetched body stays fresh for sources this collector handles,
     * in minutes. Absent means the collector has no opinion and the global
     * default applies. A user override, per collector or per source, still
     * wins. Kept out of `settings`, which holds parsing knobs a collector reads
     * itself; this one is read by the loader.
     */
    cache_minutes?: number
    settings?: Record<string, unknown>
  }

  parse: (
    input: Document | Record<string, unknown>,
    context: ParseContext
  ) => Story[]
  /**
   * A collector that decodes the body itself, elsewhere: add-on collectors
   * run in a sandbox and get the fetched text (or the parsed JSON value for
   * `collects: "json"`), not a Document. When present the loader calls this
   * instead of `parse`, which such a collector implements as a throw.
   */
  parseBody?: (
    body: string | Record<string, unknown>,
    context: ParseContext
  ) => Promise<Story[]>
  /**
   * Validates untrusted configuration and returns a copy holding only known
   * fields, or throws. One path for the picker, an import, and a converted
   * typed source, so nothing reaches `parse` unchecked.
   */
  normalizeConfig?: (raw: unknown) => unknown
  /**
   * Produces the canonical JSON-safe form stored in a typed source. Keeping
   * this beside normalization gives editors and importers one collector-owned
   * codec instead of teaching them selector shapes.
   */
  serializeConfig?: (config: unknown) => unknown
  global_search?: (needle: string) => Promise<Story[]>
  domain_search?: (needle: string) => Promise<Story[]>
}

export type GlobalSearchProvider = StoryParser &
  Required<Pick<StoryParser, "global_search">>
export type DomainSearchProvider = StoryParser &
  Required<Pick<StoryParser, "domain_search">>

/**
 * The cast stays. Each collector's `parse` takes the input type it actually
 * handles — a `Document` or a JSON record — which is narrower than the union
 * declared above, and under `strictFunctionTypes` that is not assignable. The
 * alternative is widening all eight signatures and narrowing inside each one,
 * which buys nothing. The cast does mean a missing or duplicated `id` would not
 * be a type error, so `tests/unit/collectors/registry-ids.test.js` asserts the
 * ids instead — and that test doubles as the guard against renaming one.
 */
// Collectors add-ons contributed, after the built-ins so their URL patterns
// never capture a source a built-in handles. Ids are `addon:<addon>/<id>`.
const registered = new Map<string, StoryParser>()

/** Adds an add-on collector; the id must be namespaced and the badge unused. */
export function registerCollector(parser: StoryParser): () => void {
  const { id, type } = parser.options
  if (!id.startsWith("addon:")) throw new Error(`Add-on collectors must use addon: ids, got ${id}`)
  const clash = builtinCollectors().find((builtin) => builtin.options.type === type)
  if (clash) throw new Error(`Type badge ${type} belongs to the built-in ${clash.options.id} collector`)
  registered.set(id, parser)
  return () => {
    if (registered.get(id) === parser) registered.delete(id)
  }
}

export function get_active(): StoryParser[] {
  return [...builtinCollectors(), ...registered.values()]
}

function builtinCollectors(): StoryParser[] {
  return [
    {
      options: genyMatch.options,
      parse: genyMatch.parse,
      normalizeConfig: genyMatch.sanitize_selector_conf,
      serializeConfig: genyMatch.sanitize_selector_conf
    },
    {
      options: hackerNewsHtml.options,
      parse: hackerNewsHtml.parse,
      domain_search: hackerNewsHtml.domain_search,
      global_search: hackerNewsHtml.global_search
    },
    {
      options: jsonSelect.options,
      parse: jsonSelect.parse,
      normalizeConfig: jsonSelect.sanitize_selector_conf,
      serializeConfig: jsonSelect.sanitize_selector_conf
    },
    {
      options: lobstersHtml.options,
      parse: lobstersHtml.parse,
      domain_search: lobstersHtml.domain_search,
      global_search: lobstersHtml.global_search
    },
    {
      options: redditJson.options,
      parse: redditJson.parse,
      domain_search: redditJson.domain_search,
      global_search: redditJson.global_search
    },
    {
      options: redditRss.options,
      parse: redditRss.parse
    },
    {
      options: twitterHtml.options,
      parse: twitterHtml.parse
    },
    {
      options: vanillaRss.options,
      parse: vanillaRss.parse
    }
  ] as StoryParser[]
}

export function get_parser(): StoryParser[] {
  return get_active().filter((parser: StoryParser) => {
    return Object.prototype.hasOwnProperty.call(parser, "parse")
  })
}

/** Looks a collector up by the id a stored source named. */
export function get_parser_by_id(id: string): StoryParser | undefined {
  return get_parser().find((parser) => parser.options.id === id)
}

export function global_search_providers(): GlobalSearchProvider[] {
  return get_active().filter((parser): parser is GlobalSearchProvider => {
    return parser.global_search !== undefined
  })
}

export function domain_search_providers(): DomainSearchProvider[] {
  return get_active().filter((parser): parser is DomainSearchProvider => {
    return parser.domain_search !== undefined
  })
}
