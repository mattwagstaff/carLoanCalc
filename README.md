# Revvy

**Australian car finance, in numbers.**

A calculator for every way an Australian can pay for a car — secured loans, dealer finance,
balloon payments, Guaranteed Future Value products, novated leases, chattel mortgages, finance
leases and cash — with stamp duty, luxury car tax, income tax and running costs folded in, and the
result expressed as a share of what you actually take home.

Static HTML, CSS and JavaScript. No build step, no framework, no dependencies, no backend, no
network calls. Drop the files on any web host and it works.

> **Not financial advice.** Revvy is a calculator that produces estimates from the assumptions you
> enter. It is general information only. It is not financial, credit, tax or legal advice, does not
> consider anyone's objectives, financial situation or needs, and is not an offer, quote or
> approval. See the disclaimer in the app footer.

---

## What it does

**Finance products**

| Product | Modelled behaviour |
| --- | --- |
| Secured car loan | Standard amortising loan, optional balloon |
| Unsecured personal loan | Secured rate plus a configurable premium |
| Dealer / manufacturer finance | Its own advertised rate |
| Guaranteed Future Value | Balloon fixed at the guaranteed value, with kilometre allowance and excess charges |
| Novated lease | GST saving on purchase, pre-tax packaging, FBT via ECM or employer-paid, EV FBT exemption, ATO minimum residuals |
| Chattel mortgage | Business ownership, GST input tax credit, interest and depreciation deductions |
| Finance lease | Payments in advance, residual, business deductions |
| Cash | Opportunity cost of the money at an assumed after-tax return |

**Costs it accounts for**

- Luxury car tax, with separate fuel-efficient and standard thresholds
- Motor vehicle stamp duty for all eight states and territories, including Queensland's
  cylinder-based scale and the ACT emissions ratings and EV exemption
- Registration, CTP, plates and transfer fees, dealer delivery, options
- Establishment and monthly account fees, reflected in an effective rate
- Fuel or electricity, insurance, servicing, tyres, roadside and rego renewals

**Income features**

- Resident income tax for the selected year, Medicare levy with shade-in, Medicare levy surcharge
  and compulsory study loan repayments
- Repayment as a percentage of take-home pay, of gross income, and with running costs included
- Debt service ratio, debt-to-income ratio, and the surplus left after everything
- What different repayment levels would finance
- Reportable fringe benefit amounts and their flow-through to HELP and the surcharge — the thing
  that most often surprises people on a novated lease

**Dynamic analysis**

- Adjustable interest rates: schedule up to two rate changes mid-term, with the repayment
  recalculated over the remaining term the way a variable-rate lender does
- Rate stress testing at +1, +2 and +3 percentage points
- Negative equity tracking: loan balance against projected resale value, month by month
- Side-by-side comparison of every product on the same car
- Plain-English commentary generated from your own numbers
- Full amortisation schedule with CSV export

**Persistence**

Everything is stored in `localStorage` on the device. Inputs save as you type; named scenarios can
be saved, reloaded and deleted; the whole lot exports to and imports from JSON. Nothing is sent
anywhere — there is no server to send it to.

---

## Running it

Open `index.html` in a browser. That is the whole story — it works from `file://`.

To serve it locally:

```sh
npm start          # python3 -m http.server 8080
```

## Tests

```sh
npm test           # engine tests, no dependencies required
npm run test:all   # adds a browser smoke test (needs playwright)
```

`test/finance.test.js` covers the amortisation maths, tax scales, duty scales, novated lease and
FBT treatment, and the comparison logic. `test/browser.test.js` drives the real UI in Chromium and
skips itself if Playwright is not installed.

## Publishing

The app is four static files. Any of these work with no configuration:

- **GitHub Pages** — enable Pages on the branch. `.nojekyll` is already present.
- **Netlify / Vercel / Cloudflare Pages** — deploy the directory, no build command.
- **Any web server** — copy `index.html`, `styles.css`, `app.js` and `finance.js` to the web root.

There is no environment configuration, no API key and no build output.

## Layout

```
index.html   Page shell, glossary content, disclaimers
styles.css   Styling, light and dark themes, print stylesheet
finance.js   Calculation engine — pure functions, no DOM (also loads under Node)
app.js       Form schema, rendering, charts, persistence
test/        Engine tests and an optional browser smoke test
```

`finance.js` is deliberately free of DOM references so the maths can be tested directly and reused
elsewhere. `app.js` builds the entire form from the `GROUPS` schema, which also drives defaults,
conditional visibility and persistence — adding a field means adding one object.

## A note on the numbers

Tax rates, thresholds, the luxury car tax limits, the car limit, FBT rates and duty scales are
legislated or indexed and change regularly. The defaults are a starting point, not a source of
truth, and every one of them is editable in the **Assumptions** panel. Interest accrues per payment
period rather than daily, so figures will differ slightly from a lender's statement. Resale values
use a simple declining-balance curve and will not match any particular model.

Verify anything you intend to rely on against the ATO, your state revenue office, and the lender's
own documents.

## Licence

MIT.
