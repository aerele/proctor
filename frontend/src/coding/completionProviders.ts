// frontend/src/coding/completionProviders.ts
//
// F12.3 — curated per-language library/function AUTOCOMPLETE for the Monaco
// editor. We test problem-solving, not memory, so candidates get a hand-picked
// list of the common competitive/stdlib surface per language. This is v1 by
// design: NO language server, NO pyright/clangd/LSP, NO web-workers. Just a
// static, curated list registered as a Monaco completion-item provider.
//
// Two layers:
//   1. getCompletions(language) — PURE, testable: returns curated symbols.
//   2. registerCuratedCompletions(monaco) — thin glue that wires the pure data
//      into Monaco. Idempotent (re-mounting panes must not double-register).

export type CompletionKind = "function" | "method" | "class" | "keyword" | "module";

export interface CompletionSpec {
  label: string;
  kind: CompletionKind;
  insertText: string;
  detail: string;
  documentation?: string;
}

export type EditorLanguage = "python" | "cpp" | "java" | "javascript";

// Convenience builders — keep the big tables below readable.
const fn = (label: string, detail: string, insertText = label, documentation?: string): CompletionSpec =>
  ({ label, kind: "function", insertText, detail, documentation });
const method = (label: string, detail: string, insertText = label, documentation?: string): CompletionSpec =>
  ({ label, kind: "method", insertText, detail, documentation });
const cls = (label: string, detail: string, insertText = label, documentation?: string): CompletionSpec =>
  ({ label, kind: "class", insertText, detail, documentation });
const mod = (label: string, detail: string, insertText = label, documentation?: string): CompletionSpec =>
  ({ label, kind: "module", insertText, detail, documentation });

const PYTHON: CompletionSpec[] = [
  // builtins
  fn("input", "builtin: read a line from stdin", "input()"),
  fn("print", "builtin: write to stdout", "print"),
  fn("int", "builtin: integer conversion", "int"),
  fn("float", "builtin: float conversion", "float"),
  fn("str", "builtin: string conversion", "str"),
  fn("list", "builtin: list constructor", "list"),
  fn("dict", "builtin: dict constructor", "dict"),
  fn("set", "builtin: set constructor", "set"),
  fn("tuple", "builtin: tuple constructor", "tuple"),
  fn("map", "builtin: map(func, iterable)", "map"),
  fn("filter", "builtin: filter(func, iterable)", "filter"),
  fn("zip", "builtin: zip(*iterables)", "zip"),
  fn("sorted", "builtin: sorted(iterable, key=, reverse=)", "sorted"),
  fn("reversed", "builtin: reversed(seq)", "reversed"),
  fn("enumerate", "builtin: enumerate(iterable, start=0)", "enumerate"),
  fn("range", "builtin: range(stop) / range(start, stop, step)", "range"),
  fn("len", "builtin: len(obj)", "len"),
  fn("sum", "builtin: sum(iterable, start=0)", "sum"),
  fn("min", "builtin: min(iterable, key=)", "min"),
  fn("max", "builtin: max(iterable, key=)", "max"),
  fn("abs", "builtin: abs(x)", "abs"),
  fn("round", "builtin: round(x, ndigits=)", "round"),
  fn("pow", "builtin: pow(base, exp, mod=)", "pow"),
  fn("divmod", "builtin: divmod(a, b)", "divmod"),
  fn("ord", "builtin: ord(char)", "ord"),
  fn("chr", "builtin: chr(int)", "chr"),
  fn("any", "builtin: any(iterable)", "any"),
  fn("all", "builtin: all(iterable)", "all"),
  // math
  mod("math", "module: mathematical functions", "math"),
  fn("sqrt", "math.sqrt(x)", "sqrt"),
  fn("gcd", "math.gcd(a, b)", "gcd"),
  fn("lcm", "math.lcm(a, b)", "lcm"),
  fn("factorial", "math.factorial(n)", "factorial"),
  fn("ceil", "math.ceil(x)", "ceil"),
  fn("floor", "math.floor(x)", "floor"),
  fn("hypot", "math.hypot(x, y)", "hypot"),
  fn("log", "math.log(x, base=)", "log"),
  fn("log2", "math.log2(x)", "log2"),
  fn("inf", "math.inf — positive infinity", "inf"),
  // collections
  mod("collections", "module: specialized container datatypes", "collections"),
  cls("deque", "collections.deque — double-ended queue", "deque"),
  cls("Counter", "collections.Counter — multiset / tally", "Counter"),
  cls("defaultdict", "collections.defaultdict(default_factory)", "defaultdict"),
  cls("OrderedDict", "collections.OrderedDict — order-preserving dict", "OrderedDict"),
  // itertools
  mod("itertools", "module: iterator building blocks", "itertools"),
  fn("permutations", "itertools.permutations(iterable, r=)", "permutations"),
  fn("combinations", "itertools.combinations(iterable, r)", "combinations"),
  fn("product", "itertools.product(*iterables, repeat=)", "product"),
  fn("accumulate", "itertools.accumulate(iterable, func=)", "accumulate"),
  fn("chain", "itertools.chain(*iterables)", "chain"),
  // heapq
  mod("heapq", "module: heap queue (priority queue)", "heapq"),
  fn("heappush", "heapq.heappush(heap, item)", "heappush"),
  fn("heappop", "heapq.heappop(heap)", "heappop"),
  fn("heapify", "heapq.heapify(list)", "heapify"),
  fn("nlargest", "heapq.nlargest(n, iterable, key=)", "nlargest"),
  fn("nsmallest", "heapq.nsmallest(n, iterable, key=)", "nsmallest"),
  // bisect
  mod("bisect", "module: array bisection algorithm", "bisect"),
  fn("bisect_left", "bisect.bisect_left(a, x)", "bisect_left"),
  fn("bisect_right", "bisect.bisect_right(a, x)", "bisect_right"),
  fn("insort", "bisect.insort(a, x)", "insort"),
  // sys
  mod("sys", "module: system-specific parameters", "sys"),
  mod("stdin", "sys.stdin — standard input stream", "stdin"),
  fn("setrecursionlimit", "sys.setrecursionlimit(n)", "setrecursionlimit"),
  // string
  mod("string", "module: common string constants", "string"),
  mod("ascii_lowercase", "string.ascii_lowercase — 'abc...z'", "ascii_lowercase"),
  mod("ascii_uppercase", "string.ascii_uppercase — 'ABC...Z'", "ascii_uppercase"),
  mod("digits", "string.digits — '0123456789'", "digits"),
];

