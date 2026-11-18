import { createPartFromUri, createUserContent, FileState, GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import {
  FOLLOW_UP_QUERY_REGEX,
  isDiagramRequest,
  isVisualRequest,
  NO_VISUAL_REPLY_REGEX,
  type SopVisualCatalogEntry,
} from '../src/lib/visualIntent.ts';
import type {
  AiSopDraft,
  CitationSource,
  ConflictType,
  Division,
  PrePublishConflictItem,
  PrePublishConflictReport,
  SopChunk,
  SopConflictItem,
  SopDocument,
  SopFeedbackRevisionResult,
} from '../src/types/sop.ts';

let cachedAiClient: GoogleGenAI | null = null;

function getAiClient(): GoogleGenAI {
  if (cachedAiClient) return cachedAiClient;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY belum dikonfigurasi pada server.');
  }
  cachedAiClient = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
  return cachedAiClient;
}

function parseAiJson<T>(rawText: string | undefined, contextLabel: string): T {
  const cleaned = (rawText ?? '{}')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned || '{}') as T;
  } catch {
    throw new Error(`Respons AI untuk ${contextLabel} tidak berbentuk JSON yang valid. Silakan coba lagi.`);
  }
}

const INDONESIAN_STOPWORDS = new Set([
  'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'pada', 'dengan', 'adalah', 'atau',
  'ini', 'itu', 'jika', 'bila', 'kalau', 'apa', 'siapa', 'berapa', 'bagaimana',
  'cara', 'mengapa', 'kenapa', 'kapan', 'dimana', 'mana', 'saya', 'kami', 'kita',
  'anda', 'mereka', 'harus', 'bisa', 'dapat', 'boleh', 'tidak', 'ya', 'ada',
  'oleh', 'sebagai', 'tentang', 'dalam', 'terhadap', 'atas', 'agar', 'supaya',
]);

export function tokenizeIndonesian(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !INDONESIAN_STOPWORDS.has(token));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

const EMBEDDING_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_EMBEDDING_CACHE = 250;
const queryEmbeddingCache = new Map<string, { expiresAt: number; values: number[] }>();

export async function embedText(text: string, useCache = false): Promise<number[]> {
  const cleanText = text.slice(0, 8000).trim();
  const cacheKey = useCache ? cleanText.toLowerCase() : '';
  if (useCache && cacheKey) {
    const cached = queryEmbeddingCache.get(cacheKey);
    if (cached && Date.now() <= cached.expiresAt) {
      return cached.values;
    }
    if (cached) queryEmbeddingCache.delete(cacheKey);
  }

  const ai = getAiClient();
  const result = await ai.models.embedContent({
    model: 'gemini-embedding-2',
    contents: cleanText,
  });
  const values = result.embeddings?.[0]?.values;
  if (!values || !Array.isArray(values)) {
    throw new Error('Gagal menghasilkan embedding vektor dari Gemini.');
  }

  if (useCache && cacheKey) {
    if (queryEmbeddingCache.size >= MAX_EMBEDDING_CACHE) {
      const oldestKey = queryEmbeddingCache.keys().next().value;
      if (oldestKey) queryEmbeddingCache.delete(oldestKey);
    }
    queryEmbeddingCache.set(cacheKey, {
      expiresAt: Date.now() + EMBEDDING_CACHE_TTL_MS,
      values,
    });
  }

  return values;
}

export interface LogicalChunkInput {
  id: string;
  sopId: string;
  docNumber: string;
  title: string;
  version: number;
  divisionId: string;
  divisionName: string;
  departmentName: string;
  sectionIndex: number;
  sectionTitle: string;
  content: string;
  keywords: string;
  status: 'Disetujui';
  accessLevel: SopDocument['accessLevel'];
  viewerUids: string[];
  ownerUid: string;
  ownerName: string;
}

