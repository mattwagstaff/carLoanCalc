/*!
 * Revvy — Australian car finance calculation engine
 * Pure functions only: no DOM, no globals beyond the exported namespace.
 * Loadable as a plain <script> (window.Revvy) or via require() for tests.
 *
 * General information only. Not financial advice. See DISCLAIMER in README.md.
 */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Revvy = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Reference data
   *
   * Every figure below is a *default* that the user can override in the
   * Assumptions panel. Rates and thresholds are indexed or legislated and
   * change frequently — always verify against ato.gov.au and your state
   * revenue office before relying on a number.
   * ------------------------------------------------------------------ */

  var DATA_AS_AT = 'July 2026';

  // Resident income tax scales (excludes Medicare levy, which is applied separately).
  // Each bracket is [upperThreshold, marginalRate].
  var TAX_YEARS = {
    '2024-25': {
      label: '2024–25',
      brackets: [[18200, 0], [45000, 0.16], [135000, 0.30], [190000, 0.37], [Infinity, 0.45]],
      medicare: { rate: 0.02, singleLower: 27222, singleUpper: 34027, familyLower: 45907, perChild: 4216 }
    },
    '2025-26': {
      label: '2025–26',
      brackets: [[18200, 0], [45000, 0.16], [135000, 0.30], [190000, 0.37], [Infinity, 0.45]],
      medicare: { rate: 0.02, singleLower: 27222, singleUpper: 34027, familyLower: 45907, perChild: 4216 }
    },
    // From 1 July 2026 the lowest marginal rate steps down from 16% to 15%.
    '2026-27': {
      label: '2026–27',
      brackets: [[18200, 0], [45000, 0.15], [135000, 0.30], [190000, 0.37], [Infinity, 0.45]],
      medicare: { rate: 0.02, singleLower: 27222, singleUpper: 34027, familyLower: 45907, perChild: 4216 }
    }
  };

  // Study and training loan (HELP/HECS) repayment — marginal system.
  // [upperThreshold, rateAppliedToIncomeAboveThePreviousThreshold]
  var HELP_BRACKETS = [[67000, 0], [125000, 0.15], [Infinity, 0.17]];

  // Medicare levy surcharge — applies to the whole income for surcharge purposes.
  var MLS_TIERS = {
    single: [[101000, 0], [118000, 0.01], [158000, 0.0125], [Infinity, 0.015]],
    family: [[202000, 0], [236000, 0.01], [316000, 0.0125], [Infinity, 0.015]],
    familyPerChildAfterFirst: 1500
  };

  var CONST = {
    gstRate: 0.10,
    // Luxury car tax
    lctRate: 0.33,
    lctThresholdFuelEfficient: 91387,
    lctThresholdOther: 80567,
    // Income tax car limit — caps depreciation and the GST input tax credit
    carLimit: 69674,
    // Fringe benefits tax
    fbtRate: 0.47,
    fbtStatutoryRate: 0.20,
    fbtGrossUpType1: 2.0802, // GST-creditable benefits (typical novated lease)
    fbtGrossUpType2: 1.8868, // used for reportable fringe benefit amounts
    // ATO minimum residual values for novated leases, by whole years of term
    atoResiduals: { 12: 0.6563, 24: 0.5625, 36: 0.4688, 48: 0.3750, 60: 0.2813 },
    superGuarantee: 0.12
  };

  var STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'];

  var FREQUENCIES = {
    weekly: { label: 'Weekly', perYear: 52 },
    fortnightly: { label: 'Fortnightly', perYear: 26 },
    monthly: { label: 'Monthly', perYear: 12 }
  };

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  function num(v, fallback) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : (fallback || 0);
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function round(v, dp) {
    var f = Math.pow(10, dp == null ? 2 : dp);
    return Math.round((v + Number.EPSILON) * f) / f;
  }

  /* ------------------------------------------------------------------ *
   * Tax
   * ------------------------------------------------------------------ */

  function marginalTax(income, brackets) {
    var tax = 0, previous = 0;
    for (var i = 0; i < brackets.length; i++) {
      var cap = brackets[i][0], rate = brackets[i][1];
      if (income > previous) tax += (Math.min(income, cap) - previous) * rate;
      previous = cap;
      if (income <= cap) break;
    }
    return Math.max(0, tax);
  }

  function marginalRateAt(income, brackets) {
    var previous = 0;
    for (var i = 0; i < brackets.length; i++) {
      if (income <= brackets[i][0]) return brackets[i][1];
      previous = brackets[i][0];
    }
    return brackets[brackets.length - 1][1];
  }

  function medicareLevy(income, cfg, opts) {
    opts = opts || {};
    if (opts.exempt) return 0;
    var lower = cfg.singleLower, upper = cfg.singleUpper;
    if (opts.family) {
      lower = cfg.familyLower + cfg.perChild * num(opts.dependants);
      // The shade-in band scales with the threshold in the same proportion.
      upper = lower / (1 - cfg.rate / 0.10);
    }
    if (income <= lower) return 0;
    if (income < upper) return (income - lower) * 0.10;
    return income * cfg.rate;
  }

  function helpRepayment(repaymentIncome, brackets) {
    return marginalTax(repaymentIncome, brackets || HELP_BRACKETS);
  }

  function medicareLevySurcharge(surchargeIncome, opts) {
    opts = opts || {};
    if (opts.privateHospitalCover) return 0;
    var tiers = opts.family ? MLS_TIERS.family : MLS_TIERS.single;
    var offset = 0;
    if (opts.family && num(opts.dependants) > 1) {
      offset = MLS_TIERS.familyPerChildAfterFirst * (num(opts.dependants) - 1);
    }
    for (var i = 0; i < tiers.length; i++) {
      if (surchargeIncome <= tiers[i][0] + offset) return surchargeIncome * tiers[i][1];
    }
    return surchargeIncome * tiers[tiers.length - 1][1];
  }

  /**
   * Full personal tax position for a year.
   * `reportableFringeBenefits` is added back for HELP, MLS and surcharge purposes
   * but is not itself taxable — this is what catches people out on novated leases.
   */
  function taxPosition(input) {
    var year = TAX_YEARS[input.taxYear] || TAX_YEARS['2026-27'];
    var taxable = Math.max(0, num(input.taxableIncome));
    var rfba = Math.max(0, num(input.reportableFringeBenefits));
    var reportableSuper = Math.max(0, num(input.reportableSuper));

    var incomeTax = marginalTax(taxable, year.brackets);
    var levy = medicareLevy(taxable, year.medicare, {
      exempt: input.medicareExempt,
      family: input.family,
      dependants: input.dependants
    });

    var adjusted = taxable + rfba + reportableSuper;
    var surcharge = medicareLevySurcharge(adjusted, {
      privateHospitalCover: input.privateHospitalCover,
      family: input.family,
      dependants: input.dependants
    });
    var help = input.hasStudyLoan
      ? Math.min(num(input.studyLoanBalance, Infinity) || Infinity,
                 helpRepayment(adjusted, input.helpBrackets))
      : 0;

    var total = incomeTax + levy + surcharge + help;
    return {
      taxableIncome: taxable,
      incomeTax: incomeTax,
      medicareLevy: levy,
      medicareLevySurcharge: surcharge,
      studyLoanRepayment: help,
      totalTax: total,
      netIncome: taxable - total,
      marginalRate: marginalRateAt(taxable, year.brackets) +
        (input.medicareExempt ? 0 : year.medicare.rate)
    };
  }

  /* ------------------------------------------------------------------ *
   * Purchase costs: LCT, stamp duty, drive-away price
   * ------------------------------------------------------------------ */

  function luxuryCarTax(gstInclusivePrice, fuelEfficient, cfg) {
    cfg = cfg || CONST;
    var threshold = fuelEfficient ? cfg.lctThresholdFuelEfficient : cfg.lctThresholdOther;
    if (gstInclusivePrice <= threshold) return 0;
    // LCT applies to the GST-inclusive value above the threshold, excluding the GST component.
    return cfg.lctRate * ((gstInclusivePrice - threshold) / (1 + cfg.gstRate));
  }

  function isFuelEfficient(fuelType) {
    return fuelType === 'ev' || fuelType === 'phev' || fuelType === 'hybrid';
  }

  /**
   * Vehicle registration stamp duty (motor vehicle duty) by state.
   * These are simplified models of the published scales and are ESTIMATES ONLY —
   * concessions, EV exemptions and commercial vehicle rates vary. Users can override.
   */
  function stampDuty(state, value, opts) {
    opts = opts || {};
    var v = Math.max(0, num(value));
    var per = function (rate, unit) { return Math.ceil(v / unit) * rate; };
    var ev = opts.fuelType === 'ev';

    switch (state) {
      case 'NSW':
        // 3% to $45,000, then $1,350 + 5% of the excess.
        return v <= 45000 ? v * 0.03 : 1350 + (v - 45000) * 0.05;

      case 'VIC': {
        if (opts.vehicleType === 'commercial') return per(5.40, 200);
        if (v <= 80567) return per(8.40, 200);
        if (v <= 100000) return per(10.40, 200);
        if (v <= 150000) return per(14.00, 200);
        return per(18.00, 200);
      }

      case 'QLD': {
        var lowRate, highRate;
        if (ev || opts.fuelType === 'hybrid' || opts.fuelType === 'phev') { lowRate = 2; highRate = 4; }
        else if (num(opts.cylinders, 4) <= 4) { lowRate = 3; highRate = 5; }
        else if (num(opts.cylinders, 4) <= 6) { lowRate = 3.5; highRate = 5.5; }
        else { lowRate = 4; highRate = 6; }
        if (v <= 100000) return Math.ceil(v / 100) * lowRate;
        return Math.ceil(100000 / 100) * lowRate + Math.ceil((v - 100000) / 100) * highRate;
      }

      case 'SA': {
        if (opts.vehicleType === 'commercial') {
          if (v <= 1000) return Math.max(5, Math.ceil(v / 100) * 1);
          if (v <= 2000) return 10 + Math.ceil((v - 1000) / 100) * 2;
          return 30 + Math.ceil((v - 2000) / 100) * 3;
        }
        if (v <= 1000) return Math.max(5, Math.ceil(v / 100) * 1);
        if (v <= 2000) return 10 + Math.ceil((v - 1000) / 100) * 2;
        if (v <= 3000) return 30 + Math.ceil((v - 2000) / 100) * 3;
        return 60 + Math.ceil((v - 3000) / 100) * 4;
      }

      case 'WA': {
        if (v <= 25000) return v * 0.0275;
        if (v < 50000) {
          var rate = (2.75 + ((v - 25000) / 6666.66)) / 100;
          return v * Math.min(rate, 0.065);
        }
        return v * 0.065;
      }

      case 'TAS': {
        if (v <= 600) return 20;
        if (v <= 35000) return v * 0.03;
        if (v <= 40000) return 1050 + (v - 35000) * 0.11;
        return v * 0.04;
      }

      case 'ACT': {
        if (ev) return 0; // zero emission vehicles are exempt
        var band = opts.actRating || 'C';
        var scale = { A: [0, 0], B: [1, 2], C: [3, 5], D: [4, 6] }[band] || [3, 5];
        if (v <= 45000) return Math.ceil(v / 100) * scale[0];
        return Math.ceil(45000 / 100) * scale[0] + Math.ceil((v - 45000) / 100) * scale[1];
      }

      case 'NT':
        return v * 0.03 + 56;

      default:
        return v * 0.03;
    }
  }

  /**
   * Build the full drive-away cost from a list price.
   */
  function purchaseCosts(input) {
    var cfg = input.constants || CONST;
    var list = num(input.vehiclePrice);
    var options = num(input.optionsAndAccessories);
    var delivery = num(input.dealerDelivery);
    var priceBeforeOnRoads = list + options + delivery;

    var lct = input.includeLct === false ? 0
      : luxuryCarTax(priceBeforeOnRoads, isFuelEfficient(input.fuelType), cfg);

    var dutiableValue = priceBeforeOnRoads + (input.dutyIncludesLct === false ? 0 : lct);
    var duty = input.stampDutyOverride != null && input.stampDutyOverride !== ''
      ? num(input.stampDutyOverride)
      : stampDuty(input.state, dutiableValue, {
          fuelType: input.fuelType,
          cylinders: input.cylinders,
          vehicleType: input.vehicleType,
          actRating: input.actRating
        });

    var registration = num(input.registrationCost);
    var ctp = num(input.ctpCost);
    var plates = num(input.plateAndTransferFees);
    var onRoads = duty + registration + ctp + plates;

    var driveAway = priceBeforeOnRoads + lct + onRoads;
    return {
      listPrice: list,
      optionsAndAccessories: options,
      dealerDelivery: delivery,
      priceBeforeOnRoads: priceBeforeOnRoads,
      luxuryCarTax: lct,
      stampDuty: duty,
      registration: registration,
      ctp: ctp,
      plateAndTransferFees: plates,
      onRoadCosts: onRoads,
      driveAwayPrice: driveAway,
      gstComponent: priceBeforeOnRoads - priceBeforeOnRoads / (1 + cfg.gstRate),
      // FBT base value excludes registration and stamp duty, includes GST and LCT.
      fbtBaseValue: priceBeforeOnRoads + lct
    };
  }

  /* ------------------------------------------------------------------ *
   * Amortisation
   * ------------------------------------------------------------------ */

  /** Level payment that amortises `pv` to `fv` over `n` periods at periodic `rate`. */
  function paymentFor(rate, n, pv, fv, paymentsInAdvance) {
    if (n <= 0) return 0;
    var p;
    if (Math.abs(rate) < 1e-12) {
      p = (pv - (fv || 0)) / n;
    } else {
      var f = Math.pow(1 + rate, n);
      p = (pv * f - (fv || 0)) * rate / (f - 1);
    }
    return paymentsInAdvance ? p / (1 + rate) : p;
  }

  function rateAtPeriod(schedule, baseRate, period, periodsPerYear) {
    var annual = baseRate;
    if (schedule && schedule.length) {
      for (var i = 0; i < schedule.length; i++) {
        if (period > schedule[i].afterPeriods) annual = schedule[i].annualRate;
      }
    }
    return annual / 100 / periodsPerYear;
  }

  /**
   * Period-by-period amortisation supporting balloon/residual values, payments in
   * advance (leases), account-keeping fees, extra repayments and rate changes.
   * When the rate changes, the payment is recalculated over the remaining term —
   * which is what a variable-rate lender does.
   */
  function amortise(opts) {
    var principal = Math.max(0, num(opts.principal));
    var periodsPerYear = num(opts.periodsPerYear, 12);
    var n = Math.max(1, Math.round(num(opts.periods)));
    var balloon = Math.max(0, num(opts.balloon));
    var advance = !!opts.paymentsInAdvance;
    var fee = num(opts.feePerPeriod);
    var extra = num(opts.extraPerPeriod);
    var changes = (opts.rateChanges || []).slice().sort(function (a, b) {
      return a.afterPeriods - b.afterPeriods;
    });

    var balance = principal;
    var rows = [];
    var totalInterest = 0, totalFees = 0, totalPaid = 0;
    var payment = 0, lastRate = null;
    var scheduledPayment = null;

    for (var p = 1; p <= n; p++) {
      var r = rateAtPeriod(changes, num(opts.annualRate), p, periodsPerYear);
      if (lastRate === null || Math.abs(r - lastRate) > 1e-12) {
        payment = paymentFor(r, n - p + 1, balance, balloon, advance);
        lastRate = r;
        if (scheduledPayment === null) scheduledPayment = payment;
      }

      var interest, principalPart, cash, extraThisPeriod = extra;
      var opening = balance;

      if (advance) {
        // Paid at the start of the period, so interest accrues on what is left.
        var pay = Math.min(payment + extraThisPeriod, balance);
        cash = pay;
        balance -= pay;
        interest = balance * r;
        balance += interest;
        principalPart = pay - interest;
      } else {
        interest = balance * r;
        var target = payment + extraThisPeriod;
        if (p === n) target = balance + interest - balloon;
        if (target > balance + interest) target = balance + interest;
        cash = target;
        principalPart = target - interest;
        balance = balance + interest - target;
      }

      if (balance < 0.005) balance = 0;
      totalInterest += interest;
      totalFees += fee;
      totalPaid += cash + fee;

      rows.push({
        period: p,
        annualRate: r * periodsPerYear * 100,
        opening: opening,
        payment: cash + fee,
        interest: interest,
        principal: principalPart,
        fee: fee,
        balance: balance
      });

      if (balance <= 0 && p < n) {
        n = p; // paid out early through extra repayments
        break;
      }
    }

    var residualDue = balance;
    return {
      rows: rows,
      periods: rows.length,
      scheduledPayment: (scheduledPayment || 0) + fee,
      basePayment: scheduledPayment || 0,
      feePerPeriod: fee,
      totalInterest: totalInterest,
      totalFees: totalFees,
      totalPaid: totalPaid,
      finalBalance: residualDue
    };
  }

  /**
   * Effective annual rate implied by the actual cash flows, including fees and
   * the balloon. This is the same idea as a comparison rate but calculated on
   * *your* loan rather than the regulated $30,000 / 5 year example.
   */
  function effectiveRate(netAdvance, schedule, balloon, periodsPerYear) {
    if (netAdvance <= 0 || !schedule.length) return 0;
    var flows = schedule.map(function (r) { return r.payment; });
    flows[flows.length - 1] += Math.max(0, num(balloon));

    function npv(rate) {
      var v = -netAdvance;
      for (var i = 0; i < flows.length; i++) v += flows[i] / Math.pow(1 + rate, i + 1);
      return v;
    }

    var lo = -0.9 / periodsPerYear, hi = 3 / periodsPerYear;
    if (npv(lo) * npv(hi) > 0) return 0;
    for (var i = 0; i < 200; i++) {
      var mid = (lo + hi) / 2;
      if (npv(mid) > 0) lo = mid; else hi = mid;
    }
    return ((lo + hi) / 2) * periodsPerYear * 100;
  }

  /* ------------------------------------------------------------------ *
   * Depreciation / equity
   * ------------------------------------------------------------------ */

  function projectedValue(price, months, firstYearDropPct, ongoingPct) {
    var firstYear = clamp(num(firstYearDropPct, 20) / 100, 0, 0.9);
    var ongoing = clamp(num(ongoingPct, 14) / 100, 0, 0.9);
    var years = months / 12;
    if (years <= 1) return price * Math.pow(1 - firstYear, years);
    return price * (1 - firstYear) * Math.pow(1 - ongoing, years - 1);
  }

  /* ------------------------------------------------------------------ *
   * Running costs
   * ------------------------------------------------------------------ */

  function runningCosts(input) {
    var km = Math.max(0, num(input.annualKm));
    var energy;
    if (input.fuelType === 'ev') {
      var kwh = num(input.energyUse, 16); // kWh / 100km
      energy = km / 100 * kwh * (num(input.electricityPrice, 30) / 100);
    } else {
      var lPer100 = num(input.fuelEconomy, 7.5);
      energy = km / 100 * lPer100 * num(input.fuelPrice, 1.95);
      if (input.fuelType === 'phev') energy *= 0.6; // rough blend of electric running
    }
    var items = {
      energy: energy,
      insurance: num(input.insuranceCost),
      registration: num(input.annualRegistration),
      servicing: num(input.servicingCost),
      tyres: num(input.tyresCost),
      roadside: num(input.roadsideCost),
      other: num(input.otherRunningCost)
    };
    var total = 0;
    for (var k in items) total += items[k];
    return { items: items, annualTotal: total, perKm: km > 0 ? total / km : 0 };
  }

  /* ------------------------------------------------------------------ *
   * Loan products
   * ------------------------------------------------------------------ */

  /**
   * The rate that applies to a given product. Unsecured lending carries a
   * premium over secured; dealer and GFV products are quoted separately.
   */
  function productRate(input, product) {
    var base = num(input.interestRate, 7);
    if (product === 'unsecured') return base + num(input.unsecuredPremium, 3.5);
    if (product === 'dealer') return num(input.dealerRate, base);
    if (product === 'gfv') return num(input.gfvRate, base);
    return base;
  }

  function resolveBalloon(input, financedAmount, termMonths) {
    var mode = input.balloonMode || 'percent';
    if (mode === 'none') return 0;
    if (mode === 'amount') return Math.max(0, num(input.balloonAmount));
    if (mode === 'atoMinimum') {
      var years = Math.round(termMonths / 12);
      var pct = CONST.atoResiduals[years * 12] || CONST.atoResiduals[60];
      return financedAmount * pct;
    }
    if (mode === 'gfv') return Math.max(0, num(input.gfvAmount));
    return financedAmount * clamp(num(input.balloonPercent), 0, 90) / 100;
  }

  /**
   * Model a credit contract (secured loan, unsecured loan, dealer finance,
   * GFV product, chattel mortgage, finance lease).
   */
  function loanModel(input, overrides) {
    overrides = overrides || {};
    var cfg = input.constants || CONST;
    var costs = purchaseCosts(input);
    var freq = FREQUENCIES[input.paymentFrequency] || FREQUENCIES.monthly;
    var periodsPerYear = freq.perYear;
    var termMonths = Math.max(1, Math.round(num(input.termMonths, 60)));
    var periods = Math.max(1, Math.round(termMonths / 12 * periodsPerYear));

    var product = overrides.product || input.product || 'secured';
    var rate = overrides.annualRate != null ? overrides.annualRate : productRate(input, product);

    var price = costs.driveAwayPrice;
    var gstCredit = 0;
    if (product === 'chattel' || product === 'financeLease') {
      // A GST-registered business claims the input tax credit, capped at 1/11th
      // of the car limit. It arrives with the next BAS, not at settlement.
      if (input.gstRegistered) {
        gstCredit = Math.min(costs.priceBeforeOnRoads / 11, cfg.carLimit / 11) *
          clamp(num(input.businessUsePercent, 100), 0, 100) / 100;
      }
    }

    var deposit = num(input.deposit);
    var tradeIn = num(input.tradeInValue);
    var tradePayout = num(input.tradeInPayout);
    var netTrade = tradeIn - tradePayout;
    var establishment = num(input.establishmentFee);
    var financedAmount = Math.max(0, price - deposit - netTrade +
      (input.capitaliseFees === false ? 0 : establishment));

    // A GFV product's balloon *is* the guaranteed future value.
    var balloon = overrides.balloon != null ? overrides.balloon
      : product === 'gfv' ? num(input.gfvAmount)
      : resolveBalloon(input, financedAmount, termMonths);
    balloon = Math.min(balloon, financedAmount * 0.95);

    var feePerPeriod = num(input.monthlyFee) * 12 / periodsPerYear;
    var advance = overrides.paymentsInAdvance != null ? overrides.paymentsInAdvance
      : (product === 'financeLease' || product === 'novated');

    var rateChanges = (input.rateChanges || []).map(function (c) {
      return {
        afterPeriods: Math.round(num(c.afterMonths) / 12 * periodsPerYear),
        annualRate: num(c.annualRate) + num(overrides.rateShift)
      };
    }).filter(function (c) { return c.afterPeriods > 0 && c.afterPeriods < periods; });

    var sched = amortise({
      principal: financedAmount,
      annualRate: rate + num(overrides.rateShift),
      periodsPerYear: periodsPerYear,
      periods: periods,
      balloon: balloon,
      paymentsInAdvance: advance,
      feePerPeriod: feePerPeriod,
      extraPerPeriod: num(input.extraRepayment),
      rateChanges: rateChanges
    });

    var netAdvance = financedAmount - (input.capitaliseFees === false ? 0 : establishment);
    var effRate = effectiveRate(netAdvance, sched.rows, balloon, periodsPerYear);

    var running = runningCosts(input);
    var years = sched.periods / periodsPerYear;
    var runningOverTerm = running.annualTotal * years;

    var totalFinanceCost = sched.totalInterest + sched.totalFees + establishment;
    var totalOutlay = deposit + Math.max(0, netTrade) + sched.totalPaid + balloon +
      (input.capitaliseFees === false ? establishment : 0);

    var resale = projectedValue(costs.priceBeforeOnRoads + costs.luxuryCarTax, termMonths,
      input.depreciationFirstYear, input.depreciationOngoing);

    // Equity track: what you owe vs what the car is worth, month by month.
    var equity = [];
    var monthsPerPeriod = 12 / periodsPerYear;
    for (var i = 0; i <= sched.rows.length; i++) {
      var m = i * monthsPerPeriod;
      equity.push({
        month: m,
        owing: i === 0 ? financedAmount : sched.rows[i - 1].balance,
        value: projectedValue(costs.priceBeforeOnRoads + costs.luxuryCarTax, m,
          input.depreciationFirstYear, input.depreciationOngoing)
      });
    }
    var negativeEquityUntil = null;
    for (var j = 0; j < equity.length; j++) {
      if (equity[j].owing > equity[j].value) negativeEquityUntil = equity[j].month;
      else if (negativeEquityUntil !== null) break;
    }

    var result = {
      product: product,
      label: PRODUCT_LABELS[product] || product,
      costs: costs,
      financedAmount: financedAmount,
      deposit: deposit,
      netTrade: netTrade,
      annualRate: rate,
      termMonths: termMonths,
      frequency: input.paymentFrequency || 'monthly',
      periodsPerYear: periodsPerYear,
      periods: sched.periods,
      payment: sched.scheduledPayment,
      paymentPerWeek: sched.scheduledPayment * periodsPerYear / 52,
      paymentPerMonth: sched.scheduledPayment * periodsPerYear / 12,
      balloon: balloon,
      balloonDue: balloon,
      totalInterest: sched.totalInterest,
      totalFees: sched.totalFees + establishment,
      totalFinanceCost: totalFinanceCost,
      totalRepayments: sched.totalPaid + balloon,
      totalOutlay: totalOutlay,
      effectiveRate: effRate,
      schedule: sched.rows,
      running: running,
      runningOverTerm: runningOverTerm,
      totalCostOfOwnership: totalOutlay + runningOverTerm - resale - gstCredit,
      projectedResale: resale,
      equityAtEnd: resale - balloon,
      equity: equity,
      negativeEquityUntilMonth: negativeEquityUntil,
      gstCredit: gstCredit,
      annualKm: num(input.annualKm)
    };

    result.costPerKm = result.annualKm > 0
      ? result.totalCostOfOwnership / (result.annualKm * years) : 0;
    result.costPerWeek = years > 0 ? result.totalCostOfOwnership / (years * 52) : 0;

    if (product === 'chattel' || product === 'financeLease') {
      result.business = businessDeductions(input, result, cfg);
    }
    if (product === 'gfv') {
      result.gfv = {
        guaranteedValue: balloon,
        projectedMarket: resale,
        equityIfTradedIn: resale - balloon,
        protection: Math.max(0, balloon - resale),
        kmAllowance: num(input.gfvAnnualKm, num(input.annualKm)),
        excessKmRate: num(input.gfvExcessKmRate, 0.15),
        excessKmCost: Math.max(0, (num(input.annualKm) - num(input.gfvAnnualKm, num(input.annualKm)))) *
          (termMonths / 12) * num(input.gfvExcessKmRate, 0.15)
      };
    }
    return result;
  }

  var PRODUCT_LABELS = {
    secured: 'Secured car loan',
    unsecured: 'Unsecured personal loan',
    dealer: 'Dealer / manufacturer finance',
    gfv: 'Guaranteed Future Value',
    chattel: 'Chattel mortgage (business)',
    financeLease: 'Finance lease (business)',
    novated: 'Novated lease (salary packaged)',
    cash: 'Pay cash / savings'
  };

  /** Indicative business tax effect of a chattel mortgage or finance lease. */
  function businessDeductions(input, model, cfg) {
    var rate = clamp(num(input.companyTaxRate, 25), 0, 50) / 100;
    var businessUse = clamp(num(input.businessUsePercent, 100), 0, 100) / 100;
    var years = model.termMonths / 12;
    var depreciable = Math.min(model.costs.priceBeforeOnRoads / (1 + cfg.gstRate), cfg.carLimit);
    // Diminishing value at 25% p.a. (8 year effective life), capped by the car limit.
    var written = depreciable * (1 - Math.pow(0.75, years));
    var deductions = (model.totalInterest + model.totalFees + written) * businessUse;
    return {
      carLimit: cfg.carLimit,
      depreciationClaimed: written * businessUse,
      interestClaimed: (model.totalInterest + model.totalFees) * businessUse,
      totalDeductions: deductions,
      taxSaved: deductions * rate,
      gstCredit: model.gstCredit,
      netCostAfterTax: model.totalOutlay - deductions * rate - model.gstCredit
    };
  }

  /* ------------------------------------------------------------------ *
   * Novated lease
   * ------------------------------------------------------------------ */

  /**
   * Fully maintained novated lease with salary packaging.
   *
   * Models the three things that actually move the number: the GST saving on
   * the purchase price, pre-tax salary deductions, and FBT (either neutralised
   * with the Employee Contribution Method, or exempt for an eligible EV).
   */
  function novatedModel(input) {
    var cfg = input.constants || CONST;
    var costs = purchaseCosts(input);
    var termMonths = Math.max(12, Math.round(num(input.termMonths, 60)));
    var years = termMonths / 12;
    var freq = FREQUENCIES[input.paymentFrequency] || FREQUENCIES.monthly;

    // The financier claims the GST input tax credit on the purchase, capped at
    // 1/11th of the car limit, so the employee finances the GST-exclusive price.
    var gstSaving = Math.min(costs.priceBeforeOnRoads / 11, cfg.carLimit / 11);
    var financedBase = costs.priceBeforeOnRoads + costs.luxuryCarTax - gstSaving +
      costs.stampDuty + costs.registration + costs.ctp + costs.plateAndTransferFees;
    var financedAmount = Math.max(0, financedBase - num(input.deposit) -
      (num(input.tradeInValue) - num(input.tradeInPayout)) + num(input.establishmentFee));

    var residualPct = input.residualMode === 'custom'
      ? clamp(num(input.residualPercent), 0, 90) / 100
      : (cfg.atoResiduals[Math.round(termMonths / 12) * 12] || cfg.atoResiduals[60]);
    var residual = financedAmount * residualPct;

    // Novated lease payments are made monthly in advance.
    var sched = amortise({
      principal: financedAmount,
      annualRate: num(input.novatedRate, num(input.interestRate, 7)),
      periodsPerYear: 12,
      periods: termMonths,
      balloon: residual,
      paymentsInAdvance: true,
      feePerPeriod: 0
    });
    var leasePaymentMonthly = sched.scheduledPayment;

    // Budgeted running costs. Where the employer can claim GST credits, the
    // employee packages the GST-exclusive amount.
    var running = runningCosts(input);
    var gstOnRunning = input.employerClaimsGstOnRunning === false ? 0 : running.annualTotal / 11;
    var runningPackagedAnnual = running.annualTotal - gstOnRunning;
    var packagingFee = num(input.packagingFee, 0);

    var annualPackageCost = leasePaymentMonthly * 12 + runningPackagedAnnual + packagingFee;

    // FBT
    var isExemptEv = !!input.evFbtExempt && input.fuelType === 'ev' &&
      costs.fbtBaseValue <= cfg.lctThresholdFuelEfficient;
    var statutoryTaxableValue = cfg.fbtStatutoryRate * costs.fbtBaseValue;
    var method = isExemptEv ? 'exempt' : (input.fbtMethod || 'ecm');

    var postTaxContribution = 0, fbtPayable = 0, taxableValueAfterEcm = 0;
    if (isExemptEv) {
      postTaxContribution = 0;
      fbtPayable = 0;
      taxableValueAfterEcm = 0;
    } else if (method === 'ecm') {
      // Post-tax contributions reduce the taxable value dollar for dollar.
      postTaxContribution = Math.min(statutoryTaxableValue, annualPackageCost);
      taxableValueAfterEcm = Math.max(0, statutoryTaxableValue - postTaxContribution);
      fbtPayable = taxableValueAfterEcm * cfg.fbtGrossUpType1 * cfg.fbtRate;
    } else {
      taxableValueAfterEcm = statutoryTaxableValue;
      fbtPayable = statutoryTaxableValue * cfg.fbtGrossUpType1 * cfg.fbtRate;
    }

    var preTaxAnnual = Math.max(0, annualPackageCost - postTaxContribution + fbtPayable);

    // Reportable fringe benefits: exempt EV benefits are still reported, and an
    // RFBA lifts study loan repayments and the Medicare levy surcharge.
    var rfbaTaxableValue = isExemptEv ? statutoryTaxableValue : taxableValueAfterEcm;
    var rfba = input.includeRfba === false ? 0 : rfbaTaxableValue * cfg.fbtGrossUpType2;
    if (isExemptEv && input.evRfbaReportable === false) rfba = 0;

    var grossIncome = grossPackageIncome(input);
    var baseTax = taxPosition({
      taxableIncome: grossIncome,
      taxYear: input.taxYear,
      medicareExempt: input.medicareExempt,
      privateHospitalCover: input.privateHospitalCover,
      family: input.family,
      dependants: input.dependants,
      hasStudyLoan: input.hasStudyLoan,
      studyLoanBalance: input.studyLoanBalance
    });
    var packagedTax = taxPosition({
      taxableIncome: Math.max(0, grossIncome - preTaxAnnual),
      reportableFringeBenefits: rfba,
      taxYear: input.taxYear,
      medicareExempt: input.medicareExempt,
      privateHospitalCover: input.privateHospitalCover,
      family: input.family,
      dependants: input.dependants,
      hasStudyLoan: input.hasStudyLoan,
      studyLoanBalance: input.studyLoanBalance
    });

    var taxSaving = baseTax.totalTax - packagedTax.totalTax;
    var studyLoanImpact = packagedTax.studyLoanRepayment - baseTax.studyLoanRepayment;
    var netAnnualCost = preTaxAnnual - taxSaving + postTaxContribution;
    var netCostOverTerm = netAnnualCost * years;

    var resale = projectedValue(costs.priceBeforeOnRoads + costs.luxuryCarTax, termMonths,
      input.depreciationFirstYear, input.depreciationOngoing);
    var residualInclGst = residual * (1 + cfg.gstRate);

    return {
      product: 'novated',
      label: PRODUCT_LABELS.novated,
      costs: costs,
      gstSavingOnPurchase: gstSaving,
      financedAmount: financedAmount,
      residual: residual,
      residualInclGst: residualInclGst,
      residualPercent: residualPct * 100,
      termMonths: termMonths,
      leasePaymentMonthly: leasePaymentMonthly,
      totalInterest: sched.totalInterest,
      schedule: sched.rows,
      running: running,
      runningPackagedAnnual: runningPackagedAnnual,
      gstOnRunning: gstOnRunning,
      packagingFee: packagingFee,
      annualPackageCost: annualPackageCost,
      fbt: {
        method: method,
        exemptEv: isExemptEv,
        baseValue: costs.fbtBaseValue,
        statutoryTaxableValue: statutoryTaxableValue,
        postTaxContribution: postTaxContribution,
        taxableValueAfterContribution: taxableValueAfterEcm,
        fbtPayable: fbtPayable,
        reportableFringeBenefitAmount: rfba
      },
      preTaxAnnual: preTaxAnnual,
      postTaxAnnual: postTaxContribution,
      taxSaving: taxSaving,
      studyLoanImpact: studyLoanImpact,
      netAnnualCost: netAnnualCost,
      netCostOverTerm: netCostOverTerm,
      netCostPerPay: netAnnualCost / freq.perYear,
      grossPerPay: (preTaxAnnual + postTaxContribution) / freq.perYear,
      takeHomeBefore: baseTax.netIncome / freq.perYear,
      takeHomeAfter: (packagedTax.netIncome - postTaxContribution) / freq.perYear,
      taxBefore: baseTax,
      taxAfter: packagedTax,
      projectedResale: resale,
      equityAtEnd: resale - residualInclGst,
      totalCostOfOwnership: netCostOverTerm + num(input.deposit) - resale + residualInclGst,
      annualKm: num(input.annualKm)
    };
  }

  /* ------------------------------------------------------------------ *
   * Cash purchase (opportunity cost benchmark)
   * ------------------------------------------------------------------ */

  function cashModel(input) {
    var costs = purchaseCosts(input);
    var termMonths = Math.max(1, Math.round(num(input.termMonths, 60)));
    var years = termMonths / 12;
    var returnRate = num(input.savingsReturn, 4) / 100;
    var opportunityCost = costs.driveAwayPrice * (Math.pow(1 + returnRate, years) - 1) *
      (1 - num(input.savingsTaxRate, 30) / 100);
    var running = runningCosts(input);
    var resale = projectedValue(costs.priceBeforeOnRoads + costs.luxuryCarTax, termMonths,
      input.depreciationFirstYear, input.depreciationOngoing);
    return {
      product: 'cash',
      label: PRODUCT_LABELS.cash,
      costs: costs,
      financedAmount: 0,
      payment: 0,
      termMonths: termMonths,
      upfront: costs.driveAwayPrice,
      opportunityCost: opportunityCost,
      totalInterest: 0,
      totalFinanceCost: opportunityCost,
      balloon: 0,
      running: running,
      runningOverTerm: running.annualTotal * years,
      projectedResale: resale,
      totalOutlay: costs.driveAwayPrice,
      totalCostOfOwnership: costs.driveAwayPrice + opportunityCost +
        running.annualTotal * years - resale,
      equity: [],
      schedule: [],
      annualKm: num(input.annualKm)
    };
  }

  /* ------------------------------------------------------------------ *
   * Income, affordability and ratios
   * ------------------------------------------------------------------ */

  function grossPackageIncome(input) {
    var salary = Math.max(0, num(input.grossSalary));
    if (input.salaryIncludesSuper) salary = salary / (1 + CONST.superGuarantee);
    return salary + num(input.otherIncome);
  }

  function incomeSummary(input) {
    var gross = grossPackageIncome(input);
    var tax = taxPosition({
      taxableIncome: gross,
      taxYear: input.taxYear,
      medicareExempt: input.medicareExempt,
      privateHospitalCover: input.privateHospitalCover,
      family: input.family,
      dependants: input.dependants,
      hasStudyLoan: input.hasStudyLoan,
      studyLoanBalance: input.studyLoanBalance
    });
    var freq = FREQUENCIES[input.paymentFrequency] || FREQUENCIES.monthly;
    var household = gross + num(input.partnerIncome);
    return {
      gross: gross,
      household: household,
      superGuarantee: gross * CONST.superGuarantee,
      tax: tax,
      net: tax.netIncome,
      netPerPay: tax.netIncome / freq.perYear,
      netPerWeek: tax.netIncome / 52,
      netPerMonth: tax.netIncome / 12,
      livingExpensesAnnual: num(input.livingExpenses) * 12,
      otherDebtAnnual: num(input.otherDebtRepayments) * 12,
      frequency: input.paymentFrequency || 'monthly'
    };
  }

  var AFFORDABILITY_BANDS = [
    { max: 10, key: 'comfortable', label: 'Comfortable', note: 'Under 10% of take-home pay.' },
    { max: 15, key: 'moderate', label: 'Moderate', note: '10–15% of take-home pay.' },
    { max: 20, key: 'stretched', label: 'Stretched', note: '15–20% of take-home pay.' },
    { max: Infinity, key: 'high', label: 'High', note: 'Over 20% of take-home pay.' }
  ];

  function affordability(model, income, input) {
    var freq = FREQUENCIES[input.paymentFrequency] || FREQUENCIES.monthly;
    var repaymentAnnual = (model.payment != null ? model.payment : 0) * freq.perYear;
    if (model.product === 'novated') repaymentAnnual = model.netAnnualCost;
    if (model.product === 'cash') repaymentAnnual = 0;

    var runningAnnual = model.product === 'novated' ? 0 : (model.running ? model.running.annualTotal : 0);
    var totalAnnual = repaymentAnnual + runningAnnual;

    var pctNet = income.net > 0 ? repaymentAnnual / income.net * 100 : 0;
    var pctGross = income.gross > 0 ? repaymentAnnual / income.gross * 100 : 0;
    var pctNetAllIn = income.net > 0 ? totalAnnual / income.net * 100 : 0;

    var band = AFFORDABILITY_BANDS[AFFORDABILITY_BANDS.length - 1];
    for (var i = 0; i < AFFORDABILITY_BANDS.length; i++) {
      if (pctNet <= AFFORDABILITY_BANDS[i].max) { band = AFFORDABILITY_BANDS[i]; break; }
    }

    var surplus = income.net - income.livingExpensesAnnual - income.otherDebtAnnual - totalAnnual;
    var debtToIncome = income.gross > 0
      ? (model.financedAmount + num(input.otherDebtBalances)) / income.gross : 0;

    return {
      repaymentAnnual: repaymentAnnual,
      repaymentPerPay: repaymentAnnual / freq.perYear,
      repaymentPerWeek: repaymentAnnual / 52,
      runningAnnual: runningAnnual,
      totalAnnual: totalAnnual,
      totalPerWeek: totalAnnual / 52,
      percentOfNet: pctNet,
      percentOfGross: pctGross,
      percentOfNetAllIn: pctNetAllIn,
      percentOfHousehold: income.household > 0 ? repaymentAnnual / income.household * 100 : 0,
      band: band,
      annualSurplus: surplus,
      monthlySurplus: surplus / 12,
      debtToIncomeRatio: debtToIncome,
      debtServiceRatio: income.gross > 0
        ? (repaymentAnnual + income.otherDebtAnnual) / income.gross * 100 : 0
    };
  }

  /** What does a +X% rate move do to the repayment? */
  function rateStress(input, shifts) {
    shifts = shifts || [1, 2, 3];
    var base = loanModel(input);
    return shifts.map(function (s) {
      var m = loanModel(input, { rateShift: s });
      return {
        shift: s,
        annualRate: base.annualRate + s,
        payment: m.payment,
        increase: m.payment - base.payment,
        totalInterest: m.totalInterest,
        extraInterest: m.totalInterest - base.totalInterest
      };
    });
  }

  /** The maximum loan a target repayment supports at the current settings. */
  function borrowingPower(input, targetPaymentPerPeriod) {
    var freq = FREQUENCIES[input.paymentFrequency] || FREQUENCIES.monthly;
    var periods = Math.max(1, Math.round(num(input.termMonths, 60) / 12 * freq.perYear));
    var r = num(input.interestRate, 7) / 100 / freq.perYear;
    var net = targetPaymentPerPeriod - num(input.monthlyFee) * 12 / freq.perYear;
    if (net <= 0) return 0;
    if (Math.abs(r) < 1e-12) return net * periods;
    var pctBalloon = (input.balloonMode === 'percent') ? clamp(num(input.balloonPercent), 0, 90) / 100 : 0;
    var f = Math.pow(1 + r, periods);
    // pv = (pmt * (f - 1) / r + fv) / f, with fv expressed as a % of pv
    var pv = (net * (f - 1) / r) / (f - pctBalloon * 1);
    return Math.max(0, pv);
  }

  /* ------------------------------------------------------------------ *
   * Comparison across every product
   * ------------------------------------------------------------------ */

  function compareAll(input) {
    var income = incomeSummary(input);
    var products = ['secured', 'unsecured', 'dealer', 'gfv', 'chattel', 'financeLease'];
    var rows = products.map(function (p) {
      // Each product carries its own rate and balloon treatment via loanModel.
      var m = loanModel(input, { product: p });
      m.affordability = affordability(m, income, input);
      return m;
    });

    if (num(input.grossSalary) > 0) {
      var nov = novatedModel(input);
      nov.affordability = affordability(nov, income, input);
      rows.push(nov);
    }
    var cash = cashModel(input);
    cash.affordability = affordability(cash, income, input);
    rows.push(cash);
    return rows;
  }

  /* ------------------------------------------------------------------ *
   * Top level
   * ------------------------------------------------------------------ */

  function calculate(input) {
    var income = incomeSummary(input);
    var primary = input.product === 'novated' ? novatedModel(input)
      : input.product === 'cash' ? cashModel(input)
      : loanModel(input);
    primary.affordability = affordability(primary, income, input);

    return {
      asAt: DATA_AS_AT,
      input: input,
      income: income,
      model: primary,
      novated: num(input.grossSalary) > 0 ? novatedModel(input) : null,
      cash: cashModel(input),
      stress: input.product === 'novated' || input.product === 'cash' ? [] : rateStress(input),
      comparison: compareAll(input)
    };
  }

  return {
    DATA_AS_AT: DATA_AS_AT,
    TAX_YEARS: TAX_YEARS,
    HELP_BRACKETS: HELP_BRACKETS,
    MLS_TIERS: MLS_TIERS,
    CONST: CONST,
    STATES: STATES,
    FREQUENCIES: FREQUENCIES,
    PRODUCT_LABELS: PRODUCT_LABELS,
    AFFORDABILITY_BANDS: AFFORDABILITY_BANDS,
    // maths
    marginalTax: marginalTax,
    marginalRateAt: marginalRateAt,
    medicareLevy: medicareLevy,
    medicareLevySurcharge: medicareLevySurcharge,
    helpRepayment: helpRepayment,
    taxPosition: taxPosition,
    luxuryCarTax: luxuryCarTax,
    stampDuty: stampDuty,
    purchaseCosts: purchaseCosts,
    paymentFor: paymentFor,
    amortise: amortise,
    effectiveRate: effectiveRate,
    projectedValue: projectedValue,
    runningCosts: runningCosts,
    productRate: productRate,
    loanModel: loanModel,
    novatedModel: novatedModel,
    cashModel: cashModel,
    incomeSummary: incomeSummary,
    affordability: affordability,
    rateStress: rateStress,
    borrowingPower: borrowingPower,
    compareAll: compareAll,
    calculate: calculate,
    round: round
  };
});
