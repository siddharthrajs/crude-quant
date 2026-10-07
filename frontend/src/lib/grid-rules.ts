export type RuleOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "between" | "in" | "contains" | "startsWith" | "isNull" | "notNull"

/** What a rule compares against, as typed. A string is read in the column's format; a number or boolean is used as it is. */
export type RuleValue = string | number | boolean | null

/** A token name. The soft variant tints the background; the token itself colors the text. */
export type RuleTone = "up" | "down" | "flat" | "stale" | "expiring" | "primary" | "destructive"

export interface RuleCondition {
  op: RuleOp
  /** For eq, ne, gt, gte, lt, lte, contains, and startsWith. */
  value?: RuleValue
  /** For between (two: low, then high, both inclusive) and in (any number). Each is read as `value` is. */
  values?: RuleValue[]
}

export interface ColumnRule {
  id: string
  /** The column whose value the rule reads, by key. */
  column: string
  when: RuleCondition
  tone: RuleTone
  /** The rule in words: the accessible description of what it paints. `describeRule` writes one when it is left out. */
  label?: string
  /** What the tone paints: the cell in `column` (default), or the whole row. */
  target?: "cell" | "row"
}

export interface FilterRule extends RuleCondition {
  column: string
}

export interface SortRule {
  key: string
  dir: "asc" | "desc"
}

export interface GridRules {
  /** Cells and rows to color. The first rule in the list that matches a cell decides it. */
  columns?: ColumnRule[]
  /** Every rule has to hold for a row to show. */
  filter?: FilterRule[]
  /** The first rule that tells two rows apart decides their order. */
  sort?: SortRule[]
}

/** What a rule needs of a column. The grid's `ColumnDef` satisfies it. */
export interface RuleColumn<T> {
  key: string
  /** Named in a rule's words when it is a string; the key otherwise. */
  header?: unknown
  accessor: (row: T) => unknown
  numeric?: boolean
  /** Reads a value typed into a rule in this column's own format. Default: a number for a numeric column, the text itself for the rest. */
  parse?: (text: string) => unknown
}

export const RULE_OPS: readonly RuleOp[] = ["eq", "ne", "gt", "gte", "lt", "lte", "between", "in", "contains", "startsWith", "isNull", "notNull"]
export const NUMBER_OPS: readonly RuleOp[] = ["eq", "ne", "gt", "gte", "lt", "lte", "between", "in", "isNull", "notNull"]
export const TEXT_OPS: readonly RuleOp[] = ["eq", "ne", "contains", "startsWith", "in", "isNull", "notNull"]

/** The word for each op, as a rule reads aloud: "Price above 99-16+". */
export const RULE_OP_LABELS: Record<RuleOp, string> = {
  eq: "is",
  ne: "is not",
  gt: "above",
  gte: "at or above",
  lt: "below",
  lte: "at or below",
  between: "between",
  in: "one of",
  contains: "contains",
  startsWith: "starts with",
  isNull: "is empty",
  notNull: "is not empty",
}

export const RULE_TONES: readonly RuleTone[] = ["up", "down", "flat", "stale", "expiring", "primary", "destructive"]

// The text takes the token and the background a tint of its soft variant, painted as a background
// image rather than a background color so it layers over whatever color the element already has: a
// frozen cell keeps its opaque `bg-background` under the tint and stays opaque as rows scroll beneath
// it, and a selected row's `bg-accent` shows through. Literal strings, so Tailwind finds them.
export const RULE_TONE_CLASS: Record<RuleTone, string> = {
  up: "text-up bg-[linear-gradient(var(--up-soft),var(--up-soft))]",
  down: "text-down bg-[linear-gradient(var(--down-soft),var(--down-soft))]",
  flat: "text-flat bg-[linear-gradient(var(--flat-soft),var(--flat-soft))]",
  stale: "text-stale bg-[linear-gradient(var(--stale-soft),var(--stale-soft))]",
  expiring: "text-expiring bg-[linear-gradient(var(--expiring-soft),var(--expiring-soft))]",
  primary: "text-primary bg-[linear-gradient(color-mix(in_oklab,var(--primary)_12%,transparent),color-mix(in_oklab,var(--primary)_12%,transparent))]",
  destructive: "text-destructive bg-[linear-gradient(color-mix(in_oklab,var(--destructive)_12%,transparent),color-mix(in_oklab,var(--destructive)_12%,transparent))]",
}

/** What an applied rule puts on a cell or a row. */
export interface RuleDecoration {
  "data-rule": string
  "data-tone": RuleTone
  "aria-description": string
  className: string
}

/** The ops a column offers: comparisons and ranges for a numeric column, text matching for the rest. */
export function opsFor(column: { numeric?: boolean } | undefined): readonly RuleOp[] {
  return column?.numeric ? NUMBER_OPS : TEXT_OPS
}

/** The column's name in words: its header when that is a string, else its key. */
export function columnName<T>(column: RuleColumn<T> | undefined, key?: string): string {
  if (column && typeof column.header === "string" && column.header.trim()) return column.header
  return column?.key ?? key ?? ""
}