export function buildLogicalChunks(sop: SopDocument): LogicalChunkInput[] {
  const chunks: LogicalChunkInput[] = [];
  const docNumber = (sop.docNumber || 'SOP').slice(0, 60);
  const title = (sop.title || 'SOP').slice(0, 240);
  const divisionName = (sop.divisionName || 'Umum').slice(0, 120);
  const departmentName = (sop.departmentName || 'Umum').slice(0, 120);
  const ownerUid = (sop.ownerUid || '').slice(0, 128);
  const ownerName = (sop.ownerName || '').slice(0, 120);
  const headerPrefix = `[${docNumber} v${sop.version}] ${title} (${divisionName} - ${departmentName})`;

  const overviewContent = [
    headerPrefix,
    `Tujuan: ${sop.purpose || '-'}`,
    `Ruang Lingkup: ${sop.scope || '-'}`,
    `Pemilik Proses: ${ownerName || 'Belum ditetapkan'}`,
    `Peran Terkait: ${sop.relatedRoles.length ? sop.relatedRoles.join(', ') : '-'}`,
    `Tanggal Berlaku: ${sop.effectiveDate || '-'} | Review Berikutnya: ${sop.nextReviewDate || '-'}`,
    sop.attachments.length
      ? `Formulir & Lampiran: ${sop.attachments.map((a) => a.name).join(', ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  chunks.push({
    id: `${sop.id}_v${sop.version}_sec0`,
    sopId: sop.id,
    docNumber,
    title,
    version: sop.version,
    divisionId: sop.divisionId,
    divisionName,
    departmentName,
    sectionIndex: 0,
    sectionTitle: 'Ringkasan, Tujuan & Peran Terkait',
    content: overviewContent.slice(0, 11500),
    keywords: tokenizeIndonesian(overviewContent).join(' ').slice(0, 11500),
    status: 'Disetujui',
    accessLevel: sop.accessLevel,
    viewerUids: sop.viewerUids,
    ownerUid,
    ownerName,
  });

  sop.sections.forEach((sec, idx) => {
    const imgSummary =
      sec.images && sec.images.length > 0
        ? `\n[Foto/Gambar Modul Tersedia (${sec.images.length}): ${sec.images
            .map((im) => {
              const cap = im.caption || sec.title;
              const ocr = (im.ocrText || '').trim();
              return ocr ? `${cap} (teks layar: ${ocr})` : cap;
            })
            .join('; ')}]`
        : '\n[Status Foto Modul: Belum ada foto yang diunggah pada bagian ini]';
    const sectionText = `${headerPrefix}\nBagian ${idx + 1}: ${sec.title}\n${sec.content}${imgSummary}`;
    chunks.push({
      id: `${sop.id}_v${sop.version}_sec${idx + 1}`,
      sopId: sop.id,
      docNumber,
      title,
      version: sop.version,
      divisionId: sop.divisionId,
      divisionName,
      departmentName,
      sectionIndex: idx + 1,
      sectionTitle: (sec.title || `Langkah ${idx + 1}`).slice(0, 240),
      content: sectionText.slice(0, 11500),
      keywords: tokenizeIndonesian(sectionText).join(' ').slice(0, 11500),
      status: 'Disetujui',
      accessLevel: sop.accessLevel,
      viewerUids: sop.viewerUids,
      ownerUid,
      ownerName,
    });
  });

  const attachmentTexts = sop.attachments
    .filter((a) => a.extractedText && a.extractedText.trim().length > 0)
    .map((a) => `Lampiran "${a.name}" (${a.fileType}):\n${a.extractedText}`)
    .join('\n\n');

  if (attachmentTexts.trim().length > 0) {
    const fullAtt = `${headerPrefix}\nLampiran & Formulir Terkait:\n${attachmentTexts}`;
    chunks.push({
      id: `${sop.id}_v${sop.version}_att`,
      sopId: sop.id,
      docNumber,
      title,
      version: sop.version,
      divisionId: sop.divisionId,
      divisionName,
      departmentName,
      sectionIndex: sop.sections.length + 1,
      sectionTitle: 'Lampiran & Formulir',
      content: fullAtt.slice(0, 11500),
      keywords: tokenizeIndonesian(fullAtt).join(' ').slice(0, 11500),
      status: 'Disetujui',
      accessLevel: sop.accessLevel,
      viewerUids: sop.viewerUids,
      ownerUid,
      ownerName,
    });
  }

  return chunks;
}

export async function embedSopLogicalChunks(sop: SopDocument): Promise<Omit<SopChunk, 'createdAt'>[]> {
  const drafts = buildLogicalChunks(sop);
  const embedded = await Promise.all(
    drafts.map(async (draft) => {
      const vector = await embedText(draft.content);
      return {
        ...draft,
        embedding: vector,
      };
    })
  );
  return embedded;
}

export interface HybridScoredChunk {
  chunk: SopChunk;
  semanticScore: number;
  lexicalScore: number;
  hybridScore: number;
}

export function rankChunksHybrid(
  queryText: string,
  queryEmbedding: number[],
  chunks: SopChunk[],
  topK = 8
): HybridScoredChunk[] {
  const queryTokens = tokenizeIndonesian(queryText);
  const queryLower = queryText.toLowerCase();

  const scored: HybridScoredChunk[] = chunks.map((chunk) => {
    const semanticScore = cosineSimilarity(queryEmbedding, chunk.embedding || []);
    const haystack = `${chunk.docNumber} ${chunk.title} ${chunk.sectionTitle} ${chunk.content}`.toLowerCase();

    let matchedTerms = 0;
    let totalHits = 0;
    for (const token of queryTokens) {
      if (haystack.includes(token)) {
        matchedTerms++;
        const matches = haystack.split(token).length - 1;
        totalHits += Math.min(matches, 4);
      }
    }

    const coverage = queryTokens.length > 0 ? matchedTerms / queryTokens.length : 0;
    const density = queryTokens.length > 0 ? Math.min(1, totalHits / (queryTokens.length * 2.5)) : 0;
    const docNumberBoost = chunk.docNumber && queryLower.includes(chunk.docNumber.toLowerCase()) ? 0.35 : 0;
    const lexicalScore = Math.min(1, coverage * 0.65 + density * 0.35 + docNumberBoost);

    const hybridScore = semanticScore * 0.65 + lexicalScore * 0.35;
    return { chunk, semanticScore, lexicalScore, hybridScore };
  });

  scored.sort((a, b) => b.hybridScore - a.hybridScore);
  return scored.slice(0, topK);
}

export interface RagAnswerResponse {
  answered: boolean;
  answerMarkdown: string;
  hasConflict: boolean;
  conflictSummary: string;
  suggestedContact: string;
  citations: CitationSource[];
  matchedSopIds: string[];
  showVisual?: boolean;
  visualType?: 'pdf_page' | 'diagram';
  visualPageNumbers?: number[];
}

export function buildRetrievalQuery(
  question: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): string {
  const lastUserMessages = history
    .filter((m) => m.role === 'user')
    .slice(-2)
    .map((m) => m.content);
  const wordCount = question.trim().split(/\s+/).length;
  return lastUserMessages.length > 0 && (wordCount <= 12 || FOLLOW_UP_QUERY_REGEX.test(question))
    ? `${lastUserMessages.join(' ')} ${question}`
    : question;
}

function buildEmptyChunksResponse(divisions: Division[]): RagAnswerResponse {
  const fallbackDiv = divisions[0];
  const contactText = fallbackDiv
    ? `Divisi ${fallbackDiv.name}${fallbackDiv.leadName ? ` (${fallbackDiv.leadName})` : ''}`
    : 'Admin Divisi atau Pemilik Proses terkait';
  return {
    answered: false,
    answerMarkdown: `Saya tidak menemukan ini di SOP yang ada.\n\nSaat ini belum ada dokumen SOP berstatus **Disetujui** yang dapat diakses sesuai hak akses akun Anda untuk menjawab pertanyaan ini. Anda dapat menghubungi **${contactText}** untuk konfirmasi prosedur resmi.`,
    hasConflict: false,
    conflictSummary: '',
    suggestedContact: contactText,
    citations: [],
    matchedSopIds: [],
    showVisual: false,
    visualPageNumbers: [],
  };
}

function formatVisualCatalogContext(
  topScored: HybridScoredChunk[],
  visualCatalog?: SopVisualCatalogEntry[]
): string {
  if (!visualCatalog || visualCatalog.length === 0) return '';
  const relevantSopIds = new Set(topScored.map((s) => s.chunk.sopId));
  const matchedEntries = visualCatalog.filter((entry) => relevantSopIds.has(entry.sopId));
  if (matchedEntries.length === 0) return '';

  const lines = matchedEntries.map((entry) => {
    const parts = [`- ${entry.docNumber} (${entry.title}):`];
    if (entry.sectionsWithImages.length > 0) {
      parts.push(
        `  * Bagian yang MEMILIKI Foto Modul (${entry.sectionsWithImages.length}):`
      );
      for (const s of entry.sectionsWithImages) {
        const ocrHint = s.ocrKeywords?.length ? ` | teks layar: ${s.ocrKeywords.join(', ')}` : '';
        parts.push(
          `    - Bagian ${s.order}: ${s.title}${s.captions.length ? ` [foto: ${s.captions.join(', ')}${ocrHint}]` : ''}`
        );
      }
    } else {
      parts.push('  * Bagian yang MEMILIKI Foto Modul: Belum ada');
    }
    if (entry.sectionsWithoutImages.length > 0) {
      parts.push(
        `  * Bagian yang BELUM memiliki Foto Modul: ${entry.sectionsWithoutImages
          .map((s) => `Bagian ${s.order} (${s.title})`)
          .join('; ')}`
      );
    }
    if (entry.pdfFigures.length > 0) {
      parts.push(
        `  * Gambar Halaman PDF Tersimpan: ${entry.pdfFigures
          .map((p) => `Hal. ${p.pageNumber} (${p.caption})`)
          .join('; ')}`
      );
    } else {
      parts.push('  * Gambar Halaman PDF Tersimpan: Belum ada');
    }
    return parts.join('\n');
  });

  return `INVENTARIS GAMBAR/FOTO ASLI YANG BENAR-BENAR TERSEDIA DI SOP SAAT INI:\n${lines.join('\n')}\n`;
}

function prepareRagContext(params: {
  question: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  accessibleChunks: SopChunk[];
  divisions: Division[];
  queryEmbedding: number[];
  retrievalQuery: string;
  visualCatalog?: SopVisualCatalogEntry[];
}): {
  topScored: HybridScoredChunk[];
  prompt: string;
  divisionDirectory: string;
} {
  const { question, history, accessibleChunks, divisions, queryEmbedding, retrievalQuery, visualCatalog } = params;
  const rawTop = rankChunksHybrid(retrievalQuery, queryEmbedding, accessibleChunks, 6);

  // Keep top 5 chunks (or 6 if a 6th chunk comes from a different SOP and still has solid relevance)
  const topScored = rawTop.slice(0, 5);
  if (rawTop[5]) {
    const seenSops = new Set(topScored.map((s) => s.chunk.sopId));
    if (!seenSops.has(rawTop[5].chunk.sopId) && rawTop[5].hybridScore >= 0.42) {
      topScored.push(rawTop[5]);
    }
  }

  const contextBlocks = topScored.map((item, i) => {
    const c = item.chunk;
    return [
      `--- KUTIPAN #${i + 1} ---`,
      `SOP ID: ${c.sopId} | Nomor: ${c.docNumber} | Judul: ${c.title} | Versi: v${c.version}`,
      `Divisi: ${c.divisionName} (${c.departmentName}) | Bagian: ${c.sectionTitle}`,
      `Owner: ${c.ownerName || 'Admin Divisi'} | Relevansi: ${item.hybridScore.toFixed(3)}`,
      `Isi:\n${c.content.slice(0, 3200)}`,
    ].join('\n');
  });

  const divisionDirectory = divisions
    .map((d) => `- ${d.name} (${d.code}): ${d.leadName || 'Admin Divisi'}`)
    .join('\n');

  const historyText = history
    .slice(-4)
    .map((m) => `${m.role === 'user' ? 'Karyawan' : 'SOP Brain'}: ${m.content.slice(0, 600)}`)
    .join('\n\n');

  const visualInventoryText = formatVisualCatalogContext(topScored, visualCatalog);

  const prompt = [
    historyText ? `RIWAYAT PERCAKAPAN SEBELUMNYA:\n${historyText}\n` : '',
    `PERTANYAAN KARYAWAN SAAT INI:\n${question}\n`,
    visualInventoryText,
    `DAFTAR DIVISI & PEMILIK PROSES:\n${divisionDirectory || '(Belum ada divisi)'}\n`,
    `KUTIPAN SOP BERSTATUS DISETUJUI YANG BOLEH DIAKSES PENANYA:\n${contextBlocks.join('\n\n')}`,
  ]
    .filter(Boolean)
    .join('\n');

  return { topScored, prompt, divisionDirectory };
}

