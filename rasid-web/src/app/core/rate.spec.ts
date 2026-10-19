import { normaliseUnit, parseRate, perUnitTax, quantityIn } from './rate';

describe('parseRate', () => {
  // Every format seen in PRAL's SaleTypeToRate descriptions, plus what users type into sheets.
  it.each<[string, number, ReturnType<typeof parseRate>['perUnit'], boolean]>([
    ['18%', 18, undefined, false],
    ['17%', 17, undefined, false],
    ['1.43%', 1.43, undefined, false],
    ['19.5%', 19.5, undefined, false],
    ['18 %', 18, undefined, false],
    ['0%', 0, undefined, false],
    ['18', 18, undefined, false],
    ['Exempt', 0, undefined, true],
    ['EXEMPT', 0, undefined, true],
    ['Zero rated', 0, undefined, false],
    ['Zero-rated', 0, undefined, false],
    ['18% along with rupees 60 per kilogram', 18, { amount: 60, unit: 'KG' }, false],
    ['18% along with Rs. 1,000 per MT', 18, { amount: 1000, unit: 'MT' }, false],
    ['Rs.60 per kg', 0, { amount: 60, unit: 'KG' }, false],
    ['Rs 1000/MT', 0, { amount: 1000, unit: 'MT' }, false],
    ['PKR 2.5/kWh', 0, { amount: 2.5, unit: 'KWH' }, false],
    ['60 rupees per litre', 0, { amount: 60, unit: 'Liter' }, false],
    ['5% along with rupees 10 per SIM', 5, { amount: 10, unit: 'sim' }, false],
  ])('%s', (text, percent, perUnit, exempt) => {
    const r = parseRate(text);
    expect(r).toEqual({ percent, exempt, ok: true, ...(perUnit ? { perUnit } : {}) });
  });

  it.each(['', '   ', 'n/a', 'DTRE', null, undefined])('cannot read %j', text => {
    expect(parseRate(text)).toEqual({ percent: 0, exempt: false, ok: false });
  });
});

describe('units of a per-unit amount', () => {
  it('normalises the names PRAL and users write', () => {
    expect(['kilogram', 'KGs', 'kg.'].map(normaliseUnit)).toEqual(['KG', 'KG', 'KG']);
    expect(['Metric Ton', 'tonne', 'MT', 'Ton'].map(normaliseUnit)).toEqual(['MT', 'MT', 'MT', 'MT']);
    expect(normaliseUnit('Numbers, pieces, units')).toBe('Numbers, pieces, units');
  });
  it('counts the line in the amount’s unit, converting mass', () => {
    expect(quantityIn('KG', 'KG', 10)).toBe(10);
    expect(quantityIn('KG', 'Ton', 2)).toBe(2000);
    expect(quantityIn('MT', 'KG', 500)).toBe(0.5);
    expect(quantityIn('KG', 'Gram', 1500)).toBe(1.5);
    expect(quantityIn('KG', 'Liter', 10)).toBeUndefined();
  });
  it('the fixed part is amount × quantity, or 0 when the units do not compare', () => {
    expect(perUnitTax({ amount: 60, unit: 'KG' }, 'KG', 10)).toBe(600);
    expect(perUnitTax({ amount: 60, unit: 'KG' }, 'Ton', 1)).toBe(60_000);
    expect(perUnitTax({ amount: 60, unit: 'KG' }, 'Numbers, pieces, units', 10)).toBe(0);
    expect(perUnitTax(undefined, 'KG', 10)).toBe(0);
  });
});