/** Null for null, undefined, NaN, and the infinities; the value otherwise. */
export function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === "number" && !Number.isFinite(value)) return null
  return value
}

/** Nulls last, numbers numerically, everything else as text. */
export function compareValues(a: unknown, b: unknown): number {
  const an = normalizeValue(a) === null
  const bn = normalizeValue(b) === null
  if (an && bn) return 0
  if (an) return 1
  if (bn) return -1
  if (typeof a === "number" && typeof b === "number") return a - b
  return String(a).localeCompare(String(b))
}

/** `compareValues` in a direction, with a null last whichever way the list runs: a missing price never leads a list sorted high to low. */
export function compareDirected(a: unknown, b: unknown, dir: "asc" | "desc"): number {
  const an = normalizeValue(a) === null
  const bn = normalizeValue(b) === null
  if (an || bn) return compareValues(a, b)
  const c = compareValues(a, b)
  return dir === "desc" ? -c : c
}

/**
 * A value as typed into a rule, read for a column: a string goes through the column's `parse`, or
 * `Number` for a numeric column, and stays text otherwise; a number or boolean is used as it is.
 * Null when there is nothing to read, and null never matches anything but `isNull`.
 */
export function readRuleValue<T>(column: RuleColumn<T> | undefined, raw: RuleValue | undefined): unknown {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== "string") return normalizeValue(raw)
  if (column?.parse) return normalizeValue(column.parse(raw))
  if (column?.numeric) {
    const text = raw.trim().replace(/−/g, "-").replace(/,/g, "")
    return text === "" ? null : normalizeValue(Number(text))
  }
  return raw
}

function same(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase()
  if (typeof a === "number" && typeof b === "string") return a === Number(b)
  if (typeof a === "string" && typeof b === "number") return Number(a) === b
  return a === b
}

const needsValue = new Set<RuleOp>(["eq", "ne", "gt", "gte", "lt", "lte", "contains", "startsWith"])

/**
 * One condition compiled against one column: the typed values are read once, and the function that
 * comes back only compares. A row whose value is null answers only `isNull` and `notNull`.
 */
export function compileCondition<T>(condition: RuleCondition, column: RuleColumn<T>): (row: T) => boolean {
  const { op } = condition
  const want = readRuleValue(column, condition.value)
  const list = (condition.values ?? []).map((v) => readRuleValue(column, v)).filter((v) => v !== null)
  const read = (row: T) => normalizeValue(column.accessor(row))
  switch (op) {
    case "isNull":
      return (row) => read(row) === null
    case "notNull":
      return (row) => read(row) !== null
    case "eq":
      return want === null ? () => false : (row) => same(read(row), want)
    case "ne":
      return want === null
        ? () => false
        : (row) => {
            const v = read(row)
            return v !== null && !same(v, want)
          }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (want === null) return () => false
      return (row) => {
        const v = read(row)
        if (v === null) return false
        const c = compareValues(v, want)
        return op === "gt" ? c > 0 : op === "gte" ? c >= 0 : op === "lt" ? c < 0 : c <= 0
      }
    }
    case "between": {
      const [lo, hi] = list
      if (lo === undefined || hi === undefined) return () => false
      return (row) => {
        const v = read(row)
        return v !== null && compareValues(v, lo) >= 0 && compareValues(v, hi) <= 0
      }
    }
    case "in":
      return list.length === 0 ? () => false : (row) => list.some((item) => same(read(row), item))
    case "contains":
    case "startsWith": {
      if (want === null) return () => false
      const needle = String(want).toLowerCase()
      return (row) => {
        const v = read(row)
        if (v === null) return false
        const text = String(v).toLowerCase()
        return op === "contains" ? text.includes(needle) : text.startsWith(needle)
      }
    }
  }
}

function findColumn<T>(columns: readonly RuleColumn<T>[], key: string): RuleColumn<T> | undefined {
  return columns.find((column) => column.key === key)
}

/**
 * Why a rule cannot apply, in a sentence, or null when it can: a column the grid does not have, a
 * value the column cannot read, a range without its two ends, a set with nothing in it.
 */
export function ruleProblem<T>(rule: { column: string; when?: RuleCondition } & Partial<RuleCondition>, columns: readonly RuleColumn<T>[]): string | null {
  const column = findColumn(columns, rule.column)
  if (!column) return `No column is named "${rule.column}".`
  const condition: RuleCondition = rule.when ?? { op: rule.op!, value: rule.value, values: rule.values }
  const name = columnName(column)
  const unreadable = (raw: RuleValue | undefined) => raw !== undefined && raw !== null && raw !== "" && readRuleValue(column, raw) === null
  if (needsValue.has(condition.op)) {
    if (condition.value === undefined || condition.value === null || condition.value === "") return `${RULE_OP_LABELS[condition.op]} needs a value.`
    if (unreadable(condition.value)) return `"${condition.value}" is not a value ${name} reads.`
  }
  if (condition.op === "between") {
    const values = condition.values ?? []
    if (values.length !== 2) return "between needs a low value and a high value."
    for (const raw of values) if (unreadable(raw) || raw === "" || raw === null) return `"${raw ?? ""}" is not a value ${name} reads.`
  }
  if (condition.op === "in") {
    const values = (condition.values ?? []).filter((raw) => raw !== null && raw !== "")
    if (!values.length) return "one of needs at least one value."
    for (const raw of values) if (unreadable(raw)) return `"${raw}" is not a value ${name} reads.`
  }
  return null
}