const CPP: CompletionSpec[] = [
  // containers
  cls("vector", "std::vector<T> — dynamic array", "vector"),
  cls("map", "std::map<K,V> — ordered map", "map"),
  cls("unordered_map", "std::unordered_map<K,V> — hash map", "unordered_map"),
  cls("set", "std::set<T> — ordered set", "set"),
  cls("unordered_set", "std::unordered_set<T> — hash set", "unordered_set"),
  cls("pair", "std::pair<A,B>", "pair"),
  cls("queue", "std::queue<T> — FIFO", "queue"),
  cls("stack", "std::stack<T> — LIFO", "stack"),
  cls("priority_queue", "std::priority_queue<T> — max-heap", "priority_queue"),
  cls("string", "std::string", "string"),
  // <algorithm>
  fn("sort", "std::sort(first, last, cmp=)", "sort"),
  fn("stable_sort", "std::stable_sort(first, last, cmp=)", "stable_sort"),
  fn("lower_bound", "std::lower_bound(first, last, val)", "lower_bound"),
  fn("upper_bound", "std::upper_bound(first, last, val)", "upper_bound"),
  fn("max_element", "std::max_element(first, last)", "max_element"),
  fn("min_element", "std::min_element(first, last)", "min_element"),
  fn("accumulate", "std::accumulate(first, last, init)", "accumulate"),
  fn("reverse", "std::reverse(first, last)", "reverse"),
  fn("unique", "std::unique(first, last)", "unique"),
  fn("__gcd", "std::__gcd(a, b)", "__gcd"),
  fn("max", "std::max(a, b)", "max"),
  fn("min", "std::min(a, b)", "min"),
  fn("swap", "std::swap(a, b)", "swap"),
  // member ops
  method("push_back", "container.push_back(x)", "push_back"),
  method("pop_back", "container.pop_back()", "pop_back"),
  method("emplace_back", "container.emplace_back(args...)", "emplace_back"),
  method("begin", "container.begin()", "begin"),
  method("end", "container.end()", "end"),
  method("size", "container.size()", "size"),
  method("empty", "container.empty()", "empty"),
  method("clear", "container.clear()", "clear"),
  method("insert", "container.insert(...)", "insert"),
  method("erase", "container.erase(...)", "erase"),
  method("find", "container.find(key)", "find"),
  method("count", "container.count(key)", "count"),
  method("push", "adaptor.push(x)", "push"),
  method("pop", "adaptor.pop()", "pop"),
  method("top", "adaptor.top()", "top"),
  method("front", "container.front()", "front"),
  method("back", "container.back()", "back"),
  // io
  mod("cin", "std::cin — standard input", "cin"),
  mod("cout", "std::cout — standard output", "cout"),
  mod("endl", "std::endl — newline + flush", "endl"),
  fn("getline", "std::getline(cin, str)", "getline"),
];

