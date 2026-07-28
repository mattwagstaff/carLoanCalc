/*
 * Engine tests. Run with: npm test  (node --test)
 */
const test = require('node:test');
const assert = require('node:assert');
const R = require('../finance.js');

const near = (a, b, tol = 0.5) =>
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} to be within ${tol} of ${b}`);

/* ----------------------------- payments ----------------------------- */

test('paymentFor matches the standard annuity formula', () => {
  // $30,000 over 5 years at 7% p.a. monthly ≈ $594.04
  near(R.paymentFor(0.07 / 12, 60, 30000, 0, false), 594.04, 0.05);
});

test('paymentFor with a balloon is lower than without', () => {
  const withBalloon = R.paymentFor(0.07 / 12, 60, 30000, 10000, false);
  const without = R.paymentFor(0.07 / 12, 60, 30000, 0, false);
  assert.ok(withBalloon < without);
  near(withBalloon, 594.04 - 10000 * (0.07 / 12) / (Math.pow(1 + 0.07 / 12, 60) - 1), 0.05);
});

test('paymentFor handles a zero rate', () => {
  near(R.paymentFor(0, 60, 30000, 6000, false), 400, 0.001);
});

test('payments in advance are cheaper than in arrears', () => {
  const arrears = R.paymentFor(0.07 / 12, 60, 30000, 0, false);
  const advance = R.paymentFor(0.07 / 12, 60, 30000, 0, true);
  near(advance, arrears / (1 + 0.07 / 12), 0.001);
});

/* --------------------------- amortisation --------------------------- */

test('amortise clears the balance to zero with no balloon', () => {
  const s = R.amortise({ principal: 30000, annualRate: 7, periodsPerYear: 12, periods: 60 });
  near(s.finalBalance, 0, 0.01);
  near(s.scheduledPayment, 594.04, 0.05);
  near(s.totalInterest, s.totalPaid - 30000, 0.05);
});

test('amortise leaves exactly the balloon outstanding', () => {
  const s = R.amortise({ principal: 40000, annualRate: 8, periodsPerYear: 12, periods: 60, balloon: 12000 });
  near(s.finalBalance, 12000, 0.5);
});

test('totalPaid equals the sum of the payment column, in advance or arrears', () => {
  [true, false].forEach((advance) => {
    const s = R.amortise({
      principal: 40000, annualRate: 8, periodsPerYear: 12, periods: 60,
      balloon: 10000, paymentsInAdvance: advance, feePerPeriod: 15
    });
    const summed = s.rows.reduce((a, r) => a + r.payment, 0);
    near(s.totalPaid, summed, 0.05);
    // Principal repaid plus the residual must account for the whole advance.
    const principal = s.rows.reduce((a, r) => a + r.principal, 0);
    near(principal + s.finalBalance, 40000, 1);
  });
});

test('paying in advance costs less in total than paying in arrears', () => {
  const opts = { principal: 40000, annualRate: 8, periodsPerYear: 12, periods: 60 };
  const advance = R.amortise(Object.assign({ paymentsInAdvance: true }, opts));
  const arrears = R.amortise(opts);
  assert.ok(advance.totalPaid < arrears.totalPaid,
    `advance ${advance.totalPaid} should be below arrears ${arrears.totalPaid}`);
});

test('amortise adds account fees to the payment but not to interest', () => {
  const plain = R.amortise({ principal: 30000, annualRate: 7, periodsPerYear: 12, periods: 60 });
  const fees = R.amortise({ principal: 30000, annualRate: 7, periodsPerYear: 12, periods: 60, feePerPeriod: 10 });
  near(fees.scheduledPayment - plain.scheduledPayment, 10, 0.001);
  near(fees.totalInterest, plain.totalInterest, 0.001);
  near(fees.totalFees, 600, 0.001);
});

test('extra repayments shorten the term and cut interest', () => {
  const plain = R.amortise({ principal: 30000, annualRate: 7, periodsPerYear: 12, periods: 60 });
  const extra = R.amortise({ principal: 30000, annualRate: 7, periodsPerYear: 12, periods: 60, extraPerPeriod: 200 });
  assert.ok(extra.periods < plain.periods, 'term should shorten');
  assert.ok(extra.totalInterest < plain.totalInterest, 'interest should fall');
});

test('a rate rise mid-term recalculates the payment upward', () => {
  const s = R.amortise({
    principal: 30000, annualRate: 7, periodsPerYear: 12, periods: 60,
    rateChanges: [{ afterPeriods: 24, annualRate: 10 }]
  });
  assert.ok(s.rows[30].payment > s.rows[10].payment, 'payment should rise after the change');
  near(s.finalBalance, 0, 0.5);
});

test('weekly and monthly schedules cost about the same', () => {
  const monthly = R.amortise({ principal: 30000, annualRate: 7, periodsPerYear: 12, periods: 60 });
  const weekly = R.amortise({ principal: 30000, annualRate: 7, periodsPerYear: 52, periods: 260 });
  near(weekly.totalInterest, monthly.totalInterest, 200);
});

/* ------------------------- effective rate --------------------------- */

test('effective rate equals the nominal rate when there are no fees', () => {
  const s = R.amortise({ principal: 30000, annualRate: 7, periodsPerYear: 12, periods: 60 });
  near(R.effectiveRate(30000, s.rows, 0, 12), 7, 0.02);
});

test('fees push the effective rate above the nominal rate', () => {
  const s = R.amortise({ principal: 30400, annualRate: 7, periodsPerYear: 12, periods: 60, feePerPeriod: 10 });
  const eff = R.effectiveRate(30000, s.rows, 0, 12);
  assert.ok(eff > 7.5, `expected effective rate above 7.5%, got ${eff}`);
});

/* ------------------------------- tax -------------------------------- */

test('2025-26 tax on $100,000 is $20,788 before Medicare', () => {
  // 26,800 @ 16% + 55,000 @ 30%
  near(R.marginalTax(100000, R.TAX_YEARS['2025-26'].brackets), 20788, 1);
});

test('2026-27 drops the lowest rate to 15%', () => {
  const y2526 = R.marginalTax(45000, R.TAX_YEARS['2025-26'].brackets);
  const y2627 = R.marginalTax(45000, R.TAX_YEARS['2026-27'].brackets);
  near(y2526 - y2627, 26800 * 0.01, 1);
});

test('tax free threshold produces no tax', () => {
  assert.strictEqual(R.marginalTax(18200, R.TAX_YEARS['2026-27'].brackets), 0);
});

test('Medicare levy shades in and then hits 2%', () => {
  const cfg = R.TAX_YEARS['2025-26'].medicare;
  assert.strictEqual(R.medicareLevy(25000, cfg, {}), 0);
  near(R.medicareLevy(30000, cfg, {}), (30000 - 27222) * 0.10, 1);
  near(R.medicareLevy(90000, cfg, {}), 1800, 1);
});

test('study loan repayments are marginal, not a cliff', () => {
  assert.strictEqual(R.helpRepayment(66000), 0);
  near(R.helpRepayment(75000), (75000 - 67000) * 0.15, 1);
  near(R.helpRepayment(150000), 58000 * 0.15 + 25000 * 0.17, 1);
});

test('MLS is avoided with private hospital cover', () => {
  assert.strictEqual(R.medicareLevySurcharge(150000, { privateHospitalCover: true }), 0);
  near(R.medicareLevySurcharge(150000, {}), 150000 * 0.0125, 1);
});

test('a reportable fringe benefit lifts study loan repayments', () => {
  const base = { taxableIncome: 90000, taxYear: '2026-27', hasStudyLoan: true };
  const withRfba = Object.assign({}, base, { reportableFringeBenefits: 15000 });
  assert.ok(R.taxPosition(withRfba).studyLoanRepayment > R.taxPosition(base).studyLoanRepayment);
  // ... but taxable income itself is unchanged
  assert.strictEqual(R.taxPosition(withRfba).incomeTax, R.taxPosition(base).incomeTax);
});

/* ------------------------ purchase costs ---------------------------- */

test('LCT applies only above the threshold', () => {
  assert.strictEqual(R.luxuryCarTax(70000, false), 0);
  near(R.luxuryCarTax(100000, false), 0.33 * (100000 - 80567) / 1.1, 1);
  // fuel efficient vehicles get the higher threshold
  assert.strictEqual(R.luxuryCarTax(90000, true), 0);
  assert.ok(R.luxuryCarTax(90000, false) > 0);
});

test('NSW stamp duty follows the two-step scale', () => {
  near(R.stampDuty('NSW', 40000, {}), 1200, 0.5);
  near(R.stampDuty('NSW', 60000, {}), 1350 + 15000 * 0.05, 0.5);
});

test('VIC duty steps up past the LCT threshold', () => {
  near(R.stampDuty('VIC', 40000, {}), Math.ceil(40000 / 200) * 8.40, 0.5);
  assert.ok(R.stampDuty('VIC', 120000, {}) > R.stampDuty('VIC', 99000, {}));
});

test('QLD charges less duty on an EV than a V8', () => {
  assert.ok(R.stampDuty('QLD', 60000, { fuelType: 'ev' }) <
            R.stampDuty('QLD', 60000, { fuelType: 'petrol', cylinders: 8 }));
});

test('ACT exempts zero emission vehicles', () => {
  assert.strictEqual(R.stampDuty('ACT', 60000, { fuelType: 'ev' }), 0);
});

test('every state returns a plausible duty figure', () => {
  R.STATES.forEach((s) => {
    const d = R.stampDuty(s, 45000, { fuelType: 'petrol', cylinders: 4 });
    assert.ok(d > 0 && d < 6000, `${s} duty out of range: ${d}`);
  });
});

test('drive-away price is the sum of its parts', () => {
  const c = R.purchaseCosts({
    vehiclePrice: 45000, dealerDelivery: 2000, optionsAndAccessories: 1000,
    state: 'NSW', fuelType: 'petrol', registrationCost: 400, ctpCost: 600,
    plateAndTransferFees: 100
  });
  near(c.priceBeforeOnRoads, 48000, 0.01);
  near(c.driveAwayPrice, 48000 + c.luxuryCarTax + c.stampDuty + 1100, 0.01);
  near(c.gstComponent, 48000 - 48000 / 1.1, 0.01);
});

/* --------------------------- loan model ----------------------------- */

const baseInput = {
  vehiclePrice: 45000, dealerDelivery: 0, optionsAndAccessories: 0,
  state: 'VIC', fuelType: 'petrol', vehicleType: 'passenger', cylinders: 4,
  registrationCost: 900, ctpCost: 0, plateAndTransferFees: 100,
  deposit: 5000, tradeInValue: 0, tradeInPayout: 0,
  product: 'secured', interestRate: 7.5, termMonths: 60,
  paymentFrequency: 'monthly', balloonMode: 'none',
  establishmentFee: 400, monthlyFee: 10,
  annualKm: 15000, fuelEconomy: 8, fuelPrice: 2.0,
  insuranceCost: 1400, annualRegistration: 900, servicingCost: 600,
  tyresCost: 300, roadsideCost: 100, otherRunningCost: 0,
  grossSalary: 95000, taxYear: '2026-27', paymentFrequencyIncome: 'fortnightly',
  livingExpenses: 3000, otherDebtRepayments: 0,
  depreciationFirstYear: 20, depreciationOngoing: 14
};

test('loan model produces a coherent set of numbers', () => {
  const m = R.loanModel(baseInput);
  assert.ok(m.financedAmount > 40000 && m.financedAmount < 48000);
  assert.ok(m.payment > 0);
  near(m.totalRepayments, m.financedAmount + m.totalInterest + m.totalFees - 400, 5);
  assert.ok(m.effectiveRate > m.annualRate, 'fees should lift the effective rate');
  assert.strictEqual(m.periods, 60);
});

test('a balloon lowers the repayment and raises total interest', () => {
  const noBalloon = R.loanModel(baseInput);
  const balloon = R.loanModel(Object.assign({}, baseInput, { balloonMode: 'percent', balloonPercent: 30 }));
  assert.ok(balloon.payment < noBalloon.payment);
  assert.ok(balloon.totalInterest > noBalloon.totalInterest);
  near(balloon.balloon, balloon.financedAmount * 0.3, 1);
});

test('a bigger deposit means less interest', () => {
  const small = R.loanModel(Object.assign({}, baseInput, { deposit: 2000 }));
  const large = R.loanModel(Object.assign({}, baseInput, { deposit: 15000 }));
  assert.ok(large.totalInterest < small.totalInterest);
});

test('negative equity is detected with a large balloon and no deposit', () => {
  const m = R.loanModel(Object.assign({}, baseInput, {
    deposit: 0, balloonMode: 'percent', balloonPercent: 45
  }));
  assert.ok(m.equityAtEnd < 0, 'expected to owe more than the car is worth');
  assert.ok(m.negativeEquityUntilMonth !== null);
});

test('the ATO minimum residual matches the published scale', () => {
  const m = R.loanModel(Object.assign({}, baseInput, { balloonMode: 'atoMinimum', termMonths: 60 }));
  near(m.balloon / m.financedAmount, 0.2813, 0.0001);
});

test('rate stress increases the repayment monotonically', () => {
  const s = R.rateStress(baseInput, [1, 2, 3]);
  assert.ok(s[0].increase > 0 && s[1].increase > s[0].increase && s[2].increase > s[1].increase);
});

test('borrowing power inverts the repayment calculation', () => {
  const m = R.loanModel(baseInput);
  const pv = R.borrowingPower(baseInput, m.payment);
  near(pv, m.financedAmount, 50);
});

/* -------------------------- running costs --------------------------- */

test('EV running costs use electricity, not fuel', () => {
  const petrol = R.runningCosts(Object.assign({}, baseInput, { fuelType: 'petrol' }));
  const ev = R.runningCosts(Object.assign({}, baseInput, { fuelType: 'ev', energyUse: 16, electricityPrice: 30 }));
  near(ev.items.energy, 15000 / 100 * 16 * 0.30, 1);
  assert.ok(ev.items.energy < petrol.items.energy);
});

/* -------------------------- novated lease --------------------------- */

test('novated lease packages pre-tax and produces a tax saving', () => {
  const n = R.novatedModel(Object.assign({}, baseInput, { product: 'novated' }));
  assert.ok(n.gstSavingOnPurchase > 0, 'GST on the purchase should be saved');
  assert.ok(n.preTaxAnnual > 0);
  assert.ok(n.taxSaving > 0, 'packaging should reduce tax');
  assert.ok(n.netAnnualCost < n.annualPackageCost, 'net cost should be below gross cost');
  near(n.residualPercent, 28.13, 0.01);
});

test('ECM reduces the FBT taxable value to nil', () => {
  const n = R.novatedModel(Object.assign({}, baseInput, { product: 'novated', fbtMethod: 'ecm' }));
  near(n.fbt.taxableValueAfterContribution, 0, 0.01);
  near(n.fbt.fbtPayable, 0, 0.01);
  near(n.fbt.postTaxContribution, 0.2 * n.fbt.baseValue, 1);
});

test('paying FBT instead of using ECM costs more', () => {
  const ecm = R.novatedModel(Object.assign({}, baseInput, { product: 'novated', fbtMethod: 'ecm' }));
  const full = R.novatedModel(Object.assign({}, baseInput, { product: 'novated', fbtMethod: 'fbt' }));
  assert.ok(full.netAnnualCost > ecm.netAnnualCost);
  assert.ok(full.fbt.fbtPayable > 0);
});

test('an eligible EV is FBT exempt but still reports an RFBA', () => {
  const ev = R.novatedModel(Object.assign({}, baseInput, {
    product: 'novated', fuelType: 'ev', evFbtExempt: true, vehiclePrice: 60000
  }));
  assert.strictEqual(ev.fbt.exemptEv, true);
  assert.strictEqual(ev.fbt.postTaxContribution, 0);
  assert.strictEqual(ev.fbt.fbtPayable, 0);
  assert.ok(ev.fbt.reportableFringeBenefitAmount > 0, 'exempt EV benefits are still reportable');
});

test('an EV above the fuel efficient LCT threshold is not exempt', () => {
  const ev = R.novatedModel(Object.assign({}, baseInput, {
    product: 'novated', fuelType: 'ev', evFbtExempt: true, vehiclePrice: 130000
  }));
  assert.strictEqual(ev.fbt.exemptEv, false);
});

test('a higher earner saves more on the same novated lease', () => {
  const low = R.novatedModel(Object.assign({}, baseInput, { product: 'novated', grossSalary: 60000 }));
  const high = R.novatedModel(Object.assign({}, baseInput, { product: 'novated', grossSalary: 200000 }));
  assert.ok(high.taxSaving > low.taxSaving);
});

/* ------------------------- income and ratios ------------------------ */

test('income summary nets down for tax and Medicare', () => {
  const i = R.incomeSummary(baseInput);
  near(i.gross, 95000, 0.01);
  assert.ok(i.net < i.gross);
  near(i.netPerWeek, i.net / 52, 0.01);
});

test('salary including super is stripped back to cash salary', () => {
  const withSuper = R.incomeSummary(Object.assign({}, baseInput, { grossSalary: 106400, salaryIncludesSuper: true }));
  near(withSuper.gross, 106400 / 1.12, 1);
});

test('affordability reports repayment as a percentage of take-home pay', () => {
  const income = R.incomeSummary(baseInput);
  const m = R.loanModel(baseInput);
  const a = R.affordability(m, income, baseInput);
  near(a.percentOfNet, m.payment * 12 / income.net * 100, 0.01);
  assert.ok(['comfortable', 'moderate', 'stretched', 'high'].includes(a.band.key));
});

test('affordability band degrades as the loan grows', () => {
  const income = R.incomeSummary(baseInput);
  const cheap = R.affordability(R.loanModel(Object.assign({}, baseInput, { vehiclePrice: 20000 })), income, baseInput);
  const dear = R.affordability(R.loanModel(Object.assign({}, baseInput, { vehiclePrice: 140000 })), income, baseInput);
  assert.ok(dear.percentOfNet > cheap.percentOfNet);
});

/* --------------------------- comparison ----------------------------- */

test('compareAll returns every product with affordability attached', () => {
  const rows = R.compareAll(baseInput);
  const keys = rows.map((r) => r.product);
  ['secured', 'unsecured', 'dealer', 'gfv', 'chattel', 'financeLease', 'novated', 'cash']
    .forEach((p) => assert.ok(keys.includes(p), `missing ${p}`));
  rows.forEach((r) => {
    assert.ok(r.affordability, `${r.product} missing affordability`);
    assert.ok(isFinite(r.totalCostOfOwnership), `${r.product} has a non-finite cost`);
  });
});

test('an unsecured loan costs more than a secured one', () => {
  const rows = R.compareAll(baseInput);
  const secured = rows.find((r) => r.product === 'secured');
  const unsecured = rows.find((r) => r.product === 'unsecured');
  assert.ok(unsecured.totalInterest > secured.totalInterest);
});

test('calculate returns a full result tree', () => {
  const out = R.calculate(baseInput);
  assert.ok(out.income && out.model && out.comparison.length && out.stress.length);
  assert.ok(out.model.affordability.percentOfNet > 0);
});

test('calculate survives empty input without throwing', () => {
  const out = R.calculate({});
  assert.ok(isFinite(out.model.payment));
  assert.strictEqual(out.novated, null);
});
