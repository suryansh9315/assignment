import { join } from 'node:path';
import { loadCSV } from './csv-loader.js';
import type { SalesforceOpportunity, SalesforceAccount } from './types.js';

type ForecastCategory = SalesforceOpportunity['forecast_category'];
type OpportunityType = SalesforceOpportunity['type'];
type AccountSegment = SalesforceAccount['segment'];

function toNullableString(value: string | undefined): string | null {
  if (value == null) return null;

  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.toLowerCase() === 'null' ||
    trimmed.toLowerCase() === 'undefined'
  ) {
    return null;
  }

  return trimmed;
}

function requireString(value: string | undefined, fieldName: string): string {
  const normalized = toNullableString(value);
  if (normalized == null) {
    throw new Error(`Missing required Salesforce field "${fieldName}"`);
  }

  return normalized;
}

function parseNumber(value: string | undefined, fieldName: string): number {
  const normalized = requireString(value, fieldName).replace(/[$,\s]/g, '');
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid Salesforce number in field "${fieldName}"`);
  }

  return parsed;
}

function parseInteger(value: string | undefined, fieldName: string): number {
  return Math.trunc(parseNumber(value, fieldName));
}

function normalizeDate(value: string | undefined, fieldName: string): string {
  const normalized = requireString(value, fieldName);
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid Salesforce date in field "${fieldName}"`);
  }

  return normalized.length <= 10 ? normalized : parsed.toISOString();
}

function normalizeOwnerEmail(ownerName: string): string {
  return `${ownerName.trim().toLowerCase().replace(/\s+/g, '.')}@crm.clean-room.internal`;
}

function normalizeForecastCategory(stage: string): ForecastCategory {
  const normalizedStage = stage.trim().toLowerCase();

  if (normalizedStage === 'closed won') return 'closed';
  if (normalizedStage === 'closed lost') return 'omitted';
  if (normalizedStage === 'negotiation') return 'commit';
  if (normalizedStage === 'proposal') return 'best_case';

  return 'pipeline';
}

function normalizeOpportunityType(value: string | undefined): OpportunityType {
  const normalized = requireString(value, 'deal_type').trim().toLowerCase();
  if (normalized === 'new business') return 'new_business';
  if (normalized === 'expansion') return 'expansion';
  if (normalized === 'renewal') return 'renewal';

  throw new Error(`Unsupported Salesforce opportunity type "${value}"`);
}

function normalizeSegment(employeeCount: number): AccountSegment {
  if (employeeCount <= 50) return 'startup';
  if (employeeCount <= 250) return 'smb';
  if (employeeCount <= 1000) return 'mid_market';
  return 'enterprise';
}

function normalizeAccount(row: Record<string, string>): SalesforceAccount {
  const employeeCount = parseInteger(row.employee_count, 'employee_count');
  const ownerName = requireString(row.account_owner, 'account_owner');

  return {
    account_id: requireString(row.account_id, 'account_id'),
    account_name: requireString(row.account_name, 'account_name'),
    industry: requireString(row.industry, 'industry'),
    employee_count: employeeCount,
    annual_revenue: parseNumber(row.annual_contract_value, 'annual_contract_value'),
    billing_country: requireString(row.region, 'region'),
    billing_state: '',
    website: requireString(row.website, 'website'),
    owner_name: ownerName,
    owner_email: normalizeOwnerEmail(ownerName),
    created_date: normalizeDate(row.created_date, 'created_date'),
    segment: normalizeSegment(employeeCount),
    parent_account_id: toNullableString(row.parent_account_id),
    stripe_customer_id: null,
    chargebee_customer_id: null,
  };
}

function normalizeOpportunity(row: Record<string, string>): SalesforceOpportunity {
  const ownerName = requireString(row.owner_name, 'owner_name');
  const amount = parseNumber(row.amount, 'amount');
  const contractTermMonths = parseInteger(row.contract_term_months, 'contract_term_months');

  return {
    opportunity_id: requireString(row.opportunity_id, 'opportunity_id'),
    account_id: requireString(row.account_id, 'account_id'),
    account_name: requireString(row.account_name, 'account_name'),
    opportunity_name: requireString(row.opportunity_name, 'opportunity_name'),
    stage: requireString(row.stage, 'stage'),
    amount,
    currency: requireString(row.currency, 'currency').toLowerCase(),
    close_date: normalizeDate(row.close_date, 'close_date'),
    created_date: normalizeDate(row.created_date, 'created_date'),
    probability: parseInteger(row.probability, 'probability'),
    forecast_category: normalizeForecastCategory(requireString(row.stage, 'stage')),
    type: normalizeOpportunityType(row.deal_type),
    owner_name: ownerName,
    owner_email: normalizeOwnerEmail(ownerName),
    next_step: toNullableString(row.next_step),
    tcv: amount,
    acv: contractTermMonths > 0 ? Math.round((amount * 12) / contractTermMonths) : amount,
    contract_term_months: contractTermMonths,
    competitor: null,
    loss_reason:
      requireString(row.stage, 'stage').trim().toLowerCase() === 'closed lost'
        ? toNullableString(row.next_step)
        : null,
    partner_id: toNullableString(row.partner_id),
  };
}

/**
 * Load and normalize Salesforce CRM data (Opportunities and Accounts).
 *
 * Salesforce data introduces several reconciliation challenges:
 *
 * - **TCV vs ACV**: Opportunities have both `tcv` (Total Contract Value) and
 *   `acv` (Annual Contract Value) fields.  For multi-year deals the TCV is
 *   a multiple of ACV, but discounts and ramp deals may cause mismatches.
 *   ARR calculations should use ACV, not TCV.
 *
 * - **Opportunity stages**: The pipeline includes stages from "Prospecting"
 *   through "Closed Won" and "Closed Lost".  Only "Closed Won" opportunities
 *   should map to actual revenue, but "Commit" and "Best Case" stages are
 *   used for forecasting.  Zombie deals (open opportunities with no activity
 *   for 90+ days) are a common data quality issue.
 *
 * - **Account hierarchy**: Some accounts have a `parent_account_id` linking
 *   them in a corporate hierarchy.  Revenue roll-ups for enterprise customers
 *   must aggregate across child accounts.
 *
 * - **External ID mapping**: Accounts may have `stripe_customer_id` and/or
 *   `chargebee_customer_id` fields that map to billing systems.  These are
 *   manually entered and may be missing, outdated, or incorrect.
 *
 * - **Duplicate accounts**: The same company may appear as multiple Salesforce
 *   accounts with slightly different names (e.g., "Acme Corp" vs "ACME Inc.").
 *
 * @param dataDir - Path to the data directory
 * @returns Tuple of [opportunities, accounts]
 */
export async function loadSalesforceData(
  dataDir: string,
): Promise<[SalesforceOpportunity[], SalesforceAccount[]]> {
  const opportunitiesPath = join(dataDir, 'salesforce_opportunities.csv');
  const accountsPath = join(dataDir, 'salesforce_accounts.csv');

  const [opportunities, accounts] = await Promise.all([
    loadCSV<SalesforceOpportunity>(opportunitiesPath, {
      transform: (row) => normalizeOpportunity(row),
    }),
    loadCSV<SalesforceAccount>(accountsPath, {
      transform: (row) => normalizeAccount(row),
    }),
  ]);

  return [opportunities, accounts];
}
