/*!
 * Revvy — UI layer.
 * Renders the input form from a schema, recalculates on every change, and keeps
 * everything in localStorage. No dependencies, no network calls.
 */
(function () {
  'use strict';

  var R = window.Revvy;
  var KEY_INPUTS = 'revvy.inputs.v1';
  var KEY_SCENARIOS = 'revvy.scenarios.v1';
  var KEY_PREFS = 'revvy.prefs.v1';

  /* ================================================================== *
   * Formatting
   * ================================================================== */

  var fmtMoney = new Intl.NumberFormat('en-AU', {
    style: 'currency', currency: 'AUD', maximumFractionDigits: 0
  });
  var fmtMoney2 = new Intl.NumberFormat('en-AU', {
    style: 'currency', currency: 'AUD', minimumFractionDigits: 2, maximumFractionDigits: 2
  });
  var fmtNum = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 0 });

  function $(v) { return isFinite(v) ? fmtMoney.format(Math.round(v)) : '—'; }
  function $$(v) { return isFinite(v) ? fmtMoney2.format(v) : '—'; }
  function pct(v, dp) { return isFinite(v) ? v.toFixed(dp == null ? 1 : dp) + '%' : '—'; }
  function n(v) { return isFinite(v) ? fmtNum.format(Math.round(v)) : '—'; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ================================================================== *
   * Field schema
   * ================================================================== */

  var STATE_ONROADS = {
    NSW: { registrationCost: 400, ctpCost: 620, annualRegistration: 400 },
    VIC: { registrationCost: 900, ctpCost: 0, annualRegistration: 900 },
    QLD: { registrationCost: 800, ctpCost: 0, annualRegistration: 800 },
    SA: { registrationCost: 500, ctpCost: 500, annualRegistration: 1000 },
    WA: { registrationCost: 400, ctpCost: 450, annualRegistration: 850 },
    TAS: { registrationCost: 400, ctpCost: 350, annualRegistration: 750 },
    ACT: { registrationCost: 600, ctpCost: 500, annualRegistration: 1100 },
    NT: { registrationCost: 700, ctpCost: 400, annualRegistration: 1100 }
  };

  // How long ago the electric vehicle FBT exemption started. A used EV first
  // held before this does not qualify, however cheap it is.
  var EV_EXEMPTION_START = new Date('2022-07-01T00:00:00Z');
  function yearsSinceEvExemption() {
    return (Date.now() - EV_EXEMPTION_START.getTime()) / (365.25 * 24 * 3600 * 1000);
  }

  var is = {
    ev: function (s) { return s.fuelType === 'ev'; },
    liquidFuel: function (s) { return s.fuelType !== 'ev'; },
    qld: function (s) { return s.state === 'QLD'; },
    act: function (s) { return s.state === 'ACT'; },
    loanProduct: function (s) { return s.product !== 'novated' && s.product !== 'cash'; },
    novated: function (s) { return s.product === 'novated'; },
    business: function (s) { return s.product === 'chattel' || s.product === 'financeLease'; },
    gfv: function (s) { return s.product === 'gfv'; },
    // GFV sets its own residual, so the generic balloon controls do not apply.
    balloonable: function (s) { return is.loanProduct(s) && s.product !== 'gfv'; },
    used: function (s) { return s.vehicleCondition === 'used'; },
    // Dealer delivery and factory options are charges on a first sale. A used
    // car's advertised price already has them baked in.
    firstSale: function (s) { return s.vehicleCondition !== 'used'; },
    driveAway: function (s) { return s.priceBasis === 'driveaway'; }
  };

  var GROUPS = [
    {
      id: 'vehicle', title: 'Vehicle & purchase', open: true,
      blurb: 'Start with the advertised price. Tell Revvy whether that figure already includes ' +
        'on-road costs, and whether the car is new or used — both change what applies.',
      fields: [
        { id: 'vehicleCondition', label: 'New or used?', type: 'segmented', def: 'new', simple: true, options: [['new', 'New'], ['demo', 'Demo'], ['used', 'Used']], help: 'Changes what applies: luxury car tax, dealer delivery, GFV and depreciation all differ.' },
        { id: 'vehicleAge', label: 'Age of the vehicle', type: 'number', suffix: 'years', def: 3, step: 1, min: 0, max: 30, simple: true, showIf: is.used, help: 'Used for depreciation, and for electric vehicle FBT eligibility.' },
        { id: 'vehiclePrice', label: 'Purchase price', type: 'number', prefix: '$', def: 45000, step: 500, min: 0, simple: true, help: 'Including GST.' },
        { id: 'priceBasis', label: 'That price is', type: 'segmented', def: 'beforeOnRoads', simple: true, options: [['beforeOnRoads', 'Before on-roads'], ['driveaway', 'Drive-away']], help: 'Drive-away prices are worked backwards to separate duty and registration.' },
        { id: 'state', label: 'State or territory', type: 'select', def: 'NSW', simple: true, options: R.STATES.map(function (s) { return [s, s]; }), help: 'Stamp duty is a state tax and varies significantly.' },
        { id: 'fuelType', label: 'Fuel type', type: 'select', def: 'petrol', simple: true, options: [['petrol', 'Petrol'], ['diesel', 'Diesel'], ['hybrid', 'Hybrid'], ['phev', 'Plug-in hybrid'], ['ev', 'Electric']] },
        { id: 'vehicleType', label: 'Vehicle class', type: 'select', def: 'passenger', options: [['passenger', 'Passenger'], ['commercial', 'Commercial / ute / van']] },
        { id: 'cylinders', label: 'Cylinders', type: 'number', def: 4, min: 1, max: 12, step: 1, showIf: is.qld, help: 'Queensland duty depends on cylinder count.' },
        { id: 'actRating', label: 'ACT emissions rating', type: 'select', def: 'C', options: [['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'D']], showIf: is.act, help: 'ACT duty is based on the vehicle emissions rating.' },
        { id: 'dealerDelivery', label: 'Dealer delivery', type: 'number', prefix: '$', def: 2000, step: 100, min: 0, showIf: is.firstSale, help: 'Charged on a first sale. Not applicable to a used car.' },
        { id: 'optionsAndAccessories', label: 'Options & accessories', type: 'number', prefix: '$', def: 0, step: 250, min: 0, showIf: is.firstSale, help: 'Counts towards LCT, duty and the FBT base value.' },
        { id: 'registrationCost', label: 'Registration (first year)', type: 'number', prefix: '$', def: 400, step: 50, min: 0, auto: 'onroads' },
        { id: 'ctpCost', label: 'CTP / green slip', type: 'number', prefix: '$', def: 620, step: 50, min: 0, auto: 'onroads' },
        { id: 'plateAndTransferFees', label: 'Plates & transfer fees', type: 'number', prefix: '$', def: 100, step: 10, min: 0 },
        { id: 'stampDutyOverride', label: 'Stamp duty override', type: 'number', prefix: '$', def: '', step: 100, min: 0, help: 'Leave blank to use the calculated state scale.' },
        { id: 'depositBasis', label: 'Deposit as', type: 'segmented', def: 'amount', simple: true, options: [['amount', '$ amount'], ['percent', '% of price']] },
        { id: 'deposit', label: 'Cash deposit', type: 'number', prefix: '$', def: 5000, step: 500, min: 0, simple: true,
          showIf: function (s) { return s.depositBasis !== 'percent'; } },
        { id: 'depositPercent', label: 'Cash deposit', type: 'number', suffix: '% of drive-away', def: 10, step: 1, min: 0, max: 100, simple: true,
          showIf: function (s) { return s.depositBasis === 'percent'; } },
        { id: 'tradeInValue', label: 'Trade-in value', type: 'number', prefix: '$', def: 0, step: 500, min: 0, simple: true },
        { id: 'tradeInPayout', label: 'Trade-in payout owing', type: 'number', prefix: '$', def: 0, step: 500, min: 0, help: 'Existing finance rolled into the new loan.' }
      ]
    },
    {
      id: 'finance', title: 'Finance', open: true,
      blurb: 'Choose a product, then compare it against every other option on the Compare tab.',
      fields: [
        { id: 'product', label: 'Finance type', type: 'cards', def: 'secured', simple: true,
          // Filtered by vehicle condition — GFV is a new/demo program only.
          optionsFor: function (s) {
            var labels = {
              secured: ['Secured loan', 'Car is the security. Usually the cheapest rate.'],
              unsecured: ['Personal loan', 'No security over the car, so a higher rate.'],
              dealer: ['Dealer finance', 'Arranged at the dealership.'],
              gfv: ['Guaranteed Future Value', 'Trade back at a guaranteed price. New and demo only.'],
              novated: ['Novated lease', 'Salary packaged through your employer.'],
              chattel: ['Chattel mortgage', 'Business purchase, you own it outright.'],
              financeLease: ['Finance lease', 'Business lease with a residual.'],
              cash: ['Pay cash', 'No finance. Compare the opportunity cost.']
            };
            return R.availableProducts(s).map(function (p) {
              return [p, labels[p][0], labels[p][1]];
            });
          },
          options: [] },
        { id: 'interestRate', label: 'Interest rate', type: 'number', suffix: '% p.a.', def: 7.45, step: 0.05, min: 0, max: 40, simple: true,
          showIf: function (s) { return ['secured', 'chattel', 'financeLease'].indexOf(s.product) !== -1; } },
        { id: 'unsecuredRate', label: 'Interest rate', type: 'number', suffix: '% p.a.', def: 10.95, step: 0.05, min: 0, max: 40, simple: true,
          showIf: function (s) { return s.product === 'unsecured'; }, help: 'Unsecured personal loans price well above secured car loans.' },
        { id: 'dealerRate', label: 'Interest rate', type: 'number', suffix: '% p.a.', def: 4.99, step: 0.05, min: 0, max: 40, simple: true,
          showIf: function (s) { return s.product === 'dealer'; }, help: 'Sharp advertised rates often come with a firmer price or a compulsory balloon.' },
        { id: 'gfvRate', label: 'Interest rate', type: 'number', suffix: '% p.a.', def: 6.99, step: 0.05, min: 0, max: 40, simple: true,
          showIf: is.gfv },
        { id: 'novatedRate', label: 'Lease finance rate', type: 'number', suffix: '% p.a.', def: 7.95, step: 0.05, min: 0, max: 40, simple: true,
          showIf: is.novated },
        { id: 'termMonths', label: 'Loan term', type: 'select', def: 60, simple: true, options: [[12, '1 year'], [24, '2 years'], [36, '3 years'], [48, '4 years'], [60, '5 years'], [72, '6 years'], [84, '7 years']] },
        { id: 'paymentFrequency', label: 'Pay & repayment cycle', type: 'segmented', def: 'monthly', simple: true, options: [['weekly', 'Weekly'], ['fortnightly', 'Fortnightly'], ['monthly', 'Monthly']], help: 'Used for both your repayments and your take-home pay.' },
        { id: 'balloonMode', label: 'Balloon / residual', type: 'select', def: 'none', simple: true, showIf: is.balloonable, options: [
          ['none', 'None — pay it off in full'], ['percent', 'Percentage of the amount financed'],
          ['amount', 'Fixed dollar amount'], ['atoMinimum', 'ATO minimum residual']
        ] },
        { id: 'balloonPercent', label: 'Balloon percentage', type: 'number', suffix: '%', def: 30, step: 1, min: 0, max: 60, simple: true, showIf: function (s) { return is.balloonable(s) && s.balloonMode === 'percent'; } },
        { id: 'balloonAmount', label: 'Balloon amount', type: 'number', prefix: '$', def: 12000, step: 500, min: 0, simple: true, showIf: function (s) { return is.balloonable(s) && s.balloonMode === 'amount'; } },
        { id: 'gfvBasis', label: 'Guaranteed Future Value as', type: 'segmented', def: 'amount', simple: true, showIf: is.gfv, options: [['amount', '$ amount'], ['percent', '% of price']] },
        { id: 'gfvAmount', label: 'Guaranteed Future Value', type: 'number', prefix: '$', def: 18000, step: 500, min: 0, simple: true,
          showIf: function (s) { return is.gfv(s) && s.gfvBasis !== 'percent'; }, help: 'The value the manufacturer guarantees at the end of the term. This replaces the balloon.' },
        { id: 'gfvPercent', label: 'Guaranteed Future Value', type: 'number', suffix: '% of drive-away', def: 40, step: 1, min: 0, max: 90, simple: true,
          showIf: function (s) { return is.gfv(s) && s.gfvBasis === 'percent'; }, help: 'Manufacturer programs usually quote 35–55% over three to five years.' },
        { id: 'gfvAnnualKm', label: 'GFV kilometre allowance', type: 'number', suffix: 'km/yr', def: 15000, step: 1000, min: 0, showIf: is.gfv },
        { id: 'gfvExcessKmRate', label: 'Excess kilometre charge', type: 'number', prefix: '$', def: 0.15, step: 0.01, min: 0, showIf: is.gfv, help: 'Charged per kilometre over the allowance.' },
        { id: 'establishmentFee', label: 'Establishment fee', type: 'number', prefix: '$', def: 400, step: 50, min: 0 },
        { id: 'monthlyFee', label: 'Monthly account fee', type: 'number', prefix: '$', def: 10, step: 1, min: 0 },
        { id: 'capitaliseFees', label: 'Add establishment fee to the loan', type: 'checkbox', def: true },
        { id: 'extraRepayment', label: 'Extra per repayment', type: 'number', prefix: '$', def: 0, step: 25, min: 0, showIf: is.loanProduct, help: 'Check your contract — fixed-rate loans often limit extra repayments.' },
        { id: 'rateChange1After', label: 'Rate change after', type: 'number', suffix: 'months', def: 0, step: 6, min: 0, showIf: is.loanProduct, help: 'Model a variable rate. Leave at 0 for a fixed rate.' },
        { id: 'rateChange1Rate', label: 'New rate', type: 'number', suffix: '% p.a.', def: 8.45, step: 0.05, min: 0, showIf: function (s) { return is.loanProduct(s) && +s.rateChange1After > 0; } },
        { id: 'rateChange2After', label: 'Second change after', type: 'number', suffix: 'months', def: 0, step: 6, min: 0, showIf: function (s) { return is.loanProduct(s) && +s.rateChange1After > 0; } },
        { id: 'rateChange2Rate', label: 'Then', type: 'number', suffix: '% p.a.', def: 7.45, step: 0.05, min: 0, showIf: function (s) { return is.loanProduct(s) && +s.rateChange2After > 0; } },
      ]
    },
    {
      id: 'running', title: 'Running costs', open: false,
      blurb: 'The real cost of a car is rarely the repayment. These feed cost per kilometre and the novated lease budget.',
      fields: [
        { id: 'includeRunningCosts', label: 'Include running costs in the analysis', type: 'checkbox', def: true, simple: true, help: 'Turn off to look at the finance on its own.' },
        { id: 'annualKm', label: 'Kilometres per year', type: 'number', suffix: 'km', def: 15000, step: 1000, min: 0, simple: true,
          showIf: function (s) { return s.includeRunningCosts !== false; } },
        { id: 'fuelEconomy', label: 'Fuel use', type: 'number', suffix: 'L/100km', def: 7.5, step: 0.1, min: 0, showIf: function (s) { return s.includeRunningCosts !== false && is.liquidFuel(s); } },
        { id: 'fuelPrice', label: 'Fuel price', type: 'number', prefix: '$', suffix: '/L', def: 1.95, step: 0.05, min: 0, showIf: function (s) { return s.includeRunningCosts !== false && is.liquidFuel(s); } },
        { id: 'energyUse', label: 'Energy use', type: 'number', suffix: 'kWh/100km', def: 16, step: 0.5, min: 0, showIf: function (s) { return s.includeRunningCosts !== false && is.ev(s); } },
        { id: 'electricityPrice', label: 'Electricity price', type: 'number', suffix: 'c/kWh', def: 30, step: 1, min: 0, showIf: function (s) { return s.includeRunningCosts !== false && is.ev(s); } },
        { id: 'insuranceCost', label: 'Insurance', type: 'number', prefix: '$', suffix: '/yr', def: 1500, step: 100, min: 0, showIf: function (s) { return s.includeRunningCosts !== false; } },
        { id: 'annualRegistration', label: 'Registration & CTP renewal', type: 'number', prefix: '$', suffix: '/yr', def: 900, step: 50, min: 0, auto: 'onroads', showIf: function (s) { return s.includeRunningCosts !== false; } },
        { id: 'servicingCost', label: 'Servicing & repairs', type: 'number', prefix: '$', suffix: '/yr', def: 700, step: 50, min: 0, showIf: function (s) { return s.includeRunningCosts !== false; } },
        { id: 'tyresCost', label: 'Tyres', type: 'number', prefix: '$', suffix: '/yr', def: 350, step: 50, min: 0, showIf: function (s) { return s.includeRunningCosts !== false; } },
        { id: 'roadsideCost', label: 'Roadside assistance', type: 'number', prefix: '$', suffix: '/yr', def: 120, step: 10, min: 0, showIf: function (s) { return s.includeRunningCosts !== false; } },
        { id: 'otherRunningCost', label: 'Tolls, parking, other', type: 'number', prefix: '$', suffix: '/yr', def: 0, step: 100, min: 0, showIf: function (s) { return s.includeRunningCosts !== false; } }
      ]
    },
    {
      id: 'income', title: 'Your income', open: true,
      blurb: 'Optional, but this is where Revvy gets useful: repayments as a share of what you actually take home.',
      fields: [
        { id: 'grossSalary', label: 'Gross salary', type: 'number', prefix: '$', def: 95000, step: 1000, min: 0, simple: true },
        { id: 'salaryFrequency', label: 'Salary is per', type: 'segmented', def: 'annual', simple: true, options: [['weekly', 'Week'], ['fortnightly', 'Fortnight'], ['monthly', 'Month'], ['annual', 'Year']] },
        { id: 'salaryIncludesSuper', label: 'That figure includes super', type: 'checkbox', def: false, simple: true },
        { id: 'otherIncome', label: 'Other taxable income', type: 'number', prefix: '$', suffix: '/yr', def: 0, step: 1000, min: 0 },
        { id: 'partnerIncome', label: 'Partner income', type: 'number', prefix: '$', suffix: '/yr', def: 0, step: 1000, min: 0, help: 'Used for household ratios and family thresholds.' },
        { id: 'taxYear', label: 'Financial year', type: 'select', def: '2026-27', simple: true, options: Object.keys(R.TAX_YEARS).map(function (k) { return [k, R.TAX_YEARS[k].label]; }) },
        { id: 'hasStudyLoan', label: 'I have a HELP / HECS or study loan', type: 'checkbox', def: false },
        { id: 'studyLoanBalance', label: 'Study loan balance', type: 'number', prefix: '$', def: 25000, step: 1000, min: 0, showIf: function (s) { return !!s.hasStudyLoan; } },
        { id: 'privateHospitalCover', label: 'I have private hospital cover', type: 'checkbox', def: true, help: 'Without it, the Medicare levy surcharge may apply above the income thresholds.' },
        { id: 'family', label: 'Use family thresholds', type: 'checkbox', def: false },
        { id: 'dependants', label: 'Dependent children', type: 'number', def: 0, step: 1, min: 0, showIf: function (s) { return !!s.family; } },
        { id: 'medicareExempt', label: 'Medicare levy exempt', type: 'checkbox', def: false },
        { id: 'livingExpenses', label: 'Living expenses', type: 'number', prefix: '$', suffix: '/mth', def: 3200, step: 100, min: 0, simple: true, help: 'Everything except the car and other loan repayments.' },
        { id: 'otherDebtRepayments', label: 'Other loan repayments', type: 'number', prefix: '$', suffix: '/mth', def: 0, step: 50, min: 0 },
        { id: 'otherDebtBalances', label: 'Other debt balances', type: 'number', prefix: '$', def: 0, step: 1000, min: 0, help: 'Mortgage, credit cards and personal loans, for the debt-to-income ratio.' },
        { id: 'savingsReturn', label: 'Return on savings', type: 'number', suffix: '% p.a.', def: 4.5, step: 0.1, min: 0, help: 'The opportunity cost of paying cash instead of financing.' },
        { id: 'savingsTaxRate', label: 'Tax on that return', type: 'number', suffix: '%', def: 32, step: 1, min: 0, max: 50 }
      ]
    },
    {
      id: 'novated', title: 'Novated lease', open: true, showIf: is.novated,
      blurb: 'Only relevant if your employer offers salary packaging. Figures are indicative — your packager will quote differently.',
      fields: [
        { id: 'residualMode', label: 'Residual value', type: 'select', def: 'ato', options: [['ato', 'ATO minimum for the term'], ['custom', 'Custom percentage']] },
        { id: 'residualPercent', label: 'Residual percentage', type: 'number', suffix: '%', def: 28.13, step: 0.01, min: 0, max: 70, showIf: function (s) { return s.residualMode === 'custom'; } },
        { id: 'fbtMethod', label: 'FBT treatment', type: 'select', def: 'ecm', options: [['ecm', 'Employee Contribution Method'], ['fbt', 'Employer pays FBT']], help: 'ECM uses post-tax contributions to reduce the FBT taxable value to nil.' },
        { id: 'evFbtExempt', label: 'Claim the electric vehicle FBT exemption', type: 'checkbox', def: true, help: 'Eligible battery EVs under the fuel-efficient LCT threshold, first held from 1 July 2022.' },
        { id: 'packagingFee', label: 'Packaging administration fee', type: 'number', prefix: '$', suffix: '/yr', def: 250, step: 50, min: 0 },
        { id: 'employerClaimsGstOnRunning', label: 'Employer claims GST on running costs', type: 'checkbox', def: true },
        { id: 'includeRfba', label: 'Include reportable fringe benefits in income tests', type: 'checkbox', def: true, help: 'An RFBA lifts study loan repayments and the Medicare levy surcharge.' }
      ]
    },
    {
      id: 'business', title: 'Business use', open: true, showIf: is.business,
      blurb: 'For chattel mortgages and finance leases. Indicative only — talk to your accountant.',
      fields: [
        { id: 'gstRegistered', label: 'Registered for GST', type: 'checkbox', def: true },
        { id: 'businessUsePercent', label: 'Business use', type: 'number', suffix: '%', def: 100, step: 5, min: 0, max: 100 },
        { id: 'companyTaxRate', label: 'Tax rate applied to deductions', type: 'number', suffix: '%', def: 25, step: 1, min: 0, max: 50, help: '25% for a base rate entity, 30% otherwise, or your marginal rate as a sole trader.' }
      ]
    },
    {
      id: 'assumptions', title: 'Assumptions', open: false,
      blurb: 'Thresholds are indexed or legislated and change regularly. Verify anything you rely on against the ATO and your state revenue office.',
      fields: [
        { id: 'depreciationFirstYear', label: 'First year depreciation', type: 'number', suffix: '%', def: 20, step: 1, min: 0, max: 60 },
        { id: 'depreciationOngoing', label: 'Depreciation after that', type: 'number', suffix: '% p.a.', def: 14, step: 1, min: 0, max: 50 },
        { id: 'lctThresholdFuelEfficient', label: 'LCT threshold (fuel efficient)', type: 'number', prefix: '$', def: R.CONST.lctThresholdFuelEfficient, step: 100, min: 0 },
        { id: 'lctThresholdOther', label: 'LCT threshold (other)', type: 'number', prefix: '$', def: R.CONST.lctThresholdOther, step: 100, min: 0 },
        { id: 'carLimit', label: 'Car limit (depreciation & GST credit)', type: 'number', prefix: '$', def: R.CONST.carLimit, step: 100, min: 0 },
        { id: 'fbtStatutoryRate', label: 'FBT statutory rate', type: 'number', suffix: '%', def: 20, step: 1, min: 0, max: 100 },
        { id: 'fbtRate', label: 'FBT rate', type: 'number', suffix: '%', def: 47, step: 1, min: 0, max: 100 },
        { id: 'superGuarantee', label: 'Super guarantee', type: 'number', suffix: '%', def: 12, step: 0.5, min: 0, max: 20 }
      ]
    }
  ];

  var FIELD_INDEX = {};
  GROUPS.forEach(function (g) {
    g.fields.forEach(function (f) { f.group = g.id; FIELD_INDEX[f.id] = f; });
  });

  function defaults() {
    var s = {};
    GROUPS.forEach(function (g) {
      g.fields.forEach(function (f) { s[f.id] = f.def; });
    });
    s.__autoOnRoads = true;
    return s;
  }

  /* ================================================================== *
   * State
   * ================================================================== */

  var state = load(KEY_INPUTS, defaults());
  var prefs = load(KEY_PREFS, { theme: 'auto', tab: 'summary', acknowledged: false, groupYears: true });
  // New arrivals start in Simple. Anyone who has used Revvy before keeps the
  // full form rather than finding half their fields apparently missing.
  if (!prefs.mode) prefs.mode = prefs.acknowledged ? 'detailed' : 'simple';
  var scenarios = load(KEY_SCENARIOS, []);

  // Merge in any fields added since the saved copy was written.
  var d = defaults();
  for (var k in d) if (!(k in state)) state[k] = d[k];

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }

  /** Translate the flat form state into the shape the engine expects. */
  function toInput() {
    var i = {};
    for (var key in state) i[key] = state[key];
    i.constants = Object.assign({}, R.CONST, {
      lctThresholdFuelEfficient: +state.lctThresholdFuelEfficient || R.CONST.lctThresholdFuelEfficient,
      lctThresholdOther: +state.lctThresholdOther || R.CONST.lctThresholdOther,
      carLimit: +state.carLimit || R.CONST.carLimit,
      fbtStatutoryRate: (+state.fbtStatutoryRate || 20) / 100,
      fbtRate: (+state.fbtRate || 47) / 100,
      superGuarantee: (+state.superGuarantee || 12) / 100
    });
    R.CONST.superGuarantee = i.constants.superGuarantee;
    i.termMonths = +state.termMonths;
    i.rateChanges = [];
    if (+state.rateChange1After > 0) {
      i.rateChanges.push({ afterMonths: +state.rateChange1After, annualRate: +state.rateChange1Rate });
    }
    if (+state.rateChange2After > 0) {
      i.rateChanges.push({ afterMonths: +state.rateChange2After, annualRate: +state.rateChange2Rate });
    }
    i.residualMode = state.residualMode;
    if (state.stampDutyOverride === '' || state.stampDutyOverride == null) i.stampDutyOverride = null;

    // Hidden fields must not leak into the maths. A used car has no dealer
    // delivery, and a drive-away price already contains everything.
    if (is.used(state)) {
      i.dealerDelivery = 0;
      i.optionsAndAccessories = 0;
    }

    // The EV FBT exemption reaches only cars first held from 1 July 2022.
    // A used car older than that window cannot qualify however cheap it is.
    i.evFirstHeldFromJuly2022 = !is.used(state) ||
      +state.vehicleAge <= yearsSinceEvExemption();

    // Never model a product the vehicle cannot actually be sold with.
    if (R.availableProducts(state).indexOf(i.product) === -1) i.product = 'secured';
    return i;
  }

  /* ================================================================== *
   * Form rendering
   * ================================================================== */

  var formEl = document.getElementById('inputs');

  function fieldHtml(f) {
    var val = state[f.id];
    var id = 'f-' + f.id;
    var help = f.help ? '<span class="help">' + esc(f.help) + '</span>' : '';

    if (f.type === 'checkbox') {
      return '<div class="field check" data-field="' + f.id + '">' +
        '<label for="' + id + '"><input type="checkbox" id="' + id + '" data-id="' + f.id + '"' +
        (val ? ' checked' : '') + '><span>' + esc(f.label) + '</span></label>' + help + '</div>';
    }

    // Radio groups styled as buttons: the choice and its alternatives are both
    // visible at a glance, which a dropdown hides. Real radios keep arrow-key
    // navigation and screen reader semantics for free.
    if (f.type === 'segmented' || f.type === 'cards') {
      var picks = f.optionsFor ? f.optionsFor(state) : f.options;
      var body = picks.map(function (o) {
        var optId = 'f-' + f.id + '-' + o[0];
        return '<label class="' + (f.type === 'cards' ? 'card-opt' : 'seg-opt') + '" ' +
          'data-value="' + esc(o[0]) + '" for="' + optId + '">' +
          '<input type="radio" id="' + optId + '" name="f-' + f.id + '" value="' + esc(o[0]) + '" ' +
          'data-id="' + f.id + '"' + (String(val) === String(o[0]) ? ' checked' : '') + '>' +
          '<span class="opt-label">' + esc(o[1]) + '</span>' +
          (o[2] ? '<span class="opt-note">' + esc(o[2]) + '</span>' : '') +
          '</label>';
      }).join('');
      return '<div class="field ' + (f.type === 'cards' ? 'is-cards' : 'is-segmented') +
        '" data-field="' + f.id + '">' +
        '<span class="field-label">' + esc(f.label) + '</span>' +
        '<div class="' + (f.type === 'cards' ? 'cards' : 'segmented') + '" role="radiogroup" ' +
        'aria-label="' + esc(f.label) + '">' + body + '</div>' + help + '</div>';
    }

    if (f.type === 'select') {
      var choices = f.optionsFor ? f.optionsFor(state) : f.options;
      var opts = choices.map(function (o) {
        return '<option value="' + esc(o[0]) + '"' +
          (String(val) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('');
      return '<div class="field" data-field="' + f.id + '">' +
        '<label for="' + id + '">' + esc(f.label) + '</label>' +
        '<select id="' + id + '" data-id="' + f.id + '">' + opts + '</select>' + help + '</div>';
    }

    var attrs = ['type="number"', 'id="' + id + '"', 'data-id="' + f.id + '"',
      'value="' + esc(val) + '"', 'inputmode="decimal"'];
    if (f.step != null) attrs.push('step="' + f.step + '"');
    if (f.min != null) attrs.push('min="' + f.min + '"');
    if (f.max != null) attrs.push('max="' + f.max + '"');
    return '<div class="field" data-field="' + f.id + '">' +
      '<label for="' + id + '">' + esc(f.label) + '</label>' +
      '<div class="control' + (f.prefix ? ' has-prefix' : '') + (f.suffix ? ' has-suffix' : '') + '">' +
      (f.prefix ? '<span class="affix pre">' + esc(f.prefix) + '</span>' : '') +
      '<input ' + attrs.join(' ') + '>' +
      (f.suffix ? '<span class="affix post">' + esc(f.suffix) + '</span>' : '') +
      '</div>' + help + '</div>';
  }

  function modeSwitchHtml() {
    var simple = prefs.mode === 'simple';
    return '<div class="mode-switch">' +
      '<div class="seg" role="group" aria-label="Level of detail">' +
      '<button type="button" data-mode="simple" aria-pressed="' + simple + '">Simple</button>' +
      '<button type="button" data-mode="detailed" aria-pressed="' + !simple + '">Detailed</button>' +
      '</div>' +
      '<p class="mode-note">' + (simple
        ? 'Just the essentials. Everything hidden — dealer delivery, fees, running costs, ' +
          'tax settings — uses a sensible estimate you can see in the results.'
        : 'Every input, including on-road costs, fees, rate changes, novated lease settings and ' +
          'the tax assumptions behind the numbers.') +
      '</p></div>';
  }

  function renderForm() {
    formEl.innerHTML = modeSwitchHtml() + GROUPS.map(function (g) {
      return '<details class="group" id="group-' + g.id + '"' + (g.open ? ' open' : '') + '>' +
        '<summary><span>' + esc(g.title) + '</span></summary>' +
        (g.blurb ? '<p class="blurb">' + esc(g.blurb) + '</p>' : '') +
        '<div class="grid">' + g.fields.map(fieldHtml).join('') + '</div>' +
        '</details>';
    }).join('');

    formEl.querySelectorAll('[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        prefs.mode = b.dataset.mode;
        save(KEY_PREFS, prefs);
        renderForm();
        render();
      });
    });
    applyVisibility();
  }

  function applyVisibility() {
    var simple = prefs.mode === 'simple';
    GROUPS.forEach(function (g) {
      var visible = 0;
      g.fields.forEach(function (f) {
        var show = (!f.showIf || f.showIf(state)) && (!simple || f.simple);
        var el = formEl.querySelector('[data-field="' + f.id + '"]');
        if (el) el.hidden = !show;
        if (show) visible++;
      });
      // A section is shown only when it is relevant to what is selected, and
      // hidden outright when it has nothing left to offer.
      var relevant = !g.showIf || g.showIf(state);
      var groupEl = document.getElementById('group-' + g.id);
      if (groupEl) groupEl.hidden = visible === 0 || !relevant;
    });
  }

  formEl.addEventListener('input', onFieldChange);
  formEl.addEventListener('change', onFieldChange);

  function onFieldChange(e) {
    var el = e.target;
    var id = el.getAttribute('data-id');
    if (!id) return;
    var f = FIELD_INDEX[id];

    if (f.type === 'checkbox') state[id] = el.checked;
    else if (f.type === 'number') state[id] = el.value === '' ? '' : parseFloat(el.value);
    else state[id] = el.value;

    if (f.auto === 'onroads' && e.type === 'input') state.__autoOnRoads = false;

    if (id === 'state' && state.__autoOnRoads) {
      var od = STATE_ONROADS[state.state];
      if (od) {
        for (var key in od) {
          state[key] = od[key];
          var input = formEl.querySelector('#f-' + key);
          if (input) input.value = od[key];
        }
      }
    }

    if (id === 'fuelType' && state.fuelType !== 'ev') state.evFbtExempt = false;
    if (id === 'fuelType' && state.fuelType === 'ev') {
      state.evFbtExempt = true;
      var evBox = formEl.querySelector('#f-evFbtExempt');
      if (evBox) evBox.checked = true;
    }

    if (id === 'vehicleCondition') {
      // Used cars are almost always advertised drive-away; new ones are not.
      if (state.__autoPriceBasis !== false) {
        state.priceBasis = is.used(state) ? 'driveaway' : 'beforeOnRoads';
      }
      if (is.used(state)) state.dealerDelivery = 0;
      // GFV is a new/demo program — do not leave an impossible product selected.
      if (R.availableProducts(state).indexOf(state.product) === -1) {
        var was = R.PRODUCT_LABELS[state.product];
        state.product = 'secured';
        toast(was + ' is not available on a used car — switched to a secured loan');
      }
      save(KEY_INPUTS, state);
      renderForm();
      render();
      return;
    }
    if (id === 'priceBasis') state.__autoPriceBasis = false;

    applyVisibility();
    save(KEY_INPUTS, state);
    render();
  }

  /* ================================================================== *
   * Charts (hand-rolled SVG — no libraries)
   * ================================================================== */

  var C = {
    ink: 'var(--chart-ink)',
    grid: 'var(--chart-grid)',
    a: 'var(--c-a)', b: 'var(--c-b)', c: 'var(--c-c)',
    d: 'var(--c-d)', e: 'var(--c-e)', f: 'var(--c-f)'
  };

  function lineChart(opts) {
    var w = 720, h = 300, pad = { l: 64, r: 16, t: 16, b: 34 };
    var series = opts.series.filter(function (s) { return s.points.length; });
    if (!series.length) return '';
    var xs = [], ys = [];
    series.forEach(function (s) {
      s.points.forEach(function (p) { xs.push(p.x); ys.push(p.y); });
    });
    var xMax = Math.max.apply(null, xs), xMin = Math.min.apply(null, xs);
    var yMax = Math.max.apply(null, ys) * 1.05, yMin = Math.min(0, Math.min.apply(null, ys));
    var X = function (v) { return pad.l + (v - xMin) / ((xMax - xMin) || 1) * (w - pad.l - pad.r); };
    var Y = function (v) { return h - pad.b - (v - yMin) / ((yMax - yMin) || 1) * (h - pad.t - pad.b); };

    var gridLines = '', ticks = 4;
    for (var i = 0; i <= ticks; i++) {
      var v = yMin + (yMax - yMin) * i / ticks;
      gridLines += '<line x1="' + pad.l + '" x2="' + (w - pad.r) + '" y1="' + Y(v) + '" y2="' + Y(v) +
        '" stroke="' + C.grid + '" stroke-width="1"/>' +
        '<text x="' + (pad.l - 8) + '" y="' + (Y(v) + 4) + '" text-anchor="end" class="ct">' + $(v) + '</text>';
    }
    var xTicks = '';
    var stepMonths = xMax > 60 ? 24 : xMax > 36 ? 12 : 6;
    for (var m = 0; m <= xMax; m += stepMonths) {
      xTicks += '<text x="' + X(m) + '" y="' + (h - 10) + '" text-anchor="middle" class="ct">' + m + 'm</text>';
    }

    var shade = '';
    if (opts.shadeBetween && series.length >= 2) {
      var above = series[0].points, below = series[1].points;
      var segs = [], cur = null;
      for (var j = 0; j < Math.min(above.length, below.length); j++) {
        if (above[j].y > below[j].y) {
          if (!cur) cur = [];
          cur.push(j);
        } else if (cur) { segs.push(cur); cur = null; }
      }
      if (cur) segs.push(cur);
      segs.forEach(function (seg) {
        var top = seg.map(function (j) { return X(above[j].x) + ',' + Y(above[j].y); });
        var bot = seg.slice().reverse().map(function (j) { return X(below[j].x) + ',' + Y(below[j].y); });
        shade += '<polygon points="' + top.concat(bot).join(' ') + '" fill="' + C.f + '" opacity=".18"/>';
      });
    }

    var paths = series.map(function (s) {
      var dAttr = s.points.map(function (p, idx) {
        return (idx ? 'L' : 'M') + X(p.x).toFixed(1) + ' ' + Y(p.y).toFixed(1);
      }).join(' ');
      return '<path d="' + dAttr + '" fill="none" stroke="' + s.color + '" stroke-width="2.5" ' +
        'stroke-linejoin="round" stroke-linecap="round"' +
        (s.dashed ? ' stroke-dasharray="6 5"' : '') + '/>';
    }).join('');

    var legend = series.map(function (s, idx) {
      return '<span class="key"><i style="background:' + s.color + '"></i>' + esc(s.name) + '</span>';
    }).join('');

    return '<div class="chart"><svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' +
      esc(opts.title || 'Chart') + '">' + gridLines + shade + paths + xTicks + '</svg>' +
      '<div class="legend">' + legend + '</div></div>';
  }

  function barChart(items, opts) {
    opts = opts || {};
    if (!items.length) return '';
    var max = Math.max.apply(null, items.map(function (i) { return Math.abs(i.value); })) || 1;
    return '<div class="hbars">' + items.map(function (i) {
      var wpc = Math.abs(i.value) / max * 100;
      return '<div class="hbar' + (i.highlight ? ' hl' : '') + '">' +
        '<span class="hbar-label">' + esc(i.label) + '</span>' +
        '<span class="hbar-track"><span class="hbar-fill" style="width:' + wpc.toFixed(1) +
        '%;background:' + (i.color || C.a) + '"></span></span>' +
        '<span class="hbar-value">' + (opts.format ? opts.format(i.value) : $(i.value)) + '</span>' +
        '</div>';
    }).join('') + '</div>';
  }

  function stackedBar(segments) {
    var total = segments.reduce(function (a, s) { return a + Math.max(0, s.value); }, 0) || 1;
    var bar = segments.filter(function (s) { return s.value > 0; }).map(function (s) {
      return '<span class="seg" style="width:' + (s.value / total * 100).toFixed(2) + '%;background:' +
        s.color + '" title="' + esc(s.label) + ': ' + $(s.value) + '"></span>';
    }).join('');
    var keys = segments.map(function (s) {
      return '<span class="key"><i style="background:' + s.color + '"></i>' + esc(s.label) +
        ' <b>' + $(s.value) + '</b> <em>' + pct(s.value / total * 100) + '</em></span>';
    }).join('');
    return '<div class="stack"><div class="stack-bar">' + bar + '</div>' +
      '<div class="legend wrap">' + keys + '</div></div>';
  }

  /* ================================================================== *
   * Table helper
   * ================================================================== */

  function table(rows, opts) {
    opts = opts || {};
    var body = rows.map(function (r) {
      if (r === null) return '<tr class="spacer"><td colspan="2"></td></tr>';
      var cls = r[2] ? ' class="' + r[2] + '"' : '';
      return '<tr' + cls + '><th scope="row">' + r[0] + '</th><td>' + r[1] + '</td></tr>';
    }).join('');
    return '<table class="kv' + (opts.className ? ' ' + opts.className : '') + '"><tbody>' + body + '</tbody></table>';
  }

  function card(title, inner, note) {
    return '<section class="card"><h3>' + esc(title) + '</h3>' + inner +
      (note ? '<p class="note">' + note + '</p>' : '') + '</section>';
  }

  /* ================================================================== *
   * Insights — the dynamic commentary
   * ================================================================== */

  function insights(out) {
    var m = out.model, inc = out.income, a = m.affordability, list = [];
    var s = state;

    function add(level, title, text) { list.push({ level: level, title: title, text: text }); }

    if (inc.gross > 0) {
      if (a.percentOfNet > 20) {
        add('warn', 'Repayments are over 20% of your take-home pay',
          'At ' + pct(a.percentOfNet) + ' of net income, this repayment leaves little room for the ' +
          'unexpected. Lenders and financial counsellors commonly point to 10–15% as a more ' +
          'comfortable band for a depreciating asset.');
      } else if (a.percentOfNet > 15) {
        add('info', 'Repayments are a meaningful share of your pay',
          pct(a.percentOfNet) + ' of take-home pay goes to the repayment, before running costs. ' +
          'Including fuel, insurance and servicing it is ' + pct(a.percentOfNetAllIn) + '.');
      } else if (a.percentOfNet > 0) {
        add('good', 'Repayments sit in a comfortable band',
          pct(a.percentOfNet) + ' of take-home pay, or ' + pct(a.percentOfNetAllIn) +
          ' once running costs are included.');
      }
      if (a.annualSurplus < 0) {
        add('warn', 'Your budget does not balance',
          'After tax, living expenses, other debts and this car you are short ' +
          $(Math.abs(a.monthlySurplus)) + ' a month.');
      }
    } else {
      add('info', 'Add your income for the useful part',
        'Enter a salary and Revvy will show the repayment as a share of your actual take-home pay, ' +
        'your tax position and how a novated lease compares.');
    }

    if (m.negativeEquityUntilMonth) {
      add('warn', 'You would owe more than the car is worth for ' + Math.round(m.negativeEquityUntilMonth) + ' months',
        'On these depreciation assumptions the loan balance stays above the projected resale value ' +
        'until month ' + Math.round(m.negativeEquityUntilMonth) + '. Selling or writing the car off before ' +
        'then would leave a shortfall to cover.');
    }

    if (m.balloon > 0) {
      var gap = m.projectedResale - m.balloon;
      if (gap < 0) {
        add('warn', 'The balloon looks higher than the car will be worth',
          'A ' + $(m.balloon) + ' balloon against a projected resale value of ' + $(m.projectedResale) +
          ' leaves roughly ' + $(Math.abs(gap)) + ' to find at the end.');
      } else {
        add('info', 'Balloon of ' + $(m.balloon) + ' due at the end',
          'Projected resale value is ' + $(m.projectedResale) + ', so you would expect about ' +
          $(gap) + ' of equity. You will need to pay it, refinance it or sell.');
      }
      var noBalloon = R.loanModel(Object.assign(toInput(), { balloonMode: 'none', gfvAmount: 0 }));
      add('info', 'What the balloon costs you',
        'It lowers the repayment by ' + $(noBalloon.payment - m.payment) + ' per ' +
        freqWord(state.paymentFrequency) + ', but adds ' + $(m.totalInterest - noBalloon.totalInterest) +
        ' in interest over the term.');
    }

    if (+state.termMonths >= 84) {
      add('info', 'Seven years is a long time to owe money on a car',
        'Long terms cut the repayment but stretch interest across more years and keep you in negative ' +
        'equity for longer.');
    }

    if (is.used(state)) {
      add('good', 'A used car has already taken its steepest depreciation',
        'The first owner absorbed the drop off the showroom floor. Revvy applies only the ongoing ' +
        pct(+state.depreciationOngoing, 0) + ' a year from here, which is why a used car climbs out ' +
        'of negative equity sooner than an equivalent new one.');
      if (state.fuelType === 'ev' && +state.vehicleAge > yearsSinceEvExemption()) {
        add('warn', 'This EV is too old for the FBT exemption',
          'The exemption only covers cars first held and used on or after 1 July 2022. At ' +
          n(state.vehicleAge) + ' years old this one predates that, so a novated lease on it is ' +
          'treated like any other car.');
      }
      if (m.costs.luxuryCarTax === 0 && m.costs.priceBeforeOnRoads > R.CONST.lctThresholdOther) {
        add('good', 'No luxury car tax on a second-hand purchase',
          'LCT is charged on the first retail sale. Buying used avoids it entirely, which is a real ' +
          'saving on an expensive car.');
      }
    }

    if (state.priceBasis === 'driveaway') {
      add('info', 'Drive-away price split into its parts',
        'Working backwards from ' + $(+state.vehiclePrice) + ', the vehicle itself is about ' +
        $(m.costs.listPrice) + ' with roughly ' + $(m.costs.stampDuty) + ' of stamp duty and ' +
        $(m.costs.registration + m.costs.ctp + m.costs.plateAndTransferFees) +
        ' of registration and fees inside it.');
    }

    if (m.costs.luxuryCarTax > 0) {
      add('info', 'Luxury car tax applies: ' + $(m.costs.luxuryCarTax),
        'LCT is charged at ' + pct(R.CONST.lctRate * 100, 0) + ' on the value above the ' +
        (R.CONST.lctThresholdOther === undefined ? '' : '') + 'threshold. It is not refundable and it ' +
        'counts towards the FBT base value on a novated lease.');
    }

    if (state.fuelType === 'ev' && out.novated) {
      if (out.novated.fbt.exemptEv) {
        add('good', 'This EV qualifies for the FBT exemption',
          'The whole package can be deducted pre-tax with no employee contribution required. The ' +
          'benefit is still reported as a fringe benefit amount of ' +
          $(out.novated.fbt.reportableFringeBenefitAmount) + ', which counts towards income tests.');
      } else {
        add('info', 'This EV is above the fuel-efficient LCT threshold',
          'The FBT exemption only applies below ' + $(R.CONST.lctThresholdFuelEfficient) +
          ', so normal FBT treatment applies.');
      }
    }

    if (out.novated && inc.gross > 0 && is.loanProduct(state)) {
      var loanAllIn = a.repaymentAnnual + m.running.annualTotal;
      var novAllIn = out.novated.netAnnualCost;
      var delta = loanAllIn - novAllIn;
      if (Math.abs(delta) > 200) {
        add(delta > 0 ? 'good' : 'info',
          delta > 0 ? 'A novated lease looks cheaper here, by about ' + $(delta) + ' a year'
                    : 'A novated lease looks more expensive here, by about ' + $(Math.abs(delta)) + ' a year',
          'Comparing your after-tax cost of the loan plus running costs (' + $(loanAllIn) + ') against ' +
          'the net cost of a packaged lease including running costs (' + $(novAllIn) + '). It depends ' +
          'entirely on your employer offering packaging, and on the residual you owe at the end.');
      }
      if (out.novated.studyLoanImpact > 50) {
        add('warn', 'Packaging would lift your study loan repayment by ' + $(out.novated.studyLoanImpact) + ' a year',
          'Reportable fringe benefits are added back when your compulsory HELP repayment is worked out.');
      }
    }

    if (out.stress.length) {
      var s2 = out.stress[1] || out.stress[0];
      add('info', 'A ' + s2.shift + ' point rate rise adds ' + $(s2.increase) + ' per ' + freqWord(state.paymentFrequency),
        'If your rate is fixed for the full term this does not apply to you — but it is worth knowing ' +
        'before you choose a variable rate.');
    }

    if (state.product === 'unsecured') {
      add('info', 'Secured lending is usually cheaper',
        'Using the car as security typically drops the rate by several percentage points. Compare both ' +
        'on the Compare tab.');
    }

    if (state.product === 'dealer' && +state.dealerRate < +state.interestRate - 1) {
      add('info', 'Check what the low rate costs elsewhere',
        'Sharply advertised finance rates are often paired with less movement on price, a shorter term ' +
        'or a compulsory balloon. Compare the drive-away price you could negotiate with outside finance.');
    }

    if (state.product === 'gfv' && m.gfv) {
      if (m.gfv.excessKmCost > 0) {
        add('warn', 'You are driving past the kilometre allowance',
          'At ' + n(state.annualKm) + ' km a year against an allowance of ' + n(m.gfv.kmAllowance) +
          ' km, excess charges could reach ' + $(m.gfv.excessKmCost) + ' over the term.');
      }
      if (m.gfv.protection > 0) {
        add('good', 'The guarantee is worth something here',
          'The guaranteed value is ' + $(m.gfv.protection) + ' above the projected market value, which ' +
          'is the downside protection you are paying for — provided you meet the condition and ' +
          'kilometre terms.');
      }
    }

    if (m.effectiveRate && m.effectiveRate - m.annualRate > 0.5) {
      add('info', 'Fees add ' + (m.effectiveRate - m.annualRate).toFixed(2) + ' points to your real rate',
        'The headline rate is ' + pct(m.annualRate, 2) + ', but including the establishment and monthly ' +
        'fees the effective rate on your cash flows is ' + pct(m.effectiveRate, 2) + '.');
    }

    if (+state.deposit === 0 && +state.tradeInValue === 0 && is.loanProduct(state)) {
      add('info', 'No deposit means financing the on-road costs too',
        'Stamp duty, registration and delivery are sunk costs you cannot resell, so financing them ' +
        'deepens the early negative equity.');
    }

    if (+state.extraRepayment > 0) {
      var plain = R.loanModel(Object.assign(toInput(), { extraRepayment: 0 }));
      add('good', 'Extra repayments save ' + $(plain.totalInterest - m.totalInterest) + ' in interest',
        'They also clear the loan about ' +
        Math.round((plain.periods - m.periods) / m.periodsPerYear * 12) + ' months sooner. Check ' +
        'whether your contract allows extra repayments without a break fee.');
    }

    return list;
  }

  function freqWord(f) {
    return { weekly: 'week', fortnightly: 'fortnight', monthly: 'month' }[f] || 'month';
  }
  function freqLabel(f) {
    return { weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly' }[f] || 'Monthly';
  }

  /* ================================================================== *
   * Panels
   * ================================================================== */

  function renderHero(out) {
    var m = out.model, inc = out.income, a = m.affordability;
    var cards = [];

    if (m.product === 'novated') {
      cards.push(heroCard(freqLabel(state.paymentFrequency) + ' net cost', $$(m.netCostPerPay),
        'After tax, including running costs'));
      cards.push(heroCard('Tax saved each year', $(m.taxSaving),
        m.fbt.exemptEv ? 'EV exempt from FBT' : 'FBT method: ' + (m.fbt.method === 'ecm' ? 'ECM' : 'employer pays')));
      cards.push(heroCard('Residual at the end', $(m.residualInclGst),
        pct(m.residualPercent) + ' of the amount financed, incl GST'));
    } else if (m.product === 'cash') {
      cards.push(heroCard('Cash needed', $(m.upfront), 'Drive-away price'));
      cards.push(heroCard('Opportunity cost', $(m.opportunityCost),
        'Return foregone over ' + (m.termMonths / 12) + ' years'));
      cards.push(heroCard('Cost of ownership', $(m.totalCostOfOwnership),
        'After resale value, over the period'));
    } else {
      cards.push(heroCard(freqLabel(state.paymentFrequency) + ' repayment', $$(m.payment),
        $$(m.paymentPerWeek) + ' per week equivalent'));
      cards.push(heroCard('Total interest & fees', $(m.totalFinanceCost),
        'Effective rate ' + pct(m.effectiveRate, 2) + ' incl fees'));
      cards.push(heroCard(m.balloon > 0 ? 'Balloon due at the end' : 'Amount financed',
        $(m.balloon > 0 ? m.balloon : m.financedAmount),
        m.balloon > 0 ? 'On ' + $(m.financedAmount) + ' financed' : 'Over ' + (m.termMonths / 12) + ' years'));
    }

    if (inc.gross > 0) {
      cards.push('<div class="hero-card band-' + a.band.key + '">' +
        '<span class="hero-label">Share of take-home pay</span>' +
        '<span class="hero-value">' + pct(a.percentOfNet) + '</span>' +
        '<span class="hero-sub"><span class="chip">' + esc(a.band.label) + '</span> ' +
        pct(a.percentOfNetAllIn) + ' with running costs</span>' +
        '<span class="meter"><span style="width:' + Math.min(100, a.percentOfNet / 30 * 100).toFixed(1) + '%"></span></span>' +
        '</div>');
    } else {
      cards.push(heroCard('Cost per week, all in', $$(m.costPerWeek || 0),
        m.annualKm > 0 ? $$(m.costPerKm || 0) + ' per kilometre' : 'Add kilometres for a per-km figure'));
    }

    document.getElementById('hero').innerHTML = cards.join('');
  }

  function heroCard(label, value, sub) {
    return '<div class="hero-card"><span class="hero-label">' + esc(label) + '</span>' +
      '<span class="hero-value">' + value + '</span>' +
      '<span class="hero-sub">' + esc(sub) + '</span></div>';
  }

  function renderSummary(out) {
    var m = out.model, c = m.costs, html = '';

    var purchase = [
      [state.priceBasis === 'driveaway' ? 'Vehicle, excluding on-roads' : 'List price', $(c.listPrice)]
    ];
    // Charges that do not apply to this purchase are omitted rather than
    // listed as zero — a used car has no dealer delivery to explain away.
    if (c.optionsAndAccessories > 0) purchase.push(['Options & accessories', $(c.optionsAndAccessories)]);
    if (c.dealerDelivery > 0) purchase.push(['Dealer delivery', $(c.dealerDelivery)]);
    if (c.luxuryCarTax > 0) purchase.push(['Luxury car tax', $(c.luxuryCarTax), 'em']);
    purchase.push(['Stamp duty (' + esc(state.state) + ')', $(c.stampDuty)]);
    purchase.push(['Registration', $(c.registration)]);
    if (c.ctp > 0) purchase.push(['CTP', $(c.ctp)]);
    purchase.push(['Plates & transfer', $(c.plateAndTransferFees)]);
    purchase.push(null);
    purchase.push(['<strong>Drive-away price</strong>', '<strong>' + $(c.driveAwayPrice) + '</strong>', 'total']);
    purchase.push(['GST included in the price', $(c.gstComponent), 'muted']);
    html += card('Purchase costs', table(purchase),
      'Stamp duty is estimated from the published ' + esc(state.state) + ' scale. Use the override field if you have a quote.');

    if (m.product === 'novated') {
      html += renderNovatedCard(m);
    } else if (m.product === 'cash') {
      html += card('Paying cash', table([
        ['Cash required', $(m.upfront)],
        ['Assumed return foregone', pct(+state.savingsReturn, 2) + ' p.a. after ' + pct(+state.savingsTaxRate, 0) + ' tax'],
        ['Opportunity cost over the period', $(m.opportunityCost)],
        ['Running costs over the period', $(m.runningOverTerm)],
        ['Projected resale value', $(m.projectedResale)],
        null,
        ['<strong>Cost of ownership</strong>', '<strong>' + $(m.totalCostOfOwnership) + '</strong>', 'total']
      ]), 'No interest, no fees, no lender. The trade-off is the return that money could have earned.');
    } else {
      var fin = [
        ['Amount financed', $(m.financedAmount)],
        ['Less deposit', '−' + $(m.deposit)],
        ['Less net trade-in', '−' + $(m.netTrade)],
        null,
        ['Interest rate', pct(m.annualRate, 2) + ' p.a.'],
        ['Effective rate including fees', '<strong>' + pct(m.effectiveRate, 2) + '</strong>'],
        ['Term', (m.termMonths / 12) + ' years (' + m.periods + ' ' + freqWord(state.paymentFrequency) + 'ly payments)'],
        [freqLabel(state.paymentFrequency) + ' repayment', '<strong>' + $$(m.payment) + '</strong>'],
        ['Equivalent per week', $$(m.paymentPerWeek)],
        null,
        ['Total interest', $(m.totalInterest)],
        ['Fees', $(m.totalFees)],
        ['Balloon / residual due', $(m.balloon)],
        ['<strong>Total repaid</strong>', '<strong>' + $(m.totalRepayments) + '</strong>', 'total']
      ];
      html += card(R.PRODUCT_LABELS[m.product] || 'Finance', table(fin));
    }

    // Cost of ownership
    var rc = m.running.items;
    if (m.running.excluded) {
      html += card('Running costs',
        '<p class="blurb">Running costs are excluded, so the figures above cover the finance only. ' +
        'Fuel, insurance, registration, servicing and tyres routinely add ' +
        '$3,000–$6,000 a year on an ordinary car — enough to change whether something is ' +
        'affordable.</p>',
        'Turn them back on in the Running costs section to see the full cost of ownership.');
    }
    var own = [
      ['Fuel or electricity', $(rc.energy)],
      ['Insurance', $(rc.insurance)],
      ['Registration & CTP', $(rc.registration)],
      ['Servicing & repairs', $(rc.servicing)],
      ['Tyres', $(rc.tyres)],
      ['Roadside', $(rc.roadside)],
      ['Other', $(rc.other)],
      null,
      ['<strong>Running costs per year</strong>', '<strong>' + $(m.running.annualTotal) + '</strong>', 'total'],
      ['Per week', $(m.running.annualTotal / 52), 'muted']
    ];
    if (!m.running.excluded) html += card('Running costs', table(own));

    var years = m.termMonths / 12;
    var tco = [
      ['Total paid to the lender', $(m.totalRepayments || 0)],
      ['Deposit and trade-in', $((m.deposit || 0) + Math.max(0, m.netTrade || 0))],
      ['Running costs over ' + years + ' years', $(m.runningOverTerm || m.running.annualTotal * years)],
      ['Less projected resale value', '−' + $(m.projectedResale)],
      null,
      ['<strong>Cost of ownership</strong>', '<strong>' + $(m.totalCostOfOwnership) + '</strong>', 'total'],
      ['Per week', $(m.costPerWeek || m.totalCostOfOwnership / (years * 52))],
      ['Per kilometre', m.annualKm > 0 ? $$(m.costPerKm || 0) : '—']
    ];
    html += card('What it really costs', table(tco),
      'Depreciation is the largest cost in most of these numbers, and it applies whether you finance or not.');

    if (m.business) {
      html += card('Business tax treatment', table([
        ['GST credit on purchase', $(m.business.gstCredit)],
        ['Interest and fees claimed', $(m.business.interestClaimed)],
        ['Depreciation claimed (car limit ' + $(m.business.carLimit) + ')', $(m.business.depreciationClaimed)],
        ['Total deductions', $(m.business.totalDeductions)],
        ['Tax saved at ' + pct(+state.companyTaxRate, 0), $(m.business.taxSaved)],
        null,
        ['<strong>Net cost after tax and GST</strong>', '<strong>' + $(m.business.netCostAfterTax) + '</strong>', 'total']
      ]), 'Indicative only. Depreciation is capped by the car limit and adjusted for business use. ' +
          'Speak to a registered tax agent about your circumstances.');
    }

    if (out.stress.length) {
      var head = '<div class="scroll-x"><table class="data"><thead><tr><th>Scenario</th><th>Rate</th><th>Repayment</th>' +
        '<th>Change</th><th>Extra interest</th></tr></thead><tbody>' +
        '<tr><th scope="row">Today</th><td>' + pct(m.annualRate, 2) + '</td><td>' + $$(m.payment) +
        '</td><td>—</td><td>—</td></tr>' +
        out.stress.map(function (s) {
          return '<tr><th scope="row">+' + s.shift + ' points</th><td>' + pct(s.annualRate, 2) + '</td><td>' +
            $$(s.payment) + '</td><td class="up">+' + $$(s.increase) + '</td><td class="up">+' +
            $(s.extraInterest) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      html += card('If rates rise', head,
        'Only relevant on a variable rate. Fixed-rate car loans are the norm in Australia, but not universal.');
    }

    // Interest vs principal by year
    if (m.schedule && m.schedule.length) {
      var perYear = m.periodsPerYear, byYear = [];
      for (var y = 0; y < Math.ceil(m.schedule.length / perYear); y++) {
        var slice = m.schedule.slice(y * perYear, (y + 1) * perYear);
        byYear.push({
          label: 'Year ' + (y + 1),
          interest: slice.reduce(function (a, r) { return a + r.interest; }, 0),
          principal: slice.reduce(function (a, r) { return a + r.principal; }, 0)
        });
      }
      var bars = byYear.map(function (b) {
        var t = b.interest + b.principal;
        return '<div class="ybar"><span class="ybar-label">' + b.label + '</span>' +
          '<span class="ybar-track">' +
          '<span class="seg" style="width:' + (b.principal / t * 100).toFixed(1) + '%;background:' + C.a + '"></span>' +
          '<span class="seg" style="width:' + (b.interest / t * 100).toFixed(1) + '%;background:' + C.c + '"></span>' +
          '</span><span class="ybar-value">' + $(b.interest) + ' interest</span></div>';
      }).join('');
      html += card('Where each year\'s payments go',
        '<div class="ybars">' + bars + '</div>' +
        '<div class="legend"><span class="key"><i style="background:' + C.a + '"></i>Principal</span>' +
        '<span class="key"><i style="background:' + C.c + '"></i>Interest</span></div>',
        'Interest is front-loaded: early payments barely touch the balance.');
    }

    var ins = insights(out);
    if (ins.length) {
      html += '<section class="card"><h3>What stands out</h3><div class="insights">' +
        ins.map(function (i) {
          return '<div class="insight ' + i.level + '"><strong>' + esc(i.title) + '</strong>' +
            '<p>' + esc(i.text) + '</p></div>';
        }).join('') +
        '</div><p class="note">Observations generated from your inputs. General information only — ' +
        'not a recommendation, and not advice about what you should do.</p></section>';
    }

    document.getElementById('panel-summary').innerHTML = html;
  }

  function renderNovatedCard(m) {
    var rows = [
      ['Vehicle price incl GST', $(m.costs.priceBeforeOnRoads + m.costs.luxuryCarTax)],
      ['GST saved on the purchase', '−' + $(m.gstSavingOnPurchase), 'good'],
      ['Amount financed', $(m.financedAmount)],
      ['Lease rate', pct(+state.novatedRate, 2) + ' p.a.'],
      ['Monthly lease payment', $$(m.leasePaymentMonthly)],
      ['Residual (' + pct(m.residualPercent) + ')', $(m.residual) + ' + GST = ' + $(m.residualInclGst)],
      null,
      ['Running costs budgeted', $(m.running.annualTotal) + ' /yr'],
      ['Less GST claimed by employer', '−' + $(m.gstOnRunning), 'good'],
      ['Packaging fee', $(m.packagingFee) + ' /yr'],
      ['<strong>Total packaged each year</strong>', '<strong>' + $(m.annualPackageCost) + '</strong>', 'total'],
      null,
      ['FBT base value', $(m.fbt.baseValue)],
      ['Statutory taxable value (' + pct(R.CONST.fbtStatutoryRate * 100, 0) + ')', $(m.fbt.statutoryTaxableValue)],
      ['Post-tax employee contribution', $(m.fbt.postTaxContribution)],
      ['FBT payable', $(m.fbt.fbtPayable)],
      ['Reportable fringe benefits amount', $(m.fbt.reportableFringeBenefitAmount)],
      null,
      ['Pre-tax salary deduction', $(m.preTaxAnnual) + ' /yr'],
      ['Post-tax deduction', $(m.postTaxAnnual) + ' /yr'],
      ['Tax saved', '−' + $(m.taxSaving) + ' /yr', 'good']
    ];
    if (Math.abs(m.studyLoanImpact) > 1) {
      rows.push(['Extra study loan repayment', $(m.studyLoanImpact) + ' /yr', 'warnrow']);
    }
    rows.push(null);
    rows.push(['<strong>Net cost each year</strong>', '<strong>' + $(m.netAnnualCost) + '</strong>', 'total']);
    rows.push(['Net cost per ' + freqWord(state.paymentFrequency), $$(m.netCostPerPay)]);
    rows.push(['Take-home pay before packaging', $$(m.takeHomeBefore) + ' per ' + freqWord(state.paymentFrequency), 'muted']);
    rows.push(['Take-home pay after packaging', $$(m.takeHomeAfter) + ' per ' + freqWord(state.paymentFrequency), 'muted']);

    return card('Novated lease', table(rows),
      (m.fbt.exemptEv
        ? 'This vehicle is treated as an FBT-exempt electric vehicle, so no employee contribution is required. '
        : '') +
      'These figures include running costs, which a loan repayment does not. Your employer must offer ' +
      'salary packaging, and a real quote from a packager will differ. Not tax advice.');
  }

  function renderIncome(out) {
    var inc = out.income, t = inc.tax, m = out.model, a = m.affordability;
    if (!(inc.gross > 0)) {
      document.getElementById('panel-income').innerHTML =
        '<section class="card"><h3>Add your income</h3><p class="blurb">Enter a gross salary in the ' +
        '<strong>Your income</strong> panel and Revvy will work out your tax, your take-home pay, and ' +
        'how much of it this car would consume.</p></section>';
      return;
    }
    var freq = R.FREQUENCIES[state.paymentFrequency];
    var isNovated = m.product === 'novated';
    var html = card('Your tax position' + (isNovated ? ' before packaging' : '') +
      ' — ' + esc(R.TAX_YEARS[state.taxYear].label), table([
      ['Gross taxable income', $(inc.gross)],
      ['Superannuation paid on top', $(inc.superGuarantee), 'muted'],
      null,
      ['Income tax', '−' + $(t.incomeTax)],
      ['Medicare levy', '−' + $(t.medicareLevy)],
      ['Medicare levy surcharge', '−' + $(t.medicareLevySurcharge)],
      ['Study loan repayment', '−' + $(t.studyLoanRepayment)],
      ['<strong>Total tax</strong>', '<strong>−' + $(t.totalTax) + '</strong>', 'total'],
      null,
      ['<strong>Take-home pay</strong>', '<strong>' + $(inc.net) + '</strong>', 'total'],
      ['Per ' + freqWord(state.paymentFrequency), $$(inc.netPerPay)],
      ['Per week', $$(inc.netPerWeek)],
      ['Marginal rate including Medicare', pct(t.marginalRate * 100, 0)]
    ]), 'Ignores tax offsets, deductions, salary sacrifice to super and anything else specific to you. ' +
        'Not tax advice.');

    // A novated lease changes the tax figure itself, and bundles running costs
    // into the package — so the allocation has to be described differently.
    var packaged = isNovated;
    if (packaged) {
      html += card('With the lease packaged', table([
        ['Gross salary', $(inc.gross)],
        ['Pre-tax salary deduction', '−' + $(m.preTaxAnnual)],
        ['<strong>New taxable income</strong>', '<strong>' + $(inc.gross - m.preTaxAnnual) + '</strong>', 'total'],
        null,
        ['Total tax before packaging', $(m.taxBefore.totalTax)],
        ['Total tax after packaging', $(m.taxAfter.totalTax)],
        ['Tax saved', '−' + $(m.taxSaving), 'good'],
        ['Reportable fringe benefits amount', $(m.fbt.reportableFringeBenefitAmount)],
        null,
        ['Post-tax employee contribution', '−' + $(m.postTaxAnnual)],
        ['Take-home pay before packaging', $$(m.takeHomeBefore) + ' per ' + freqWord(state.paymentFrequency)],
        ['Take-home pay after packaging', $$(m.takeHomeAfter) + ' per ' + freqWord(state.paymentFrequency)],
        ['<strong>Difference in your pay</strong>',
          '<strong>−' + $$(m.takeHomeBefore - m.takeHomeAfter) + '</strong> per ' + freqWord(state.paymentFrequency), 'total'],
        ['That difference covers', 'the car, fuel, insurance, rego, servicing and tyres', 'muted']
      ]), 'Your pay packet drops by less than the full cost of the car because part of it comes out ' +
          'before tax. This is why a lease can look cheap and still leave a residual to pay. ' +
          'Not tax advice.');
    }

    var segments = packaged ? [
      { label: 'Tax after packaging', value: m.taxAfter.totalTax, color: C.e },
      { label: 'Car, packaged (incl running costs)', value: a.repaymentAnnual, color: C.a },
      { label: 'Other debts', value: inc.otherDebtAnnual, color: C.f },
      { label: 'Living expenses', value: inc.livingExpensesAnnual, color: C.d },
      { label: 'Surplus', value: Math.max(0, a.annualSurplus), color: C.c }
    ] : [
      { label: 'Tax', value: t.totalTax, color: C.e },
      { label: 'Car repayment', value: a.repaymentAnnual, color: C.a },
      { label: 'Car running costs', value: a.runningAnnual, color: C.b },
      { label: 'Other debts', value: inc.otherDebtAnnual, color: C.f },
      { label: 'Living expenses', value: inc.livingExpensesAnnual, color: C.d },
      { label: 'Surplus', value: Math.max(0, a.annualSurplus), color: C.c }
    ];
    html += card('Where your gross income goes', stackedBar(segments),
      a.annualSurplus < 0
        ? '<strong>Your outgoings exceed your income by ' + $(Math.abs(a.annualSurplus)) + ' a year on these numbers.</strong>'
        : 'Based on a gross income of ' + $(inc.gross) + '.');

    var costWord = packaged ? 'Net car cost' : 'Repayment';
    var ratios = [
      [costWord + ' as a share of take-home pay', '<strong>' + pct(a.percentOfNet) + '</strong>'],
      [costWord + ' as a share of gross income', pct(a.percentOfGross)],
      [costWord + ' plus running costs, of take-home', pct(a.percentOfNetAllIn)],
      ['All car costs per week', $$(a.totalPerWeek)],
      ['Debt service ratio (all repayments / gross)', pct(a.debtServiceRatio)],
      ['Debt to income (all debt / gross)', a.debtToIncomeRatio.toFixed(2) + '×'],
      ['Surplus after everything', $(a.annualSurplus) + ' /yr (' + $(a.monthlySurplus) + ' /mth)']
    ];
    if (inc.household > inc.gross) {
      ratios.push(['Repayment as a share of household income', pct(a.percentOfHousehold)]);
    }
    html += card('Ratios', table(ratios),
      (packaged
        ? 'Measured against your take-home pay <em>before</em> packaging, so it answers "what share of ' +
          'my normal pay does this car consume". '
        : '') +
      'The 10–15% of take-home pay guide is a common rule of thumb, not a rule, and not advice. ' +
      'Lenders assess serviceability using their own models.');

    // Affordability ladder
    var ladder = [10, 15, 20].map(function (p) {
      var monthly = inc.net * p / 100 / 12;
      var perPeriod = inc.net * p / 100 / freq.perYear;
      var power = R.borrowingPower(toInput(), perPeriod);
      return { label: p + '% of take-home (' + $$(perPeriod) + ' per ' + freqWord(state.paymentFrequency) + ')', value: power };
    });
    html += card('What different repayment levels would finance',
      barChart(ladder, {}),
      'At ' + pct(+state.interestRate, 2) + ' over ' + (+state.termMonths / 12) + ' years. This is not a ' +
      'borrowing capacity assessment — lenders count your expenses, other debts and credit history.');

    if (out.stress.length && is.loanProduct(state)) {
      var stressRows = out.stress.map(function (s) {
        var p = s.payment * freq.perYear / inc.net * 100;
        return '<tr><th scope="row">+' + s.shift + ' points</th><td>' + $$(s.payment) + '</td><td>' +
          pct(p) + '</td><td>' + $(inc.net / 12 - (s.payment * freq.perYear + a.runningAnnual + inc.livingExpensesAnnual + inc.otherDebtAnnual) / 12) + '</td></tr>';
      }).join('');
      html += card('Your buffer if rates move',
        '<div class="scroll-x"><table class="data"><thead><tr><th>Scenario</th><th>Repayment</th><th>Of take-home</th>' +
        '<th>Monthly surplus</th></tr></thead><tbody>' +
        '<tr><th scope="row">Today</th><td>' + $$(m.payment) + '</td><td>' + pct(a.percentOfNet) + '</td><td>' +
        $(a.monthlySurplus) + '</td></tr>' + stressRows + '</tbody></table></div>');
    }

    document.getElementById('panel-income').innerHTML = html;
  }

  function renderCompare(out) {
    var rows = out.comparison, inc = out.income;
    var head = '<div class="scroll-x"><table class="data compare"><thead><tr>' +
      '<th>Option</th><th>Repayment</th><th>Rate</th><th>Balloon / residual</th>' +
      '<th>Interest &amp; fees</th><th>Cost of ownership</th><th>% of take-home</th>' +
      '</tr></thead><tbody>';

    var best = rows.reduce(function (a, b) {
      return (b.totalCostOfOwnership < a.totalCostOfOwnership) ? b : a;
    }, rows[0]);

    var body = rows.map(function (r) {
      var payment = r.product === 'novated' ? r.netCostPerPay
        : r.product === 'cash' ? 0 : r.payment;
      var rate = r.product === 'novated' ? +state.novatedRate
        : r.product === 'cash' ? null : r.annualRate;
      var balloon = r.product === 'novated' ? r.residualInclGst : (r.balloon || 0);
      var finCost = r.product === 'novated' ? r.totalInterest
        : (r.totalFinanceCost != null ? r.totalFinanceCost : 0);
      var share = inc.gross > 0 && r.affordability ? pct(r.affordability.percentOfNet) : '—';
      return '<tr' + (r === best ? ' class="best"' : '') +
        (r.product === state.product ? ' data-current="1"' : '') + '>' +
        '<th scope="row">' + esc(r.label) + (r === best ? ' <span class="chip good">lowest cost</span>' : '') +
        (r.product === state.product ? ' <span class="chip">selected</span>' : '') + '</th>' +
        '<td>' + (payment ? $$(payment) : '—') + '</td>' +
        '<td>' + (rate == null ? '—' : pct(rate, 2)) + '</td>' +
        '<td>' + (balloon ? $(balloon) : '—') + '</td>' +
        '<td>' + $(finCost) + '</td>' +
        '<td><strong>' + $(r.totalCostOfOwnership) + '</strong></td>' +
        '<td>' + share + '</td></tr>';
    }).join('');

    var html = card('Every option, same car',
      head + body + '</tbody></table></div>' +
      '<p class="note">Cost of ownership includes finance costs, running costs and the residual, less the ' +
      'projected resale value. The novated lease line is a net-of-tax figure and already includes ' +
      'running costs, which is why it looks different in kind to the loan rows.</p>');

    html += card('Cost of ownership compared', barChart(rows.map(function (r) {
      return {
        label: r.label, value: r.totalCostOfOwnership,
        color: r === best ? C.c : C.a, highlight: r.product === state.product
      };
    }), {}));

    if (inc.gross > 0) {
      var nov = rows.find(function (r) { return r.product === 'novated'; });
      var sec = rows.find(function (r) { return r.product === 'secured'; });
      if (nov && sec) {
        var loanAllIn = sec.payment * sec.periodsPerYear + sec.running.annualTotal;
        html += card('Novated lease vs secured loan, side by side',
          '<div class="scroll-x"><table class="data"><thead><tr><th></th><th>Secured loan</th>' +
          '<th>Novated lease</th></tr></thead><tbody>' +
          cmpRow('Paid from', 'After-tax income', 'Pre-tax and post-tax salary') +
          cmpRow('GST on the vehicle', 'You pay it', 'Saved: ' + $(nov.gstSavingOnPurchase)) +
          cmpRow('Repayment', $$(sec.payment) + ' per ' + freqWord(state.paymentFrequency), $$(nov.netCostPerPay) + ' per ' + freqWord(state.paymentFrequency) + ' net') +
          cmpRow('Running costs', 'On top: ' + $(sec.running.annualTotal) + ' /yr', 'Included in the package') +
          cmpRow('Annual all-in cost', $(loanAllIn), $(nov.netAnnualCost)) +
          cmpRow('Owed at the end', sec.balloon ? $(sec.balloon) : 'Nothing', $(nov.residualInclGst)) +
          cmpRow('You own the car', 'Yes, from day one', 'Only if you pay the residual') +
          cmpRow('If you change jobs', 'Nothing changes', 'The lease follows you, but the packaging stops') +
          '</tbody></table></div>',
          'A novated lease only works if your employer offers packaging, and the residual is a real debt ' +
          'at the end. Compare a written quote from a packager against a written loan offer.');
      }
    }

    document.getElementById('panel-compare').innerHTML = html;
  }

  function cmpRow(label, a, b) {
    return '<tr><th scope="row">' + esc(label) + '</th><td>' + esc(a) + '</td><td>' + esc(b) + '</td></tr>';
  }

  function renderEquity(out) {
    var m = out.model;
    if (!m.equity || !m.equity.length) {
      document.getElementById('panel-equity').innerHTML = card('Equity',
        '<p class="blurb">Equity tracking applies to financed options. With cash there is no loan ' +
        'balance — you simply own a depreciating asset from day one.</p>' +
        table([
          ['Purchase price', $(m.costs.driveAwayPrice)],
          ['Projected value after ' + (m.termMonths / 12) + ' years', $(m.projectedResale)],
          ['Depreciation', $(m.costs.driveAwayPrice - m.projectedResale)]
        ]));
      return;
    }

    var owing = m.equity.map(function (p) { return { x: p.month, y: p.owing }; });
    var value = m.equity.map(function (p) { return { x: p.month, y: p.value }; });

    var html = card('What you owe vs what it is worth',
      lineChart({
        title: 'Loan balance against projected value',
        series: [
          { name: 'Loan balance', color: C.a, points: owing },
          { name: 'Projected value', color: C.c, points: value, dashed: true }
        ],
        shadeBetween: true
      }),
      m.negativeEquityUntilMonth
        ? 'The shaded area is <strong>negative equity</strong> — you would owe more than the car is worth. ' +
          'On these assumptions that lasts until month ' + Math.round(m.negativeEquityUntilMonth) + '.'
        : 'You stay in positive equity for the whole term on these depreciation assumptions.');

    var milestones = [];
    var checkpoints = [12, 24, 36, 48, 60, 72, 84].filter(function (mo) { return mo <= m.termMonths; });
    checkpoints.push(m.termMonths);
    checkpoints = checkpoints.filter(function (v, i, arr) { return arr.indexOf(v) === i; });
    var rowsHtml = checkpoints.map(function (mo) {
      var point = m.equity.reduce(function (best, p) {
        return Math.abs(p.month - mo) < Math.abs(best.month - mo) ? p : best;
      }, m.equity[0]);
      var eq = point.value - point.owing;
      return '<tr><th scope="row">' + mo + ' months</th><td>' + $(point.owing) + '</td><td>' +
        $(point.value) + '</td><td class="' + (eq < 0 ? 'down' : 'up') + '">' + $(eq) + '</td></tr>';
    }).join('');
    html += card('Equity checkpoints',
      '<div class="scroll-x"><table class="data"><thead><tr><th>Point</th><th>Owing</th><th>Projected value</th>' +
      '<th>Equity</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>',
      'Depreciation assumed at ' + pct(+state.depreciationFirstYear, 0) + ' in the first year, then ' +
      pct(+state.depreciationOngoing, 0) + ' a year. Change these in Assumptions — resale values vary ' +
      'enormously by model.');

    if (m.gfv) {
      html += card('Guaranteed Future Value at the end', table([
        ['Guaranteed value', $(m.gfv.guaranteedValue)],
        ['Projected market value', $(m.gfv.projectedMarket)],
        ['Value of the guarantee', m.gfv.protection > 0 ? $(m.gfv.protection) + ' of downside protection' : 'Market value is above the guarantee'],
        ['Equity if you trade it in', $(m.gfv.equityIfTradedIn)],
        ['Kilometre allowance', n(m.gfv.kmAllowance) + ' km/yr'],
        ['Your usage', n(state.annualKm) + ' km/yr'],
        ['Estimated excess kilometre charge', m.gfv.excessKmCost > 0 ? $(m.gfv.excessKmCost) : 'None']
      ]), 'The guarantee only holds if you meet the condition, service history and kilometre terms in ' +
          'the contract. Read them before relying on the walk-away option.');
    }

    document.getElementById('panel-equity').innerHTML = html;
  }

  function renderSchedule(out) {
    var m = out.model;
    var sched = m.schedule || [];
    if (!sched.length) {
      document.getElementById('panel-schedule').innerHTML =
        card('Repayment schedule', '<p class="blurb">There is no repayment schedule for a cash purchase.</p>');
      return;
    }
    var perYear = m.periodsPerYear || 12;
    var grouped = prefs.groupYears && perYear > 12;

    var rows;
    if (grouped) {
      rows = [];
      for (var y = 0; y < Math.ceil(sched.length / perYear); y++) {
        var slice = sched.slice(y * perYear, (y + 1) * perYear);
        if (!slice.length) continue;
        rows.push({
          label: 'Year ' + (y + 1),
          payment: slice.reduce(function (a, r) { return a + r.payment; }, 0),
          interest: slice.reduce(function (a, r) { return a + r.interest; }, 0),
          principal: slice.reduce(function (a, r) { return a + r.principal; }, 0),
          fee: slice.reduce(function (a, r) { return a + r.fee; }, 0),
          rate: slice[0].annualRate,
          balance: slice[slice.length - 1].balance
        });
      }
    } else {
      rows = sched.map(function (r) {
        return {
          label: '#' + r.period, payment: r.payment, interest: r.interest,
          principal: r.principal, fee: r.fee, rate: r.annualRate, balance: r.balance
        };
      });
    }

    var body = rows.map(function (r) {
      return '<tr><th scope="row">' + esc(r.label) + '</th><td>' + pct(r.rate, 2) + '</td><td>' +
        $$(r.payment) + '</td><td>' + $$(r.interest) + '</td><td>' + $$(r.principal) + '</td><td>' +
        $$(r.fee) + '</td><td>' + $$(r.balance) + '</td></tr>';
    }).join('');

    var html = '<section class="card"><div class="card-head"><h3>Repayment schedule</h3>' +
      '<div class="card-actions">' +
      (perYear > 12 ? '<label class="inline-check"><input type="checkbox" id="chk-groupyears"' +
        (grouped ? ' checked' : '') + '> Group by year</label>' : '') +
      '<button type="button" class="btn small" id="btn-csv">Download CSV</button></div></div>' +
      '<div class="scroll-y"><table class="data sched"><thead><tr><th>Period</th><th>Rate</th>' +
      '<th>Payment</th><th>Interest</th><th>Principal</th><th>Fee</th><th>Balance</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table></div>' +
      (m.balloon > 0 ? '<p class="note"><strong>Plus a balloon of ' + $(m.balloon) +
        '</strong> payable at the end of the term. It is not included in the payment column above.</p>' : '') +
      '<p class="note">Interest is accrued per period at the annual rate divided by the number of ' +
      'periods in a year. Lenders usually accrue daily, so expect small differences from a real ' +
      'statement.</p></section>';

    document.getElementById('panel-schedule').innerHTML = html;

    var chk = document.getElementById('chk-groupyears');
    if (chk) chk.addEventListener('change', function () {
      prefs.groupYears = chk.checked; save(KEY_PREFS, prefs); renderSchedule(out);
    });
    document.getElementById('btn-csv').addEventListener('click', function () { exportCsv(m); });
  }

  function exportCsv(m) {
    var lines = ['Period,Annual rate %,Payment,Interest,Principal,Fee,Closing balance'];
    m.schedule.forEach(function (r) {
      lines.push([r.period, r.annualRate.toFixed(4), r.payment.toFixed(2), r.interest.toFixed(2),
        r.principal.toFixed(2), r.fee.toFixed(2), r.balance.toFixed(2)].join(','));
    });
    if (m.balloon > 0) lines.push('Balloon,,' + m.balloon.toFixed(2) + ',,,,0.00');
    download(lines.join('\n'), 'revvy-schedule.csv', 'text/csv');
  }

  function download(content, filename, type) {
    var blob = new Blob([content], { type: type + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ================================================================== *
   * Render orchestration
   * ================================================================== */

  var lastOut = null;

  function render() {
    var out;
    try {
      out = R.calculate(toInput());
    } catch (err) {
      console.error(err);
      document.getElementById('panel-summary').innerHTML =
        '<section class="card"><h3>Something went wrong</h3><p class="blurb">Check your inputs — one ' +
        'of them may be out of range.</p></section>';
      return;
    }
    lastOut = out;
    renderHero(out);
    renderSummary(out);
    renderIncome(out);
    renderCompare(out);
    renderEquity(out);
    renderSchedule(out);
    document.getElementById('foot-asat').textContent =
      'Default rates and thresholds as at ' + R.DATA_AS_AT + ' — check the Assumptions panel.';
  }

  /* ================================================================== *
   * Tabs
   * ================================================================== */

  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  tabs.forEach(function (t) {
    t.addEventListener('click', function () { selectTab(t.dataset.tab); });
  });

  function selectTab(name) {
    tabs.forEach(function (t) {
      var on = t.dataset.tab === name;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      document.getElementById('panel-' + t.dataset.tab).hidden = !on;
    });
    prefs.tab = name;
    save(KEY_PREFS, prefs);
  }

  /* ================================================================== *
   * Scenarios
   * ================================================================== */

  var dlgScenarios = document.getElementById('dlg-scenarios');

  function renderScenarios() {
    var el = document.getElementById('scenario-list');
    if (!scenarios.length) {
      el.innerHTML = '<p class="muted">Nothing saved yet. Set up a car and save it, then change the ' +
        'numbers and save another to compare.</p>';
      return;
    }
    el.innerHTML = scenarios.map(function (s, i) {
      var summary = s.summary || {};
      return '<div class="scenario">' +
        '<div class="scenario-main"><strong>' + esc(s.name) + '</strong>' +
        '<span class="muted">' + esc(summary.line || '') + '</span></div>' +
        '<div class="scenario-actions">' +
        '<button type="button" class="btn small" data-load="' + i + '">Load</button>' +
        '<button type="button" class="btn small ghost" data-del="' + i + '">Delete</button>' +
        '</div></div>';
    }).join('');
    el.querySelectorAll('[data-load]').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = scenarios[+b.dataset.load];
        state = Object.assign(defaults(), s.state);
        save(KEY_INPUTS, state);
        renderForm(); render();
        dlgScenarios.close();
        toast('Loaded “' + s.name + '”');
      });
    });
    el.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        scenarios.splice(+b.dataset.del, 1);
        save(KEY_SCENARIOS, scenarios);
        renderScenarios();
      });
    });
  }

  document.getElementById('btn-scenarios').addEventListener('click', function () {
    renderScenarios();
    dlgScenarios.showModal();
  });
  document.getElementById('btn-close-scenarios').addEventListener('click', function () {
    dlgScenarios.close();
  });
  document.getElementById('btn-save-scenario').addEventListener('click', function () {
    var input = document.getElementById('scenario-name');
    var name = (input.value || '').trim() ||
      ($(state.vehiclePrice) + ' · ' + (+state.termMonths / 12) + 'yr · ' +
        (R.PRODUCT_LABELS[state.product] || state.product));
    var m = lastOut && lastOut.model;
    scenarios.unshift({
      name: name,
      saved: new Date().toISOString(),
      state: JSON.parse(JSON.stringify(state)),
      summary: {
        line: m ? (m.product === 'novated'
          ? $$(m.netCostPerPay) + ' net per ' + freqWord(state.paymentFrequency)
          : $$(m.payment || 0) + ' per ' + freqWord(state.paymentFrequency) +
            ' · ' + $(m.totalCostOfOwnership) + ' to own') : ''
      }
    });
    scenarios = scenarios.slice(0, 20);
    save(KEY_SCENARIOS, scenarios);
    input.value = '';
    renderScenarios();
    toast('Scenario saved');
  });

  document.getElementById('btn-export').addEventListener('click', function () {
    download(JSON.stringify({ app: 'revvy', version: 1, state: state, scenarios: scenarios }, null, 2),
      'revvy-data.json', 'application/json');
  });
  document.getElementById('btn-import').addEventListener('click', function () {
    document.getElementById('file-import').click();
  });
  document.getElementById('file-import').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (data.state) { state = Object.assign(defaults(), data.state); save(KEY_INPUTS, state); }
        if (Array.isArray(data.scenarios)) { scenarios = data.scenarios; save(KEY_SCENARIOS, scenarios); }
        renderForm(); render(); renderScenarios();
        toast('Imported');
      } catch (err) { toast('That file could not be read'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  /* ================================================================== *
   * Chrome: theme, reset, print, disclaimer, toast
   * ================================================================== */

  function applyTheme() {
    document.documentElement.dataset.theme = prefs.theme;
  }
  document.getElementById('btn-theme').addEventListener('click', function () {
    prefs.theme = prefs.theme === 'dark' ? 'light' : prefs.theme === 'light' ? 'auto' : 'dark';
    save(KEY_PREFS, prefs);
    applyTheme();
    toast('Theme: ' + prefs.theme);
  });

  document.getElementById('btn-reset').addEventListener('click', function () {
    if (!confirm('Reset every input back to the defaults? Saved scenarios are kept.')) return;
    state = defaults();
    save(KEY_INPUTS, state);
    renderForm(); render();
    toast('Reset to defaults');
  });

  document.getElementById('btn-print').addEventListener('click', function () { window.print(); });

  var dlgDisclaimer = document.getElementById('dlg-disclaimer');
  document.getElementById('btn-disclaimer').addEventListener('click', function () {
    dlgDisclaimer.showModal();
  });
  dlgDisclaimer.addEventListener('close', function () {
    prefs.acknowledged = true;
    save(KEY_PREFS, prefs);
  });

  var toastEl = document.getElementById('toast');
  var toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 2400);
  }

  /* ================================================================== *
   * Boot
   * ================================================================== */

  applyTheme();
  renderForm();
  render();
  selectTab(prefs.tab || 'summary');
  if (!prefs.acknowledged) dlgDisclaimer.showModal();
})();