const JAVA: CompletionSpec[] = [
  // java.util
  cls("Scanner", "java.util.Scanner — token/line input", "Scanner"),
  cls("ArrayList", "java.util.ArrayList<E> — resizable array", "ArrayList"),
  cls("LinkedList", "java.util.LinkedList<E>", "LinkedList"),
  cls("HashMap", "java.util.HashMap<K,V> — hash map", "HashMap"),
  cls("HashSet", "java.util.HashSet<E> — hash set", "HashSet"),
  cls("TreeMap", "java.util.TreeMap<K,V> — sorted map", "TreeMap"),
  cls("TreeSet", "java.util.TreeSet<E> — sorted set", "TreeSet"),
  cls("Collections", "java.util.Collections — static utilities", "Collections"),
  cls("Arrays", "java.util.Arrays — array utilities", "Arrays"),
  cls("PriorityQueue", "java.util.PriorityQueue<E> — heap", "PriorityQueue"),
  cls("Deque", "java.util.Deque<E> — double-ended queue", "Deque"),
  cls("ArrayDeque", "java.util.ArrayDeque<E>", "ArrayDeque"),
  cls("StringBuilder", "java.lang.StringBuilder — mutable string", "StringBuilder"),
  cls("Integer", "java.lang.Integer — boxed int", "Integer"),
  cls("Long", "java.lang.Long — boxed long", "Long"),
  cls("Math", "java.lang.Math — math utilities", "Math"),
  // io
  fn("System.out.println", "print line to stdout", "System.out.println"),
  fn("System.out.print", "print to stdout (no newline)", "System.out.print"),
  cls("BufferedReader", "java.io.BufferedReader — buffered line input", "BufferedReader"),
  cls("InputStreamReader", "java.io.InputStreamReader", "InputStreamReader"),
  // common methods
  method("add", "collection.add(e)", "add"),
  method("get", "list.get(i) / map.get(key)", "get"),
  method("put", "map.put(key, value)", "put"),
  method("containsKey", "map.containsKey(key)", "containsKey"),
  method("contains", "collection.contains(e)", "contains"),
  method("remove", "collection.remove(e)", "remove"),
  method("size", "collection.size()", "size"),
  method("isEmpty", "collection.isEmpty()", "isEmpty"),
  method("poll", "queue.poll()", "poll"),
  method("offer", "queue.offer(e)", "offer"),
  method("peek", "queue.peek()", "peek"),
  method("nextInt", "scanner.nextInt()", "nextInt"),
  method("nextLine", "scanner.nextLine()", "nextLine"),
  method("hasNext", "scanner.hasNext()", "hasNext"),
];

