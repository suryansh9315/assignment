# Architecture Document

## System Overview

The `data-engine` is responsible for ingesting raw source files from `operation-clean-room/data`, normalizing them into typed domain records, and exposing reconciliation-ready results through API routes consumed by the dashboard. For the billing sources implemented so far, the flows are:

`stripe_payments.csv` -> `loadCSV()` -> `loadStripePayments()` -> normalized `StripePayment[]` -> reconciliation modules -> API routes -> dashboard views

`chargebee_subscriptions.json` -> `loadJSON()` -> `loadChargebeeSubscriptions()` -> normalized `ChargebeeSubscription[]` -> reconciliation modules -> API routes -> dashboard views

`legacy_invoices.xml` -> `loadXML()` -> `loadLegacyInvoices()` -> normalized `LegacyInvoice[]` -> reconciliation modules -> API routes -> dashboard views

`salesforce_accounts.csv` + `salesforce_opportunities.csv` -> `loadCSV()` -> `loadSalesforceData()` -> normalized `SalesforceAccount[]` + `SalesforceOpportunity[]` -> reconciliation modules -> API routes -> dashboard views

Within that flow, the ingestion layer is the boundary where source-specific quirks are resolved. The Stripe loader standardizes currencies, coerces nullable fields, validates dates, promotes dispute/refund signals into canonical statuses, and converts non-USD amounts into USD using historical FX data. The Chargebee loader unwraps the JSON payload, validates nested structures, fills sparse customer fields, converts minor-unit plan/addon/fixed-discount amounts into major currency units, normalizes coupons / plan changes / addons, and derives a consistent `mrr` value from plan and addon data. The Legacy loader parses XML, disambiguates mixed-format dates using dataset context, preserves nullable payment references, and converts non-USD invoice amounts to USD. The Salesforce loader derives missing normalized fields such as forecast category, opportunity type, ACV, segment, and owner email from the exported CRM fields.

The ARR endpoint composes these normalized sources into one recurring-revenue view:

`Chargebee subscriptions` + `non-duplicative Stripe recurring payment streams` + `non-duplicative Legacy recurring invoice streams` -> `calculateARR()` -> `GET /api/metrics/arr`

When the route is called without a `date` query, it uses the latest active Chargebee billing snapshot date instead of the wall-clock server date. This prevents the sample dataset from returning zero ARR simply because the local runtime date is later than the data snapshot.

The dashboard revenue page uses a second CFO-oriented API:

`calculateARR()` source normalization -> month-end customer ARR snapshots -> movement buckets + plan mix + timing flags -> `GET /api/metrics/revenue-summary` -> `RevenueSummary.tsx`

The summary endpoint intentionally keeps full revenue recognition out of scope. It exposes `mrrRunRate` as an ARR-derived monthly run-rate and separately returns timing-review flags for annual prepayments, disputed/refunded Stripe payments, and overdue or partially paid legacy invoices.

Retention and unit economics reuse the same unified ARR snapshot helper so NRR, churn, cohorts, and the revenue view reconcile to the same source interpretation:

`getUnifiedARRRecords(start/end)` -> `calculateNRR()` / `calculateChurn()` / `buildCohortAnalysis()` -> metrics routes -> dashboard views

`marketing_spend.csv` + unified ARR snapshots + churn snapshots -> `calculateUnitEconomics()` -> `GET /api/metrics/unit-economics`

The reconciliation API is structured as a repeatable run:

`Stripe + Chargebee + Salesforce + FX rates` -> duplicate detection + payment reconciliation + pipeline quality analysis -> `POST /api/reconciliation/run`

When no date range is supplied, reconciliation defaults to the latest billing snapshot month rather than the whole historical sample. The latest run is cached in memory for discrepancy browsing and resolution routes. That is enough for the emergency dashboard, but durable audit storage should replace it before a formal close process.

### Reconciliation Summary Semantics