function finalizeRagResponse(
  parsed: {
    answered?: boolean;
    answerMarkdown?: string;
    hasConflict?: boolean;
    conflictSummary?: string;
    suggestedContact?: string;
    citedSources?: Partial<CitationSource>[];
    showVisual?: boolean;
    visualType?: string;
    visualPageNumbers?: unknown[];
  },
  topScored: HybridScoredChunk[],
  question?: string
): RagAnswerResponse {
  const allowedChunkMap = new Map(topScored.map((s) => [s.chunk.sopId, s.chunk]));
  const docNumberMap = new Map(
    topScored.map((s) => [s.chunk.docNumber.toLowerCase(), s.chunk])
  );
  const verifiedCitations: CitationSource[] = [];
  const seenKeys = new Set<string>();

  for (const src of parsed.citedSources || []) {
    const matched =
      (src.sopId && allowedChunkMap.get(src.sopId)) ||
      (src.docNumber && docNumberMap.get(src.docNumber.toLowerCase()));
    if (matched) {
      const sectionTitle = src.sectionTitle || matched.sectionTitle;
      const key = `${matched.sopId}::${sectionTitle}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        verifiedCitations.push({
          sopId: matched.sopId,
          docNumber: matched.docNumber,
          title: matched.title,
          version: matched.version,
          sectionTitle,
          divisionName: matched.divisionName,
        });
      }
    }
  }

  // Fallback citation matching if answered=true but citedSources omitted
  const answerText = (parsed.answerMarkdown || '').trim();
  const answerLower = answerText.toLowerCase();
  const isNotFoundReply = answerLower.startsWith('saya tidak menemukan ini di sop yang ada');
  if (parsed.answered && !isNotFoundReply && verifiedCitations.length === 0 && answerText) {
    for (const item of topScored) {
      const hasDocMatch =
        item.chunk.docNumber && answerLower.includes(item.chunk.docNumber.toLowerCase());
      const hasTitleMatch =
        item.chunk.title &&
        item.chunk.title.length > 6 &&
        answerLower.includes(item.chunk.title.toLowerCase());
      const hasSectionMatch =
        item.chunk.sectionTitle &&
        item.chunk.sectionTitle.length > 6 &&
        answerLower.includes(item.chunk.sectionTitle.toLowerCase());
      if (hasDocMatch || hasTitleMatch || hasSectionMatch) {
        const key = `${item.chunk.sopId}::${item.chunk.sectionTitle}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          verifiedCitations.push({
            sopId: item.chunk.sopId,
            docNumber: item.chunk.docNumber,
            title: item.chunk.title,
            version: item.chunk.version,
            sectionTitle: item.chunk.sectionTitle,
            divisionName: item.chunk.divisionName,
          });
        }
      }
    }
    if (verifiedCitations.length === 0 && topScored[0] && topScored[0].hybridScore >= 0.28) {
      const topChunk = topScored[0].chunk;
      verifiedCitations.push({
        sopId: topChunk.sopId,
        docNumber: topChunk.docNumber,
        title: topChunk.title,
        version: topChunk.version,
        sectionTitle: topChunk.sectionTitle,
        divisionName: topChunk.divisionName,
      });
    }
  }

  const answered = Boolean(parsed.answered) && verifiedCitations.length > 0;
  const fallbackOwner = topScored[0]?.chunk
    ? `Divisi ${topScored[0].chunk.divisionName} (Pemilik SOP: ${topScored[0].chunk.ownerName || 'Admin Divisi'})`
    : 'Admin Divisi terkait';

  const isNoVisualMessage = NO_VISUAL_REPLY_REGEX.test(answerText);
  const asksForDiagram = isDiagramRequest(question || '');
  const asksForVisual =
    !isNoVisualMessage &&
    (parsed.showVisual === true ||
      asksForDiagram ||
      (parsed.showVisual === undefined && isVisualRequest(question || '')));

  const rawPages = Array.isArray(parsed.visualPageNumbers)
    ? parsed.visualPageNumbers
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n > 0)
    : [];

  // Fallback: extract explicit page numbers mentioned in answerText if visualPageNumbers was empty
  const extractedPages: number[] = [];
  if (rawPages.length === 0 && asksForVisual && answerText) {
    for (const match of answerText.matchAll(/(?:halaman|hal\.?)\s*(\d+)/gi)) {
      const p = Number(match[1]);
      if (Number.isInteger(p) && p > 0 && !extractedPages.includes(p)) {
        extractedPages.push(p);
      }
    }
  }

  const visualPageNumbers = (rawPages.length > 0 ? rawPages : extractedPages).slice(0, 3);
  const visualType: 'pdf_page' | 'diagram' =
    parsed.visualType === 'diagram' || asksForDiagram ? 'diagram' : 'pdf_page';

  return {
    answered,
    answerMarkdown:
      answerText ||
      (answered ? '' : `Saya tidak menemukan ini di SOP yang ada.\n\nSilakan hubungi **${fallbackOwner}** untuk informasi lebih lanjut.`),
    hasConflict: Boolean(parsed.hasConflict),
    conflictSummary: parsed.conflictSummary || '',
    suggestedContact: parsed.suggestedContact || fallbackOwner,
    citations: answered ? verifiedCitations : [],
    matchedSopIds: Array.from(new Set(verifiedCitations.map((c) => c.sopId))),
    showVisual: answered && asksForVisual,
    visualType,
    visualPageNumbers,
  };
}

const RAG_BASE_SYSTEM_RULES = `Kamu adalah "SOP Brain", asisten AI resmi perusahaan untuk tanya-jawab Standard Operating Procedure (SOP) dalam Bahasa Indonesia.

ATURAN MUTLAK (TIDAK BOLEH DILANGGAR):
1. Jawab HANYA berdasarkan KUTIPAN SOP yang diberikan di konteks. DILARANG KERAS mengarang, menebak, atau memakai pengetahuan umum di luar kutipan SOP.
2. FOKUS & BERHENTI TEPAT DI JAWABAN (STOP):
   - Jawab HANYA topik atau proses spesifik yang ditanyakan pengguna saat ini, lalu BERHENTI (STOP).
   - DILARANG menambahkan paragraf "Sebagai informasi tambahan...", jangan menjelaskan bagian/modul/menu lain yang tidak ditanyakan (misalnya jika user hanya tanya "cara pembuatan user", jelaskan langkah pembuatan user saja lalu BERHENTI — JANGAN ikut menjelaskan Role User, hak akses, atau bagian lain di SOP kecuali user menanyakannya nanti).
3. IKUTI ALUR PERCAKAPAN (FOLLOW-UP):
   - Jika pertanyaan saat ini adalah kelanjutan dari percakapan sebelumnya (misal: "contoh gambar menunya mana", "langkah berikutnya", "lanjutannya apa"), ikuti konteks topik yang sedang dibahas di RIWAYAT PERCAKAPAN SEBELUMNYA.
4. PERMINTAAN GAMBAR / FOTO MODUL / CONTOH MENU / SCREENSHOT / DIAGRAM:
   - Aplikasi SOP Brain secara OTOMATIS menampilkan gambar/foto modul, tangkapan layar PDF, atau infografis alur di bawah jawabanmu HANYA jika "showVisual": true.
   - WAJIB periksa daftar INVENTARIS GAMBAR/FOTO ASLI YANG BENAR-BENAR TERSEDIA DI SOP SAAT INI (atau tanda [Foto/Gambar Modul Tersedia ...] pada kutipan) sebelum menjawab permintaan gambar/foto/contoh menu/screenshot:
     * JIKA gambar/foto modul atau gambar halaman PDF yang SESUAI dengan bagian/proses yang ditanyakan BENAR-BENAR ADA di inventaris:
       - Set "answered": true dan cantumkan "citedSources" HANYA untuk bagian yang sesuai tersebut.
       - Jawab singkat (1-2 kalimat) merujuk pada menu/proses yang diminta saja.
       - Set "showVisual": true, "visualType": "pdf_page", dan isi "visualPageNumbers" jika menggunakan halaman PDF (atau [] jika menggunakan foto modul).
     * JIKA bagian/menu yang diminta BELUM MEMILIKI foto modul maupun gambar PDF di inventaris (misalnya bagian yang ditanya adalah Administrasi User/Bagian 3 yang belum punya foto, walaupun bagian lain seperti Role User/Bagian 4 sudah punya foto):
       - DILARANG KERAS menampilkan gambar dari bagian lain sebagai pengganti!
       - DILARANG menulis kalimat seolah-olah gambarnya ada/ditampilkan (jangan menulis "Berikut adalah tampilan screenshot...").
       - Sampaikan dengan jujur dan sopan: "Belum ada gambar atau tangkapan layar yang tersimpan untuk bagian [Nama Bagian/Menu] pada [Nomor SOP]." (dan boleh sebutkan bahwa Admin dapat mengunggah foto modul melalui menu Edit SOP).
       - Set "showVisual": false, "visualPageNumbers": [], "answered": true (dengan "citedSources" bagian yang ditanyakan).
     * JIKA pengguna secara eksplisit meminta dibuatkan diagram alur / flowchart / bagan / infografis prosedurnya:
       - Set "showVisual": true dan "visualType": "diagram".
   - Jika pengguna TIDAK meminta gambar/visual dalam pertanyaannya, set "showVisual": false dan "visualPageNumbers": [].
5. Jika kutipan yang tersedia TIDAK menjawab pertanyaan dengan cukup jelas dan eksplisit:
   - Set "answered": false.
   - Awali jawaban dengan kalimat persis: "Saya tidak menemukan ini di SOP yang ada."
   - Sarankan siapa atau divisi mana yang sebaiknya dihubungi berdasarkan daftar divisi dan pemilik SOP terdekat.
   - Kosongkan "citedSources" menjadi [].
6. Jika pertanyaan prosedural, sajikan langkah-langkah secara ringkas, bernomor (1, 2, 3...) dengan format jelas (misal: "1. **Nama Langkah:** Penjelasan...").
7. Sebutkan sumber SOP secara ringkas (nomor SOP, judul, versi, bagian, dan halaman jika ada) dan hanya mengutip SOP ID yang benar-benar ada di KUTIPAN SOP.
8. DETEKSI KONFLIK: Jika ada DUA atau lebih SOP dalam kutipan yang memiliki aturan, angka batas, atau prosedur yang SALING BERTENTANGAN untuk hal yang sama, set "hasConflict": true, jelaskan kedua versi aturan beserta nomor SOP masing-masing di jawaban dan "conflictSummary", dan ingatkan karyawan untuk mengonfirmasi ke Pemilik Proses/Admin Divisi.`;

