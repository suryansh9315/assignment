import { loadCSV } from '../ingestion/csv-loader.js';
import type { FXRate } from '../ingestion/types.js';

function normalizeDateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

function parseFXRateRow(row: Record<string, string>): FXRate {
  const date = row.date?.trim();
  if (!date) {
    throw new Error('Missing FX rate date');
  }

  const parseRate = (value: string | undefined, fieldName: string): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid FX rate field "${fieldName}"`);
    }

    return parsed;
  };

  return {
    date,
    eur_usd: parseRate(row.eur_usd, 'eur_usd'),
    gbp_usd: parseRate(row.gbp_usd, 'gbp_usd'),
    jpy_usd: parseRate(row.jpy_usd, 'jpy_usd'),
    aud_usd: parseRate(row.aud_usd, 'aud_usd'),
  };
}

function getRateField(currency: string): keyof Omit<FXRate, 'date'> | null {
  switch (normalizeCurrency(currency)) {
    case 'USD':
      return null;
    case 'EUR':
      return 'eur_usd';
    case 'GBP':
      return 'gbp_usd';
    case 'JPY':
      return 'jpy_usd';
    case 'AUD':
      return 'aud_usd';
    default:
      throw new Error(`Unsupported currency "${currency}"`);
  }
}

export async function loadFXRates(filePath: string): Promise<FXRate[]> {
  return loadCSV<FXRate>(filePath, {
    transform: (row) => parseFXRateRow(row),
  });
}

export function findHistoricalFXRate(
  currency: string,
  date: Date,
  rates: FXRate[],
): number {
  const rateField = getRateField(currency);
  if (rateField == null) {
    return 1;
  }

  const rateByDate = new Map(rates.map((rate) => [rate.date, rate]));

  for (let lookbackDays = 0; lookbackDays <= 5; lookbackDays++) {
    const lookupDate = new Date(date);
    lookupDate.setUTCDate(lookupDate.getUTCDate() - lookbackDays);

    const rate = rateByDate.get(normalizeDateKey(lookupDate));
    if (rate) {
      return rate[rateField];
    }
  }

  throw new Error(
    `No FX rate found for ${normalizeCurrency(currency)} on ${normalizeDateKey(date)} or prior 5 days`,
  );
}

/**
 * Convert an amount from one currency to USD using historical FX rates.
 *
 * Looks up the FX rate for the given date. If the exact date is not available
 * (e.g., weekends or holidays), falls back to the most recent prior trading
 * day's rate. The lookup order is:
 *   1. Exact date match
 *   2. Previous day, up to 5 days back (covers weekends + holidays)
 *   3. Throws an error if no rate is found within the window
 *
 * Supported currencies: EUR, GBP, JPY, AUD.
 * USD amounts are returned as-is (no conversion needed).
 *
 * @param amount - The amount to convert
 * @param currency - Source currency code (EUR, GBP, JPY, AUD, USD)
 * @param date - The date to use for the FX rate lookup
 * @param rates - Historical FX rate data
 * @returns Amount converted to USD
 *
 * @throws Error if the currency is not supported
 * @throws Error if no FX rate is available within the lookback window
 */
export function convertToUSD(
  amount: number,
  currency: string,
  date: Date,
  rates: FXRate[],
): number {
  const fxRate = findHistoricalFXRate(currency, date, rates);
  return Math.round(amount * fxRate * 100) / 100;
}
