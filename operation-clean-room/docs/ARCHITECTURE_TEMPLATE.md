# Architecture Document

## System Overview

The system has two main parts:

- `packages/data-engine`: loads source files, normalizes them, computes metrics, and serves Express API routes.
- `packages/dashboard`: reads those APIs and renders the board-facing UI.

The data flow is:

`raw files in /data` -> source-specific loaders -> normalized records -> metric/reconciliation services -> Express routes -> dashboard components

Implemented source flows:

- `stripe_payments.csv` -> `loadStripePayments()` -> normalized Stripe payments
- `chargebee_subscriptions.json` -> `loadChargebeeSubscriptions()` -> normalized Chargebee subscriptions
- `legacy_invoices.xml` -> `loadLegacyInvoices()` -> normalized Legacy invoices
- `salesforce_accounts.csv` + `salesforce_opportunities.csv` -> `loadSalesforceData()` -> normalized Salesforce accounts and opportunities
- `support_tickets.csv`, `nps_surveys.csv`, `product_events.jsonl` -> health-scoring inputs

The ingestion layer is where source quirks are handled. Examples:

- Stripe: normalize currency/status fields, coerce nullable values, preserve date-only dates, and convert non-USD amounts with historical FX rates.
- Chargebee: unwrap the payload, validate nested objects, convert minor units to major units, and derive monthly `mrr`.
- Legacy: parse XML, resolve ambiguous dates, and normalize non-USD invoice amounts.
- Salesforce: derive fields the export does not provide directly, such as ACV, segment, and owner email.

## Runtime Architecture

### Metrics

ARR is built from active recurring revenue across the billing systems:

`Chargebee subscriptions` + `active Stripe recurring streams` + `active Legacy recurring streams` -> duplicate suppression -> `calculateARR()` -> `GET /api/metrics/arr`

Important behaviors:

- `GET /api/metrics/arr` defaults to `getDefaultARRAsOfDate()` instead of the server clock.
- Plan labels are normalized for reporting, but `plan_pricing_history.csv` is not part of the live ARR calculation path.
- Stripe recurring subscriptions are inferred from payment streams because there is no standalone Stripe subscription-state export.

The board-facing revenue trend uses month-end snapshots:

`calculateARR()` -> monthly customer snapshots -> `calculateRevenueSummary()` -> `GET /api/metrics/revenue-summary`

This route returns:

- month-end ARR history
- `mrrRunRate = arr / 12`
- movement buckets from customer-level month-over-month deltas
- timing-review flags

Because of that design, the default ARR endpoint and revenue summary can differ slightly: ARR defaults to the latest billing as-of date, while the revenue summary headline uses the final month-end snapshot.

Other metric routes reuse the same normalized ARR foundation:

- `GET /api/metrics/nrr` -> `calculateNRR()`
- `GET /api/metrics/churn` -> `calculateChurn()`
- `GET /api/metrics/cohorts` -> `buildCohortAnalysis()`
- `GET /api/metrics/unit-economics` -> `calculateUnitEconomics()`
- `GET /api/metrics/overview` -> combined ARR, NRR, churn, and unit-economics summary

### Customer Health

Customer health is a separate scoring pipeline:

`Salesforce accounts` + `Chargebee` + `Stripe` + `support_tickets.csv` + `nps_surveys.csv` + `product_events.jsonl` -> `calculateHealthScores()` -> `GET /api/metrics/customer-health`

The scorer computes five weighted signals:

- Product Usage
- Support Burden
- Billing Health
- NPS
- Engagement

The route maps the composite score into dashboard grades (`A`-`F`) and derives a churn-risk ranking. By default, the metrics route returns the full scored portfolio unless the caller supplies pagination or filters. The dashboard then highlights the highest-risk accounts from that full set.

### Reconciliation

Reconciliation is an on-demand pipeline:

`Stripe + Chargebee + Legacy + Salesforce + FX rates` -> duplicate detection + billing snapshot assembly + revenue checks + CRM comparison -> `POST /api/reconciliation/run`

Key route behavior:

- If no date range is provided, reconciliation defaults to the latest billing snapshot month.
- Latest results are stored in memory and reused by discrepancy routes.
- Resolution state is also in memory, so it is lost on API restart.

Supporting routes:

- `GET /api/reconciliation/discrepancies`
- `GET /api/reconciliation/discrepancies/:id`
- `POST /api/reconciliation/discrepancies/:id/resolve`
- `GET /api/reconciliation/duplicates`
- `GET /api/reconciliation/pipeline`

CRM comparison uses summed active billing per normalized account and checks it against active closed-won CRM ACV. Billing-vs-billing mismatches are also emitted when multiple active billing systems disagree by more than `2%`.

### Audit

The audit route is a derived evidence view, not a persisted ledger:

`ARR + unified ARR records + NRR + churn + unit economics + cohorts + reconciliation` -> audit entries -> `GET /api/audit`

It emits:

- top-level metric entries
- one entry for the latest reconciliation run
- one entry per discrepancy
- one entry per cohort month

This supports drill-through, but it recomputes from current pipelines and does not persist immutable historical runs.

### Scenarios