export async function generateGroundedSopAnswer(params: {
  question: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  accessibleChunks: SopChunk[];
  divisions: Division[];
  precomputedEmbedding?: number[];
  visualCatalog?: SopVisualCatalogEntry[];
}): Promise<RagAnswerResponse> {
  const { question, history, accessibleChunks, divisions, precomputedEmbedding, visualCatalog } = params;

  if (accessibleChunks.length === 0) {
    return buildEmptyChunksResponse(divisions);
  }

  const retrievalQuery = buildRetrievalQuery(question, history);
  const queryEmbedding = precomputedEmbedding || (await embedText(retrievalQuery, true));
  const { topScored, prompt } = prepareRagContext({
    question,
    history,
    accessibleChunks,
    divisions,
    queryEmbedding,
    retrievalQuery,
    visualCatalog,
  });

  const ai = getAiClient();
  const response = await ai.models.generateContent({
    model: 'gemini-3.1-flash-lite',
    contents: prompt,
    config: {
      systemInstruction: RAG_BASE_SYSTEM_RULES,
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          answered: {
            type: Type.BOOLEAN,
            description: 'true jika jawaban ditemukan secara eksplisit dalam kutipan SOP; false jika tidak ditemukan.',
          },
          answerMarkdown: {
            type: Type.STRING,
            description: 'Jawaban terstruktur dalam Markdown Bahasa Indonesia.',
          },
          hasConflict: {
            type: Type.BOOLEAN,
            description: 'true jika terdapat dua SOP dengan ketentuan bertentangan.',
          },
          conflictSummary: {
            type: Type.STRING,
            description: 'Ringkasan konflik antar SOP jika hasConflict=true, kosong jika false.',
          },
          suggestedContact: {
            type: Type.STRING,
            description: 'Saran divisi/owner yang bisa dihubungi jika tidak ditemukan atau ada konflik.',
          },
          citedSources: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                sopId: { type: Type.STRING },
                docNumber: { type: Type.STRING },
                title: { type: Type.STRING },
                version: { type: Type.INTEGER },
                sectionTitle: { type: Type.STRING },
                divisionName: { type: Type.STRING },
              },
              required: ['sopId', 'docNumber', 'title', 'version', 'sectionTitle', 'divisionName'],
            },
          },
          showVisual: {
            type: Type.BOOLEAN,
            description: 'true hanya jika pengguna meminta gambar, contoh menu, screenshot, atau diagram.',
          },
          visualType: {
            type: Type.STRING,
            description: 'pdf_page atau diagram',
          },
          visualPageNumbers: {
            type: Type.ARRAY,
            items: { type: Type.INTEGER },
            description: 'Nomor halaman PDF spesifik yang relevan dengan permintaan gambar saat ini saja.',
          },
        },
        required: ['answered', 'answerMarkdown', 'hasConflict', 'conflictSummary', 'suggestedContact', 'citedSources'],
      },
    },
  });

  const parsed = parseAiJson<{
    answered?: boolean;
    answerMarkdown?: string;
    hasConflict?: boolean;
    conflictSummary?: string;
    suggestedContact?: string;
    citedSources?: CitationSource[];
    showVisual?: boolean;
    visualType?: string;
    visualPageNumbers?: number[];
  }>(response.text, 'jawaban Q&A');

  return finalizeRagResponse(parsed, topScored, question);
}

const STREAM_META_START = '<<<SOP_META>>>';
const STREAM_META_END = '<<<END_META>>>';

