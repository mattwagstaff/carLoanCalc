/*
 * End-to-end smoke test. Renders index.html in a real browser and drives the UI.
 *
 * Playwright is an optional dev dependency — if it is not installed, or no
 * browser is available, these tests skip rather than fail. The engine tests in
 * finance.test.js run everywhere with no dependencies.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const PAGE = 'file://' + path.join(__dirname, '..', 'index.html');
const EXECUTABLE = process.env.CHROMIUM_PATH ||
  (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

const PRODUCTS = ['secured', 'unsecured', 'dealer', 'gfv', 'novated', 'chattel', 'financeLease', 'cash'];
const TABS = ['summary', 'income', 'compare', 'equity', 'schedule', 'learn'];

test('browser smoke test', { skip: chromium ? false : 'playwright not installed' }, async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: EXECUTABLE });
  } catch (e) {
    t.skip('no browser available: ' + e.message);
    return;
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));

  await page.goto(PAGE);
  await page.click('#dlg-disclaimer button[value=ok]');

  // Fields live inside collapsed <details> groups, which are not interactable
  // until the group is open.
  const setField = async (id, value) => {
    await page.evaluate((f) => {
      const el = document.getElementById('f-' + f);
      const group = el && el.closest('details');
      if (group) group.open = true;
    }, id);
    await page.fill('#f-' + id, value);
  };

  await t.test('every tab renders content', async () => {
    for (const tab of TABS) {
      await page.click(`.tab[data-tab="${tab}"]`);
      const len = await page.$eval('#panel-' + tab, (e) => e.innerText.trim().length);
      assert.ok(len > 200, `tab ${tab} rendered only ${len} characters`);
    }
    await page.click('.tab[data-tab="summary"]');
  });

  await t.test('every product produces finite numbers everywhere', async () => {
    for (const product of PRODUCTS) {
      await page.selectOption('#f-product', product);
      for (const tab of TABS.slice(0, 5)) {
        await page.click(`.tab[data-tab="${tab}"]`);
        const junk = await page.$eval('#panel-' + tab, (e) => {
          const m = e.innerText.match(/NaN|undefined|Infinity|\[object/g);
          return m ? m.slice(0, 3).join(', ') : null;
        });
        assert.strictEqual(junk, null, `${product} / ${tab} rendered: ${junk}`);
      }
      const hero = await page.$eval('.hero-card .hero-value', (e) => e.textContent);
      assert.ok(!/NaN|undefined|Infinity/.test(hero), `${product} hero: ${hero}`);
    }
  });

  await t.test('the product choice actually changes the repayment', async () => {
    const payments = {};
    for (const product of ['secured', 'unsecured', 'dealer', 'gfv']) {
      await page.selectOption('#f-product', product);
      payments[product] = await page.$eval('.hero-card .hero-value', (e) => e.textContent);
    }
    assert.notStrictEqual(payments.secured, payments.unsecured, 'unsecured should cost more');
    assert.notStrictEqual(payments.secured, payments.dealer, 'dealer rate should differ');
    assert.notStrictEqual(payments.secured, payments.gfv, 'a GFV defers part of the balance');
    await page.selectOption('#f-product', 'secured');
  });

  await t.test('extreme inputs do not break the page', async () => {
    for (const [field, value] of [['grossSalary', '0'], ['vehiclePrice', ''],
      ['vehiclePrice', '250000'], ['deposit', '999999'], ['annualKm', '0']]) {
      await setField(field, value);
      const hero = await page.$eval('.hero-card .hero-value', (e) => e.textContent);
      assert.ok(!/NaN|undefined|Infinity/.test(hero), `${field}=${value} produced ${hero}`);
    }
    await setField('vehiclePrice', '45000');
    await setField('deposit', '5000');
    await setField('grossSalary', '95000');
    await setField('annualKm', '15000');
  });

  await t.test('inputs persist across a reload', async () => {
    await page.selectOption('#f-termMonths', '84');
    await page.reload();
    assert.strictEqual(await page.$eval('#f-termMonths', (e) => e.value), '84');
    await page.selectOption('#f-termMonths', '60');
  });

  await t.test('scenarios save and load', async () => {
    await page.click('#btn-scenarios');
    await page.fill('#scenario-name', 'Smoke test');
    await page.click('#btn-save-scenario');
    assert.strictEqual(await page.$$eval('.scenario', (e) => e.length), 1);
    await page.click('[data-load="0"]');
    assert.ok(await page.isHidden('#dlg-scenarios'));
  });

  await t.test('no horizontal scrolling on a phone', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const tab of TABS) {
      await page.click(`.tab[data-tab="${tab}"]`);
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1);
      assert.strictEqual(overflows, false, `tab ${tab} scrolls sideways on a 390px viewport`);
    }
  });

  await browser.close();
  assert.deepStrictEqual(problems, [], 'the page logged errors');
});
