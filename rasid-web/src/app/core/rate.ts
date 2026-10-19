/**
 * Reading FBR rate strings, in one place. PRAL's SaleTypeToRate descriptions
 * (and what users type) come as:
 *   "18%", "1.43%", "18 %", "18"            a percentage of value (or retail price)
 *   "Exempt", "EXEMPT"                       no tax
 *   "0%", "Zero rated", "Zero-rated"         0%
 *   "18% along with rupees 60 per kilogram"  a percentage plus a fixed amount per unit
 *   "Rs.60 per kg", "Rs 1000/MT", "PKR 2.5/kWh"  a fixed amount per unit only
 * computeLine (tax.ts) uses PRAL's numeric value for the percentage when the
 * API gives one, and this module for everything else.
 */
import { UOMS } from './fbr-reference';

/** Units a per-unit amount can be stated in, as Rasid's UOM names. */
const UNIT_ALIASES: [RegExp, string][] = [
  [/^(kg|kgs|kilo|kilos|kilogram|kilograms)$/, 'KG'],
  [/^(g|gm|gms|gram|grams)$/, 'Gram'],
  [/^(mt|ton|tons|tonne|tonnes|metric ton|metric tons|metric tonne)$/, 'MT'],
  [/^(l|ltr|ltrs|litre|litres|liter|liters)$/, 'Liter'],
  [/^(kwh|unit of electricity)$/, 'KWH'],
  [/^(mmbtu)$/, 'MMBTU'],
  [/^(unit|units|piece|pieces|pc|pcs|no|nos|number|numbers)$/, 'Numbers, pieces, units'],
];

export interface PerUnitAmount {
  /** Rupees per unit. */
  amount: number;
  /** Rasid's UOM name when recognised (KG, MT, Liter …), else the text as written, lower case. */
  unit: string;
}

export interface ParsedRate {
  /** Percentage of the taxable value; 0 for exempt, zero-rated and fixed-only rates. */
  percent: number;
  /** A fixed amount per unit charged on top of the percentage. */
  perUnit?: PerUnitAmount;
  exempt: boolean;
  /** False when nothing in the text could be read as a rate (percent is then 0). */
  ok: boolean;
}

const num = (s: string) => Number(s.replace(/,/g, ''));

/** A unit as Rasid's UOM name (KG, MT, Liter …): an alias, or a UOM name in any case; else lower case as written. */
export function normaliseUnit(text: string): string {
  const t = text.trim().toLowerCase().replace(/\.$/, '').replace(/\s+/g, ' ');
  return UNIT_ALIASES.find(([re]) => re.test(t))?.[1] ?? UOMS.find(u => u.toLowerCase() === t) ?? t;
}

export function parseRate(text: string | null | undefined): ParsedRate {
  const s = String(text ?? '').trim();
  if (!s) return { percent: 0, exempt: false, ok: false };
  if (/\bexempt/i.test(s)) return { percent: 0, exempt: true, ok: true };
  if (/^zero[\s-]*rated?$/i.test(s)) return { percent: 0, exempt: false, ok: true };

  // "rupees 60 per kilogram", "Rs.60/kg", "PKR 2.5 per kWh", "60 rupees per kg"
  const fixed = /(?:\b(?:rs|rupees?|pkr)\.?\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*(?:rs|rupees?|pkr)\b\.?)\s*(?:\/|\bper\b)\s*([a-z][a-z .]*?)\s*$/i.exec(s);
  const perUnit = fixed ? { amount: num(fixed[1] ?? fixed[2]!), unit: normaliseUnit(fixed[3]!) } : undefined;

  const pct = /(-?\d+(?:\.\d+)?)\s*%/.exec(s);
  if (pct) return { percent: parseFloat(pct[1]!), perUnit, exempt: false, ok: true };
  if (perUnit) return { percent: 0, perUnit, exempt: false, ok: true };
  // A bare number is a percentage ("18").
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return { percent: parseFloat(s), exempt: false, ok: true };
  return { percent: 0, exempt: false, ok: false };
}

/** Mass units that convert into each other, in kilograms. */
const KG_PER: Record<string, number> = { KG: 1, Gram: 0.001, MT: 1000 };

/**
 * How many of `perUnit.unit` a line holds: the quantity itself when the units
 * match, converted for mass (Gram / KG / Ton / MT), and undefined when they
 * can't be compared (the fixed part is then left for the user and FBR to settle).
 */
export function quantityIn(unit: string, lineUom: string, quantity: number): number | undefined {
  const lineUnit = normaliseUnit(lineUom);
  if (lineUnit === unit) return quantity;
  const from = KG_PER[lineUnit];
  const to = KG_PER[unit];
  return from !== undefined && to !== undefined ? (quantity * from) / to : undefined;
}

/** The fixed part of a rate for a line, in rupees (0 when the rate has none or the units don't compare). */
export function perUnitTax(perUnit: PerUnitAmount | undefined, lineUom: string, quantity: number): number {
  if (!perUnit) return 0;
  const q = quantityIn(perUnit.unit, lineUom, quantity);
  return q === undefined ? 0 : perUnit.amount * q;
}
