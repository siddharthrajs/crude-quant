import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PRICE_FIELD_LABELS, PRICE_FIELDS, type PriceField } from "@/lib/ticks"

/** Which of the feed's price fields a chart plots -- the "add or remove information" control on every panel. */
export function FieldSelect({ value, onChange }: { value: PriceField; onChange: (field: PriceField) => void }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as PriceField)}>
      <SelectTrigger size="sm" className="h-6 w-24 text-xs">
        {/* Base UI's Select.Value only knows an item's label once that item has actually mounted
            (i.e. after the dropdown has opened once); before that it falls back to the raw value
            ("tradePrice" instead of "Trade"). A formatter sidesteps the lookup entirely. */}
        <SelectValue>{(v: PriceField) => PRICE_FIELD_LABELS[v] ?? v}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {PRICE_FIELDS.map((field) => (
          <SelectItem key={field} value={field} className="text-xs">
            {PRICE_FIELD_LABELS[field]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
