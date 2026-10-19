import { expect, test } from '@playwright/test';

/** The offline demo (npm start): no API, bundled lists, the in-browser FBR simulator. */
test('offline demo: sign in, pick an HS code from the sample, post to the simulator', async ({ page }) => {
  const apiCalls: string[] = [];
  page.on('request', r => { if (new URL(r.url()).pathname.startsWith('/api/')) apiCalls.push(r.url()); });

  await page.goto('/login');
  await page.getByLabel('Email').fill('demo@alnoor.pk');
  await page.getByLabel('Password').fill('demo-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto('/invoices/new');
  await page.getByLabel('Buyer name').fill('Metro Cash & Carry');
  await page.getByLabel('NTN or CNIC').fill('4410235');
  const line = page.locator('table.lines tbody tr').first();
  await line.getByLabel('Line 1 product', { exact: true }).fill('Laptop');

  // The type-ahead searches the bundled sample offline.
  const hs = page.getByRole('combobox', { name: 'Line 1 HS code' });
  await hs.fill('laptop');
  await expect(page.getByRole('listbox', { name: 'HS codes' }).getByRole('option')).toHaveText(['8471.3020 · Laptops and notebooks']);
  await hs.press('Enter');
  await expect(hs).toHaveValue('8471.3020');

  // Bundled rates, not PRAL's.
  await line.getByLabel('Line 1 sale type', { exact: true }).selectOption('Goods at Reduced Rate');
  await expect(line.getByLabel('Line 1 rate', { exact: true }).locator('option')).toHaveText(['1%', '5%', '10%', '12%', '15%', '16%']);
  await line.getByLabel('Line 1 rate', { exact: true }).selectOption('10%');
  await line.getByLabel('Line 1 quantity', { exact: true }).fill('2');
  await line.getByLabel('Line 1 unit price', { exact: true }).fill('150000');
  await expect(line.getByLabel('Line 1 sales tax', { exact: true })).toHaveValue('30000');

  await page.getByRole('button', { name: /Post to FBR/ }).click();
  // The simulator answers 500 now and then; the app retries, so allow for that.
  await expect(page).toHaveURL(/\/invoices\/i_[^/]+$/, { timeout: 30_000 });
  await expect(page.getByText(/1234567DI\d+|\d{7}DI\d+/).first()).toBeVisible();
  expect(apiCalls).toEqual([]);
});
