/**
 * The sale types Rasid offers, as written in PRAL's spec (v1.12, section 9) and
 * in rasid-web's SALE_TYPES (checked by test/contract.test.ts). Seeded into
 * the sale_types table (drizzle/0006_sale_types.sql); PRAL's transaction type
 * id for each is filled in from transtypecode (src/reference/sale-types.ts).
 * Pure data, so the payload builder can use it without a database.
 */
export interface SaleTypeSeed {
  name: string;
  /** Primary sandbox scenario. SN002 and SN026–SN028 are buyer-type variants of these (rasid-web SCENARIOS). */
  scenarioId: string;
  usesRetailPrice?: boolean;
  exempt?: boolean;
}

export const SALE_TYPE_SEED: readonly SaleTypeSeed[] = [
  { name: 'Goods at standard rate (default)', scenarioId: 'SN001' },
  { name: 'Goods at Reduced Rate', scenarioId: 'SN005' },
  { name: 'Exempt Goods', scenarioId: 'SN006', exempt: true },
  { name: 'Goods at zero-rate', scenarioId: 'SN007' },
  { name: '3rd Schedule Goods', scenarioId: 'SN008', usesRetailPrice: true },
  { name: 'Steel Melting and re-rolling', scenarioId: 'SN003' },
  { name: 'Ship breaking', scenarioId: 'SN004' },
  { name: 'Cotton Ginners', scenarioId: 'SN009' },
  { name: 'Telecommunication services', scenarioId: 'SN010' },
  { name: 'Toll Manufacturing', scenarioId: 'SN011' },
  { name: 'Petroleum Products', scenarioId: 'SN012' },
  { name: 'Electricity Supply to Retailers', scenarioId: 'SN013' },
  { name: 'Gas to CNG stations', scenarioId: 'SN014' },
  { name: 'Mobile Phones', scenarioId: 'SN015' },
  { name: 'Processing/ Conversion of Goods', scenarioId: 'SN016' },
  { name: 'Goods (FED in ST Mode)', scenarioId: 'SN017' },
  { name: 'Services (FED in ST Mode)', scenarioId: 'SN018' },
  { name: 'Services', scenarioId: 'SN019' },
  { name: 'Electric Vehicle', scenarioId: 'SN020' },
  { name: 'Cement /Concrete Block', scenarioId: 'SN021' },
  { name: 'Potassium Chlorate', scenarioId: 'SN022' },
  { name: 'CNG Sales', scenarioId: 'SN023' },
  { name: 'Goods as per SRO.297(|)/2023', scenarioId: 'SN024' },
  { name: 'Non-Adjustable Supplies', scenarioId: 'SN025' },
];
