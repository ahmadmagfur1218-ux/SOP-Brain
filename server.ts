import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import multer from 'multer';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { DecodedIdToken } from 'firebase-admin/auth';
import firebaseConfig from './firebase-applet-config.json' with { type: 'json' };
import {
  analyzeModuleImageWithAi,
  buildRetrievalQuery,
  checkPrePublishConflictsWithAi,
  conductHandoverInterview,
  detectSopConflictsWithAi,
  embedSopLogicalChunks,
  embedText,
  generateGroundedSopAnswer,
  reviseSopWithFeedbackAi,
  streamGroundedSopAnswer,
  structureSopWithAi,
  summarizeVisualPdfAttachment,
} from './server/ai.ts';
import {
  fetchAccessibleApprovedChunks,
  getCachedAccessibleChunks,
  invalidateChunkCache,
} from './server/firestoreRest.ts';
import type { SopVisualCatalogEntry } from './src/lib/visualIntent.ts';
import type { Division, SopDocument } from './src/types/sop.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!getApps().length) {
  initializeApp({
    projectId: firebaseConfig.projectId,
  });
}

const adminAuth = getAuth();

interface AuthRequest extends Request {
  user?: DecodedIdToken;
  idToken?: string;
}

const requireAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Autentikasi diperlukan (token tidak ditemukan).' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    req.user = decoded;
    req.idToken = token;
    next();
  } catch (err) {
    console.error('Firebase token verification error:', err);
    res.status(401).json({ error: 'Sesi login tidak valid atau telah kedaluwarsa.' });
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 45 * 1024 * 1024 },
});

