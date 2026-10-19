/**
 * FBR reference data.
 *
 * With the API, rates, UOMs, HS codes and HS→UOM rules come from PRAL's
 * reference APIs, cached nightly by rasid-api and read through
 * ReferenceService. The lists below are for the offline demo and the fallback
 * when the API has no PRAL copy; their rates are illustrative. Sale type
 * behaviour (scenario, retail price, exempt), scenarios and error help are
 * not in PRAL's lists and live only here.
 */

export const PROVINCES = [
  'Punjab', 'Sindh', 'Khyber Pakhtunkhwa', 'Balochistan',
  'Capital Territory', 'Gilgit Baltistan', 'Azad Jammu and Kashmir',
] as const;

export const UOMS = [
  'Numbers, pieces, units', 'KG', 'Liter', 'Meter', 'Square Metre', 'Cubic Metre',
  'Dozen', 'Pair', 'Ton', 'Gram', 'KWH', 'MMBTU', 'Bag', 'Carton', 'Packet', 'Set', 'Bill of lading',
];

export interface SaleTypeDef {
  name: string;               // exact saleType string sent to FBR
  scenario: string;           // primary sandbox scenario
  /** Offline demo and fallback only; live rates come from PRAL via ReferenceService. First = default. */
  offlineRates: string[];
  usesRetailPrice?: boolean;  // tax computed on retail price (3rd schedule)
  exempt?: boolean;
  note?: string;
}

export const SALE_TYPES: SaleTypeDef[] = [
  { name: 'Goods at standard rate (default)', scenario: 'SN001', offlineRates: ['18%'] },
  { name: 'Goods at Reduced Rate', scenario: 'SN005', offlineRates: ['1%', '5%', '10%', '12%', '15%', '16%'] },
  { name: 'Exempt Goods', scenario: 'SN006', offlineRates: ['Exempt'], exempt: true },
  { name: 'Goods at zero-rate', scenario: 'SN007', offlineRates: ['0%'] },
  { name: '3rd Schedule Goods', scenario: 'SN008', offlineRates: ['18%'], usesRetailPrice: true, note: 'Tax is charged on printed retail price × quantity.' },
  { name: 'Steel Melting and re-rolling', scenario: 'SN003', offlineRates: ['18%'] },
  { name: 'Ship breaking', scenario: 'SN004', offlineRates: ['18%'] },
  { name: 'Cotton Ginners', scenario: 'SN009', offlineRates: ['18%'] },
  { name: 'Telecommunication services', scenario: 'SN010', offlineRates: ['17%', '19.5%'] },
  { name: 'Toll Manufacturing', scenario: 'SN011', offlineRates: ['18%'] },
  { name: 'Petroleum Products', scenario: 'SN012', offlineRates: ['1.43%', '0%'] },
  { name: 'Electricity Supply to Retailers', scenario: 'SN013', offlineRates: ['5%', '7.5%'] },
  { name: 'Gas to CNG stations', scenario: 'SN014', offlineRates: ['18%'] },
  { name: 'Mobile Phones', scenario: 'SN015', offlineRates: ['18%', '25%'] },
  { name: 'Processing/ Conversion of Goods', scenario: 'SN016', offlineRates: ['5%'] },
  { name: 'Goods (FED in ST Mode)', scenario: 'SN017', offlineRates: ['8%', '18%'] },
  { name: 'Services (FED in ST Mode)', scenario: 'SN018', offlineRates: ['8%', '16%'] },
  { name: 'Services', scenario: 'SN019', offlineRates: ['5%', '16%'] },
  { name: 'Electric Vehicle', scenario: 'SN020', offlineRates: ['1%'] },
  { name: 'Cement /Concrete Block', scenario: 'SN021', offlineRates: ['18%'] },
  { name: 'Potassium Chlorate', scenario: 'SN022', offlineRates: ['18%'] },
  { name: 'CNG Sales', scenario: 'SN023', offlineRates: ['18%'] },
  { name: 'Goods as per SRO.297(|)/2023', scenario: 'SN024', offlineRates: ['25%'] },
  { name: 'Non-Adjustable Supplies', scenario: 'SN025', offlineRates: ['0%', '1%'] },
];

export function saleTypeDef(name: string): SaleTypeDef | undefined {
  const n = name.trim().toLowerCase();
  return SALE_TYPES.find(s => s.name.toLowerCase() === n);
}

