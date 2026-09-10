import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openTestPage, test } from './fixtures';

const PRODUCT_PAGE = readFileSync(
  join(process.cwd(), 'tests', 'fixtures', 'product-demo.html'),
  'utf8',
);

const PASSPHRASE = 'synthetic-demo-passphrase';
const DETAILS = [
  { label: 'Demo name', category: 'NAME', value: 'Ada Synthetic' },
  { label: 'Demo email', category: 'EMAIL', value: 'vault_demo_4812@example.test' },
  { label: 'Demo phone', category: 'PHONE', value: '555-481-2000' },
  { label: 'Demo address', category: 'ADDRESS', value: '42 Synthetic Lane' },
] as const;

async function addDetail(
  panel: Page,
  detail: (typeof DETAILS)[number],
): Promise<void> {
  await panel.getByLabel('Detail label').fill(detail.label);
  await panel.getByLabel('Detail category').selectOption(detail.category);
  await panel.getByLabel('Detail value').fill(detail.value);
  await panel.getByRole('button', { name: 'Encrypt and save' }).click();
  await expect(panel.getByRole('status')).toHaveText('Detail encrypted and saved.');
}

test('persistent saved details execute locally and produce a value-free run audit', async ({
  extContext,
  panel,
}) => {
  const page = await openTestPage(extContext, PRODUCT_PAGE);

  await panel.getByRole('tab', { name: 'Secure Vault' }).click();
  await panel.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await panel.getByRole('button', { name: 'Create Vault' }).click();
  await expect(panel.getByText('🔓 Vault unlocked locally')).toBeVisible();
  for (const detail of DETAILS) await addDetail(panel, detail);

  const vaultText = await panel.getByRole('region', { name: 'Secure Vault' }).innerText();
  for (const detail of DETAILS) expect(vaultText).not.toContain(detail.value);
  await expect(panel.getByText('USER_NAME_1', { exact: false })).toBeVisible();
  await expect(panel.getByText('USER_EMAIL_1', { exact: false })).toBeVisible();

  // A panel restart creates a new vault service: ciphertext persists, key/plaintext do not.
  await panel.reload();
  await expect(panel.locator('h1')).toHaveText('PrivAgent');
  await panel.getByRole('tab', { name: 'Secure Vault' }).click();
  await expect(panel.getByText('🔒 Secure Vault locked')).toBeVisible();
  await panel.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await panel.getByRole('button', { name: 'Unlock' }).click();
  await expect(panel.getByText('🔓 Vault unlocked locally')).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Stored details' }).getByRole('listitem')).toHaveCount(4);

  await panel.getByRole('tab', { name: 'Run Agent' }).click();
  await panel.getByPlaceholder(/fill the form/).fill('Fill the form with my saved details and submit');
  await panel.getByTestId('planner-mode-offline').check();
  await page.bringToFront();
  await panel.getByRole('button', { name: 'Run agent task' }).dispatchEvent('click');
  await expect(panel.getByTestId('agent-result')).toContainText('Task completed');
  await expect(panel.getByTestId('agent-result')).toContainText('5 actions executed');

  await expect(page.locator('input[name="name"]')).toHaveValue(DETAILS[0].value);
  await expect(page.locator('input[name="email"]')).toHaveValue(DETAILS[1].value);
  await expect(page.locator('input[name="phone"]')).toHaveValue(DETAILS[2].value);
  await expect(page.locator('input[name="address"]')).toHaveValue(DETAILS[3].value);
  await expect(page.getByRole('status')).toHaveText('PROFILE SUBMITTED');

  await panel.getByRole('tab', { name: 'Privacy Audit' }).click();
  await expect(panel.getByTestId('outbound-audit')).toContainText('Raw sensitive values in outbound payload: 0');
  await expect(panel.getByTestId('outbound-audit')).toContainText('Raw pixels/images in outbound payload: 0');
  await panel.getByText('View sanitized outbound payload').click();
  const auditText = await panel.locator('#panel-audit').innerText();
  expect(auditText).toContain('USER_EMAIL_1');
  expect(auditText).toContain('resolved on-device');
  for (const detail of DETAILS) expect(auditText).not.toContain(detail.value);

  // Locked saved-detail requests stop locally before any planner payload is approved.
  await panel.getByRole('tab', { name: 'Secure Vault' }).click();
  await panel.getByRole('button', { name: 'Lock' }).click();
  await page.reload();
  await panel.getByRole('tab', { name: 'Run Agent' }).click();
  await page.bringToFront();
  await panel.getByRole('button', { name: 'Run agent task' }).dispatchEvent('click');
  await expect(panel.getByTestId('agent-result')).toContainText('Secure Vault is locked');
  await panel.getByRole('tab', { name: 'Privacy Audit' }).click();
  await expect(panel.getByText('No firewall-approved planner payload recorded.')).toBeVisible();
});
