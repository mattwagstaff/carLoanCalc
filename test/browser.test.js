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

  // Segmented buttons and product cards are radio groups; click the label.
  const choose = async (field, value) => {
    await page.evaluate((f) => {
      const el = document.querySelector('[data-field="' + f + '"]');
      const group = el && el.closest('details');
      if (group) group.open = true;
    }, field);
    await page.click(`[data-field="${field}"] label[data-value="${value}"]`);
  };
  const chosen = (field) =>
    page.$eval(`[data-field="${field}"] input:checked`, (e) => e.value);
  const offered = (field) =>
    page.$$eval(`[data-field="${field}"] input`, (els) => els.map((e) => e.value));

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
      await choose('product', product);
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
      await choose('product', product);
      payments[product] = await page.$eval('.hero-card .hero-value', (e) => e.textContent);
    }
    assert.notStrictEqual(payments.secured, payments.unsecured, 'unsecured should cost more');
    assert.notStrictEqual(payments.secured, payments.dealer, 'dealer rate should differ');
    assert.notStrictEqual(payments.secured, payments.gfv, 'a GFV defers part of the balance');
    await choose('product', 'secured');
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

  // Whether a field is offered at all, independent of whether its accordion
  // happens to be collapsed — that is a separate, user-controlled thing.
  const visible = (id) => page.evaluate((f) => {
    const el = document.querySelector('[data-field="' + f + '"]');
    if (!el || el.hidden) return false;
    const group = el.closest('details');
    return !(group && group.hidden);
  }, id);

  await t.test('simple mode hides the intricate fields, detailed shows them', async () => {
    await page.click('[data-mode="simple"]');
    for (const id of ['dealerDelivery', 'stampDutyOverride', 'monthlyFee', 'rateChange1After',
      'insuranceCost', 'companyTaxRate', 'fbtRate']) {
      assert.strictEqual(await visible(id), false, `${id} should be hidden in simple mode`);
    }
    for (const id of ['vehiclePrice', 'vehicleCondition', 'priceBasis', 'interestRate',
      'termMonths', 'balloonMode', 'deposit', 'grossSalary']) {
      assert.strictEqual(await visible(id), true, `${id} should be visible in simple mode`);
    }
    await page.click('[data-mode="detailed"]');
    for (const id of ['dealerDelivery', 'stampDutyOverride', 'monthlyFee', 'insuranceCost']) {
      assert.strictEqual(await visible(id), true, `${id} should be visible in detailed mode`);
    }
  });

  await t.test('simple mode still produces the same numbers', async () => {
    await page.click('[data-mode="detailed"]');
    const detailed = await page.$eval('.hero-card .hero-value', (e) => e.textContent);
    await page.click('[data-mode="simple"]');
    const simple = await page.$eval('.hero-card .hero-value', (e) => e.textContent);
    assert.strictEqual(simple, detailed, 'hiding fields must not change the calculation');
    await page.click('[data-mode="detailed"]');
  });

  await t.test('the mode choice persists across a reload', async () => {
    await page.click('[data-mode="simple"]');
    await page.reload();
    assert.strictEqual(
      await page.getAttribute('[data-mode="simple"]', 'aria-pressed'), 'true');
    await page.click('[data-mode="detailed"]');
  });

  await t.test('GFV disappears from the product list on a used car', async () => {
    await choose('vehicleCondition', 'new');
    let products = await offered('product');
    assert.ok(products.includes('gfv'), 'GFV should be offered on a new car');

    await choose('vehicleCondition', 'used');
    products = await offered('product');
    assert.ok(!products.includes('gfv'), 'GFV should not be offered on a used car');
    // everything else survives
    ['secured', 'unsecured', 'dealer', 'novated', 'chattel', 'cash']
      .forEach((p) => assert.ok(products.includes(p), `${p} should still be offered`));
  });

  await t.test('selecting used while on GFV falls back to a secured loan', async () => {
    await choose('vehicleCondition', 'new');
    await choose('product', 'gfv');
    assert.strictEqual(await chosen('product'), 'gfv');
    await choose('vehicleCondition', 'used');
    assert.strictEqual(await chosen('product'), 'secured');
    const hero = await page.$eval('.hero-card .hero-value', (e) => e.textContent);
    assert.ok(!/NaN|undefined/.test(hero), `hero broke after fallback: ${hero}`);
  });

  await t.test('used cars hide first-sale-only charges', async () => {
    await choose('vehicleCondition', 'used');
    assert.strictEqual(await visible('dealerDelivery'), false, 'no dealer delivery on a used car');
    assert.strictEqual(await visible('vehicleAge'), true, 'age drives depreciation and EV rules');
    await choose('vehicleCondition', 'new');
    assert.strictEqual(await visible('dealerDelivery'), true);
    assert.strictEqual(await visible('vehicleAge'), false);
  });

  await t.test('a drive-away price is not double counted', async () => {
    await choose('vehicleCondition', 'new');
    await setField('vehiclePrice', '50000');
    await choose('priceBasis', 'beforeOnRoads');
    await page.click('.tab[data-tab="summary"]');
    const before = await page.$eval('#panel-summary', (e) => e.innerText);
    await choose('priceBasis', 'driveaway');
    const after = await page.$eval('#panel-summary', (e) => e.innerText);
    assert.notStrictEqual(before, after, 'price basis should change the breakdown');
    const driveAway = after.match(/Drive-away price\s*\$([\d,]+)/);
    assert.ok(driveAway, 'drive-away total should be shown');
    assert.strictEqual(driveAway[1].replace(/,/g, ''), '50000',
      'the drive-away total must equal what was entered');
    await choose('priceBasis', 'beforeOnRoads');
  });

  await t.test('sections appear only when the finance type needs them', async () => {
    const section = (id) => page.evaluate(
      (g) => !document.getElementById('group-' + g).hidden, id);

    await page.click('[data-mode="detailed"]');
    await choose('product', 'secured');
    assert.strictEqual(await section('novated'), false, 'no novated panel on a loan');
    assert.strictEqual(await section('business'), false, 'no business panel on a consumer loan');

    await choose('product', 'novated');
    assert.strictEqual(await section('novated'), true, 'novated panel should appear');
    assert.strictEqual(await section('business'), false);

    await choose('product', 'chattel');
    assert.strictEqual(await section('business'), true, 'business panel should appear');
    assert.strictEqual(await section('novated'), false);

    await choose('product', 'secured');
  });

  await t.test('the selected option is visually marked, not just checked', async () => {
    await choose('vehicleCondition', 'used');
    const marked = await page.$eval(
      '[data-field="vehicleCondition"] label[data-value="used"]',
      (el) => getComputedStyle(el).backgroundColor);
    const other = await page.$eval(
      '[data-field="vehicleCondition"] label[data-value="new"]',
      (el) => getComputedStyle(el).backgroundColor);
    assert.notStrictEqual(marked, other, 'the chosen button must look different');
    await choose('vehicleCondition', 'new');
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