/** Small HS sample for the offline assistant; production uses /pdi/v1/itemdesccode (~12k codes). */
export const HS_SAMPLE: { code: string; desc: string; uom: string }[] = [
  { code: '0101.2100', desc: 'Live horses, pure-bred breeding animals', uom: 'Numbers, pieces, units' },
  { code: '1006.3090', desc: 'Rice, semi-milled or wholly milled, other', uom: 'KG' },
  { code: '1701.9910', desc: 'Refined cane or beet sugar', uom: 'KG' },
  { code: '2523.2900', desc: 'Portland cement, other', uom: 'KG' },
  { code: '2716.0000', desc: 'Electrical energy', uom: 'KWH' },
  { code: '2710.1210', desc: 'Motor spirit (petrol)', uom: 'Liter' },
  { code: '3004.9099', desc: 'Medicaments in measured doses, other', uom: 'Numbers, pieces, units' },
  { code: '3401.1100', desc: 'Soap for toilet use', uom: 'KG' },
  { code: '3923.2100', desc: 'Sacks and bags of polymers of ethylene', uom: 'KG' },
  { code: '5205.1100', desc: 'Cotton yarn, single, uncombed', uom: 'KG' },
  { code: '5208.1100', desc: 'Woven fabrics of cotton, plain weave', uom: 'Square Metre' },
  { code: '6109.1000', desc: 'T-shirts, knitted, of cotton', uom: 'Numbers, pieces, units' },
  { code: '7214.2000', desc: 'Bars and rods of iron, deformed (rebar)', uom: 'KG' },
  { code: '8415.1010', desc: 'Air conditioners, split system', uom: 'Numbers, pieces, units' },
  { code: '8432.1010', desc: 'Agricultural machinery, chisel ploughs', uom: 'Numbers, pieces, units' },
  { code: '8471.3020', desc: 'Laptops and notebooks', uom: 'Numbers, pieces, units' },
  { code: '8517.1219', desc: 'Mobile phones, other', uom: 'Numbers, pieces, units' },
  { code: '8703.8090', desc: 'Electric motor vehicles, other', uom: 'Numbers, pieces, units' },
  { code: '9801.0000', desc: 'Services (general)', uom: 'Numbers, pieces, units' },
  { code: '9815.0000', desc: 'Advertisement services', uom: 'Numbers, pieces, units' },
];

/** HS codes that only accept one UOM — mirrors FBR errors 0096 / 0097. */
export const HS_UOM_RULES: Record<string, string> = {
  '2716.0000': 'KWH',
};

/* ---------------- Sandbox scenarios (spec section 9) ---------------- */

export const SCENARIOS: { id: string; description: string; saleType: string; buyerType?: 'Registered' | 'Unregistered' }[] = [
  { id: 'SN001', description: 'Goods at standard rate to registered buyers', saleType: 'Goods at standard rate (default)', buyerType: 'Registered' },
  { id: 'SN002', description: 'Goods at standard rate to unregistered buyers', saleType: 'Goods at standard rate (default)', buyerType: 'Unregistered' },
  { id: 'SN003', description: 'Sale of steel (melted and re-rolled)', saleType: 'Steel Melting and re-rolling' },
  { id: 'SN004', description: 'Sale by ship breakers', saleType: 'Ship breaking' },
  { id: 'SN005', description: 'Reduced rate sale', saleType: 'Goods at Reduced Rate' },
  { id: 'SN006', description: 'Exempt goods sale', saleType: 'Exempt Goods' },
  { id: 'SN007', description: 'Zero rated sale', saleType: 'Goods at zero-rate' },
  { id: 'SN008', description: 'Sale of 3rd schedule goods', saleType: '3rd Schedule Goods' },
  { id: 'SN009', description: 'Cotton spinners purchase from cotton ginners', saleType: 'Cotton Ginners' },
  { id: 'SN010', description: 'Telecom services rendered or provided', saleType: 'Telecommunication services' },
  { id: 'SN011', description: 'Toll manufacturing sale by steel sector', saleType: 'Toll Manufacturing' },
  { id: 'SN012', description: 'Sale of petroleum products', saleType: 'Petroleum Products' },
  { id: 'SN013', description: 'Electricity supply to retailers', saleType: 'Electricity Supply to Retailers' },
  { id: 'SN014', description: 'Sale of gas to CNG stations', saleType: 'Gas to CNG stations' },
  { id: 'SN015', description: 'Sale of mobile phones', saleType: 'Mobile Phones' },
  { id: 'SN016', description: 'Processing / conversion of goods', saleType: 'Processing/ Conversion of Goods' },
  { id: 'SN017', description: 'Sale of goods where FED is charged in ST mode', saleType: 'Goods (FED in ST Mode)' },
  { id: 'SN018', description: 'Services where FED is charged in ST mode', saleType: 'Services (FED in ST Mode)' },
  { id: 'SN019', description: 'Services rendered or provided', saleType: 'Services' },
  { id: 'SN020', description: 'Sale of electric vehicles', saleType: 'Electric Vehicle' },
  { id: 'SN021', description: 'Sale of cement / concrete block', saleType: 'Cement /Concrete Block' },
  { id: 'SN022', description: 'Sale of potassium chlorate', saleType: 'Potassium Chlorate' },
  { id: 'SN023', description: 'Sale of CNG', saleType: 'CNG Sales' },
  { id: 'SN024', description: 'Goods listed in SRO 297(I)/2023', saleType: 'Goods as per SRO.297(|)/2023' },
  { id: 'SN025', description: 'Drugs at fixed ST rate (Eighth Schedule, serial 81)', saleType: 'Non-Adjustable Supplies' },
  { id: 'SN026', description: 'Sale to end consumer by retailers (standard rate)', saleType: 'Goods at standard rate (default)', buyerType: 'Unregistered' },
  { id: 'SN027', description: 'Sale to end consumer by retailers (3rd schedule)', saleType: '3rd Schedule Goods', buyerType: 'Unregistered' },
  { id: 'SN028', description: 'Sale to end consumer by retailers (reduced rate)', saleType: 'Goods at Reduced Rate', buyerType: 'Unregistered' },
];