export async function streamGroundedSopAnswer(params: {
  question: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  accessibleChunks: SopChunk[];
  divisions: Division[];
  precomputedEmbedding?: number[];
  visualCatalog?: SopVisualCatalogEntry[];
  onDelta: (textChunk: string) => void;
}): Promise<RagAnswerResponse> {
  const { question, history, accessibleChunks, divisions, precomputedEmbedding, visualCatalog, onDelta } = params;

  if (accessibleChunks.length === 0) {
    const emptyRes = buildEmptyChunksResponse(divisions);
    onDelta(emptyRes.answerMarkdown);
    return emptyRes;
  }

  const retrievalQuery = buildRetrievalQuery(question, history);
  const queryEmbedding = precomputedEmbedding || (await embedText(retrievalQuery, true));
  const { topScored, prompt } = prepareRagContext({
    question,
    history,
    accessibleChunks,
    divisions,
    queryEmbedding,
    retrievalQuery,
    visualCatalog,
  });

  const streamInstruction = `${RAG_BASE_SYSTEM_RULES}

FORMAT OUTPUT WAJIB:
1. Tulis terlebih dahulu jawaban Markdown yang ringkas, langsung ke inti, dan berhenti tepat setelah menjawab pertanyaan (TANPA pembungkus JSON atau blok kode).
2. Tepat di baris baru setelah jawaban selesai, tambahkan blok metadata persis dengan format berikut:
${STREAM_META_START}
{"answered":true,"hasConflict":false,"conflictSummary":"","suggestedContact":"","showVisual":false,"visualType":"pdf_page","visualPageNumbers":[],"citedSources":[{"sopId":"...","docNumber":"...","title":"...","version":1,"sectionTitle":"...","divisionName":"..."}]}
${STREAM_META_END}
Pastikan JSON di dalam blok ${STREAM_META_START} valid dalam satu baris dan hanya menyertakan sopId yang benar-benar ada di KUTIPAN SOP. Set "showVisual": true dan isi "visualPageNumbers" HANYA jika pengguna meminta contoh gambar/menu/screenshot/diagram.`;

  const ai = getAiClient();

  let emittedAny = false;
  const trackedOnDelta = (chunk: string) => {
    emittedAny = true;
    onDelta(chunk);
  };

  const runModelStream = async (model: string, thinkingLevel: ThinkingLevel) => {
    let fullRaw = '';
    let emittedLen = 0;

    const stream = await ai.models.generateContentStream({
      model,
      contents: prompt,
      config: {
        systemInstruction: streamInstruction,
        thinkingConfig: { thinkingLevel },
      },
    });

    for await (const chunk of stream) {
      const piece = chunk.text || '';
      if (!piece) continue;
      fullRaw += piece;

      const markerIdx = fullRaw.indexOf(STREAM_META_START);
      if (markerIdx !== -1) {
        if (emittedLen < markerIdx) {
          const toEmit = fullRaw.slice(emittedLen, markerIdx);
          if (toEmit) trackedOnDelta(toEmit);
          emittedLen = markerIdx;
        }
      } else {
        const safeEnd = Math.max(emittedLen, fullRaw.length - STREAM_META_START.length);
        if (safeEnd > emittedLen) {
          const toEmit = fullRaw.slice(emittedLen, safeEnd);
          if (toEmit) trackedOnDelta(toEmit);
          emittedLen = safeEnd;
        }
      }
    }

    const markerIdx = fullRaw.indexOf(STREAM_META_START);
    let answerMarkdown = '';
    let parsedMeta: {
      answered?: boolean;
      hasConflict?: boolean;
      conflictSummary?: string;
      suggestedContact?: string;
      citedSources?: Partial<CitationSource>[];
      showVisual?: boolean;
      visualType?: string;
      visualPageNumbers?: unknown[];
    } | null = null;

    if (markerIdx !== -1) {
      answerMarkdown = fullRaw.slice(0, markerIdx).trimEnd();
      const tailRaw = fullRaw.slice(markerIdx + STREAM_META_START.length);
      const endIdx = tailRaw.indexOf(STREAM_META_END);
      const jsonBody = (endIdx !== -1 ? tailRaw.slice(0, endIdx) : tailRaw)
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      try {
        parsedMeta = JSON.parse(jsonBody);
      } catch {
        parsedMeta = null;
      }
    } else {
      // Flush held-back tail if model omitted the marker
      if (emittedLen < fullRaw.length) {
        trackedOnDelta(fullRaw.slice(emittedLen));
      }
      answerMarkdown = fullRaw.trim();
    }

    if (!parsedMeta) {
      const notFound = answerMarkdown.toLowerCase().startsWith('saya tidak menemukan ini di sop yang ada');
      const answerLower = answerMarkdown.toLowerCase();
      const inferredCitations: Partial<CitationSource>[] = [];
      for (const item of topScored) {
        const matchedDoc = item.chunk.docNumber && answerLower.includes(item.chunk.docNumber.toLowerCase());
        const matchedTitle = item.chunk.title && answerLower.includes(item.chunk.title.toLowerCase());
        if (matchedDoc || matchedTitle) {
          inferredCitations.push({
            sopId: item.chunk.sopId,
            docNumber: item.chunk.docNumber,
            title: item.chunk.title,
            version: item.chunk.version,
            sectionTitle: item.chunk.sectionTitle,
            divisionName: item.chunk.divisionName,
          });
        }
      }
      if (!notFound && inferredCitations.length === 0 && topScored[0] && topScored[0].hybridScore >= 0.3) {
        inferredCitations.push({
          sopId: topScored[0].chunk.sopId,
          docNumber: topScored[0].chunk.docNumber,
          title: topScored[0].chunk.title,
          version: topScored[0].chunk.version,
          sectionTitle: topScored[0].chunk.sectionTitle,
          divisionName: topScored[0].chunk.divisionName,
        });
      }
      parsedMeta = {
        answered: !notFound && inferredCitations.length > 0,
        hasConflict: false,
        conflictSummary: '',
        suggestedContact: '',
        citedSources: inferredCitations,
      };
    }

    return finalizeRagResponse(
      {
        ...parsedMeta,
        answerMarkdown,
      },
      topScored,
      question
    );
  };

  try {
    return await runModelStream('gemini-3.1-flash-lite', ThinkingLevel.MINIMAL);
  } catch (err) {
    if (emittedAny) {
      throw err;
    }
    // Fallback to gemini-4-hydrogen only if primary stream errored before emitting anything
    console.warn('Primary flash-lite Q&A stream failed before first token, retrying with gemini-4-hydrogen:', err);
    return await runModelStream('gemini-4-hydrogen', ThinkingLevel.LOW);
  }
}

const INLINE_MEDIA_MAX_BYTES = 7 * 1024 * 1024;

async function runWithUploadedOrInlineFile<T>(params: {
  fileBase64?: string;
  mimeType?: string;
  fileName?: string;
  textPrompt: string;
  execute: (contents: Parameters<GoogleGenAI['models']['generateContent']>[0]['contents']) => Promise<T>;
}): Promise<T> {
  const ai = getAiClient();
  if (!params.fileBase64 || !params.mimeType) {
    return params.execute(params.textPrompt);
  }

  const fileBuffer = Buffer.from(params.fileBase64, 'base64');
  if (fileBuffer.byteLength <= INLINE_MEDIA_MAX_BYTES) {
    return params.execute({
      parts: [
        { inlineData: { mimeType: params.mimeType, data: params.fileBase64 } },
        { text: params.textPrompt },
      ],
    });
  }

  // Use Gemini Files API for larger image-heavy PDFs (> 7 MB)
  const blob = new Blob([fileBuffer], { type: params.mimeType });
  const uploaded = await ai.files.upload({
    file: blob,
    config: {
      mimeType: params.mimeType,
      displayName: params.fileName || 'sop-document.pdf',
    },
  });

  try {
    let fileMeta = uploaded;
    const deadline = Date.now() + 25_000;
    while (fileMeta.state === FileState.PROCESSING && Date.now() < deadline && fileMeta.name) {
      await new Promise((r) => setTimeout(r, 1200));
      fileMeta = await ai.files.get({ name: fileMeta.name });
    }
    if (fileMeta.state === FileState.FAILED || !fileMeta.uri) {
      throw new Error('Gagal memproses file PDF berukuran besar pada layanan AI.');
    }
    const content = createUserContent([
      createPartFromUri(fileMeta.uri, fileMeta.mimeType || params.mimeType),
      params.textPrompt,
    ]);
    return await params.execute(content);
  } finally {
    if (uploaded.name) {
      await ai.files.delete({ name: uploaded.name }).catch(() => {});
    }
  }
}

export async function summarizeVisualPdfAttachment(params: {
  fileBase64: string;
  mimeType: string;
  fileName: string;
}): Promise<string> {
  const ai = getAiClient();
  const prompt = `Baca seluruh halaman PDF "${params.fileName}" secara menyeluruh termasuk teks, hasil scan (OCR), tabel, diagram alur, dan screenshot aplikasi/UI.
Buat ringkasan terstruktur per halaman (Halaman 1, Halaman 2, dst.) dalam Bahasa Indonesia yang memuat semua langkah kerja, nama menu/tombol, form, dan keterangan gambar penting.`;

  const response = await runWithUploadedOrInlineFile({
    fileBase64: params.fileBase64,
    mimeType: params.mimeType,
    fileName: params.fileName,
    textPrompt: prompt,
    execute: (contents) =>
      ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        },
      }),
  });

  return (response.text || '').trim().slice(0, 6000);
}

