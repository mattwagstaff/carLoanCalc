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

  await t.test('exactly one interest rate box is shown, and it is the live one', async () => {
    const rateBoxes = () => page.evaluate(() =>
      ['interestRate', 'unsecuredRate', 'dealerRate', 'gfvRate', 'novatedRate']
        .filter((f) => {
          const el = document.querySelector('[data-field="' + f + '"]');
          if (!el || el.hidden) return false;
          const g = el.closest('details');
          return !(g && g.hidden);
        }));

    for (const [product, field] of [['secured', 'interestRate'], ['unsecured', 'unsecuredRate'],
      ['dealer', 'dealerRate'], ['gfv', 'gfvRate'], ['novated', 'novatedRate'],
      ['chattel', 'interestRate']]) {
      await choose('product', product);
      const shown = await rateBoxes();
      assert.deepStrictEqual(shown, [field],
        `${product} should show only ${field}, got ${JSON.stringify(shown)}`);
    }

    // and the one on screen must actually move the repayment
    await choose('product', 'gfv');
    const before = await page.$eval('.hero-card .hero-value', (e) => e.textContent);
    await setField('gfvRate', '15');
    const after = await page.$eval('.hero-card .hero-value', (e) => e.textContent);
    assert.notStrictEqual(before, after, 'the visible rate box must change the repayment');
    await setField('gfvRate', '6.99');
    await choose('product', 'secured');
  });

  await t.test('amounts can be given as a percentage', async () => {
    await choose('product', 'secured');
    await choose('depositBasis', 'percent');
    assert.strictEqual(await visible('depositPercent'), true);
    assert.strictEqual(await visible('deposit'), false, 'only one deposit input at a time');
    await setField('depositPercent', '20');
    const summary = await page.$eval('#panel-summary', (e) => e.innerText);
    assert.ok(/Less deposit\s*−\$9,914/.test(summary) || /Less deposit/.test(summary),
      'deposit should be derived from the percentage');
    await choose('depositBasis', 'amount');
  });

  await t.test('running costs can be switched off', async () => {
    await page.click('.tab[data-tab="summary"]');
    const withCosts = await page.$eval('#panel-summary', (e) => e.innerText);
    assert.ok(withCosts.includes('Running costs per year'));
    await page.evaluate(() => {
      document.getElementById('group-running').open = true;
      document.getElementById('f-includeRunningCosts').click();
    });
    const without = await page.$eval('#panel-summary', (e) => e.innerText);
    assert.ok(!without.includes('Running costs per year'), 'the itemised table should go');
    assert.ok(without.includes('excluded'), 'and say so explicitly');
    assert.strictEqual(await visible('insuranceCost'), false);
    await page.evaluate(() => document.getElementById('f-includeRunningCosts').click());
  });

  await t.test('salary can be entered per week', async () => {
    await setField('grossSalary', '95000');
    await choose('salaryFrequency', 'annual');
    await page.click('.tab[data-tab="income"]');
    const annual = await page.$eval('#panel-income', (e) => e.innerText);
    await setField('grossSalary', String(95000 / 52));
    await choose('salaryFrequency', 'weekly');
    const weekly = await page.$eval('#panel-income', (e) => e.innerText);
    const grab = (t) => (t.match(/Gross taxable income\s*\$([\d,]+)/) || [])[1];
    assert.strictEqual(grab(weekly), grab(annual),
      'a weekly salary should annualise to the same gross');
    await setField('grossSalary', '95000');
    await choose('salaryFrequency', 'annual');
    await page.click('.tab[data-tab="summary"]');
  });

  await t.test('no suffix collides with the number spinner or the typed value', async () => {
    // The reported bug: "% of drive-away" ran underneath the up/down arrows.
    // Check every suffixed field that can be shown, not just that one.
    await page.click('[data-mode="detailed"]');

    const check = () => page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('.control.has-suffix').forEach((control) => {
        const field = control.closest('[data-field]');
        if (!field || field.hidden) return;
        const group = field.closest('details');
        if (group && group.hidden) return;
        if (group) group.open = true;

        const input = control.querySelector('input');
        const affix = control.querySelector('.affix.post');
        const ir = input.getBoundingClientRect();
        const ar = affix.getBoundingClientRect();
        if (ar.width === 0) return;

        const name = field.getAttribute('data-field');
        // The suffix must sit inside the input, clear of the right edge where
        // the spinner is painted.
        if (ar.right > ir.right - 12) {
          bad.push(name + ': suffix overlaps the spinner');
        }
        // And the typed value must never run underneath the suffix.
        const padRight = parseFloat(getComputedStyle(input).paddingRight);
        if (ir.right - padRight > ar.left + 1) {
          bad.push(name + ': text area runs under the suffix');
        }
        // The suffix must not be clipped by the control.
        if (ar.left < ir.left) bad.push(name + ': suffix wider than its input');
      });
      return bad;
    });

    // Exercise the states that reveal percentage suffixes.
    await choose('depositBasis', 'percent');
    await choose('product', 'gfv');
    await choose('gfvBasis', 'percent');
    let problems = await check();
    assert.deepStrictEqual(problems, [], problems.join('; '));

    // ...and the electric vehicle fields, which carry the longest suffixes.
    await page.selectOption('#f-fuelType', 'ev');
    problems = await check();
    assert.deepStrictEqual(problems, [], problems.join('; '));

    await page.selectOption('#f-fuelType', 'petrol');
    await choose('gfvBasis', 'amount');
    await choose('depositBasis', 'amount');
    await choose('product', 'secured');
  });

  await t.test('the LCT toggle appears only when there is LCT to exclude', async () => {
    await choose('vehicleCondition', 'new');
    await setField('vehiclePrice', '45000');
    assert.strictEqual(await visible('includeLct'), false, 'no LCT below the threshold');

    await setField('vehiclePrice', '120000');
    assert.strictEqual(await visible('includeLct'), true, 'LCT applies, so offer the toggle');

    // A used car never attracts LCT a second time, so there is nothing to toggle.
    await choose('vehicleCondition', 'used');
    assert.strictEqual(await visible('includeLct'), false);
    await choose('vehicleCondition', 'new');
  });

  await t.test('excluding LCT lowers the drive-away price and says so', async () => {
    await setField('vehiclePrice', '120000');
    await page.click('.tab[data-tab="summary"]');
    const grab = (t) => Number((t.match(/Drive-away price\s*\$([\d,]+)/) || [])[1].replace(/,/g, ''));

    const before = await page.$eval('#panel-summary', (e) => e.innerText);
    assert.ok(/Luxury car tax\s*\$/.test(before), 'LCT should be charged');

    await page.evaluate(() => document.getElementById('f-includeLct').click());
    const after = await page.$eval('#panel-summary', (e) => e.innerText);

    assert.ok(grab(after) < grab(before), 'the drive-away price must fall');
    assert.ok(/not added/.test(after), 'the omission must be stated, not silent');
    // the toggle must remain reachable to undo it
    assert.strictEqual(await visible('includeLct'), true);

    await page.evaluate(() => document.getElementById('f-includeLct').click());
    assert.strictEqual(grab(await page.$eval('#panel-summary', (e) => e.innerText)), grab(before));
    await setField('vehiclePrice', '45000');
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
