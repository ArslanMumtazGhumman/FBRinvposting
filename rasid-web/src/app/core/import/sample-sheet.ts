/**
 * The "Try with sample data" sheet: a messy, realistic export with different
 * headers, DD/MM/YYYY dates, mixed NTN/CNIC formats and UOM spellings, and
 * three deliberate mistakes:
 *   row 8   short HS code "1701"        → 0019
 *   row 16  sales tax at 17%, not 18%  → 0104
 *   last    no buyer name              → 0010
 * Bills SB-2400…SB-2429 have two rows each (two lines per invoice).
 */
export function sampleSheet(): unknown[][] {
  const buyers = [
    ['Metro Cash & Carry', '4410235', 'Punjab'], ['Imtiaz Super Market', '3820114', 'Sindh'], ['Hamid & Sons', '5129903', 'Punjab'],
    ['Usman Kiryana', '35202-1234567-1', 'Punjab'], ['Peshawar Wholesale Mart', '2287741', 'KPK'],
  ];
  const items = [['Refined sugar 50kg', '17019910', 'KGS', 155], ['Basmati rice 25kg', '1006.3090', 'kg', 340], ['Polythene bags', '3923.2100', 'KG', 410], ['Beauty soap carton', '3401.1100', 'pcs', 6200]];
  const rows: unknown[][] = [['Bill #', 'Bill Date', 'Party Name', 'NTN', 'Province', 'City', 'PCT Code', 'Item Name', 'Unit', 'Qty', 'Rate/Unit', 'GST %', 'GST Amount']];
  for (let n = 0; n < 60; n++) {
    const b = buyers[n % buyers.length]; const it = items[n % 3];
    const qty = 20 + (n * 13) % 180; const val = qty * (it[3] as number);
    const bill = `SB-${2400 + Math.floor(n / 2)}`;
    let tax: number | string = Math.round(val * 0.18 * 100) / 100;
    let hs = it[1];
    if (n === 7) hs = '1701';                 // short HS code → 0019
    if (n === 15) tax = Math.round(val * 0.17); // wrong tax → 0104
    rows.push([bill, `${String(1 + (n % 27)).padStart(2, '0')}/10/2026`, b[0], b[1], b[2], b[2] === 'Sindh' ? 'Karachi' : 'Lahore', hs, it[0], it[2], qty, it[3], '18%', tax]);
  }
  rows.push(['SB-2430', '30/10/2026', '', '4410235', 'Punjab', 'Lahore', '1701.9910', 'Refined sugar 50kg', 'KG', 10, 155, '18%', 279]); // missing buyer → 0010
  return rows;
}