The dashboard's `Billing Exposure` card is intentionally not a sum of every discrepancy row. It maps to `summary.totalAmountImpact`, which is limited to current billing exposure from duplicate billing records and Stripe/Chargebee amount mismatches in the reconciliation period. This keeps it comparable to clean MRR.

CRM pipeline mismatches are still included in the discrepancies table because they matter for board readiness, but their opportunity ACV deltas are not added to `totalAmountImpact` and are not summarized as a dollar KPI. Pipeline ACV is a forecast/bookings data-quality issue, not current billing exposure. Mixing those values caused an inflated total that could exceed clean ARR and confuse the CFO narrative.

Pipeline amount checks are restricted to closed-won opportunities whose contract term is active as of the ARR snapshot date, and billing-side comparisons only use active Chargebee subscriptions or recent Stripe recurring payments. This avoids comparing expired historical bookings to current ARR. The Salesforce exports still contain materially inconsistent amount magnitudes, so those rows are treated as CRM review findings rather than a trusted aggregate revenue number.

<!-- Consider including a diagram (ASCII art is fine) -->

## Data Model

### Unified Customer Model

_How do you represent a customer that exists across multiple systems? What is the canonical identifier?_

### Source Data Mapping

_For each data source, describe:_
_- What it provides_
_- How it connects to the unified model_
_- Known data quality issues you discovered_

| Source | Key Fields | Links To | Issues Found |
|--------|-----------|----------|-------------|
| Stripe Payments | `payment_id`, `customer_id`, `customer_name`, `amount`, `currency`, `status`, `payment_date`, `subscription_id`, `refund_id`, `dispute_id` | Primary joins are `customer_id` to a unified billing identity and `subscription_id` to recurring subscription records; `customer_name` is a secondary fallback for entity matching | The real CSV uses uppercase currency codes while the normalized model expects canonical lowercase codes; 25 rows contain a `dispute_id` even though the raw `status` is `succeeded`; refunds appear both as explicit `refunded` rows and as negative-amount rows; optional identifiers are represented as blank strings in the source export |
| Chargebee Subscriptions | `subscription_id`, `customer.customer_id`, `customer.company`, `customer.email`, `plan.plan_id`, `plan.price`, `plan.currency`, `status`, `current_term_start`, `current_term_end`, `mrr` | Primary joins are `customer.customer_id` and `subscription_id`; `customer.company` acts as a secondary fallback for entity resolution across billing and CRM systems | The real JSON is wrapped in a top-level `subscriptions` array object; customer records are sparse and often omit `first_name`, `last_name`, and detailed billing address fields; monetary fields are stored in minor units and need conversion to major units; plan interval is expressed as `month` / `year` and must be normalized into a monthly MRR view; only a subset of subscriptions include coupons, plan changes, or addons, so those nested arrays need safe defaults |
| Legacy Invoices | `id`, `customer_name`, `amount`, `currency`, `date`, `status`, `description`, `payment_ref` | Primary joins are `payment_ref` to Stripe payment IDs when present and `customer_name` as a fallback for billing-history matching | The XML uses ambiguous slash-delimited dates and requires day-first disambiguation for this dataset; most `payment_ref` tags are blank; the loader preserves source currency but converts non-USD amounts into USD-normalized `amount` values for downstream comparison |
| Salesforce Opportunities | `opportunity_id`, `account_id`, `account_name`, `stage`, `amount`, `currency`, `close_date`, `contract_term_months`, `probability`, `partner_id` | Primary join is `account_id` to Salesforce Accounts; `account_name` is a secondary fallback for cross-system matching | The export does not provide explicit `acv`, `tcv`, `forecast_category`, `competitor`, or `loss_reason` columns in normalized form, so several fields are derived; some open deals encode structured ramp/escalator notes inside `next_step` free text |
| Salesforce Accounts | `account_id`, `account_name`, `parent_account_id`, `industry`, `employee_count`, `website`, `created_date`, `account_owner`, `annual_contract_value` | Primary join is `account_id` to Opportunities; account name and any future external billing IDs support cross-system entity resolution | The export does not include owner email, billing state, a direct segment field, or explicit Stripe / Chargebee IDs; `region` is the closest available location field and `annual_contract_value` is used as the nearest proxy for the normalized `annual_revenue` field |
| Product Events | | | |
| Support Tickets | | | |
| NPS Surveys | | | |
| Marketing Spend | | | |
| Plan Pricing | | | |
| FX Rates | `date`, `eur_usd`, `gbp_usd`, `jpy_usd`, `aud_usd` | Used by Stripe, Chargebee, and Legacy normalization / reconciliation whenever non-USD amounts need a historical USD value | The file has expected gaps around weekends and holidays, so consumers must support lookback fallback rather than exact-date-only matching |
| Partner Deals | | | |

