import type { MatchResult, MatchConfidence } from './types.js';
import { normalizeCompanyName } from '../utils/normalization.js';

/**
 * Fuzzy matching engine for cross-system entity resolution.
 *
 * Must handle variant company names, different ID schemes, and partial
 * matches.  The matcher should use a combination of:
 *
 * - **Exact ID matching**: When external IDs (stripe_customer_id,
 *   chargebee_customer_id) are present and valid, these are the strongest
 *   signals.
 *
 * - **Domain matching**: If both entities have a website/domain field,
 *   matching domains are a very strong signal.
 *
 * - **Fuzzy name matching**: Company names vary across systems
 *   ("Acme Corp" vs "ACME Corporation Ltd." vs "acme").  Use normalized
 *   string comparison with techniques such as:
 *   - Case folding
 *   - Stripping common suffixes (Corp, Inc, Ltd, LLC, GmbH, etc.)
 *   - Token-based similarity (Jaccard, Sørensen-Dice)
 *   - Edit distance (Levenshtein)
 *
 * - **Composite scoring**: Combine signals from multiple fields into
 *   a single confidence score using configurable weights.
 *
 * @module reconciliation/matcher
 */

/** Options for controlling the entity matching process. */
export interface MatchOptions {
  /** Minimum confidence score (0-1) to consider a match. Defaults to 0.6. */
  threshold?: number;
  /** Weight for exact ID matches. Defaults to 1.0. */
  idWeight?: number;
  /** Weight for domain matches. Defaults to 0.9. */
  domainWeight?: number;
  /** Weight for name similarity. Defaults to 0.7. */
  nameWeight?: number;
  /** Whether to allow many-to-one matches. Defaults to false. */
  allowMultipleMatches?: boolean;
}

/**
 * Match entities across two data sources using fuzzy matching.
 *
 * @param sourceA - Array of entities from the first data source
 * @param sourceB - Array of entities from the second data source
 * @param options - Matching options
 * @returns Array of match results with confidence scores
 */
export async function matchEntities(
  sourceA: Record<string, unknown>[],
  sourceB: Record<string, unknown>[],
  options?: MatchOptions,
): Promise<MatchResult[]> {
  const threshold = options?.threshold ?? 0.6;
  const allowMultipleMatches = options?.allowMultipleMatches ?? false;
  const matches: MatchResult[] = [];
  const claimedB = new Set<number>();

  for (const entityA of sourceA) {
    let best: { index: number; entity: Record<string, unknown>; confidence: MatchConfidence } | null =
      null;

    for (let index = 0; index < sourceB.length; index++) {
      if (!allowMultipleMatches && claimedB.has(index)) continue;

      const entityB = sourceB[index]!;
      const confidence = await calculateConfidence(entityA, entityB);
      if (confidence.score >= threshold && (best == null || confidence.score > best.confidence.score)) {
        best = { index, entity: entityB, confidence };
      }
    }

    if (best) {
      claimedB.add(best.index);
      matches.push({
        entityA: { id: getEntityId(entityA), source: getEntitySource(entityA), ...entityA },
        entityB: { id: getEntityId(best.entity), source: getEntitySource(best.entity), ...best.entity },
        confidence: best.confidence,
      });
    }
  }

  return matches.sort((a, b) => b.confidence.score - a.confidence.score);
}

/**
 * Calculate the confidence score for a potential match between two entities.
 *
 * @param entityA - First entity (must have at minimum: id, name)
 * @param entityB - Second entity (must have at minimum: id, name)
 * @returns Confidence assessment with score, matched fields, and unmatched fields
 */
export async function calculateConfidence(
  entityA: Record<string, unknown>,
  entityB: Record<string, unknown>,
): Promise<MatchConfidence> {
  const matchedFields: string[] = [];
  const unmatchedFields: string[] = [];
  let score = 0;

  const idA = getExternalId(entityA);
  const idB = getExternalId(entityB);
  if (idA && idB) {
    if (idA === idB) {
      matchedFields.push('external_id');
      score += 1;
    } else {
      unmatchedFields.push('external_id');
    }
  }

  const domainA = normalizeDomain(getString(entityA, ['domain', 'website', 'email']));
  const domainB = normalizeDomain(getString(entityB, ['domain', 'website', 'email']));
  if (domainA && domainB) {
    if (domainA === domainB) {
      matchedFields.push('domain');
      score += 0.45;
    } else {
      unmatchedFields.push('domain');
    }
  }

  const nameA = getString(entityA, ['name', 'company', 'companyName', 'customer_name', 'account_name']);
  const nameB = getString(entityB, ['name', 'company', 'companyName', 'customer_name', 'account_name']);
  const nameScore = computeNameSimilarity(nameA, nameB);
  if (nameScore >= 0.95) {
    matchedFields.push('company_name_exact');
    score += 0.45;
  } else if (nameScore >= 0.55) {
    matchedFields.push('company_name_fuzzy');
    score += 0.45 * nameScore;
  } else {
    unmatchedFields.push('company_name');
  }

  return {
    score: Math.min(1, Number(score.toFixed(3))),
    matchedFields,
    unmatchedFields,
  };
}

function getString(entity: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = entity[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

function getEntityId(entity: Record<string, unknown>): string {
  return getString(entity, ['id', 'customer_id', 'account_id', 'subscription_id', 'payment_id']) || 'unknown';
}

function getEntitySource(entity: Record<string, unknown>): string {
  return getString(entity, ['source', 'system']) || 'unknown';
}

function getExternalId(entity: Record<string, unknown>): string {
  return getString(entity, [
    'external_id',
    'stripe_customer_id',
    'chargebee_customer_id',
    'customer_id',
    'account_id',
  ]);
}

function normalizeDomain(value: string): string {
  if (!value) return '';
  const emailDomain = value.includes('@') ? value.split('@').pop() ?? value : value;
  return emailDomain
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]!
    .trim();
}

function computeNameSimilarity(nameA: string, nameB: string): number {
  const normalizedA = normalizeCompanyName(nameA);
  const normalizedB = normalizeCompanyName(nameB);
  if (!normalizedA || !normalizedB) return 0;
  if (normalizedA === normalizedB) return 1;
  if (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) return 0.9;

  const tokensA = new Set(normalizedA.split(' ').filter(Boolean));
  const tokensB = new Set(normalizedB.split(' ').filter(Boolean));
  const intersection = [...tokensA].filter((token) => tokensB.has(token)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  const jaccard = union === 0 ? 0 : intersection / union;
  const edit = 1 - levenshtein(normalizedA, normalizedB) / Math.max(normalizedA.length, normalizedB.length);

  return Math.max(jaccard, edit);
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i++) {
    let previous = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j]!;
      row[j] =
        a[i - 1] === b[j - 1]
          ? row[j - 1]!
          : Math.min(row[j - 1]!, previous, row[j]!) + 1;
      previous = temp;
    }
    row[0] = i;
  }

  return row[b.length]!;
}