export const ACTIVITIES = ['Manufacturer', 'Importer', 'Distributor', 'Wholesaler', 'Exporter', 'Retailer', 'Service Provider', 'Other'] as const;
export const SECTORS = [
  'All Other Sectors', 'Steel', 'FMCG', 'Textile', 'Telecom', 'Petroleum', 'Electricity Distribution',
  'Gas Distribution', 'Services', 'Automobile', 'CNG Stations', 'Pharmaceuticals', 'Wholesale / Retails',
] as const;

const BASE = [1, 2, 5, 6, 7, 15, 16, 17, 21, 22, 24];
const RETAIL = [26, 27, 28, 8];
const SECTOR_EXTRA: Record<string, number[]> = {
  'All Other Sectors': [], 'Steel': [3, 4, 11], 'FMCG': [8], 'Textile': [9], 'Telecom': [10],
  'Petroleum': [12], 'Electricity Distribution': [13], 'Gas Distribution': [14], 'Services': [18, 19],
  'Automobile': [20], 'CNG Stations': [23], 'Pharmaceuticals': [25], 'Wholesale / Retails': [26, 27, 28, 8],
};

/** Applicable scenarios by business activity and sector (spec section 10). */
export function applicableScenarios(activity: string, sector: string): string[] {
  const extra = SECTOR_EXTRA[sector] ?? [];
  let ids: number[];
  switch (activity) {
    case 'Distributor':
    case 'Wholesaler':
      if (sector === 'All Other Sectors') ids = [...BASE, ...RETAIL];
      else if (sector === 'Wholesale / Retails') ids = [1, 2, ...RETAIL];
      else ids = [...extra, ...RETAIL];
      break;
    case 'Retailer':
      if (sector === 'All Other Sectors') ids = [...BASE, ...RETAIL];
      else if (sector === 'Steel') ids = [3, 4, 11];
      else ids = [...extra, ...RETAIL];
      break;
    case 'Service Provider':
      if (sector === 'All Other Sectors') ids = [...BASE, 18, 19];
      else ids = [...extra, 18, 19];
      break;
    case 'Manufacturer':
      if (sector === 'Steel') ids = [3, 4, 11];
      else if (sector === 'Pharmaceuticals') ids = [...BASE];
      else ids = [...BASE, ...extra];
      break;
    default: // Importer, Exporter, Other
      ids = [...BASE, ...extra];
  }
  return [...new Set(ids)].sort((a, b) => a - b).map(n => 'SN' + String(n).padStart(3, '0'));
}

/** Plain-language help for FBR error codes (spec sections 7–8). */
export const FBR_ERROR_HELP: Record<string, string> = {
  '0002': 'Buyer NTN must be 7 or 9 digits, or a 13-digit CNIC.',
  '0003': 'Invoice type must be "Sale Invoice" or "Debit Note".',
  '0005': 'Use date format YYYY-MM-DD, e.g. 2026-10-17.',
  '0009': 'Registered buyers need an NTN or CNIC.',
  '0010': 'Enter the buyer name.',
  '0012': 'Choose Registered or Unregistered for the buyer.',
  '0013': 'Pick a sale type from the list.',
  '0019': 'Add the HS code for this item.',
  '0026': 'Debit notes need the FBR number of the original invoice.',
  '0046': 'Pick a rate allowed for this sale type.',
  '0052': 'Use an HS code from FBR’s list that fits the selected sale type.',
  '0058': 'Buyer and seller cannot be the same registration number.',
  '0077': 'This sale type needs an SRO / schedule number.',
  '0078': 'This sale type needs the SRO item serial number.',
  '0090': 'Enter the printed retail price for 3rd schedule goods.',
  '0096': 'For this HS code only KWH is allowed as unit.',
  '0099': 'Unit of measure does not match the HS code.',
  '0102': 'Sales tax must equal retail price × rate for 3rd schedule goods.',
  '0104': 'Sales tax does not equal value × rate. Recalculate the line.',
  '0300': 'One of the amounts is not a valid number.',
  '0401': 'Your FBR token is not authorised for this seller NTN. Check Settings → FBR connection.',
  '0402': 'Buyer NTN/CNIC is not in a valid format.',
};