export async function structureSopWithAi(params: {
  rawText?: string;
  fileBase64?: string;
  mimeType?: string;
  fileName?: string;
  titleHint?: string;
  divisionHint?: string;
  divisions: Division[];
}): Promise<AiSopDraft> {
  const ai = getAiClient();
  const divisionNames = params.divisions.map((d) => `${d.name} (${d.code})`).join(', ');
  const isPdf = params.mimeType === 'application/pdf';

  const systemInstruction = `Kamu adalah arsitek dokumentasi SOP perusahaan profesional berbahasa Indonesia dengan kemampuan membaca dokumen multimodal (teks, tabel, diagram alur, screenshot aplikasi, dan gambar hasil scan/OCR).
Tugasmu adalah mengekstrak, merapikan, atau menyusun dokumen menjadi struktur SOP standar perusahaan yang rapi, lengkap, operasional, dan mudah dipahami karyawan.

Pedoman:
- Gunakan Bahasa Indonesia formal yang jelas, aktif, dan prosedural.
- Jika dokumen berupa PDF yang berisi GAMBAR, SCREENSHOT SISTEM/ERP, DIAGRAM ALUR (FLOWCHART), atau HALAMAN SCAN:
  1. Lakukan pembacaan visual & OCR menyeluruh pada setiap halaman dan setiap gambar.
  2. Terjemahkan informasi visual (nama menu, tombol, kolom input, alur panah, catatan pada gambar, dan ilustrasi langkah) menjadi langkah-langkah kerja eksplisit di dalam "sections" dengan referensi halaman bila relevan (misal: "[Halaman 2]").
  3. Di field "attachmentSummary", tuliskan ringkasan terperinci isi visual/gambar per halaman agar tetap dapat dicari oleh mesin tanya-jawab SOP.
- Pecah langkah kerja menjadi bagian-bagian logis ("sections") dengan judul bagian yang deskriptif (misal: "1. Persiapan & Persyaratan", "2. Pengajuan di Sistem", "3. Persetujuan Berjenjang", "4. Pencairan / Tindak Lanjut").
- Pastikan "suggestedDivisionName" dipilih dari daftar divisi yang tersedia jika cocok: [${divisionNames}].
- Buat nomor dokumen standar jika belum ada (contoh: SOP-FIN-010).`;

  const textPrompt = [
    params.fileName ? `Nama File Sumber: ${params.fileName}` : '',
    params.titleHint ? `Petunjuk Judul / Konteks: ${params.titleHint}` : '',
    params.divisionHint ? `Petunjuk Divisi: ${params.divisionHint}` : '',
    params.rawText
      ? `ISI DOKUMEN / CATATAN KASAR:\n${params.rawText.slice(0, 35000)}`
      : isPdf
        ? 'Ekstrak seluruh isi PDF terlampir secara menyeluruh, termasuk semua gambar, screenshot aplikasi, diagram alur, tabel, dan teks hasil scan (OCR) di setiap halaman menjadi SOP terstruktur.'
        : 'Ekstrak isi dokumen terlampir menjadi SOP terstruktur.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const response = await runWithUploadedOrInlineFile({
    fileBase64: params.fileBase64,
    mimeType: params.mimeType,
    fileName: params.fileName,
    textPrompt,
    execute: (contents) =>
      ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents,
        config: {
          systemInstruction,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              docNumber: { type: Type.STRING },
              suggestedDivisionName: { type: Type.STRING },
              suggestedDepartmentName: { type: Type.STRING },
              purpose: { type: Type.STRING },
              scope: { type: Type.STRING },
              relatedRoles: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              sections: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    content: { type: Type.STRING },
                  },
                  required: ['title', 'content'],
                },
              },
              attachmentSummary: { type: Type.STRING },
            },
            required: [
              'title',
              'docNumber',
              'suggestedDivisionName',
              'suggestedDepartmentName',
              'purpose',
              'scope',
              'relatedRoles',
              'sections',
              'attachmentSummary',
            ],
          },
        },
      }),
  });

  const parsed = parseAiJson<Partial<AiSopDraft>>(response.text, 'ekstraksi SOP');
  return {
    title: parsed.title || params.titleHint || 'SOP Baru',
    docNumber: parsed.docNumber || 'SOP-GEN-001',
    suggestedDivisionName: parsed.suggestedDivisionName || params.divisionHint || '',
    suggestedDepartmentName: parsed.suggestedDepartmentName || '',
    purpose: parsed.purpose || '',
    scope: parsed.scope || '',
    relatedRoles: Array.isArray(parsed.relatedRoles) ? parsed.relatedRoles : [],
    sections:
      Array.isArray(parsed.sections) && parsed.sections.length > 0
        ? parsed.sections
        : [{ title: '1. Prosedur Pelaksanaan', content: params.rawText || parsed.attachmentSummary || '' }],
    attachmentSummary: parsed.attachmentSummary || '',
  };
}

function normalizeConflictType(raw?: string): ConflictType {
  const lower = (raw || '').toLowerCase();
  if (lower.includes('duplik')) return 'Duplikasi';
  if (lower.includes('tumpang') || lower.includes('pic') || lower.includes('wewenang')) {
    return 'Tumpang Tindih PIC';
  }
  return 'Konflik Aturan';
}

function normalizeSeverity(raw?: string): 'Tinggi' | 'Sedang' | 'Rendah' {
  const lower = (raw || '').toLowerCase();
  if (lower.includes('tinggi') || lower.includes('high')) return 'Tinggi';
  if (lower.includes('rendah') || lower.includes('low')) return 'Rendah';
  return 'Sedang';
}

function buildSopDigest(s: SopDocument, maxSectionChars = 900): string {
  const sectionsText = s.sections
    .map((sec) => `  - ${sec.title}: ${sec.content.slice(0, maxSectionChars)}`)
    .join('\n');
  return [
    `SOP ID: ${s.id}`,
    `Nomor: ${s.docNumber} | Judul: ${s.title} | Divisi: ${s.divisionName} | v${s.version}`,
    `Owner: ${s.ownerName || '-'} | Peran: ${(s.relatedRoles || []).join(', ') || '-'}`,
    `Tujuan: ${s.purpose.slice(0, 400)}`,
    `Isi:\n${sectionsText}`,
  ].join('\n');
}