async function extractTextFromUploadedFile(file: Express.Multer.File): Promise<{
  rawText?: string;
  fileBase64?: string;
  mimeType?: string;
  extractedPreview: string;
}> {
  const lowerName = file.originalname.toLowerCase();
  const mime = file.mimetype || '';

  if (mime === 'application/pdf' || lowerName.endsWith('.pdf')) {
    return {
      fileBase64: file.buffer.toString('base64'),
      mimeType: 'application/pdf',
      extractedPreview: `Dokumen PDF (${file.originalname}, ${(file.size / 1024).toFixed(1)} KB)`,
    };
  }

  if (
    lowerName.endsWith('.docx') ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    const text = (result.value || '').trim();
    return {
      rawText: text,
      extractedPreview: text.slice(0, 3500),
    };
  }

  if (
    lowerName.endsWith('.xlsx') ||
    lowerName.endsWith('.xls') ||
    lowerName.endsWith('.csv') ||
    mime.includes('spreadsheet') ||
    mime.includes('excel') ||
    mime === 'text/csv'
  ) {
    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const sheetTexts = workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      return `=== Sheet: ${name} ===\n${csv}`;
    });
    const combined = sheetTexts.join('\n\n').trim();
    return {
      rawText: combined,
      extractedPreview: combined.slice(0, 3500),
    };
  }

  let utf8Text: string;
  if (file.buffer.length >= 2 && file.buffer[0] === 0xff && file.buffer[1] === 0xfe) {
    utf8Text = file.buffer.subarray(2).toString('utf16le');
  } else if (file.buffer.length >= 2 && file.buffer[0] === 0xfe && file.buffer[1] === 0xff) {
    const swapped = Buffer.alloc(file.buffer.length - 2);
    for (let i = 2; i + 1 < file.buffer.length; i += 2) {
      swapped[i - 2] = file.buffer[i + 1];
      swapped[i - 1] = file.buffer[i];
    }
    utf8Text = swapped.toString('utf16le');
  } else {
    utf8Text = file.buffer.toString('utf-8').replace(/^\uFEFF/, '');
  }
  const cleanedText = utf8Text.replace(/\u0000/g, '').trim();
  return {
    rawText: cleanedText,
    extractedPreview: cleanedText.slice(0, 3500),
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '45mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'sop-brain' });
  });

  // Generate logical chunks + Gemini embeddings for an approved SOP
  app.post('/api/sop/embed', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const { sop } = req.body as { sop?: SopDocument };
      if (!sop || !sop.id || !sop.title) {
        res.status(400).json({ error: 'Data SOP tidak lengkap untuk proses pengindeksan.' });
        return;
      }
      const chunks = await embedSopLogicalChunks(sop);
      invalidateChunkCache();
      res.json({ chunks });
    } catch (err) {
      console.error('Error embedding SOP chunks:', err);
      const message = err instanceof Error ? err.message : 'Gagal membuat embedding SOP.';
      res.status(500).json({ error: message });
    }
  });

  // Pre-warm user's accessible SOP chunk cache when entering Q&A view
  app.post('/api/rag/warm', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user || !req.idToken) {
        res.status(401).json({ error: 'Token pengguna tidak ditemukan.' });
        return;
      }
      const chunks = await fetchAccessibleApprovedChunks({
        idToken: req.idToken,
        uid: req.user.uid,
        email: req.user.email,
      });
      res.json({ ok: true, count: chunks.length });
    } catch (err) {
      console.warn('Chunk warmup warning:', err);
      res.json({ ok: false });
    }
  });

  // Clear cached RAG chunks when SOPs or user permissions change
  app.post('/api/rag/invalidate-cache', requireAuth, (_req: AuthRequest, res: Response) => {
    invalidateChunkCache();
    res.json({ ok: true });
  });

  // Streaming Grounded Hybrid RAG Q&A (SSE) with parallel retrieval + query embedding
  app.post('/api/rag/ask-stream', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const { question, history, divisions, visualCatalog } = req.body as {
        question?: string;
        history?: { role: 'user' | 'assistant'; content: string }[];
        divisions?: Division[];
        visualCatalog?: SopVisualCatalogEntry[];
      };

      if (!question || !question.trim()) {
        res.status(400).json({ error: 'Pertanyaan tidak boleh kosong.' });
        return;
      }

      if (!req.user || !req.idToken) {
        res.status(401).json({ error: 'Token pengguna tidak ditemukan.' });
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      let closed = false;
      req.on('close', () => {
        closed = true;
      });

      const sendEvent = (payload: Record<string, unknown>) => {
        if (closed) return;
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      const safeQuestion = question.trim();
      const safeHistory = Array.isArray(history) ? history : [];
      const safeDivisions = Array.isArray(divisions) ? divisions : [];

      const cachedChunks = getCachedAccessibleChunks(req.user.uid, req.user.email);
      let accessibleChunks;
      let precomputedEmbedding: number[] | undefined;

      if (cachedChunks && cachedChunks.length === 0) {
        accessibleChunks = cachedChunks;
      } else {
        const retrievalQuery = buildRetrievalQuery(safeQuestion, safeHistory);
        const [chunksResult, embeddingResult] = await Promise.all([
          cachedChunks
            ? Promise.resolve(cachedChunks)
            : fetchAccessibleApprovedChunks({
                idToken: req.idToken,
                uid: req.user.uid,
                email: req.user.email,
              }),
          embedText(retrievalQuery, true),
        ]);
        accessibleChunks = chunksResult;
        precomputedEmbedding = embeddingResult;
      }

      const result = await streamGroundedSopAnswer({
        question: safeQuestion,
        history: safeHistory,
        accessibleChunks,
        divisions: safeDivisions,
        precomputedEmbedding,
        visualCatalog: Array.isArray(visualCatalog) ? visualCatalog : undefined,
        onDelta: (textChunk) => {
          sendEvent({ type: 'delta', text: textChunk });
        },
      });

      sendEvent({ type: 'done', result });
      if (!closed) res.end();
    } catch (err) {
      console.error('Error in /api/rag/ask-stream:', err);
      const message =
        err instanceof Error ? err.message : 'Terjadi kesalahan saat memproses pertanyaan AI.';
      if (!res.headersSent) {
        res.status(500).json({ error: message });
      } else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`);
        res.end();
      }
    }
  });

  // Grounded Hybrid RAG Q&A (JSON endpoint) with parallel retrieval + query embedding
  app.post('/api/rag/ask', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const { question, history, divisions, visualCatalog } = req.body as {
        question?: string;
        history?: { role: 'user' | 'assistant'; content: string }[];
        divisions?: Division[];
        visualCatalog?: SopVisualCatalogEntry[];
      };

      if (!question || !question.trim()) {
        res.status(400).json({ error: 'Pertanyaan tidak boleh kosong.' });
        return;
      }

      if (!req.user || !req.idToken) {
        res.status(401).json({ error: 'Token pengguna tidak ditemukan.' });
        return;
      }

      const safeQuestion = question.trim();
      const safeHistory = Array.isArray(history) ? history : [];
      const cachedChunks = getCachedAccessibleChunks(req.user.uid, req.user.email);

      let accessibleChunks;
      let precomputedEmbedding: number[] | undefined;

      if (cachedChunks && cachedChunks.length === 0) {
        accessibleChunks = cachedChunks;
      } else {
        const retrievalQuery = buildRetrievalQuery(safeQuestion, safeHistory);
        const [chunksResult, embeddingResult] = await Promise.all([
          cachedChunks
            ? Promise.resolve(cachedChunks)
            : fetchAccessibleApprovedChunks({
                idToken: req.idToken,
                uid: req.user.uid,
                email: req.user.email,
              }),
          embedText(retrievalQuery, true),
        ]);
        accessibleChunks = chunksResult;
        precomputedEmbedding = embeddingResult;
      }

      const result = await generateGroundedSopAnswer({
        question: safeQuestion,
        history: safeHistory,
        accessibleChunks,
        divisions: Array.isArray(divisions) ? divisions : [],
        precomputedEmbedding,
        visualCatalog: Array.isArray(visualCatalog) ? visualCatalog : undefined,
      });

      res.json(result);
    } catch (err) {
      console.error('Error in /api/rag/ask:', err);
      const message = err instanceof Error ? err.message : 'Terjadi kesalahan saat memproses pertanyaan AI.';
      res.status(500).json({ error: message });
    }
  });

  // AI Import: Parse PDF / Word / Excel / Text and structure into standard SOP format
  app.post('/api/ai/import-sop', requireAuth, upload.single('file'), async (req: AuthRequest, res: Response) => {
    try {
      const file = req.file;
      let divisions: Division[] = [];
      if (typeof req.body?.divisions === 'string') {
        try {
          divisions = JSON.parse(req.body.divisions) as Division[];
        } catch {
          divisions = [];
        }
      }

      const titleHint = typeof req.body?.titleHint === 'string' ? req.body.titleHint : '';
      const divisionHint = typeof req.body?.divisionHint === 'string' ? req.body.divisionHint : '';
      const rawTextBody = typeof req.body?.rawText === 'string' ? req.body.rawText : '';
      const extractOnly = req.body?.extractOnly === 'true';

      if (!file && !rawTextBody.trim()) {
        res.status(400).json({ error: 'Unggah file (PDF, Word, Excel) atau masukkan teks dokumen.' });
        return;
      }

      if (file) {
        const extracted = await extractTextFromUploadedFile(file);
        if (!extracted.fileBase64 && (!extracted.rawText || !extracted.rawText.trim())) {
          res.status(400).json({ error: 'Isi file dokumen kosong atau tidak terbaca.' });
          return;
        }

        const attachmentInfo = {
          name: file.originalname,
          fileType: file.originalname.split('.').pop()?.toUpperCase() || 'FILE',
          sizeLabel: `${Math.max(1, Math.round(file.size / 1024))} KB`,
          extractedText: extracted.extractedPreview,
        };

        if (extractOnly) {
          if (!extracted.rawText && extracted.fileBase64 && extracted.mimeType === 'application/pdf') {
            const pdfSummary = await summarizeVisualPdfAttachment({
              fileBase64: extracted.fileBase64,
              mimeType: extracted.mimeType,
              fileName: file.originalname,
            });
            if (pdfSummary) {
              attachmentInfo.extractedText = pdfSummary;
            }
          }
          res.json({ draft: null, attachmentInfo });
          return;
        }

        const draft = await structureSopWithAi({
          rawText: extracted.rawText,
          fileBase64: extracted.fileBase64,
          mimeType: extracted.mimeType,
          fileName: file.originalname,
          titleHint,
          divisionHint,
          divisions,
        });

        // For image-rich PDFs without raw text extraction, store AI OCR/visual summary in attachmentInfo.extractedText
        if (extracted.mimeType === 'application/pdf') {
          const combinedSummary = [
            draft.attachmentSummary,
            draft.sections.map((s) => `${s.title}: ${s.content}`).join('\n'),
          ]
            .filter(Boolean)
            .join('\n\n')
            .trim();
          if (combinedSummary) {
            attachmentInfo.extractedText = combinedSummary.slice(0, 6000);
          }
        }

        res.json({
          draft,
          attachmentInfo,
        });
        return;
      }

      const draft = await structureSopWithAi({
        rawText: rawTextBody,
        titleHint,
        divisionHint,
        divisions,
      });
      res.json({ draft, attachmentInfo: null });
    } catch (err) {
      console.error('Error in /api/ai/import-sop:', err);
      const message = err instanceof Error ? err.message : 'Gagal mengekstrak SOP dari file.';
      res.status(500).json({ error: message });
    }
  });

  // AI SOP Writer: Turn rough notes or transcript into structured SOP
  app.post('/api/ai/write-sop', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const { notes, titleHint, divisionHint, divisions } = req.body as {
        notes?: string;
        titleHint?: string;
        divisionHint?: string;
        divisions?: Division[];
      };

      if (!notes || !notes.trim()) {
        res.status(400).json({ error: 'Catatan atau transkrip tidak boleh kosong.' });
        return;
      }

      const draft = await structureSopWithAi({
        rawText: notes.trim(),
        titleHint: titleHint || '',
        divisionHint: divisionHint || '',
        divisions: Array.isArray(divisions) ? divisions : [],
      });
      res.json({ draft });
    } catch (err) {
      console.error('Error in /api/ai/write-sop:', err);
      const message = err instanceof Error ? err.message : 'Gagal menyusun SOP dengan AI.';
      res.status(500).json({ error: message });
    }
  });

  // Fase 2: Proactive AI Conflict Detection across Approved SOPs
  app.post('/api/ai/detect-conflicts', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const { sops } = req.body as { sops?: SopDocument[] };
      if (!Array.isArray(sops)) {
        res.status(400).json({ error: 'Daftar SOP tidak valid.' });
        return;
      }
      const report = await detectSopConflictsWithAi(sops);
      res.json(report);
    } catch (err) {
      console.error('Error in /api/ai/detect-conflicts:', err);
      const message = err instanceof Error ? err.message : 'Gagal memindai konflik antar SOP.';
      res.status(500).json({ error: message });
    }
  });

  // Fase 3: AI Offboarding / Handover Knowledge Interview
  app.post('/api/ai/handover-interview', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const { employeeRole, divisionName, topic, transcript } = req.body as {
        employeeRole?: string;
        divisionName?: string;
        topic?: string;
        transcript?: { speaker: 'ai' | 'user'; text: string }[];
      };

      if (!employeeRole?.trim() || !topic?.trim()) {
        res.status(400).json({ error: 'Peran karyawan dan topik pekerjaan wajib diisi.' });
        return;
      }

      const result = await conductHandoverInterview({
        employeeRole: employeeRole.trim(),
        divisionName: (divisionName || 'Umum').trim(),
        topic: topic.trim(),
        transcript: Array.isArray(transcript) ? transcript : [],
      });
      res.json(result);
    } catch (err) {
      console.error('Error in /api/ai/handover-interview:', err);
      const message = err instanceof Error ? err.message : 'Gagal menjalankan wawancara AI.';
      res.status(500).json({ error: message });
    }
  });

  // Feature #2: Vision Auto-OCR & Auto-Caption for uploaded module screenshots
  app.post('/api/ai/analyze-module-image', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const { imageBase64, mimeType, moduleTitle, sopTitle, fileName } = req.body as {
        imageBase64?: string;
        mimeType?: string;
        moduleTitle?: string;
        sopTitle?: string;
        fileName?: string;
      };
      if (!imageBase64 || !mimeType) {
        res.status(400).json({ error: 'Data gambar tidak lengkap untuk dianalisis.' });
        return;
      }
      const result = await analyzeModuleImageWithAi({
        imageBase64,
        mimeType,
        moduleTitle: moduleTitle || '',
        sopTitle: sopTitle || '',
        fileName: fileName || '',
      });
      res.json(result);
    } catch (err) {
      console.error('Error in /api/ai/analyze-module-image:', err);
      const message = err instanceof Error ? err.message : 'Gagal membaca isi gambar modul dengan AI.';
      res.status(500).json({ error: message });
    }
  });

  // Feature #1: Closed-loop AI SOP revision from negative employee feedback logs
  app.post('/api/ai/revise-sop-from-feedback', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const { sop, feedbackItems } = req.body as {
        sop?: SopDocument;
        feedbackItems?: {
          question: string;
          feedback: string;
          feedbackNote: string;
          userName?: string;
        }[];
      };
      if (!sop || !sop.id || !Array.isArray(feedbackItems) || feedbackItems.length === 0) {
        res.status(400).json({ error: 'Data SOP dan umpan balik karyawan wajib disediakan.' });
        return;
      }
      const revision = await reviseSopWithFeedbackAi({ sop, feedbackItems });
      res.json({ revision });
    } catch (err) {
      console.error('Error in /api/ai/revise-sop-from-feedback:', err);
      const message = err instanceof Error ? err.message : 'Gagal menyusun draf revisi SOP dari umpan balik.';
      res.status(500).json({ error: message });
    }
  });

  // Feature #3: Pre-Publish Conflict & Duplication Guardrail before review/approval
  app.post('/api/ai/check-publish-conflicts', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const { candidateSop, existingApprovedSops } = req.body as {
        candidateSop?: SopDocument;
        existingApprovedSops?: SopDocument[];
      };
      if (!candidateSop || !candidateSop.title) {
        res.status(400).json({ error: 'Kandidat SOP tidak lengkap untuk pengecekan konflik.' });
        return;
      }
      const report = await checkPrePublishConflictsWithAi({
        candidateSop,
        existingApprovedSops: Array.isArray(existingApprovedSops) ? existingApprovedSops : [],
      });
      res.json(report);
    } catch (err) {
      console.error('Error in /api/ai/check-publish-conflicts:', err);
      const message = err instanceof Error ? err.message : 'Gagal memeriksa konflik pra-persetujuan.';
      res.status(500).json({ error: message });
    }
  });

  // Ensure /api/* routes never fall through to Vite/SPA HTML
  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'Endpoint API tidak ditemukan.' });
  });

  // Ensure Multer / Express errors on API routes always return JSON
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api/')) {
      const message =
        err instanceof multer.MulterError
          ? err.code === 'LIMIT_FILE_SIZE'
            ? 'Ukuran file melebihi batas maksimal 45 MB.'
            : `Gagal mengunggah file: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Terjadi kesalahan internal pada server API.';
      res.status(400).json({ error: message });
      return;
    }
    next(err);
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    let viteMiddlewares: express.RequestHandler | null = null;
    const viteReady = import('vite')
      .then(({ createServer: createViteServer }) =>
        createViteServer({
          server: { middlewareMode: true },
          appType: 'spa',
        })
      )
      .then((vite) => {
        viteMiddlewares = vite.middlewares;
      });

    app.use(async (req, res, next) => {
      try {
        if (!viteMiddlewares) {
          await viteReady;
        }
        viteMiddlewares!(req, res, next);
      } catch (err) {
        next(err);
      }
    });
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`SOP Brain server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