## Matching Strategy

_How do you link entities across systems? What matching algorithm(s) did you use? What confidence thresholds did you set and why?_

For billing-related linking, the preferred join order is:
1. Exact identifier match on `customer_id` when another system stores a Stripe customer reference.
2. Exact identifier match on Chargebee `customer.customer_id` when another system stores a Chargebee customer reference.
3. Exact identifier match on `subscription_id` for recurring billing comparisons.
4. Exact identifier match on Salesforce `account_id` for CRM-internal joins between opportunities and accounts.
5. Legacy `payment_ref` match to Stripe payment IDs when present.
6. Fallback name-based comparison on `customer_name`, `customer.company`, or `account_name` only when no authoritative ID is available.

### Entity Resolution Approach

_Describe your approach to matching customers across systems with different IDs and name variants._

Stripe records are treated as authoritative for payment events but not for customer identity on their own. Chargebee records are treated as authoritative for subscription state and recurring contract structure, but their nested customer objects are incomplete in this dataset. Legacy invoices provide historical billing continuity and occasional direct Stripe cross-references through `payment_ref`, but otherwise rely on customer-name alignment. Salesforce accounts and opportunities are authoritative for CRM pipeline structure, while several normalized fields are derived because the exports are not one-to-one with the target interfaces. The ingestion layer preserves the vendor-native IDs plus human-readable company names so reconciliation can prefer deterministic ID joins and only use name matching as a backup.

### Confidence Scoring

_How do you score match confidence? What fields contribute? What threshold separates a "match" from "needs review"?_

The general-purpose matcher combines exact external identifiers, normalized domain equality, and normalized company-name similarity. Company names are lowercased, legal suffixes are stripped, and token/edit-distance similarity is used for variants such as `Acme Corp` vs `ACME Corporation Ltd.`. The default entity-match threshold is `0.6`; duplicate detection uses stricter billing-specific logic by requiring strong name confidence plus MRR proximity and active-period classification before labeling a record as a true duplicate.

## Metric Definitions

_For each metric, provide:_
_1. Precise definition_
_2. Formula_
_3. Edge cases and how you handle them_
_4. Why you chose this definition over alternatives_

### ARR (Annual Recurring Revenue)

_Definition:_ Annualized recurring revenue from active recurring customers as of the requested date.
_Formula:_ `SUM(monthly_recurring_revenue_usd * 12)` across included active subscriptions / recurring streams.
_Edge cases:_ Chargebee is preferred for explicit subscription state; Stripe and Legacy contribute ARR only when they are inferred active and not duplicated by a newer billing source. Stripe subscriptions are inferred from grouped recurring payments and payment cadence. Legacy recurring streams are inferred from paid/overdue historical invoices and excluded when linked to Stripe via `payment_ref` or already represented in active Stripe/Chargebee records. Trials and churned subscriptions are excluded by default.

### Revenue Summary

_Definition:_ Board-facing monthly ARR trend from January 2024 through the latest active billing snapshot, with an ARR waterfall and plan segmentation.
_Formula:_ For each month, `ARR = calculateARR(month_end).total`; `MRR run rate = ARR / 12`; movement buckets are customer-level month-over-month deltas: first-seen customers are new business, positive deltas on existing customers are expansion, negative deltas are contraction, and customers present in the prior month but absent in the current month are churn.
_Edge cases:_ Reactivated customers whose first source date predates the month are treated as expansion/reactivation rather than new business. Full ASC 606 revenue recognition is not implemented; timing risks are emitted as a separate review queue for Finance.