function rankRelatedApprovedSops(candidate: SopDocument, pool: SopDocument[], limit = 14): SopDocument[] {
  const candText = [
    candidate.title,
    candidate.purpose,
    candidate.scope,
    ...(candidate.relatedRoles || []),
    ...candidate.sections.map((s) => `${s.title} ${s.content}`),
  ].join(' ');
  const candTokens = new Set(tokenizeIndonesian(candText));

  const scored = pool
    .filter((s) => s.id !== candidate.id)
    .map((other) => {
      const otherText = [
        other.title,
        other.purpose,
        other.scope,
        ...(other.relatedRoles || []),
        ...other.sections.map((s) => `${s.title} ${s.content}`),
      ].join(' ');
      const otherTokens = tokenizeIndonesian(otherText);
      let overlap = 0;
      const seen = new Set<string>();
      for (const tok of otherTokens) {
        if (candTokens.has(tok) && !seen.has(tok)) {
          seen.add(tok);
          overlap += 1;
        }
      }
      const sameDivBonus = other.divisionId && other.divisionId === candidate.divisionId ? 4 : 0;
      const score = overlap + sameDivBonus;
      return { sop: other, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((item) => item.sop);
}

export async function detectSopConflictsWithAi(
  sops: SopDocument[]
): Promise<{ conflicts: SopConflictItem[]; summary: string }> {
  const approvedSops = sops.filter((s) => s.status === 'Disetujui');
  if (approvedSops.length < 2) {
    return {
      conflicts: [],
      summary: 'Minimal dibutuhkan 2 SOP berstatus Disetujui untuk memindai konflik antar dokumen.',
    };
  }

  // Scalable batching: if <= 25 SOPs inspect all together; if > 25, partition into overlapping batches
  // plus top cross-division high-risk pairs (financial/approval/HR/IT policies) so no SOP is skipped.
  const batches: SopDocument[][] = [];
  if (approvedSops.length <= 25) {
    batches.push(approvedSops);
  } else {
    const batchSize = 20;
    for (let i = 0; i < approvedSops.length; i += 14) {
      const slice = approvedSops.slice(i, i + batchSize);
      if (slice.length >= 2) batches.push(slice);
      if (i + batchSize >= approvedSops.length) break;
    }
  }

  const ai = getAiClient();
  const validIds = new Set(approvedSops.map((s) => s.id));
  const allConflicts: SopConflictItem[] = [];
  const seenPairs = new Set<string>();
  const batchSummaries: string[] = [];

  for (const batch of batches.slice(0, 4)) {
    const digest = batch
      .map((s) => buildSopDigest(s, batch.length > 15 ? 600 : 1000))
      .join('\n\n====================\n\n');

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Analisis daftar SOP berstatus Disetujui berikut ini untuk menemukan apakah ada KONFLIK kebijakan/angka batas/plafon/SLA, DUPLIKASI prosedur serupa, atau TUMPANG TINDIH tanggung jawab PIC antar SOP.\n\nJika tidak ada masalah nyata, kembalikan array conflicts kosong []. Jangan mengada-ada konflik jika memang selaras.\n\nDAFTAR SOP:\n${digest}`,
      config: {
        systemInstruction:
          'Kamu adalah auditor tata kelola SOP perusahaan. Gunakan Bahasa Indonesia formal dan objektif. Hanya laporkan konflik, duplikasi, atau tumpang tindih nyata antar dua SOP berbeda yang ID-nya benar-benar ada di input.',
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            conflicts: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  sopAId: { type: Type.STRING },
                  sopADocNumber: { type: Type.STRING },
                  sopATitle: { type: Type.STRING },
                  sopBId: { type: Type.STRING },
                  sopBDocNumber: { type: Type.STRING },
                  sopBTitle: { type: Type.STRING },
                  conflictType: {
                    type: Type.STRING,
                    description: 'Konflik Aturan, Duplikasi, atau Tumpang Tindih PIC',
                  },
                  severity: {
                    type: Type.STRING,
                    description: 'Tinggi, Sedang, atau Rendah',
                  },
                  description: { type: Type.STRING },
                  recommendation: { type: Type.STRING },
                },
                required: [
                  'sopAId',
                  'sopADocNumber',
                  'sopATitle',
                  'sopBId',
                  'sopBDocNumber',
                  'sopBTitle',
                  'conflictType',
                  'severity',
                  'description',
                  'recommendation',
                ],
              },
            },
          },
          required: ['summary', 'conflicts'],
        },
      },
    });

    const parsed = parseAiJson<{
      summary?: string;
      conflicts?: SopConflictItem[];
    }>(response.text, 'pemindaian konflik SOP');

    if (parsed.summary) batchSummaries.push(parsed.summary);

    for (const c of parsed.conflicts || []) {
      if (!validIds.has(c.sopAId) || !validIds.has(c.sopBId) || c.sopAId === c.sopBId) continue;
      const pairKey = [c.sopAId, c.sopBId].sort().join('::');
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      allConflicts.push({
        ...c,
        conflictType: normalizeConflictType(c.conflictType),
        severity: normalizeSeverity(c.severity),
      });
    }
  }

  return {
    conflicts: allConflicts,
    summary:
      allConflicts.length === 0
        ? `Pemindaian selesai pada ${approvedSops.length} SOP Disetujui. Tidak ditemukan konflik aturan, duplikasi, atau tumpang tindih PIC.`
        : batchSummaries[0] ||
          `Ditemukan ${allConflicts.length} potensi konflik atau duplikasi pada ${approvedSops.length} SOP Disetujui.`,
  };
}

export async function checkPrePublishConflictsWithAi(params: {
  candidateSop: SopDocument;
  existingApprovedSops: SopDocument[];
}): Promise<PrePublishConflictReport> {
  const approvedOthers = params.existingApprovedSops.filter(
    (s) => s.status === 'Disetujui' && s.id !== params.candidateSop.id
  );

  if (approvedOthers.length === 0) {
    return {
      hasIssues: false,
      checkedCount: 0,
      summary: 'Belum ada SOP Disetujui lain untuk dibandingkan.',
      conflicts: [],
    };
  }

  const relatedSops = rankRelatedApprovedSops(params.candidateSop, approvedOthers, 14);
  const candidateDigest = buildSopDigest(params.candidateSop, 1200);
  const existingDigest = relatedSops
    .map((s) => buildSopDigest(s, 750))
    .join('\n\n--------------------\n\n');

  const ai = getAiClient();
  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: `KANDIDAT SOP YANG AKAN DISIMPAN / DISETUJUI:\n${candidateDigest}\n\n====================\n\nDAFTAR SOP DISETUJUI YANG SUDAH ADA:\n${existingDigest}\n\nTugasmu: Periksa apakah KANDIDAT SOP di atas bertentangan (plafon biaya, SLA, batas persetujuan, syarat), menduplikasi prosedur yang sudah ada, atau tumpang tindih kewenangan PIC dengan salah satu SOP Disetujui di atas.\nJika hanya pembaruan wajar tanpa bentrokan aturan nyata dengan SOP lain, kembalikan conflicts kosong [].`,
    config: {
      systemInstruction:
        'Kamu adalah penjaga kualitas tata kelola SOP pra-publikasi (Pre-Publish Guardrail) berbahasa Indonesia. Laporkan hanya konflik, duplikasi, atau tumpang tindih nyata dengan SOP existing yang ID-nya ada pada daftar.',
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: { type: Type.STRING },
          conflicts: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                existingSopId: { type: Type.STRING },
                existingDocNumber: { type: Type.STRING },
                existingTitle: { type: Type.STRING },
                conflictType: {
                  type: Type.STRING,
                  description: 'Konflik Aturan, Duplikasi, atau Tumpang Tindih PIC',
                },
                severity: {
                  type: Type.STRING,
                  description: 'Tinggi, Sedang, atau Rendah',
                },
                description: { type: Type.STRING },
                recommendation: { type: Type.STRING },
              },
              required: [
                'existingSopId',
                'existingDocNumber',
                'existingTitle',
                'conflictType',
                'severity',
                'description',
                'recommendation',
              ],
            },
          },
        },
        required: ['summary', 'conflicts'],
      },
    },
  });

  const parsed = parseAiJson<{
    summary?: string;
    conflicts?: PrePublishConflictItem[];
  }>(response.text, 'pengecekan konflik pra-persetujuan');

  const existingMap = new Map(relatedSops.map((s) => [s.id, s]));
  const docNumMap = new Map(relatedSops.map((s) => [s.docNumber.toLowerCase(), s]));

  const verified: PrePublishConflictItem[] = [];
  for (const item of parsed.conflicts || []) {
    const matched =
      existingMap.get(item.existingSopId) ||
      (item.existingDocNumber ? docNumMap.get(item.existingDocNumber.toLowerCase()) : undefined);
    if (!matched) continue;
    verified.push({
      existingSopId: matched.id,
      existingDocNumber: matched.docNumber,
      existingTitle: matched.title,
      conflictType: normalizeConflictType(item.conflictType),
      severity: normalizeSeverity(item.severity),
      description: item.description,
      recommendation: item.recommendation,
    });
  }

  return {
    hasIssues: verified.length > 0,
    checkedCount: relatedSops.length,
    summary:
      parsed.summary ||
      (verified.length > 0
        ? `Terdeteksi ${verified.length} potensi konflik atau duplikasi dengan SOP yang sudah aktif.`
        : `Lolos pemeriksaan pra-persetujuan terhadap ${relatedSops.length} SOP aktif terdekat.`),
    conflicts: verified,
  };
}

export async function analyzeModuleImageWithAi(params: {
  imageBase64: string;
  mimeType: string;
  moduleTitle: string;
  sopTitle?: string;
  fileName?: string;
}): Promise<{
  suggestedCaption: string;
  ocrText: string;
  matchesModule: boolean;
  mismatchWarning: string;
}> {
  const ai = getAiClient();
  const prompt = [
    `Judul SOP: ${params.sopTitle || '-'}`,
    `Nama Bagian / Modul Target: ${params.moduleTitle || '-'}`,
    params.fileName ? `Nama File Gambar: ${params.fileName}` : '',
    `Tugasmu:
1. Lakukan OCR & pembacaan visual terhadap tangkapan layar / foto modul terlampir.
2. Buat "suggestedCaption": keterangan singkat (maks. 12 kata) dalam Bahasa Indonesia yang menggambarkan layar/menu/form apa yang terlihat pada gambar (contoh: "Form Tambah User — Pengisian Kode, Nama, Password & Cabang").
3. Buat "ocrText": ringkasan teks penting di dalam gambar (judul jendela/window, path menu, nama tombol utama, nama kolom/field, atau label tabel) maksimal 450 karakter untuk keperluan indeks pencarian AI.
4. Periksa "matchesModule": true jika isi gambar sesuai atau relevan untuk mendukung "${params.moduleTitle}". Set false HANYA jika gambar jelas merupakan menu/modul yang salah atau sama sekali tidak nyambung dengan "${params.moduleTitle}".
5. Jika "matchesModule" false, tulis "mismatchWarning" singkat (1 kalimat) menjelaskan apa yang sebenarnya terlihat di gambar dibanding judul modul.`,
  ]
    .filter(Boolean)
    .join('\n');

  const response = await ai.models.generateContent({
    model: 'gemini-3.1-flash-lite',
    contents: {
      parts: [
        { inlineData: { mimeType: params.mimeType, data: params.imageBase64 } },
        { text: prompt },
      ],
    },
    config: {
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          suggestedCaption: { type: Type.STRING },
          ocrText: { type: Type.STRING },
          matchesModule: { type: Type.BOOLEAN },
          mismatchWarning: { type: Type.STRING },
        },
        required: ['suggestedCaption', 'ocrText', 'matchesModule', 'mismatchWarning'],
      },
    },
  });

  const parsed = parseAiJson<{
    suggestedCaption?: string;
    ocrText?: string;
    matchesModule?: boolean;
    mismatchWarning?: string;
  }>(response.text, 'analisis OCR gambar modul');

  return {
    suggestedCaption: (parsed.suggestedCaption || params.moduleTitle || 'Foto Modul').trim().slice(0, 220),
    ocrText: (parsed.ocrText || '').trim().slice(0, 480),
    matchesModule: parsed.matchesModule !== false,
    mismatchWarning:
      parsed.matchesModule === false
        ? (parsed.mismatchWarning || 'Gambar tampak menampilkan menu yang berbeda dari judul modul.').trim().slice(0, 240)
        : '',
  };
}

export async function reviseSopWithFeedbackAi(params: {
  sop: SopDocument;
  feedbackItems: {
    question: string;
    feedback: string;
    feedbackNote: string;
    userName?: string;
  }[];
}): Promise<SopFeedbackRevisionResult> {
  const ai = getAiClient();
  const feedbackLines = params.feedbackItems
    .map((f, i) => {
      const label = f.feedback === 'outdated' ? 'SOP Sudah Usang' : 'Tidak Akurat';
      return `${i + 1}. [${label}] Pertanyaan karyawan: "${f.question}"\n   Catatan pelapor (${f.userName || 'Karyawan'}): "${f.feedbackNote || 'Tidak ada catatan tambahan — tinjau relevansi & kejelasan langkah terkait.'}"`;
    })
    .join('\n\n');

  const existingSections = params.sop.sections
    .map((s, idx) => `Bagian ${idx + 1} (id: ${s.id}): ${s.title}\n${s.content}`)
    .join('\n\n---\n\n');

  const prompt = `DOKUMEN SOP SAAT INI (${params.sop.docNumber} v${params.sop.version}):
Judul: ${params.sop.title}
Divisi/Departemen: ${params.sop.divisionName} / ${params.sop.departmentName}
Tujuan: ${params.sop.purpose}
Ruang Lingkup: ${params.sop.scope}
Peran Terkait: ${(params.sop.relatedRoles || []).join(', ')}

ISI BAGIAN SAAT INI:
${existingSections}

====================

UMPAN BALIK / KELUHAN KARYAWAN YANG HARUS DITINDAKLANJUTI:
${feedbackLines}

Tugasmu:
1. Perbaiki/perbarui isi bagian SOP yang terdampak oleh umpan balik karyawan di atas secara presisi dalam Bahasa Indonesia formal.
2. Pertahankan bagian-bagian lain yang tidak bermasalah (pertahankan "id" bagian asal jika masih merupakan bagian yang sama agar foto modul tidak terlepas!).
3. Jika catatan karyawan menyebut nilai angka/aturan baru secara eksplisit (misal plafon atau SLA baru), gunakan nilai tersebut; jika catatan hanya menyebut bagian membingungkan atau belum lengkap tanpa angka baru, perjelas struktur langkah dan beri penanda "[PERLU VERIFIKASI ADMIN: ...]" pada bagian yang butuh konfirmasi kebijakan.
4. Isi "changeSummary" (maks 180 karakter) untuk catatan riwayat versi dan "revisionNotes" (ringkasan perubahan apa saja yang dilakukan AI).`;

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: prompt,
    config: {
      systemInstruction:
        'Kamu adalah editor tata kelola SOP senior berbahasa Indonesia. Revisi SOP secara terstruktur berdasarkan masukan lapangan karyawan tanpa merusak bagian yang sudah benar.',
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          purpose: { type: Type.STRING },
          scope: { type: Type.STRING },
          relatedRoles: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          sections: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                title: { type: Type.STRING },
                content: { type: Type.STRING },
              },
              required: ['title', 'content'],
            },
          },
          changeSummary: { type: Type.STRING },
          revisionNotes: { type: Type.STRING },
        },
        required: [
          'title',
          'purpose',
          'scope',
          'relatedRoles',
          'sections',
          'changeSummary',
          'revisionNotes',
        ],
      },
    },
  });

  const parsed = parseAiJson<Partial<SopFeedbackRevisionResult>>(
    response.text,
    'revisi SOP dari umpan balik'
  );

  return {
    title: parsed.title || params.sop.title,
    purpose: parsed.purpose || params.sop.purpose,
    scope: parsed.scope || params.sop.scope,
    relatedRoles:
      Array.isArray(parsed.relatedRoles) && parsed.relatedRoles.length > 0
        ? parsed.relatedRoles
        : params.sop.relatedRoles,
    sections:
      Array.isArray(parsed.sections) && parsed.sections.length > 0
        ? parsed.sections
        : params.sop.sections.map((s) => ({ id: s.id, title: s.title, content: s.content })),
    changeSummary:
      (parsed.changeSummary || 'Revisi SOP berdasarkan umpan balik karyawan').slice(0, 480),
    revisionNotes:
      parsed.revisionNotes || 'Draf revisi telah disesuaikan berdasarkan umpan balik karyawan.',
  };
}

export async function conductHandoverInterview(params: {
  employeeRole: string;
  divisionName: string;
  topic: string;
  transcript: { speaker: 'ai' | 'user'; text: string }[];
}): Promise<{ nextQuestion: string; capturedKeyPoints: string[]; readyToDraft: boolean }> {
  const ai = getAiClient();
  const historyLines = params.transcript
    .map((t) => `${t.speaker === 'ai' ? 'Pewawancara AI' : 'Karyawan'}: ${t.text}`)
    .join('\n\n');

  const userTurns = params.transcript.filter((t) => t.speaker === 'user').length;

  const prompt = [
    `Peran / Jabatan Karyawan: ${params.employeeRole}`,
    `Divisi: ${params.divisionName}`,
    `Topik Proses / Tugas Kunci yang Diserahterimakan: ${params.topic}`,
    `Jumlah jawaban karyawan sejauh ini: ${userTurns}`,
    historyLines
      ? `TRANSKRIP WAWANCARA SEJAUH INI:\n${historyLines}`
      : 'Belum ada pertanyaan. Mulailah wawancara dengan pertanyaan pembuka pertama.',
  ].join('\n\n');

  const response = await ai.models.generateContent({
    model: 'gemini-3.1-flash-lite',
    contents: prompt,
    config: {
      systemInstruction: `Kamu adalah pewawancara AI profesional untuk proses handover/offboarding karyawan yang akan resign atau mutasi agar pengetahuan kerjanya tidak hilang.
Tugasmu:
1. Ajukan SATU pertanyaan lanjutan yang singkat, spesifik, dan tajam dalam Bahasa Indonesia untuk menggali detail operasional yang sering terlupakan (urutan langkah nyata, batas nilai/SLA, aplikasi/formulir yang dipakai, PIC eksternal/vendor, pengecualian kasus darurat).
2. Jangan menanyakan hal yang sudah dijawab dengan jelas di transkrip.
3. Ekstrak poin-poin penting yang sudah berhasil terkumpul ke dalam "capturedKeyPoints".
4. Set "readyToDraft": true jika jumlah jawaban karyawan >= 3 dan alur utama, PIC, serta langkah kerja sudah cukup jelas untuk disusun menjadi SOP.`,
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          nextQuestion: { type: Type.STRING },
          capturedKeyPoints: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          readyToDraft: { type: Type.BOOLEAN },
        },
        required: ['nextQuestion', 'capturedKeyPoints', 'readyToDraft'],
      },
    },
  });

  const parsed = parseAiJson<{
    nextQuestion?: string;
    capturedKeyPoints?: string[];
    readyToDraft?: boolean;
  }>(response.text, 'wawancara handover');

  return {
    nextQuestion:
      parsed.nextQuestion ||
      'Bisa jelaskan langkah demi langkah proses tersebut dari awal hingga selesai, termasuk dokumen atau sistem yang digunakan?',
    capturedKeyPoints: Array.isArray(parsed.capturedKeyPoints) ? parsed.capturedKeyPoints : [],
    readyToDraft: Boolean(parsed.readyToDraft) || userTurns >= 3,
  };
}
