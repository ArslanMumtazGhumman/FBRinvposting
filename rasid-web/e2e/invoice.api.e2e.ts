import { expect, test } from '@playwright/test';
import { fakeApi } from './fake-api';

test('a manual invoice with the HS type-ahead and PRAL rates is posted', async ({ page }) => {
  const api = await fakeApi(page);
  await page.goto('/invoices/new');
  await expect(page.getByRole('heading', { name: 'New invoice' })).toBeVisible();

  // Buyer.
  await page.getByLabel('Buyer name').fill('Metro Cash & Carry');
  await page.getByLabel('NTN or CNIC').fill('4410235');

  // HS type-ahead: type words, get "code · description" from FBR's list, pick with the keyboard.
  const line = page.locator('table.lines tbody tr').first();
  await line.getByLabel('Line 1 product', { exact: true }).fill('Refined sugar 50kg');
  const hs = page.getByRole('combobox', { name: 'Line 1 HS code' });
  await hs.fill('sugar');
  const options = page.getByRole('listbox', { name: 'HS codes' }).getByRole('option');
  await expect(options).toHaveText(['1701.1400 · Other cane sugar, raw', '1701.9910 · Refined sugar, cane or beet']);
  await hs.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await hs.press('Enter');
  await expect(hs).toHaveValue('1701.9910');
  await expect(page.getByRole('listbox', { name: 'HS codes' })).toHaveCount(0);
  expect(api.calls.filter(c => c.startsWith('GET /businesses/b1/reference/hs?'))).toEqual(['GET /businesses/b1/reference/hs?q=sugar&limit=20']);

  // FBR allows one unit for this code: it's selected, and it's the only unit offered.
  const unit = line.getByLabel('Line 1 unit', { exact: true });
  await expect(unit).toHaveValue('KG');
  await expect(unit.locator('option')).toHaveText(['KG']);

  // Rates come from the API for the sale type, invoice date and seller province: 7.5% isn't in the bundled list.
  await line.getByLabel('Line 1 sale type', { exact: true }).selectOption('Goods at Reduced Rate');
  const rate = line.getByLabel('Line 1 rate', { exact: true });
  await expect(rate.locator('option')).toHaveText(['7.5%']);
  await expect(rate).toHaveValue('7.5%');
  const today = await page.getByLabel('Date').inputValue();
  expect(api.calls).toContain(`GET /businesses/b1/reference/rates?province=Punjab&date=${today}`);

  await line.getByLabel('Line 1 quantity', { exact: true }).fill('10');
  await line.getByLabel('Line 1 unit price', { exact: true }).fill('155');
  await expect(line.getByLabel('Line 1 sales tax', { exact: true })).toHaveValue('116.25'); // 7.5% of 1,550

  // PRAL has SRO schedules for this rate: they're dropdowns, and the extra fields opened by themselves.
  const schedule = page.getByLabel('Line 1 SRO schedule', { exact: true });
  await expect(schedule.locator('option')).toHaveText(['Choose…', 'EIGHTH SCHEDULE Table 1']);
  await schedule.selectOption('EIGHTH SCHEDULE Table 1');
  const item = page.getByLabel('Line 1 SRO item', { exact: true });
  await expect(item.locator('option')).toHaveText(['Choose…', '50', '51']);
  await item.selectOption('50');

  await expect(page.getByText('All local checks pass')).toBeVisible();
  await page.getByRole('button', { name: /Post to FBR/ }).click();

  // Posted through the (fake) gateway; the detail page shows the FBR invoice number.
  await expect(page).toHaveURL(/\/invoices\/i_[^/]+$/);
  await expect(page.getByText(/1234567DI\d+/).first()).toBeVisible();
  expect(api.posted).toHaveLength(1);
  const [posted] = api.posted as { buyer: { name: string }; items: Record<string, unknown>[] }[];
  expect(posted!.buyer.name).toBe('Metro Cash & Carry');
  expect(posted!.items).toHaveLength(1);
  expect(posted!.items[0]).toMatchObject({
    hsCode: '1701.9910', uoM: 'KG', saleType: 'Goods at Reduced Rate', rate: '7.5%', quantity: 10,
    valueSalesExcludingST: 1550, salesTaxApplicable: 116.25, totalValues: 1666.25,
    sroScheduleNo: 'EIGHTH SCHEDULE Table 1', sroItemSerialNo: '50',
  });
});