/** The rule in words: "Price above 99-16+", "Client one of ALPHA, BETA", "Status is empty". */
export function describeRule<T>(rule: { column: string; when?: RuleCondition } & Partial<RuleCondition>, columns: readonly RuleColumn<T>[]): string {
  const column = findColumn(columns, rule.column)
  const condition: RuleCondition = rule.when ?? { op: rule.op!, value: rule.value, values: rule.values }
  const name = columnName(column, rule.column)
  const word = RULE_OP_LABELS[condition.op]
  const text = (raw: RuleValue | undefined) => (raw === undefined || raw === null ? "" : String(raw))
  if (condition.op === "isNull" || condition.op === "notNull") return `${name} ${word}`
  if (condition.op === "between") {
    const [lo, hi] = condition.values ?? []
    return `${name} ${word} ${text(lo)} and ${text(hi)}`
  }
  if (condition.op === "in") return `${name} ${word} ${(condition.values ?? []).map(text).join(", ")}`
  return `${name} ${word} ${text(condition.value)}`
}

/** Every rule has to hold. A rule on a column the grid does not have is skipped, so a stale rule hides nothing. */
export function compileFilter<T>(rules: readonly FilterRule[], columns: readonly RuleColumn<T>[]): (row: T) => boolean {
  const tests: ((row: T) => boolean)[] = []
  for (const rule of rules) {
    const column = findColumn(columns, rule.column)
    if (column) tests.push(compileCondition(rule, column))
  }
  if (!tests.length) return () => true
  if (tests.length === 1) return tests[0]!
  return (row) => tests.every((test) => test(row))
}

/** The first rule that tells two rows apart decides, nulls last either way. Undefined when no rule names a column the grid has. */
export function compileComparator<T>(rules: readonly SortRule[], columns: readonly RuleColumn<T>[]): ((a: T, b: T) => number) | undefined {
  const keys: { accessor: (row: T) => unknown; dir: "asc" | "desc" }[] = []
  for (const rule of rules) {
    const column = findColumn(columns, rule.key)
    if (column) keys.push({ accessor: column.accessor, dir: rule.dir })
  }
  if (!keys.length) return undefined
  return (a, b) => {
    for (const { accessor, dir } of keys) {
      const c = compareDirected(accessor(a), accessor(b), dir)
      if (c !== 0) return c
    }
    return 0
  }
}

/** The decoration a matched rule puts on its cell or row. */
export function ruleDecoration<T>(rule: ColumnRule, columns: readonly RuleColumn<T>[]): RuleDecoration {
  return {
    "data-rule": rule.id,
    "data-tone": rule.tone,
    "aria-description": rule.label?.trim() || describeRule(rule, columns),
    className: RULE_TONE_CLASS[rule.tone],
  }
}

export interface AppliedRules<T> {
  /** The first cell rule on this column that the row matches, or undefined. */
  cell: (columnKey: string, row: T) => RuleDecoration | undefined
  /** The first row rule the row matches, or undefined. Shaped for the grid's `getRowProps`. */
  getRowProps: (row: T) => RuleDecoration | undefined
  /** The rules that name a column the grid has, by column key, in the order they apply. */
  byColumn: ReadonlyMap<string, readonly ColumnRule[]>
}

/**
 * Column rules compiled once: each against its column, its decoration made ahead of time, and the
 * grid's two hooks, `cell` and `getRowProps`, answering per row with a matched rule's decoration. A
 * rule naming a column the grid does not have is skipped.
 */
export function applyRules<T>(rules: readonly ColumnRule[], columns: readonly RuleColumn<T>[]): AppliedRules<T> {
  const cells = new Map<string, { test: (row: T) => boolean; decoration: RuleDecoration }[]>()
  const rows: { test: (row: T) => boolean; decoration: RuleDecoration }[] = []
  const byColumn = new Map<string, ColumnRule[]>()
  for (const rule of rules) {
    const column = findColumn(columns, rule.column)
    if (!column) continue
    const compiled = { test: compileCondition(rule.when, column), decoration: ruleDecoration(rule, columns) }
    byColumn.set(rule.column, [...(byColumn.get(rule.column) ?? []), rule])
    if (rule.target === "row") rows.push(compiled)
    else cells.set(rule.column, [...(cells.get(rule.column) ?? []), compiled])
  }
  return {
    cell(columnKey, row) {
      const list = cells.get(columnKey)
      if (!list) return undefined
      for (const { test, decoration } of list) if (test(row)) return decoration
      return undefined
    },
    getRowProps(row) {
      for (const { test, decoration } of rows) if (test(row)) return decoration
      return undefined
    },
    byColumn,
  }
}
