import firebaseConfig from '../firebase-applet-config.json' with { type: 'json' };
import type { AccessLevel, SopChunk } from '../src/types/sop.ts';

type FirestoreValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { timestampValue: string }
  | { nullValue: null }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

function decodeValue(val: FirestoreValue | undefined): unknown {
  if (!val) return undefined;
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('booleanValue' in val) return val.booleanValue;
  if ('timestampValue' in val) return val.timestampValue;
  if ('nullValue' in val) return null;
  if ('arrayValue' in val) {
    return (val.arrayValue.values || []).map((v) => decodeValue(v));
  }
  if ('mapValue' in val) {
    const out: Record<string, unknown> = {};
    const fields = val.mapValue.fields || {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = decodeValue(v);
    }
    return out;
  }
  return undefined;
}

function decodeEmbedding(val: FirestoreValue | undefined): number[] {
  if (!val || !('arrayValue' in val)) return [];
  const rawValues = val.arrayValue.values;
  if (!rawValues || rawValues.length === 0) return [];
  const out = new Array<number>(rawValues.length);
  for (let i = 0; i < rawValues.length; i++) {
    const item = rawValues[i] as { doubleValue?: number; integerValue?: string } | undefined;
    if (!item) {
      out[i] = 0;
    } else if (typeof item.doubleValue === 'number') {
      out[i] = item.doubleValue;
    } else if (item.integerValue !== undefined) {
      out[i] = Number(item.integerValue);
    } else {
      out[i] = 0;
    }
  }
  return out;
}

function decodeDocument(doc: { name: string; fields?: Record<string, FirestoreValue> }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = doc.fields || {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = k === 'embedding' ? decodeEmbedding(v) : decodeValue(v);
  }
  if (!out.id && doc.name) {
    out.id = doc.name.split('/').pop();
  }
  return out;
}

async function runChunkQuery(
  idToken: string,
  structuredQuery: Record<string, unknown>
): Promise<SopChunk[]> {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents:runQuery`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ structuredQuery }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Firestore query error (${resp.status}): ${errText}`);
  }

  const rows = (await resp.json()) as Array<{ document?: { name: string; fields?: Record<string, FirestoreValue> } }>;
  const chunks: SopChunk[] = [];

  for (const row of rows) {
    if (!row.document) continue;
    const raw = decodeDocument(row.document);
    if (raw.status !== 'Disetujui') continue;
    chunks.push({
      id: String(raw.id || ''),
      sopId: String(raw.sopId || ''),
      docNumber: String(raw.docNumber || ''),
      title: String(raw.title || ''),
      version: Number(raw.version || 1),
      divisionId: String(raw.divisionId || ''),
      divisionName: String(raw.divisionName || ''),
      departmentName: String(raw.departmentName || ''),
      sectionIndex: Number(raw.sectionIndex || 0),
      sectionTitle: String(raw.sectionTitle || ''),
      content: String(raw.content || ''),
      keywords: String(raw.keywords || ''),
      embedding: Array.isArray(raw.embedding) ? (raw.embedding as number[]) : [],
      status: 'Disetujui',
      accessLevel: (raw.accessLevel as AccessLevel) || 'Umum',
      viewerUids: Array.isArray(raw.viewerUids) ? raw.viewerUids.map(String) : [],
      ownerUid: String(raw.ownerUid || ''),
      ownerName: String(raw.ownerName || ''),
    });
  }

  return chunks;
}

const CHUNK_CACHE_TTL_MS = 60_000;
const MAX_CACHED_USERS = 100;
const chunkCache = new Map<string, { expiresAt: number; chunks: SopChunk[] }>();
const inFlightChunkQueries = new Map<string, Promise<SopChunk[]>>();

export function invalidateChunkCache(uid?: string): void {
  if (!uid) {
    chunkCache.clear();
    return;
  }
  for (const key of chunkCache.keys()) {
    if (key.startsWith(`${uid}:`)) {
      chunkCache.delete(key);
    }
  }
}

export function getCachedAccessibleChunks(uid: string, email?: string): SopChunk[] | null {
  const key = `${uid}:${email || ''}`;
  const entry = chunkCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    chunkCache.delete(key);
    return null;
  }
  return entry.chunks;
}

/**
 * Retrieves approved SOP chunks strictly enforced by Firestore Security Rules
 * at the database query level using the caller's Firebase ID Token.
 */
export async function fetchAccessibleApprovedChunks(params: {
  idToken: string;
  uid: string;
  email?: string;
}): Promise<SopChunk[]> {
  const { idToken, uid, email } = params;
  const cacheKey = `${uid}:${email || ''}`;

  const cached = getCachedAccessibleChunks(uid, email);
  if (cached) {
    return cached;
  }

  const existingInFlight = inFlightChunkQueries.get(cacheKey);
  if (existingInFlight) {
    return existingInFlight;
  }

  const queryPromise = (async () => {
    const isBootstrapAdmin = email === 'ahmadmagfur1218@gmail.com';
    let result: SopChunk[];

    if (isBootstrapAdmin) {
      result = await runChunkQuery(idToken, {
        from: [{ collectionId: 'sopChunks' }],
        limit: 500,
      });
    } else {
      const [publicChunks, scopedChunks] = await Promise.all([
        runChunkQuery(idToken, {
          from: [{ collectionId: 'sopChunks' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'accessLevel' },
              op: 'EQUAL',
              value: { stringValue: 'Umum' },
            },
          },
          limit: 400,
        }),
        runChunkQuery(idToken, {
          from: [{ collectionId: 'sopChunks' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'viewerUids' },
              op: 'ARRAY_CONTAINS',
              value: { stringValue: uid },
            },
          },
          limit: 300,
        }),
      ]);

      const dedup = new Map<string, SopChunk>();
      for (const c of [...publicChunks, ...scopedChunks]) {
        dedup.set(c.id, c);
      }
      result = Array.from(dedup.values());
    }

    if (chunkCache.size >= MAX_CACHED_USERS) {
      const oldestKey = chunkCache.keys().next().value;
      if (oldestKey) chunkCache.delete(oldestKey);
    }
    chunkCache.set(cacheKey, {
      expiresAt: Date.now() + CHUNK_CACHE_TTL_MS,
      chunks: result,
    });

    return result;
  })();

  inFlightChunkQueries.set(cacheKey, queryPromise);
  try {
    return await queryPromise;
  } finally {
    inFlightChunkQueries.delete(cacheKey);
  }
}