### NRR (Net Revenue Retention)

_Definition:_ Revenue retained from customers active at the start of the period, including expansion and excluding new customers acquired during the period.
_Formula:_ `(Starting ARR + Expansion - Contraction - Churn) / Starting ARR`.
_Edge cases:_ If starting ARR is zero, NRR returns zero. New or reactivated customers absent from the starting snapshot are excluded. Because the implementation uses normalized snapshot values, FX movement can appear as expansion or contraction until a fixed-rate cohort ledger exists.

### Gross Churn / Net Churn

_Definition:_ Gross churn measures churned and contracted revenue before expansion; net churn subtracts expansion from those losses. Logo churn measures customer-count loss.
_Formula:_ `Gross churn = (Churned ARR + Contraction) / Starting ARR`; `Net churn = (Churned ARR + Contraction - Expansion) / Starting ARR`; `Logo churn = churned starting customers / starting customers`.
_Edge cases:_ Churn and contraction are detected from period start/end snapshots, so multiple changes inside one period are netted. Cancellation reasons are sparse across sources, so reason breakdowns are currently labeled as snapshot loss.

### Unit Economics (CAC, LTV, Payback)

_Definition:_ Blended and channel-level acquisition efficiency for a month or quarter.
_Formula:_ `CAC = marketing spend / attributed deals`; `ARPA = monthly ARR run-rate / active customers`; `LTV = ARPA * gross margin / monthly logo churn`; `Payback = CAC / (ARPA * gross margin)`.
_Edge cases:_ Marketing attribution uses the `attributed_deals` channel rows because multi-touch paths are not available. Monthly churn is floored at `0.5%` to avoid infinite LTV in quiet periods. Gross margin is weighted by ARR, using `65%` for Starter and `78%` for Growth/Enterprise per the CFO brief.

## Assumptions

See [ASSUMPTIONS_TEMPLATE.md](./ASSUMPTIONS_TEMPLATE.md) for the full log.

## Known Limitations

_What doesn't work? What would you fix with more time? What edge cases did you intentionally skip?_

The current Stripe ingestion implementation normalizes status, currency, nullable fields, and FX-adjusted amounts, but it does not yet link failed payments to their later retries or collapse a charge plus its separate refund row into a higher-level payment lifecycle entity. The current Chargebee ingestion implementation derives `mrr` from the present plan, active invoice-level coupons, and addons, but it does not yet use historical `plan_changes` to construct time-phased recurring revenue or richer lifecycle events. The Legacy loader uses a strong dataset-level day-first date hint, which is well supported by the file inspected here but would need revisiting if additional exports introduced genuine month-first evidence. The Salesforce loader derives several normalized fields from proxies and heuristics because the source exports are not fully aligned with the target interfaces. The ARR calculation uses inferred active periods for Stripe and Legacy because those sources are payment/invoice streams rather than explicit subscription-state tables.

The revenue summary waterfall uses month-end snapshots rather than a full billing event ledger. This is defensible for the board trend, but it will net together multiple movements that happen to the same customer inside the same month.

Resolution state for discrepancies is process-local and will be lost on API restart. A production audit workflow should persist reconciliation runs, reviewer identity, resolution timestamps, and immutable source-record snapshots.

## Future Extensibility

_How would someone:_
_- Add a new billing source (e.g., Paddle)?_
_- Add a new metric?_
_- Change the reconciliation schedule from monthly to weekly?_
_- Add a new segmentation dimension?_

Adding another billing source should follow the Stripe, Chargebee, and Legacy pattern: create a source-specific ingester that converts raw export quirks into the shared normalized types before reconciliation logic runs, and reuse the FX utility when non-USD amounts need historical normalization. That keeps source cleanup localized and prevents dashboard-facing metrics from depending on vendor-specific file formats.
