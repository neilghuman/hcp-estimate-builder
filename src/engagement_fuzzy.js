// Customer Engagement Platform - fuzzy duplicate contact sweep.
//
// Scans existing EspoCRM Contacts for near-duplicate clusters (likely the same person split
// across records) and queues each cluster to IdentityReview. It NEVER merges anything - the hard
// guardrail is human-decided merges only. Suspected duplicates require a *shared strong identifier*
// (same normalized phone or email) AND at least a moderate name similarity, so unrelated people
// who merely share a household phone are not flagged.
//
// Blocking: candidate pairs are only formed inside phone/email buckets, so the scan stays near-linear
// even across thousands of contacts (the suspect rule requires a shared identifier anyway).

import crypto from 'node:crypto';
import { normalizeEmail, normalizePhone } from './engagement_identity.js';
import { engagementConfig } from './engagement_runtime.js';

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function nameTokens(contact) {
  const full = String(contact?.name || `${contact?.firstName || ''} ${contact?.lastName || ''}`).trim();
  return full.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function levenshtein(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 0; i < s.length; i += 1) {
    const curr = [i + 1];
    for (let j = 0; j < t.length; j += 1) {
      const cost = s[i] === t[j] ? 0 : 1;
      curr[j + 1] = Math.min(curr[j] + 1, prev[j + 1] + 1, prev[j] + cost);
    }
    prev = curr;
  }
  return prev[t.length];
}

function levRatio(a, b) {
  const max = Math.max(String(a || '').length, String(b || '').length);
  if (!max) return 1;
  return 1 - levenshtein(a, b) / max;
}

// Name similarity in [0,1]: max of token-set Jaccard (order-insensitive) and a
// Levenshtein ratio over sorted tokens (typo/nickname tolerant).
export function nameSimilarity(aTokens, bTokens) {
  if (!aTokens?.length || !bTokens?.length) return 0;
  const setA = new Set(aTokens);
  const setB = new Set(bTokens);
  const intersection = [...setA].filter((token) => setB.has(token)).length;
  const union = new Set([...setA, ...setB]).size;
  const jaccard = union ? intersection / union : 0;
  const ratio = levRatio([...aTokens].sort().join(' '), [...bTokens].sort().join(' '));
  return Math.max(jaccard, ratio);
}

function contactKey(contact, defaultCountry) {
  return {
    id: String(contact?.id),
    tokens: nameTokens(contact),
    phone: normalizePhone(contact?.phoneNumber, { defaultCountry }),
    email: normalizeEmail(contact?.emailAddress),
  };
}

// Score a pair of contact keys. A pair is a suspected duplicate when it shares a strong
// identifier (same normalized phone or email) AND either shares a name token (nickname/typo
// tolerant, e.g. "Robert Lee" / "Bob Lee") or is a very close whole-name match. Two people who
// merely share a household phone with no name overlap are therefore not flagged.
export function scoreContactPair(a, b, { nameStrong = 0.85 } = {}) {
  const phoneMatch = Boolean(a.phone && b.phone && a.phone === b.phone);
  const emailMatch = Boolean(a.email && b.email && a.email === b.email);
  const sharedIdentifier = phoneMatch || emailMatch;
  const sharedToken = (a.tokens || []).some((token) => (b.tokens || []).includes(token));
  const nameSim = round2(nameSimilarity(a.tokens, b.tokens));
  const suspect = sharedIdentifier && (sharedToken || nameSim >= nameStrong);
  return { nameSim, phoneMatch, emailMatch, sharedToken, suspect };
}

function clusterKey(ids) {
  return crypto.createHash('sha1').update([...ids].sort().join('|')).digest('hex');
}