`/api/scenarios` is mounted, but the handlers are still TODO stubs. The route exists as scaffolding only; no live scenario API is implemented yet.

## Data Model

### Unified Customer Model

There is no single durable customer master yet. The system works with normalized records from each source and resolves them at comparison time using:

1. Source-native IDs when available
2. Known cross-references such as Legacy `payment_ref` to Stripe
3. Normalized account or company names as fallback

For CRM-internal joins, Salesforce `account_id` is the canonical key. For recurring billing views, customer identity is effectively a resolved billing account assembled from source IDs plus normalized names.

### Source Data Mapping

| Source | What It Provides | Main Join Keys | Known Issues |
|---|---|---|---|
| Stripe Payments | Payment events and inferred recurring billing streams | `customer_id`, `subscription_id`, normalized `customer_name` | Source uses uppercase currencies, blank optional fields, and status values that do not always reflect disputes/refunds cleanly |
| Chargebee Subscriptions | Explicit subscription state, term dates, plan details, and derived MRR | `customer.customer_id`, `subscription_id`, normalized company name | Payload is wrapped, customer objects are sparse, and money is stored in minor units |
| Legacy Invoices | Historical invoice billing and recurring legacy coverage | `payment_ref`, normalized `customer_name` | Dates are ambiguous, most cross-references are blank, and recurring state must be inferred |
| Salesforce Accounts | CRM account metadata for joins and segmentation | `account_id`, account name | Missing direct billing IDs, owner email, and some normalized fields |
| Salesforce Opportunities | Closed-won and pipeline contract data | `account_id`, opportunity ID | ACV and related fields are partly derived from exported columns |
| Product Events | Usage and engagement telemetry | normalized `account_id` | Raw events must be aggregated into usage signals |
| Support Tickets | Ticket volume, severity, and CSAT | `account_id`, fallback account name | Mixed account-ID quality; many accounts have sparse support history |
| NPS Surveys | Latest sentiment signal | `account_id`, fallback website/email-domain match | Coverage is incomplete, so some accounts use a neutral default |
| Marketing Spend | Spend and attributed deals for unit economics | month/channel only | Aggregated data supports directional CAC, not customer-level attribution |
| FX Rates | Historical currency conversion inputs | date + currency pair | Weekend/holiday gaps require lookback fallback |

## Matching Strategy

The preferred join order is:

1. Exact external IDs (`customer_id`, `subscription_id`, `account_id`)
2. Explicit cross-references such as Legacy `payment_ref`
3. Normalized company-name matching

Name matching is a fallback, not the primary identity strategy. Names are normalized before comparison, and stricter logic is used before labeling two billing records as a true duplicate.

## Metric Definitions

### ARR

Definition: annualized recurring revenue from active recurring billing records as of a given date.

Formula: `SUM(active_mrr_usd * 12)`

Notes:

- Chargebee contributes explicit subscription MRR.
- Stripe and Legacy contribute inferred recurring streams.
- Duplicate suppression is conservative and only removes overlaps when the classifier is confident.

### Revenue Summary

Definition: month-end ARR trend plus movement buckets for board reporting.

Formula:

- `ARR(month) = calculateARR(month_end).total`
- `MRR run rate = ARR / 12`
- movements come from customer-level ARR deltas between adjacent month-end snapshots

Notes:

- This is not full ASC 606 revenue recognition.
- Timing exceptions are surfaced separately for review.

### NRR

Definition: retained revenue from customers active at the start of the period, including expansion and excluding new logos.

Formula: `(Starting ARR + Expansion - Contraction - Churn) / Starting ARR`

### Churn

Definition: gross churn, net churn, and logo churn between two snapshots.

Formula:

- `Gross churn = (Churn + Contraction) / Starting ARR`
- `Net churn = (Churn + Contraction - Expansion) / Starting ARR`
- `Logo churn = churned customers / starting customers`

### Unit Economics

Definition: acquisition efficiency using marketing spend and ARR-derived operating metrics.

Formula:

- `CAC = spend / attributed_deals`
- `ARPA = monthly ARR run rate / active customers`
- `LTV = ARPA * gross margin / monthly logo churn`
- `Payback = CAC / (ARPA * gross margin)`

## Assumptions

See [ASSUMPTIONS_TEMPLATE.md](./ASSUMPTIONS_TEMPLATE.md).

## Known Limitations

- There is no persistent customer master or audit ledger yet.
- Stripe and Legacy recurring revenue are inferred from payments/invoices rather than true subscription-state tables.
- Duplicate suppression is intentionally conservative, so some migration overlap can remain in ARR.
- Reconciliation runs and discrepancy resolutions are stored only in process memory.
- Scenario modeling is scaffolded but not implemented.
- Customer-health scoring is directionally useful, but some signals are still weakly calibrated for this sample dataset.

## Future Extensibility

- To add a new billing source, create a source-specific loader that normalizes into the shared billing model before metrics or reconciliation use it.
- To add a new metric, build it on top of normalized records or unified ARR snapshots and expose it through `routes/metrics.ts`.
- To move reconciliation from monthly to weekly, change the default period logic and any snapshot aggregation that currently assumes month-end periods.
- To add a segmentation dimension, extend normalized source mappings first, then expose it in metric grouping logic.