const JAVASCRIPT: CompletionSpec[] = [
  // Array methods
  method("push", "arr.push(...items)", "push"),
  method("pop", "arr.pop()", "pop"),
  method("shift", "arr.shift()", "shift"),
  method("unshift", "arr.unshift(...items)", "unshift"),
  method("map", "arr.map((x, i) => ...)", "map"),
  method("filter", "arr.filter((x) => ...)", "filter"),
  method("reduce", "arr.reduce((acc, x) => ..., init)", "reduce"),
  method("forEach", "arr.forEach((x) => ...)", "forEach"),
  method("sort", "arr.sort((a, b) => a - b)", "sort"),
  method("slice", "arr.slice(start, end)", "slice"),
  method("splice", "arr.splice(start, deleteCount, ...items)", "splice"),
  method("indexOf", "arr.indexOf(value)", "indexOf"),
  method("includes", "arr.includes(value)", "includes"),
  method("join", "arr.join(separator)", "join"),
  method("concat", "arr.concat(...arrays)", "concat"),
  method("find", "arr.find((x) => ...)", "find"),
  method("flat", "arr.flat(depth)", "flat"),
  // Math
  cls("Math", "Math — math utilities object", "Math"),
  fn("max", "Math.max(...values)", "max"),
  fn("min", "Math.min(...values)", "min"),
  fn("floor", "Math.floor(x)", "floor"),
  fn("ceil", "Math.ceil(x)", "ceil"),
  fn("round", "Math.round(x)", "round"),
  fn("abs", "Math.abs(x)", "abs"),
  fn("sqrt", "Math.sqrt(x)", "sqrt"),
  fn("pow", "Math.pow(base, exp)", "pow"),
  // string methods
  method("split", "str.split(separator)", "split"),
  method("charCodeAt", "str.charCodeAt(i)", "charCodeAt"),
  method("charAt", "str.charAt(i)", "charAt"),
  method("padStart", "str.padStart(targetLength, padString)", "padStart"),
  method("padEnd", "str.padEnd(targetLength, padString)", "padEnd"),
  method("repeat", "str.repeat(count)", "repeat"),
  method("trim", "str.trim()", "trim"),
  method("toUpperCase", "str.toUpperCase()", "toUpperCase"),
  method("toLowerCase", "str.toLowerCase()", "toLowerCase"),
  // globals
  fn("console.log", "console.log(...args)", "console.log"),
  fn("parseInt", "parseInt(string, radix)", "parseInt"),
  fn("parseFloat", "parseFloat(string)", "parseFloat"),
  fn("Number", "Number(value)", "Number"),
  fn("String", "String(value)", "String"),
  fn("Array.from", "Array.from(iterable, mapFn?)", "Array.from"),
];

const TABLE: Record<EditorLanguage, CompletionSpec[]> = {
  python: PYTHON,
  cpp: CPP,
  java: JAVA,
  javascript: JAVASCRIPT,
};

export const COMPLETION_LANGUAGES: EditorLanguage[] = ["python", "cpp", "java", "javascript"];

/**
 * PURE: curated completion symbols for one language. Returns [] for unknown
 * languages so callers never crash on a surprise value.
 */
export function getCompletions(language: string): CompletionSpec[] {
  return TABLE[language as EditorLanguage] ?? [];
}

// Maps our kind → Monaco's CompletionItemKind. `monaco` is the runtime object
// passed by @monaco-editor/react onMount; we read the enum off it rather than
// import the heavy module statically.
function toMonacoKind(monaco: any, kind: CompletionKind): number {
  const K = monaco.languages.CompletionItemKind;
  switch (kind) {
    case "function":
      return K.Function;
    case "method":
      return K.Method;
    case "class":
      return K.Class;
    case "keyword":
      return K.Keyword;
    case "module":
      return K.Module;
    default:
      return K.Text;
  }
}

// Idempotency guard: MonacoEditor mounts once per problem pane, so without this
// every re-mount would stack another provider and we'd get N duplicate
// suggestions. Keyed by the monaco instance so a fresh page (new monaco) still
// registers. We track which languages we've registered per monaco instance.
const registered = new WeakMap<object, Set<string>>();

/**
 * Register curated completion providers for all 4 languages on this monaco
 * instance. Idempotent. Built-in word suggestions stay ON — this only ADDS a
 * curated provider alongside them.
 */
export function registerCuratedCompletions(monaco: any): void {
  if (!monaco?.languages?.registerCompletionItemProvider) return;
  let done = registered.get(monaco);
  if (!done) {
    done = new Set<string>();
    registered.set(monaco, done);
  }

  for (const language of COMPLETION_LANGUAGES) {
    if (done.has(language)) continue;
    done.add(language);

    const specs = getCompletions(language);
    monaco.languages.registerCompletionItemProvider(language, {
      provideCompletionItems(model: any, position: any) {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const suggestions = specs.map((s) => ({
          label: s.label,
          kind: toMonacoKind(monaco, s.kind),
          insertText: s.insertText,
          detail: s.detail,
          documentation: s.documentation,
          range,
        }));
        return { suggestions };
      },
    });
  }
}

// Exposed only for tests — lets a test reset idempotency state if needed.
export function __resetRegisteredForTest(monaco: object): void {
  registered.delete(monaco);
}