// Find clusters (size >= 2) of contacts that are suspected duplicates of each other.
export function findDuplicateClusters(contacts, { nameStrong = 0.85, defaultCountry } = {}) {
  const country = defaultCountry || engagementConfig().defaultPhoneCountry;
  const keysById = new Map();
  for (const contact of contacts || []) {
    const key = contactKey(contact, country);
    if (key.id && !keysById.has(key.id)) keysById.set(key.id, key);
  }

  const byPhone = new Map();
  const byEmail = new Map();
  for (const key of keysById.values()) {
    if (key.phone) (byPhone.get(key.phone) || byPhone.set(key.phone, []).get(key.phone)).push(key);
    if (key.email) (byEmail.get(key.email) || byEmail.set(key.email, []).get(key.email)).push(key);
  }

  const parent = new Map();
  const ensure = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const find = (x) => { let r = x; while (parent.get(r) !== r) { parent.set(r, parent.get(parent.get(r))); r = parent.get(r); } return r; };
  const union = (x, y) => { ensure(x); ensure(y); parent.set(find(x), find(y)); };

  const pairs = [];
  const seen = new Set();
  const consider = (bucket) => {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i];
        const b = bucket[j];
        if (a.id === b.id) continue;
        const pk = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (seen.has(pk)) continue;
        seen.add(pk);
        const score = scoreContactPair(a, b, { nameStrong });
        if (score.suspect) {
          union(a.id, b.id);
          pairs.push({ a: a.id, b: b.id, nameSim: score.nameSim, phoneMatch: score.phoneMatch, emailMatch: score.emailMatch, sharedToken: score.sharedToken });
        }
      }
    }
  };
  for (const bucket of byPhone.values()) if (bucket.length >= 2) consider(bucket);
  for (const bucket of byEmail.values()) if (bucket.length >= 2) consider(bucket);

  const groups = new Map();
  for (const id of parent.keys()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root).add(id);
  }

  const clusters = [];
  for (const group of groups.values()) {
    if (group.size < 2) continue;
    const ids = [...group].sort();
    const key = clusterKey(ids);
    clusters.push({
      contactIds: ids,
      clusterKey: key,
      pairs: pairs.filter((pair) => group.has(pair.a) && group.has(pair.b)),
    });
  }
  clusters.sort((a, b) => (a.clusterKey < b.clusterKey ? -1 : a.clusterKey > b.clusterKey ? 1 : 0));
  return clusters;
}

// Build the IdentityReview payload for one duplicate cluster. Idempotent via externalId = clusterKey
// (a stable hash of the sorted contact ids). Names live inside EspoCRM already, so a light summary
// is included to help the reviewer.
export function buildDuplicateReview(cluster, contactsById = new Map()) {
  const sourceSystem = String(process.env.ENGAGEMENT_FUZZY_REVIEW_SOURCE_SYSTEM || 'EspoCRM');
  const sourceAccountId = String(process.env.ENGAGEMENT_FUZZY_REVIEW_ACCOUNT_ID || 'espocrm-fuzzy-dedup');
  const contacts = cluster.contactIds.map((id) => {
    const contact = contactsById.get(id) || contactsById.get(String(id)) || {};
    return { contactId: id, name: String(contact.name || `${contact.firstName || ''} ${contact.lastName || ''}`).trim() || null };
  });
  return {
    name: `Possible duplicate contacts (${cluster.contactIds.length}): ${cluster.clusterKey.slice(0, 12)}`,
    sourceSystem,
    sourceAccountId,
    externalId: cluster.clusterKey,
    reviewStatus: 'Open',
    candidateContactId: cluster.contactIds[0] || null,
    conflictSummary: 'fuzzy_duplicate',
    matchingEvidence: { type: 'fuzzy_duplicate', contactIds: cluster.contactIds, pairs: cluster.pairs, contacts },
  };
}

// --- audit persistence -------------------------------------------------------

export async function createFuzzyDedupRun(pool) {
  const id = crypto.randomUUID();
  await pool.query("INSERT INTO fuzzy_dedup_runs (id, status) VALUES ($1, 'running')", [id]);
  return id;
}

export async function completeFuzzyDedupRun(pool, runId, { contactsScanned = 0, clustersFound = 0, reviewsCreated = 0, reviewsExisting = 0, failed = 0 } = {}) {
  await pool.query(`
    UPDATE fuzzy_dedup_runs
    SET status = 'complete', contacts_scanned = $2, clusters_found = $3, reviews_created = $4,
        reviews_existing = $5, failed_count = $6, completed_at = NOW()
    WHERE id = $1
  `, [runId, contactsScanned, clustersFound, reviewsCreated, reviewsExisting, failed]);
}

export async function failFuzzyDedupRun(pool, runId, errorCode = 'fuzzy_dedup_failed') {
  await pool.query("UPDATE fuzzy_dedup_runs SET status = 'failed', error_code = $2, completed_at = NOW() WHERE id = $1", [runId, errorCode]);
}
