import type { UnitEconomics, MetricOptions } from './types.js';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCSV } from '../ingestion/csv-loader.js';
import { getUnifiedARRRecords } from './arr.js';
import { calculateChurn } from './churn.js';

type MarketingRow = {
  month: string;
  channel: string;
  spend: number;
  conversions: number;
};

/**
 * Unit economics calculation (CAC, LTV, LTV/CAC ratio, payback period).
 *
 * Unit economics determine whether the business model is sustainable.
 * Key metrics:
 *
 * - **CAC (Customer Acquisition Cost)**: Total sales and marketing spend
 *   divided by the number of new customers acquired in the period.
 *   Attribution model choices:
 *   - **Blended**: Total S&M spend / total new customers (simplest).
 *   - **Channel-attributed**: Spend per channel / conversions per channel.
 *   - **Fully-loaded**: Includes sales team salaries, tools, events, etc.
 *   The appropriate model depends on the available data and business needs.
 *
 * - **LTV (Lifetime Value)**: The expected total revenue from a customer
 *   over their entire relationship.  Common formulas:
 *   - Simple: ARPA / Monthly Churn Rate
 *   - With gross margin: (ARPA * Gross Margin) / Monthly Churn Rate
 *   - With expansion: (ARPA * Gross Margin * (1 + monthly expansion rate)) / Monthly Churn Rate
 *   The "correct" formula depends on business stage and data availability.
 *
 * - **LTV/CAC Ratio**: Target is > 3.0x for a healthy SaaS business.
 *   Below 1.0x means the company loses money on every customer.
 *
 * - **Payback Period**: Months to recover the CAC from a customer's revenue.
 *   Formula: CAC / (ARPA * Gross Margin).  Target is < 18 months.
 *
 * @param period - The period for calculation (e.g. "2024-Q1", "2024-03")
 * @param options - Calculation options
 * @returns Unit economics with blended and per-channel breakdown
 */
export async function calculateUnitEconomics(
  period: string,
  options?: MetricOptions,
): Promise<UnitEconomics> {
  const { startDate, endDate, months } = parsePeriod(period);
  const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../data');
  const [marketingRows, arrRecords, churn] = await Promise.all([
    loadMarketingRows(join(dataDir, 'marketing_spend.csv')),
    getUnifiedARRRecords(endDate, options),
    calculateChurn(startDate, endDate, options),
  ]);
  const periodRows = marketingRows.filter((row) => row.month >= formatMonth(startDate) && row.month <= formatMonth(endDate));
  const totalSpend = periodRows.reduce((sum, row) => sum + row.spend, 0);
  const conversions = periodRows.reduce((sum, row) => sum + row.conversions, 0);
  const customersAcquired = conversions > 0 ? conversions : Math.max(1, arrRecords.length);
  const cac = totalSpend / customersAcquired;
  const monthlyRevenue = arrRecords.reduce((sum, record) => sum + record.arr / 12, 0);
  const arpa = arrRecords.length === 0 ? 0 : monthlyRevenue / new Set(arrRecords.map((record) => record.customerKey)).size;
  const monthlyChurnRate = Math.max(0.005, churn.logoChurnRate / 100 / Math.max(1, months));
  const grossMargin = getWeightedGrossMargin(arrRecords);
  const ltv = (arpa * grossMargin) / monthlyChurnRate;
  const byChannel = Array.from(groupByChannel(periodRows).entries()).map(([channel, rows]) => {
    const channelSpend = rows.reduce((sum, row) => sum + row.spend, 0);
    const channelConversions = rows.reduce((sum, row) => sum + row.conversions, 0);
    const channelCac = channelConversions === 0 ? 0 : channelSpend / channelConversions;
    const paybackMonths = arpa * grossMargin === 0 ? 0 : channelCac / (arpa * grossMargin);
    return {
      channel,
      cac: Math.round(channelCac),
      ltv: Math.round(ltv),
      ltvCacRatio: channelCac === 0 ? 0 : Number((ltv / channelCac).toFixed(2)),
      paybackMonths: Number(paybackMonths.toFixed(1)),
      customersAcquired: channelConversions,
      totalSpend: Math.round(channelSpend),
    };
  });

  return {
    cac: Math.round(cac),
    ltv: Math.round(ltv),
    ltvCacRatio: cac === 0 ? 0 : Number((ltv / cac).toFixed(2)),
    paybackMonths: arpa * grossMargin === 0 ? 0 : Number((cac / (arpa * grossMargin)).toFixed(1)),
    grossMargin: Number((grossMargin * 100).toFixed(1)),
    arpa: Math.round(arpa),
    byChannel,
    period,
  };
}

async function loadMarketingRows(path: string): Promise<MarketingRow[]> {
  return loadCSV<MarketingRow>(path, {
    transform: (row) => ({
      month: requireString(row.month),
      channel: requireString(row.channel),
      spend: Number(row.spend_usd ?? 0),
      conversions: Number(row.attributed_deals ?? 0),
    }),
  });
}

function parsePeriod(period: string): { startDate: Date; endDate: Date; months: number } {
  const quarterMatch = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarterMatch) {
    const year = Number(quarterMatch[1]);
    const quarter = Number(quarterMatch[2]);
    const startMonth = (quarter - 1) * 3;
    return {
      startDate: new Date(Date.UTC(year, startMonth, 1)),
      endDate: new Date(Date.UTC(year, startMonth + 3, 0, 23, 59, 59)),
      months: 3,
    };
  }

  const monthMatch = /^(\d{4})-(\d{2})$/.exec(period);
  if (!monthMatch) {
    throw new Error('Period must use YYYY-MM or YYYY-Qn format.');
  }
  const year = Number(monthMatch[1]);
  const month = Number(monthMatch[2]);
  return {
    startDate: new Date(Date.UTC(year, month - 1, 1)),
    endDate: new Date(Date.UTC(year, month, 0, 23, 59, 59)),
    months: 1,
  };
}

function formatMonth(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function requireString(value: string | undefined): string {
  if (!value) throw new Error('Missing marketing spend value');
  return value;
}

function groupByChannel(rows: MarketingRow[]): Map<string, MarketingRow[]> {
  const groups = new Map<string, MarketingRow[]>();
  for (const row of rows) {
    const group = groups.get(row.channel) ?? [];
    group.push(row);
    groups.set(row.channel, group);
  }
  return groups;
}

function getWeightedGrossMargin(records: Awaited<ReturnType<typeof getUnifiedARRRecords>>): number {
  const totalArr = records.reduce((sum, record) => sum + record.arr, 0);
  if (totalArr === 0) return 0.78;
  const weighted = records.reduce((sum, record) => {
    const margin = record.planName.toLowerCase().includes('starter') ? 0.65 : 0.78;
    return sum + record.arr * margin;
  }, 0);
  return weighted / totalArr;
}
