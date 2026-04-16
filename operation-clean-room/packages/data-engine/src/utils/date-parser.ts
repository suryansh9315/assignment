/**
 * Ambiguous date format parser.
 *
 * The legacy billing system used inconsistent date formats depending on the
 * operator's locale settings.  Some dates are DD/MM/YYYY (European) and
 * others are MM/DD/YYYY (US).  Dates like "03/04/2023" are genuinely
 * ambiguous -- it could be March 4 or April 3.
 *
 * Disambiguation strategies:
 *
 * 1. **Unambiguous dates**: If the day component is > 12 (e.g., "25/03/2023"),
 *    the format is definitively DD/MM/YYYY.  If the month component is > 12,
 *    it's definitively MM/DD/YYYY.
 *
 * 2. **Contextual clues**: If a `context` object is provided with neighboring
 *    dates from the same customer/invoice sequence, use the unambiguous dates
 *    in the sequence to infer the format for ambiguous ones.
 *
 * 3. **ISO-8601 passthrough**: If the date string is already in ISO-8601
 *    format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss), parse it directly.
 *
 * 4. **Fallback**: When no disambiguation is possible, default to MM/DD/YYYY
 *    (US format) as the majority of the data uses this convention.
 *
 * Also handles:
 * - Dates with dashes (DD-MM-YYYY, MM-DD-YYYY)
 * - Dates with dots (DD.MM.YYYY)
 * - Two-digit years (23 -> 2023, 99 -> 1999)
 * - Whitespace trimming
 *
 * @param dateStr - Raw date string from the data source
 * @param context - Optional context for disambiguation
 * @returns Parsed Date object in UTC
 *
 * @throws Error if the date string cannot be parsed at all
 */
export function parseAmbiguousDate(
  dateStr: string,
  context?: {
    /** Other dates from the same customer / invoice sequence. */
    neighborDates?: string[];
    /** Known format hint from metadata. */
    formatHint?: 'DD/MM/YYYY' | 'MM/DD/YYYY';
  },
): Date {
  const normalized = dateStr.trim();
  if (normalized.length === 0) {
    throw new Error('Cannot parse an empty date string');
  }

  if (/^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(normalized)) {
    const parsed = new Date(normalized);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid ISO date "${dateStr}"`);
    }

    return parsed;
  }

  const parts = normalized.split(/[\/.-]/);
  if (parts.length !== 3) {
    throw new Error(`Unsupported ambiguous date format "${dateStr}"`);
  }

  const [firstRaw, secondRaw, yearRaw] = parts;
  const first = Number(firstRaw);
  const second = Number(secondRaw);
  const year = normalizeYear(Number(yearRaw));

  if (![first, second, year].every(Number.isFinite)) {
    throw new Error(`Invalid date components in "${dateStr}"`);
  }

  const resolvedFormat =
    inferFormatFromPair(first, second) ??
    context?.formatHint ??
    inferFormatFromNeighbors(context?.neighborDates) ??
    'MM/DD/YYYY';

  const month = resolvedFormat === 'DD/MM/YYYY' ? second : first;
  const day = resolvedFormat === 'DD/MM/YYYY' ? first : second;

  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date "${dateStr}"`);
  }

  return parsed;
}

function normalizeYear(year: number): number {
  if (year >= 100) return year;
  return year >= 70 ? 1900 + year : 2000 + year;
}

function inferFormatFromPair(
  first: number,
  second: number,
): 'DD/MM/YYYY' | 'MM/DD/YYYY' | null {
  if (first > 12 && second <= 12) return 'DD/MM/YYYY';
  if (second > 12 && first <= 12) return 'MM/DD/YYYY';
  return null;
}

function inferFormatFromNeighbors(
  neighborDates: string[] | undefined,
): 'DD/MM/YYYY' | 'MM/DD/YYYY' | null {
  if (!neighborDates || neighborDates.length === 0) {
    return null;
  }

  let dayFirst = 0;
  let monthFirst = 0;

  for (const neighbor of neighborDates) {
    const trimmed = neighbor.trim();
    if (trimmed.length === 0 || /^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(trimmed)) {
      continue;
    }

    const parts = trimmed.split(/[\/.-]/);
    if (parts.length !== 3) continue;

    const first = Number(parts[0]);
    const second = Number(parts[1]);
    const inferred = inferFormatFromPair(first, second);

    if (inferred === 'DD/MM/YYYY') dayFirst++;
    if (inferred === 'MM/DD/YYYY') monthFirst++;
  }

  if (dayFirst === 0 && monthFirst === 0) {
    return null;
  }

  return dayFirst >= monthFirst ? 'DD/MM/YYYY' : 'MM/DD/YYYY';
}
