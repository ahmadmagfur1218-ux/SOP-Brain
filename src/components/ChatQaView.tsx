import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Download,
  FileText,
  Image as ImageIcon,
  ListChecks,
  Maximize2,
  MessageSquarePlus,
  Send,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  X,
} from 'lucide-react';
import { renderSopAnswerToImage } from '../lib/answerImageRenderer';
import { streamApiSse } from '../lib/apiClient';
import {
  buildExecutiveSummary,
  type ExecutiveSummaryData,
} from '../lib/executiveSummary';
import { getFreshIdToken } from '../lib/firebase';
import {
  isDiagramRequest,
  isVisualRequest,
  NO_VISUAL_REPLY_REGEX,
  type SopVisualCatalogEntry,
} from '../lib/visualIntent';
import {
  createChatSession,
  deleteChatSession,
  fetchChatMessages,
  fetchChatSessions,
  logQueryAndAnswer,
  makeSafeId,
  saveChatMessage,
  submitAnswerFeedback,
} from '../lib/sopService';
import type {
  ChatMessage,
  ChatSession,
  CitationSource,
  DirectoryMember,
  Division,
  FeedbackType,
  SopDocument,
  UserProfile,
} from '../types/sop';

interface ChatQaViewProps {
  user: UserProfile;
  idToken: string;
  divisions: Division[];
  directory: DirectoryMember[];
  sops?: SopDocument[];
  onOpenSopCitation?: (sopId: string, sectionTitle?: string) => void;
}

type AnswerDisplayFormat = 'auto' | 'text_and_image' | 'text_only';

interface VisualIntentMeta {
  showVisual: boolean;
  visualType: 'pdf_page' | 'diagram';
  visualPageNumbers: number[];
}

interface ReferencedPdfVisual {
  sopTitle: string;
  docNumber: string;
  attachmentName: string;
  pageNumber: number;
  sectionTitle?: string;
  sectionOrder?: number;
  caption: string;
  dataUrl: string;
  sourceKind: 'section' | 'pdf';
}

const MATCH_STOPWORDS = new Set([
  'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'pada', 'dengan', 'adalah', 'atau',
  'ini', 'itu', 'jika', 'bila', 'kalau', 'apa', 'bagaimana', 'cara', 'mana',
  'contoh', 'gambar', 'gambarnya', 'foto', 'fotonya', 'screenshot', 'screenshotnya',
  'tampilan', 'tampilannya', 'menu', 'menunya', 'halaman', 'bagian', 'berikut',
  'proses', 'saat', 'hanya', 'tolong', 'lihat', 'tampilkan', 'tampil', 'saja',
  'sop', 'sistem', 'modul', 'berdasarkan', 'bukan', 'buka', 'kamu', 'harus',
  'seharusnya', 'salah', 'keliru', 'sebelumnya', 'ketidaksesuaian', 'belum',
  'tersedia', 'diunggah', 'mohon', 'maaf', 'atas', 'tadi', 'dong', 'coba',
  'kasih', 'minta', 'muncul', 'munculkan', 'perlihatkan', 'tunjukkan', 'tunjukin',
]);

function extractPositiveTopicText(question: string): string {
  const correctionMatch = question.match(
    /(?:yang\s+(?:kamu|anda|sistem)?\s*(?:tampilkan|munculkan|kasih)\s+.+?\s+\bbuka[n]?\b\s+)(.+)$/i
  );
  if (correctionMatch?.[1]) {
    return correctionMatch[1];
  }
  const notIdx = question.search(/\bbukan\b/i);
  if (notIdx > 0) {
    return question.slice(0, notIdx);
  }
  return question;
}

function extractMentionedPageNumbers(text: string): number[] {
  const pages: number[] = [];
  // Matches "Halaman 2", "Halaman 2-3", "Hal. 2"
  for (const m of text.matchAll(/\b(?:halaman|hal\.?)\s*(\d+)(?:\s*[-–]\s*(\d+))?/gi)) {
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    if (Number.isInteger(start) && start > 0) {
      const cap = Math.min(end >= start ? end : start, start + 2);
      for (let p = start; p <= cap; p++) {
        if (!pages.includes(p)) pages.push(p);
      }
    }
  }
  return pages;
}

function tokenizeMatchText(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 2 && !MATCH_STOPWORDS.has(t))
    )
  );
}

function scoreVisualCandidate<
  T extends ReferencedPdfVisual & { isPrimarySop: boolean; searchHaystack?: string; isCitedSection?: boolean },
>(
  candidate: T,
  questionTokens: string[],
  contextTokens: string[],
  extraTopicTokens: string[] = []
): T & { score: number; hasTopicHit: boolean } {
  const capLower = (candidate.searchHaystack || candidate.caption).toLowerCase();
  const captionOnlyLower = (candidate.caption || '').toLowerCase();
  let score = candidate.isPrimarySop ? 0.5 : 0;
  let hasTopicHit = Boolean(candidate.isCitedSection);
  if (candidate.isCitedSection) {
    score += 10;
  }
  for (const tok of questionTokens) {
    if (capLower.includes(tok)) {
      score += 5;
      if (captionOnlyLower.includes(tok)) {
        hasTopicHit = true;
      }
      if (capLower.includes(`gambar ${tok}`) || capLower.includes(`diagram ${tok}`)) {
        score += 2;
      }
    }
  }
  for (const tok of extraTopicTokens) {
    if (capLower.includes(tok)) {
      score += 2.5;
      if (captionOnlyLower.includes(tok)) {
        hasTopicHit = true;
      }
    }
  }
  for (const tok of contextTokens) {
    if (capLower.includes(tok)) {
      score += 1.5;
    }
  }
  return { ...candidate, score, hasTopicHit };
}

function findReferencedSopVisuals(params: {
  msg: ChatMessage;
  userQuestion: string;
  priorContext: string;
  sops: SopDocument[];
  explicitPageNumbers?: number[];
}): {
  visuals: ReferencedPdfVisual[];
  hasAnyPdfVisualsOnSop: boolean;
  hasLegacyPdfWithoutVisuals: boolean;
} {
  const { msg, userQuestion, priorContext, sops, explicitPageNumbers } = params;
  if (!sops.length) {
    return { visuals: [], hasAnyPdfVisualsOnSop: false, hasLegacyPdfWithoutVisuals: false };
  }

  const citedIds = new Set((msg.citations || []).map((c) => c.sopId));
  const citedSectionTitles = (msg.citations || [])
    .map((c) => (c.sectionTitle || '').trim().toLowerCase())
    .filter(Boolean);
  const combinedTextLower = `${msg.content || ''} ${priorContext}`.toLowerCase();

  let matchedSops = sops.filter((sop) => {
    if (citedIds.has(sop.id)) return true;
    if (sop.docNumber && combinedTextLower.includes(sop.docNumber.toLowerCase())) return true;
    if (sop.title && sop.title.length > 8 && combinedTextLower.includes(sop.title.toLowerCase())) {
      return true;
    }
    return false;
  });

  // Fallback: if citations & title weren't echoed verbatim, match SOPs via question/context keywords
  if (matchedSops.length === 0 && msg.answered !== false) {
    const queryTokens = tokenizeMatchText(`${extractPositiveTopicText(userQuestion)} ${msg.content || ''}`);
    if (queryTokens.length > 0) {
      const scoredSops = sops
        .map((sop) => {
          const sopHaystack = [
            sop.docNumber,
            sop.title,
            ...(sop.sections || []).map((s) => `${s.title} ${(s.images || []).map((im) => im.caption).join(' ')}`),
            ...(sop.attachments || []).flatMap((a) => (a.visualPages || []).map((vp) => vp.caption)),
          ]
            .join(' ')
            .toLowerCase();
          let score = 0;
          for (const tok of queryTokens) {
            if (sopHaystack.includes(tok)) score += 1;
          }
          return { sop, score };
        })
        .filter((item) => item.score >= 2)
        .sort((a, b) => b.score - a.score);
      if (scoredSops.length > 0) {
        matchedSops = [scoredSops[0].sop];
      }
    }
  }

  const positiveQuestionText = extractPositiveTopicText(userQuestion);
  const topicTokens = tokenizeMatchText(positiveQuestionText);
  const answerTokens = tokenizeMatchText(msg.content || '');
  const priorTokens =
    topicTokens.length === 0 && answerTokens.length <= 4 ? tokenizeMatchText(priorContext) : [];

  // Score ALL sections across matchedSops (including sections WITHOUT images)
  // so that requesting a module with NO image never falls back to a different module's photo!
  const allSectionMatches: {
    sop: SopDocument;
    sec: SopDocument['sections'][number];
    score: number;
    isPrimarySop: boolean;
    isCitedSection: boolean;
  }[] = [];

  const allPages: (ReferencedPdfVisual & { isPrimarySop: boolean })[] = [];
  let hasLegacyPdfWithoutVisuals = false;
  let hasAnyUploadedSectionImages = false;

  for (const sop of matchedSops) {
    const isPrimarySop = citedIds.has(sop.id) || msg.citations?.[0]?.sopId === sop.id;
    for (const sec of sop.sections || []) {
      if ((sec.images || []).length > 0) {
        hasAnyUploadedSectionImages = true;
      }
      const secTitleLower = (sec.title || '').trim().toLowerCase();
      const secHaystack = `${sec.title} ${sec.content.slice(0, 600)} ${(sec.images || [])
        .map((im) => `${im.caption || ''} ${im.ocrText || ''}`)
        .join(' ')}`.toLowerCase();
      const isCitedSection =
        secTitleLower.length > 2 &&
        citedSectionTitles.some(
          (ct) => ct === secTitleLower || ct.includes(secTitleLower) || secTitleLower.includes(ct)
        );

      let score = isCitedSection ? 10 : 0;
      for (const tok of topicTokens) {
        if (secTitleLower.includes(tok)) score += 6;
        else if (secHaystack.includes(tok)) score += 3;
      }
      for (const tok of answerTokens) {
        if (secTitleLower.includes(tok)) score += 4;
        else if (secHaystack.includes(tok)) score += 1.5;
      }
      for (const tok of priorTokens) {
        if (secTitleLower.includes(tok)) score += 2.5;
        else if (secHaystack.includes(tok)) score += 1;
      }
      if (isPrimarySop && score > 0) score += 0.5;

      allSectionMatches.push({
        sop,
        sec,
        score,
        isPrimarySop,
        isCitedSection,
      });
    }

    for (const att of sop.attachments || []) {
      const isPdfAtt =
        att.fileType?.toUpperCase() === 'PDF' || att.name?.toLowerCase().endsWith('.pdf');
      if (isPdfAtt && (!att.visualPages || att.visualPages.length === 0)) {
        hasLegacyPdfWithoutVisuals = true;
      }
      for (const vp of att.visualPages || []) {
        allPages.push({
          sopTitle: sop.title,
          docNumber: sop.docNumber,
          attachmentName: att.name,
          pageNumber: vp.pageNumber,
          caption: vp.caption,
          dataUrl: vp.dataUrl,
          sourceKind: 'pdf',
          isPrimarySop,
        });
      }
    }
  }

  const hasAnyVisuals = hasAnyUploadedSectionImages || allPages.length > 0;
  if (!hasAnyVisuals) {
    return { visuals: [], hasAnyPdfVisualsOnSop: false, hasLegacyPdfWithoutVisuals };
  }

  allSectionMatches.sort((a, b) => b.score - a.score || a.sec.order - b.sec.order);
  const bestSectionMatch = allSectionMatches[0];

  // 0. Check uploaded module/section photos strictly against the best-matching target section
  if (bestSectionMatch && bestSectionMatch.score >= 4) {
    const bestImages = bestSectionMatch.sec.images || [];
    if (bestImages.length > 0) {
      const visuals: ReferencedPdfVisual[] = bestImages.slice(0, 3).map((img) => ({
        sopTitle: bestSectionMatch.sop.title,
        docNumber: bestSectionMatch.sop.docNumber,
        attachmentName: `modul-${bestSectionMatch.sec.order}`,
        pageNumber: 0,
        sectionTitle: bestSectionMatch.sec.title,
        sectionOrder: bestSectionMatch.sec.order,
        caption:
          img.caption && img.caption.trim() && img.caption.trim() !== bestSectionMatch.sec.title.trim()
            ? `${bestSectionMatch.sec.title} — ${img.caption.trim()}`
            : bestSectionMatch.sec.title,
        dataUrl: img.dataUrl,
        sourceKind: 'section',
      }));
      return {
        visuals,
        hasAnyPdfVisualsOnSop: true,
        hasLegacyPdfWithoutVisuals,
      };
    }
    // Target section has 0 uploaded photos: do NOT steal photos from another section!
    // Continue ONLY to check whether PDF visualPages match this exact section/page.
  } else if (hasAnyUploadedSectionImages) {
    // No section matched the request with confidence -> check PDF pages strictly before giving up
  }

  if (allPages.length === 0) {
    return { visuals: [], hasAnyPdfVisualsOnSop: true, hasLegacyPdfWithoutVisuals };
  }

  const targetSectionTokens = bestSectionMatch
    ? tokenizeMatchText(bestSectionMatch.sec.title)
    : [];

  // 1. Prioritize explicit page numbers from AI metadata or explicitly cited in answer/question
  const targetPages =
    explicitPageNumbers && explicitPageNumbers.length > 0
      ? explicitPageNumbers
      : extractMentionedPageNumbers(`${userQuestion} ${msg.content}`);

  if (targetPages.length > 0) {
    const targetSet = new Set(targetPages);
    const exactMatches = allPages.filter((p) => targetSet.has(p.pageNumber));
    if (exactMatches.length > 0) {
      if (exactMatches.length === 1) {
        return {
          visuals: exactMatches,
          hasAnyPdfVisualsOnSop: true,
          hasLegacyPdfWithoutVisuals,
        };
      }
      const scoredExact = exactMatches
        .map((p) => scoreVisualCandidate(p, topicTokens, answerTokens, targetSectionTokens))
        .sort((a, b) => b.score - a.score || a.pageNumber - b.pageNumber);

      const best = scoredExact[0];
      const runnerUp = scoredExact[1];
      const multiPageRequested = new Set(targetPages).size > 1;
      const includeRunnerUp =
        runnerUp &&
        (multiPageRequested || best.pageNumber !== runnerUp.pageNumber) &&
        runnerUp.score >= 4 &&
        best.score - runnerUp.score <= 2;

      return {
        visuals: includeRunnerUp ? [best, runnerUp] : [best],
        hasAnyPdfVisualsOnSop: true,
        hasLegacyPdfWithoutVisuals,
      };
    }
    // Requested page number is not saved in allPages: only match via strong keyword hit (>= 6), never random page
    const strictPageMissFallback = allPages
      .map((p) => scoreVisualCandidate(p, topicTokens, answerTokens, targetSectionTokens))
      .filter((p) => p.score >= 6 && p.hasTopicHit)
      .sort((a, b) => b.score - a.score || a.pageNumber - b.pageNumber);
    return {
      visuals: strictPageMissFallback.length > 0 ? [strictPageMissFallback[0]] : [],
      hasAnyPdfVisualsOnSop: true,
      hasLegacyPdfWithoutVisuals,
    };
  }

  // 2. Fallback: strict keyword scoring against vp.caption — never return unrelated figure
  const scored = allPages
    .map((p) => scoreVisualCandidate(p, topicTokens, [...answerTokens, ...priorTokens], targetSectionTokens))
    .filter((p) => p.score >= 5 && p.hasTopicHit)
    .sort((a, b) => b.score - a.score || a.pageNumber - b.pageNumber);

  if (scored.length === 0) {
    return {
      visuals: [],
      hasAnyPdfVisualsOnSop: true,
      hasLegacyPdfWithoutVisuals,
    };
  }

  const best = scored[0];
  const runnerUp = scored[1];
  const selected =
    runnerUp &&
    best.pageNumber !== runnerUp.pageNumber &&
    runnerUp.score >= 5 &&
    best.score - runnerUp.score <= 2
      ? [best, runnerUp]
      : [best];

  return {
    visuals: selected,
    hasAnyPdfVisualsOnSop: true,
    hasLegacyPdfWithoutVisuals,
  };
}

function renderFormattedAnswer(text: string): React.ReactNode {
  const lines = text.split('\n');
  return (
    <div className="space-y-2 text-sm leading-relaxed text-slate-800 dark:text-slate-200">
      {lines.map((rawLine, idx) => {
        const line = rawLine.trim();
        if (!line) return <div key={idx} className="h-1" />;

        const isBullet = line.startsWith('- ') || line.startsWith('* ');
        const isNumbered = /^\d+\.\s/.test(line);
        const displayLine = isBullet ? line.slice(2).trim() : line;

        // Render bold segments (**text**)
        const parts = displayLine.split(/(\*\*[^*]+\*\*)/g).map((part, pIdx) => {
          if (part.startsWith('**') && part.endsWith('**')) {
            return (
              <strong key={pIdx} className="font-semibold text-slate-900 dark:text-slate-100">
                {part.slice(2, -2)}
              </strong>
            );
          }
          return part;
        });

        if (isNumbered) {
          return (
            <p key={idx} className="pl-2 text-slate-800 dark:text-slate-200">
              {parts}
            </p>
          );
        }

        if (isBullet) {
          return (
            <p key={idx} className="pl-4 text-slate-700 dark:text-slate-300">
              • {parts}
            </p>
          );
        }

        return <p key={idx}>{parts}</p>;
      })}
    </div>
  );
}

export const ChatQaView: React.FC<ChatQaViewProps> = ({
  user,
  idToken,
  divisions,
  directory,
  sops = [],
}) => {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedDivFilter, setSelectedDivFilter] = useState<string>('all');
  const [answerFormat, setAnswerFormat] = useState<AnswerDisplayFormat>('auto');
  const [visualMetaByMsgId, setVisualMetaByMsgId] = useState<Record<string, VisualIntentMeta>>({});
  const [perMessageOverride, setPerMessageOverride] = useState<
    Record<string, { showImage?: boolean; showDiagram?: boolean }>
  >({});
  const [lightboxImage, setLightboxImage] = useState<{
    url: string;
    title: string;
    downloadName: string;
  } | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [historyOpenMobile, setHistoryOpenMobile] = useState(false);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [copiedSummaryMsgId, setCopiedSummaryMsgId] = useState<string | null>(null);
  const [collapsedSummaries, setCollapsedSummaries] = useState<Record<string, boolean>>({});
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [noteEditorMsgId, setNoteEditorMsgId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingFeedback, setSavingFeedback] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const lastAutoScrollRef = useRef<number>(0);
  const skipNextFetchSessionIdRef = useRef<string | null>(null);

  const focusChatInput = () => {
    requestAnimationFrame(() => {
      chatInputRef.current?.focus({ preventScroll: true });
    });
  };

  useEffect(() => {
    focusChatInput();
  }, [activeSession?.id]);

  // Pre-warm server SOP chunk cache as soon as user opens Q&A view
  useEffect(() => {
    if (!idToken) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await getFreshIdToken(idToken);
        if (cancelled || !token) return;
        await fetch('/api/rag/warm', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        // Non-blocking warmup
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [idToken, user.uid]);

  useEffect(() => {
    let active = true;
    setLoadingSessions(true);
    fetchChatSessions(user.uid)
      .then((list) => {
        if (!active) return;
        setSessions(list);
        if (list.length > 0) {
          setActiveSession(list[0]);
        }
      })
      .catch((err) => {
        if (active) setErrorMsg(err instanceof Error ? err.message : 'Gagal memuat riwayat chat.');
      })
      .finally(() => {
        if (active) setLoadingSessions(false);
      });
    return () => {
      active = false;
    };
  }, [user.uid]);

  const activeSessionId = activeSession?.id || '';
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    if (skipNextFetchSessionIdRef.current === activeSessionId) {
      skipNextFetchSessionIdRef.current = null;
      return;
    }
    let active = true;
    fetchChatMessages(activeSessionId, user.uid)
      .then((list) => {
        if (active) setMessages(list);
      })
      .catch((err) => {
        if (active) setErrorMsg(err instanceof Error ? err.message : 'Gagal memuat pesan.');
      });
    return () => {
      active = false;
    };
  }, [activeSessionId, user.uid]);

  useEffect(() => {
    const now = Date.now();
    if (streamingMsgId) {
      if (now - lastAutoScrollRef.current >= 120) {
        lastAutoScrollRef.current = now;
        bottomRef.current?.scrollIntoView({ behavior: 'auto' });
      }
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, sending, streamingMsgId]);

  const handleNewChat = () => {
    if (sending) return;
    setActiveSession(null);
    setMessages([]);
    setErrorMsg(null);
    setHistoryOpenMobile(false);
    focusChatInput();
  };

  const handleSend = async (overrideText?: string) => {
    const questionText = (overrideText ?? input).trim();
    if (!questionText || sending) {
      focusChatInput();
      return;
    }

    setErrorMsg(null);
    setSending(true);
    if (!overrideText) setInput('');
    focusChatInput();

    const priorMessages = messages.slice(-8);
    const tempUserId = `temp_u_${Date.now()}`;
    const tempBotId = `temp_b_${Date.now()}`;
    const existingSessionId = activeSession?.id || '';

    const optimisticUserMsg: ChatMessage = {
      id: tempUserId,
      sessionId: existingSessionId,
      userId: user.uid,
      role: 'user',
      content: questionText,
      citations: [],
      hasConflict: false,
      answered: true,
      suggestedContact: '',
      feedback: 'none',
      feedbackNote: '',
      logId: '',
    };

    const optimisticBotMsg: ChatMessage = {
      id: tempBotId,
      sessionId: existingSessionId,
      userId: user.uid,
      role: 'assistant',
      content: '',
      citations: [],
      hasConflict: false,
      answered: true,
      suggestedContact: '',
      feedback: 'none',
      feedbackNote: '',
      logId: '',
    };

    setMessages((prev) => [...prev, optimisticUserMsg, optimisticBotMsg]);
    setStreamingMsgId(tempBotId);

    try {
      // Run Firestore session + user message persistence in parallel with AI streaming
      const sessionAndUserPromise = (async () => {
        let currentSession = activeSession;
        if (!currentSession) {
          currentSession = await createChatSession({
            user,
            title: questionText.slice(0, 80),
          });
          skipNextFetchSessionIdRef.current = currentSession.id;
          setSessions((prev) => [currentSession!, ...prev]);
          setActiveSession(currentSession);
        }
        const savedUserMsg = await saveChatMessage({
          sessionId: currentSession.id,
          userId: user.uid,
          role: 'user',
          content: questionText,
        });
        return { currentSession, savedUserMsg };
      })();

      const visualCatalog: SopVisualCatalogEntry[] = sops.map((sop) => ({
        sopId: sop.id,
        docNumber: sop.docNumber,
        title: sop.title,
        sectionsWithImages: (sop.sections || [])
          .filter((s) => (s.images || []).length > 0)
          .map((s) => ({
            order: s.order,
            title: s.title,
            captions: (s.images || []).map((im) => im.caption || s.title),
            ocrKeywords: (s.images || [])
              .map((im) => (im.ocrText || '').trim())
              .filter(Boolean),
          })),
        sectionsWithoutImages: (sop.sections || [])
          .filter((s) => !(s.images || []).length)
          .map((s) => ({
            order: s.order,
            title: s.title,
          })),
        pdfFigures: (sop.attachments || []).flatMap((a) =>
          (a.visualPages || []).map((vp) => ({
            pageNumber: vp.pageNumber,
            caption: vp.caption,
          }))
        ),
      }));

      const freshToken = await getFreshIdToken(idToken);
      const ragData = await streamApiSse<{
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
      }>(
        '/api/rag/ask-stream',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${freshToken}`,
          },
          body: JSON.stringify({
            question: questionText,
            history: [...priorMessages, optimisticUserMsg].slice(-8).map((m) => ({
              role: m.role,
              content: m.content,
            })),
            divisions,
            visualCatalog,
          }),
        },
        {
          fallbackError: 'Gagal mendapatkan jawaban AI.',
          onDelta: (chunk) => {
            setMessages((prev) =>
              prev.map((m) => (m.id === tempBotId ? { ...m, content: m.content + chunk } : m))
            );
          },
        }
      );

      const assistantContent =
        ragData.hasConflict && ragData.conflictSummary
          ? `${ragData.answerMarkdown}\n\n**Catatan Konflik SOP:** ${ragData.conflictSummary}`
          : ragData.answerMarkdown;

      const resolvedVisualMeta: VisualIntentMeta = {
        showVisual: Boolean(ragData.showVisual),
        visualType:
          ragData.visualType === 'diagram' || isDiagramRequest(questionText)
            ? 'diagram'
            : 'pdf_page',
        visualPageNumbers: Array.isArray(ragData.visualPageNumbers)
          ? ragData.visualPageNumbers
          : [],
      };

      // Immediately show finalized content, citations, and badges
      setStreamingMsgId(null);
      setVisualMetaByMsgId((prev) => ({
        ...prev,
        [tempBotId]: resolvedVisualMeta,
      }));
      setMessages((prev) =>
        prev.map((m) =>
          m.id === tempBotId
            ? {
                ...m,
                content: assistantContent,
                citations: ragData.citations,
                hasConflict: ragData.hasConflict,
                answered: ragData.answered,
                suggestedContact: ragData.suggestedContact,
              }
            : m
        )
      );

      const { currentSession, savedUserMsg } = await sessionAndUserPromise;
      const pregeneratedLogId = makeSafeId('qlog');
      const [, savedAssistantMsg] = await Promise.all([
        logQueryAndAnswer({
          id: pregeneratedLogId,
          user,
          question: questionText,
          answered: ragData.answered,
          matchedSopIds: ragData.matchedSopIds,
          primaryCitation: ragData.citations[0],
          directory,
        }),
        saveChatMessage({
          sessionId: currentSession.id,
          userId: user.uid,
          role: 'assistant',
          content: assistantContent,
          citations: ragData.citations,
          hasConflict: ragData.hasConflict,
          answered: ragData.answered,
          suggestedContact: ragData.suggestedContact,
          logId: pregeneratedLogId,
        }),
      ]);

      setVisualMetaByMsgId((prev) => {
        const next = { ...prev, [savedAssistantMsg.id]: resolvedVisualMeta };
        delete next[tempBotId];
        return next;
      });
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id === tempUserId) return savedUserMsg;
          if (m.id === tempBotId) return savedAssistantMsg;
          return m;
        })
      );
    } catch (err) {
      setStreamingMsgId(null);
      setMessages((prev) => prev.filter((m) => m.id !== tempBotId));
      setErrorMsg(err instanceof Error ? err.message : 'Terjadi kesalahan saat mengirim pertanyaan.');
    } finally {
      setSending(false);
      const activeTag = document.activeElement?.tagName;
      if (activeTag !== 'INPUT' && activeTag !== 'TEXTAREA') {
        focusChatInput();
      }
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    if (deletingSessionId) return;
    setDeletingSessionId(sessionId);
    setErrorMsg(null);
    try {
      await deleteChatSession(sessionId);
      setSessions((prev) => {
        const remaining = prev.filter((s) => s.id !== sessionId);
        if (activeSession?.id === sessionId) {
          setActiveSession(remaining[0] || null);
          if (remaining.length === 0) setMessages([]);
        }
        return remaining;
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal menghapus riwayat percakapan.');
    } finally {
      setDeletingSessionId(null);
    }
  };

  const handleFeedback = async (
    msg: ChatMessage,
    feedback: FeedbackType,
    feedbackNote = ''
  ) => {
    setSavingFeedback(true);
    setErrorMsg(null);
    try {
      await submitAnswerFeedback({
        sessionId: msg.sessionId,
        messageId: msg.id,
        logId: msg.logId,
        feedback,
        feedbackNote,
      });
      setMessages((prev) =>
        prev.map((m) => (m.id === msg.id ? { ...m, feedback, feedbackNote } : m))
      );
      if (feedback === 'inaccurate' || feedback === 'outdated') {
        setNoteEditorMsgId(msg.id);
        setNoteDraft(feedbackNote);
      } else if (noteEditorMsgId === msg.id) {
        setNoteEditorMsgId(null);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal menyimpan umpan balik.');
    } finally {
      setSavingFeedback(false);
    }
  };

  const handleSaveFeedbackNote = async (msg: ChatMessage) => {
    if (!msg.feedback || msg.feedback === 'none' || msg.feedback === 'helpful') return;
    setSavingFeedback(true);
    setErrorMsg(null);
    try {
      const trimmed = noteDraft.trim();
      await submitAnswerFeedback({
        sessionId: msg.sessionId,
        messageId: msg.id,
        logId: msg.logId,
        feedback: msg.feedback,
        feedbackNote: trimmed,
      });
      setMessages((prev) =>
        prev.map((m) => (m.id === msg.id ? { ...m, feedbackNote: trimmed } : m))
      );
      setNoteEditorMsgId(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal menyimpan catatan evaluasi.');
    } finally {
      setSavingFeedback(false);
    }
  };

  const handleCopyAnswer = async (msg: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopiedMsgId(msg.id);
      setTimeout(() => setCopiedMsgId((curr) => (curr === msg.id ? null : curr)), 2000);
    } catch {
      // Ignore clipboard failures in restricted frames
    }
  };

  const handleCopySummary = async (msgId: string, copyText: string) => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopiedSummaryMsgId(msgId);
      setTimeout(
        () => setCopiedSummaryMsgId((curr) => (curr === msgId ? null : curr)),
        2000
      );
    } catch {
      // Ignore clipboard failures in restricted frames
    }
  };

  const visualAssetsByMsgId = useMemo(() => {
    const map = new Map<
      string,
      {
        diagramUrl: string;
        pdfVisuals: ReferencedPdfVisual[];
        hasAnyPdfVisualsOnSop: boolean;
        hasLegacyPdfWithoutVisuals: boolean;
        aiSaidNoVisual: boolean;
        autoShowVisual: boolean;
        preferredType: 'pdf_page' | 'diagram';
      }
    >();
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'assistant' || msg.id === streamingMsgId || !msg.content.trim()) {
        continue;
      }
      const prevUserMsg =
        i > 0 && messages[i - 1].role === 'user' ? messages[i - 1].content : '';
      const priorContext = messages
        .slice(Math.max(0, i - 4), i)
        .map((m) => m.content)
        .join(' ');
      const meta = visualMetaByMsgId[msg.id];
      const aiSaidNoVisual = NO_VISUAL_REPLY_REGEX.test(msg.content);
      const userAskedDiagram = isDiagramRequest(prevUserMsg);
      const userAskedVisual = isVisualRequest(prevUserMsg);
      const preferredType: 'pdf_page' | 'diagram' =
        meta?.visualType ?? (userAskedDiagram ? 'diagram' : 'pdf_page');

      const {
        visuals: pdfVisuals,
        hasAnyPdfVisualsOnSop,
        hasLegacyPdfWithoutVisuals,
      } = findReferencedSopVisuals({
        msg,
        userQuestion: prevUserMsg,
        priorContext,
        sops,
        explicitPageNumbers: meta?.visualPageNumbers,
      });

      const hasVerifiedPdfMatch = pdfVisuals.length > 0;
      const inferredShowVisual =
        !aiSaidNoVisual &&
        (meta?.showVisual === true ||
          userAskedDiagram ||
          (userAskedVisual && (meta?.showVisual !== false || hasVerifiedPdfMatch)));

      const diagramUrl = renderSopAnswerToImage({
        question: prevUserMsg || 'Ringkasan Jawaban SOP',
        content: msg.content,
        citations: msg.citations,
        hasConflict: msg.hasConflict,
        answered: msg.answered,
      });

      map.set(msg.id, {
        diagramUrl,
        pdfVisuals,
        hasAnyPdfVisualsOnSop,
        hasLegacyPdfWithoutVisuals,
        aiSaidNoVisual,
        autoShowVisual: msg.answered !== false && inferredShowVisual,
        preferredType,
      });
    }
    return map;
  }, [messages, sops, streamingMsgId, visualMetaByMsgId]);

  const executiveSummariesByMsgId = useMemo(() => {
    const map = new Map<string, ExecutiveSummaryData>();
    for (const msg of messages) {
      if (msg.role !== 'assistant' || msg.id === streamingMsgId || !msg.content.trim()) {
        continue;
      }
      const summary = buildExecutiveSummary({
        content: msg.content,
        citations: msg.citations,
        answered: msg.answered,
      });
      if (summary) {
        map.set(msg.id, summary);
      }
    }
    return map;
  }, [messages, streamingMsgId]);

  const suggestedQuestions = divisions
    .filter((d) => selectedDivFilter === 'all' || d.id === selectedDivFilter)
    .flatMap((d) =>
      (d.suggestedQuestions || []).map((q) => ({
        divisionName: d.name,
        question: q,
      }))
    );

  return (
    <div className="h-[calc(100dvh-3.5rem)] flex flex-col lg:flex-row bg-slate-50 dark:bg-slate-950">
      {/* Left Conversation History (collapsible on mobile for instant chat access) */}
      <aside className="lg:w-72 border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 flex flex-col shrink-0">
        <div className="px-4 py-3 lg:p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setHistoryOpenMobile((v) => !v)}
            className="inline-flex items-center gap-1.5 text-left lg:pointer-events-none cursor-pointer"
          >
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Riwayat Tanya SOP
            </h2>
            <span className="lg:hidden font-mono text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              ({sessions.length})
            </span>
            <span className="lg:hidden text-slate-500 dark:text-slate-400">
              {historyOpenMobile ? (
                <ChevronUp className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </span>
          </button>
          <button
            type="button"
            onClick={handleNewChat}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-sky-600 rounded-md hover:bg-sky-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <MessageSquarePlus className="w-3.5 h-3.5" />
            <span>Tanya Baru</span>
          </button>
        </div>
        <div
          className={`${
            historyOpenMobile ? 'block max-h-48' : 'hidden'
          } lg:block lg:flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/70`}
        >
          {loadingSessions ? (
            <div className="p-4 space-y-2">
              <div className="h-4 bg-slate-100 dark:bg-slate-900 rounded w-3/4" />
              <div className="h-4 bg-slate-100 dark:bg-slate-900 rounded w-1/2" />
            </div>
          ) : sessions.length === 0 ? (
            <p className="p-4 text-xs text-slate-500 dark:text-slate-400">
              Belum ada percakapan. Mulai ajukan pertanyaan pertama Anda di bawah ini.
            </p>
          ) : (
            sessions.map((s) => (
              <div
                key={s.id}
                className={`group flex items-center justify-between gap-2 px-3 py-2 text-xs transition-colors ${
                  activeSession?.id === s.id
                    ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-900 dark:text-sky-200 font-medium'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-900'
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    setActiveSession(s);
                    setHistoryOpenMobile(false);
                  }}
                  className="flex-1 min-w-0 text-left py-1 cursor-pointer"
                >
                  <p className="truncate">{s.title}</p>
                </button>
                <button
                  type="button"
                  disabled={deletingSessionId === s.id}
                  onClick={() => handleDeleteSession(s.id)}
                  title="Hapus percakapan"
                  aria-label="Hapus percakapan"
                  className="p-1 text-slate-400 dark:text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 rounded transition-colors shrink-0 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Main Chat Canvas */}
      <section className="flex-1 flex flex-col min-w-0 bg-slate-50 dark:bg-slate-950">
        {/* Format Toggle Bar */}
        <div className="bg-white dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
            <ImageIcon className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
            <span>Sajian Jawaban AI:</span>
          </div>
          <div className="flex items-center gap-1 p-0.5 bg-slate-100 dark:bg-slate-900 border border-transparent dark:border-slate-800 rounded-lg">
            {(
              [
                { id: 'auto', label: 'Sesuai Alur' },
                { id: 'text_and_image', label: 'Selalu Gambar' },
                { id: 'text_only', label: 'Teks Saja' },
              ] as { id: AnswerDisplayFormat; label: string }[]
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  setAnswerFormat(opt.id);
                  setPerMessageOverride({});
                }}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  answerFormat === opt.id
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          <div className="max-w-3xl mx-auto space-y-6">
            {messages.length === 0 ? (
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 sm:p-8 space-y-6">
                <div className="space-y-2">
                  <h1 className="font-display text-xl sm:text-2xl font-bold text-slate-900 dark:text-slate-100">
                    Tanya Prosedur Kerja Perusahaan
                  </h1>
                  <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                    Jawaban AI hanya diambil dari SOP berstatus <strong>Disetujui</strong> yang sesuai dengan hak akses akun Anda ({user.role} · {user.divisionName || 'Semua Umum'}).
                  </p>
                </div>

                {/* Popular Question Suggestions per Division */}
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                      Saran Pertanyaan Populer per Divisi
                    </span>
                    <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
                      <button
                        type="button"
                        onClick={() => setSelectedDivFilter('all')}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          selectedDivFilter === 'all'
                            ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm'
                            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                        }`}
                      >
                        Semua Divisi
                      </button>
                      {divisions.map((div) => (
                        <button
                          key={div.id}
                          type="button"
                          onClick={() => setSelectedDivFilter(div.id)}
                          className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                            selectedDivFilter === div.id
                              ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm'
                              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                          }`}
                        >
                          {div.code}
                        </button>
                      ))}
                    </div>
                  </div>

                  {suggestedQuestions.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {suggestedQuestions.map((item, idx) => (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => handleSend(item.question)}
                          className="text-left p-3.5 bg-slate-50 dark:bg-slate-800/60 hover:bg-sky-50 dark:hover:bg-sky-950/50 border border-slate-200 dark:border-slate-700 hover:border-sky-300 dark:hover:border-sky-700 rounded-lg transition-colors cursor-pointer space-y-1"
                        >
                          <span className="block text-xs text-slate-500 dark:text-slate-400">
                            {item.divisionName}
                          </span>
                          <span className="block text-sm font-medium text-slate-900 dark:text-slate-100 leading-snug">
                            {item.question}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Ketik pertanyaan Anda di bawah untuk memulai pencarian SOP.
                    </p>
                  )}
                </div>
              </div>
            ) : (
              messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  {msg.role === 'user' ? (
                    <div className="max-w-xl bg-sky-600 text-white rounded-xl px-4 py-3 text-sm leading-relaxed">
                      {msg.content}
                    </div>
                  ) : (
                    <div className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
                      {streamingMsgId !== msg.id && msg.hasConflict && (
                        <div className="flex items-start gap-2.5 p-3 bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800/70 rounded-lg text-xs text-amber-900 dark:text-amber-200">
                          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                          <span>
                            <strong>Terdeteksi Perbedaan Ketentuan SOP:</strong> Terdapat dua SOP yang memuat ketentuan berbeda. Mohon konfirmasi kepada Pemilik Proses sebelum eksekusi.
                          </span>
                        </div>
                      )}

                      {streamingMsgId === msg.id && !msg.content ? (
                        <div className="space-y-2">
                          <p className="text-xs font-medium text-sky-700 dark:text-sky-400">
                            Menelusuri SOP yang relevan dan menyusun jawaban...
                          </p>
                          <div className="h-3 bg-slate-100 dark:bg-slate-800 rounded w-3/4 animate-pulse" />
                          <div className="h-3 bg-slate-100 dark:bg-slate-800 rounded w-1/2 animate-pulse" />
                        </div>
                      ) : (() => {
                        const isFinished = streamingMsgId !== msg.id;
                        const execSummary = isFinished
                          ? executiveSummariesByMsgId.get(msg.id)
                          : undefined;
                        const isSummaryCollapsed = Boolean(collapsedSummaries[msg.id]);
                        const visualAsset = isFinished ? visualAssetsByMsgId.get(msg.id) : undefined;
                        const override = perMessageOverride[msg.id];
                        const defaultShowImage =
                          answerFormat === 'text_and_image'
                            ? true
                            : answerFormat === 'auto'
                              ? Boolean(visualAsset?.autoShowVisual)
                              : false;
                        const showImage =
                          isFinished &&
                          Boolean(visualAsset) &&
                          (override?.showImage ?? defaultShowImage);

                        const hasPdfMatches = (visualAsset?.pdfVisuals.length || 0) > 0;
                        const showPdfSection = showImage && hasPdfMatches;
                        // In 'auto' mode, only show infographic automatically if user explicitly requested a diagram/flowchart;
                        // if user asked for a menu/SOP screenshot and none exists for that section, do NOT show an unrelated image.
                        const showDiagramSection =
                          showImage &&
                          Boolean(visualAsset?.diagramUrl) &&
                          (override?.showDiagram ??
                            (answerFormat === 'text_and_image' ||
                              visualAsset?.preferredType === 'diagram'));

                        return (
                          <div className="space-y-4">
                            <div>
                              {renderFormattedAnswer(msg.content)}
                              {streamingMsgId === msg.id && (
                                <span className="inline-block w-2 h-4 ml-1 bg-sky-600 dark:bg-sky-400 align-middle animate-pulse" />
                              )}
                            </div>

                            {execSummary && (
                              <div className="border border-sky-200/80 dark:border-sky-800/70 rounded-xl bg-sky-50/40 dark:bg-sky-950/35 overflow-hidden">
                                <div className="px-3.5 py-2.5 bg-white/80 dark:bg-slate-900/90 border-b border-sky-100 dark:border-sky-900/60 flex flex-wrap items-center justify-between gap-2">
                                  <div className="flex items-center gap-2 text-xs">
                                    <ListChecks className="w-4 h-4 text-sky-600 dark:text-sky-400 shrink-0" />
                                    <span className="font-display font-semibold text-slate-900 dark:text-slate-100">
                                      Executive Summary
                                    </span>
                                    <span className="text-slate-400 dark:text-slate-500">·</span>
                                    <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                                      {execSummary.keyPoints.length} poin utama
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleCopySummary(msg.id, execSummary.copyText)
                                      }
                                      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 rounded cursor-pointer"
                                    >
                                      {copiedSummaryMsgId === msg.id ? (
                                        <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                                      ) : (
                                        <Copy className="w-3 h-3" />
                                      )}
                                      <span>
                                        {copiedSummaryMsgId === msg.id
                                          ? 'Tersalin'
                                          : 'Salin Ringkasan'}
                                      </span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setCollapsedSummaries((prev) => ({
                                          ...prev,
                                          [msg.id]: !prev[msg.id],
                                        }))
                                      }
                                      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 rounded cursor-pointer"
                                    >
                                      {isSummaryCollapsed ? (
                                        <>
                                          <ChevronDown className="w-3 h-3" />
                                          <span>Tampilkan</span>
                                        </>
                                      ) : (
                                        <>
                                          <ChevronUp className="w-3 h-3" />
                                          <span>Ringkas</span>
                                        </>
                                      )}
                                    </button>
                                  </div>
                                </div>

                                {!isSummaryCollapsed && (
                                  <div className="p-3.5 sm:p-4 space-y-2.5">
                                    <p className="text-xs sm:text-[13px] font-medium text-slate-900 dark:text-slate-100 leading-relaxed">
                                      {execSummary.coreTakeaway}
                                    </p>
                                    <ul className="space-y-1.5 text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                                      {execSummary.keyPoints.map((kp, kpIdx) => (
                                        <li key={kpIdx} className="flex items-start gap-2">
                                          <span className="font-mono text-[11px] font-semibold text-sky-700 dark:text-sky-400 tabular-nums shrink-0 mt-0.5">
                                            {kpIdx + 1}.
                                          </span>
                                          <span>
                                            {kp.label && (
                                              <strong className="font-semibold text-slate-900 dark:text-slate-100 mr-1">
                                                {kp.label}:
                                              </strong>
                                            )}
                                            {kp.detail}
                                          </span>
                                        </li>
                                      ))}
                                    </ul>
                                    {execSummary.highlights.length > 0 && (
                                      <div className="pt-1.5 flex flex-wrap gap-1.5">
                                        {execSummary.highlights.map((hl, hlIdx) => (
                                          <span
                                            key={hlIdx}
                                            className="px-2 py-0.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-[11px] font-mono text-slate-700 dark:text-slate-300"
                                          >
                                            {hl}
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}

                            {showImage && visualAsset && (
                              <div className="space-y-3 pt-1">
                                {showPdfSection && (
                                  <div className="border border-slate-200 dark:border-slate-700 rounded-xl p-3.5 bg-slate-50/70 dark:bg-slate-800/50 space-y-2.5">
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200">
                                        <FileText className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
                                        <span>
                                          Contoh Gambar Menu SOP (
                                          {visualAsset.pdfVisuals.length === 1
                                            ? visualAsset.pdfVisuals[0].sourceKind === 'section'
                                              ? `Bagian ${visualAsset.pdfVisuals[0].sectionOrder || 1}`
                                              : `Hal. ${visualAsset.pdfVisuals[0].pageNumber}`
                                            : `${visualAsset.pdfVisuals.length} gambar`}
                                          )
                                        </span>
                                      </span>
                                    </div>
                                    <div
                                      className={`grid gap-3 ${
                                        visualAsset.pdfVisuals.length === 1
                                          ? 'grid-cols-1'
                                          : 'grid-cols-1 sm:grid-cols-2'
                                      }`}
                                    >
                                      {visualAsset.pdfVisuals.map((vp, vIdx) => {
                                        const badgeLocation =
                                          vp.sourceKind === 'section'
                                            ? `Bagian ${vp.sectionOrder || 1}`
                                            : `Hal. ${vp.pageNumber}`;
                                        const dlName =
                                          vp.sourceKind === 'section'
                                            ? `${vp.docNumber}-bagian-${vp.sectionOrder || 1}.jpg`
                                            : `${vp.docNumber}-hal-${vp.pageNumber}.jpg`;
                                        return (
                                        <div
                                          key={`${vp.attachmentName}-${vp.pageNumber}-${vIdx}`}
                                          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden"
                                        >
                                          <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2 text-xs">
                                            <span className="font-mono font-semibold text-sky-700 dark:text-sky-400 truncate">
                                              {vp.docNumber} · {badgeLocation}
                                            </span>
                                            <div className="flex items-center gap-1.5 shrink-0">
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  setLightboxImage({
                                                    url: vp.dataUrl,
                                                    title: `${vp.docNumber} · ${vp.caption}`,
                                                    downloadName: dlName,
                                                  })
                                                }
                                                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded cursor-pointer"
                                              >
                                                <Maximize2 className="w-3 h-3" />
                                                <span>Perbesar</span>
                                              </button>
                                              <a
                                                href={vp.dataUrl}
                                                download={dlName}
                                                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/60 hover:bg-sky-100 dark:hover:bg-sky-900/60 rounded"
                                              >
                                                <Download className="w-3 h-3" />
                                                <span>Unduh</span>
                                              </a>
                                            </div>
                                          </div>
                                          <button
                                            type="button"
                                            onClick={() =>
                                              setLightboxImage({
                                                url: vp.dataUrl,
                                                title: `${vp.docNumber} · ${vp.caption}`,
                                                downloadName: dlName,
                                              })
                                            }
                                            className="block w-full bg-white dark:bg-slate-950 cursor-zoom-in p-2"
                                          >
                                            <img
                                              src={vp.dataUrl}
                                              alt={vp.caption}
                                              className="w-full max-h-[420px] object-contain mx-auto bg-white rounded"
                                            />
                                          </button>
                                          {vp.caption && (
                                            <p className="px-3 py-1.5 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-600 dark:text-slate-400 truncate">
                                              {vp.caption}
                                            </p>
                                          )}
                                        </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                )}

                                {showImage &&
                                  !hasPdfMatches &&
                                  !visualAsset.aiSaidNoVisual &&
                                  visualAsset.preferredType === 'pdf_page' &&
                                  visualAsset.autoShowVisual && (
                                    <div className="p-3 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-700 dark:text-slate-300 flex flex-wrap items-center justify-between gap-2">
                                      <span>
                                        {visualAsset.hasLegacyPdfWithoutVisuals
                                          ? 'Gambar untuk bagian/menu ini belum tersedia di SOP. Admin dapat mengunggah foto modul melalui menu Edit SOP atau memperbarui lampiran PDF.'
                                          : 'Gambar atau tangkapan layar untuk bagian/menu ini belum tersedia pada dokumen SOP.'}
                                      </span>
                                      {!showDiagramSection && (
                                        <button
                                          type="button"
                                          onClick={() =>
                                            setPerMessageOverride((prev) => ({
                                              ...prev,
                                              [msg.id]: {
                                                ...prev[msg.id],
                                                showImage: true,
                                                showDiagram: true,
                                              },
                                            }))
                                          }
                                          className="px-2.5 py-1 text-[11px] font-medium bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 rounded hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
                                        >
                                          Buat Ringkasan Infografis
                                        </button>
                                      )}
                                    </div>
                                  )}

                                {showDiagramSection && (
                                  <div className="border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden bg-slate-50 dark:bg-slate-800/50">
                                    <div className="px-3.5 py-2 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 flex flex-wrap items-center justify-between gap-2 text-xs">
                                      <span className="inline-flex items-center gap-1.5 font-semibold text-slate-800 dark:text-slate-200">
                                        <ImageIcon className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
                                        <span>Jawaban Visual (Infografis Alur)</span>
                                      </span>
                                      <div className="flex items-center gap-1.5">
                                        <button
                                          type="button"
                                          onClick={() =>
                                            setLightboxImage({
                                              url: visualAsset.diagramUrl,
                                              title: 'Jawaban Visual SOP Brain',
                                              downloadName: `jawaban-sop-${msg.id.slice(-6)}.png`,
                                            })
                                          }
                                          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded cursor-pointer"
                                        >
                                          <Maximize2 className="w-3 h-3" />
                                          <span>Perbesar</span>
                                        </button>
                                        <a
                                          href={visualAsset.diagramUrl}
                                          download={`jawaban-sop-${msg.id.slice(-6)}.png`}
                                          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/60 hover:bg-sky-100 dark:hover:bg-sky-900/60 rounded"
                                        >
                                          <Download className="w-3 h-3" />
                                          <span>Unduh PNG</span>
                                        </a>
                                      </div>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setLightboxImage({
                                          url: visualAsset.diagramUrl,
                                          title: 'Jawaban Visual SOP Brain',
                                          downloadName: `jawaban-sop-${msg.id.slice(-6)}.png`,
                                        })
                                      }
                                      className="block w-full bg-white dark:bg-slate-950 cursor-zoom-in"
                                    >
                                      <img
                                        src={visualAsset.diagramUrl}
                                        alt="Sajian gambar jawaban prosedur SOP"
                                        className="w-full h-auto block"
                                      />
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {/* Feedback & Copy controls */}
                      {streamingMsgId !== msg.id && (
                      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2.5 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-slate-500 dark:text-slate-400">Apakah jawaban ini membantu?</span>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleCopyAnswer(msg)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                            >
                              {copiedMsgId === msg.id ? (
                                <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                              <span>{copiedMsgId === msg.id ? 'Tersalin' : 'Salin'}</span>
                            </button>
                            <button
                              type="button"
                              disabled={savingFeedback || msg.id.startsWith('temp_')}
                              onClick={() => handleFeedback(msg, 'helpful', '')}
                              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                msg.feedback === 'helpful'
                                  ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-300 dark:border-emerald-700 text-emerald-800 dark:text-emerald-300 font-medium'
                                  : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700'
                              }`}
                            >
                              {msg.feedback === 'helpful' ? (
                                <Check className="w-3.5 h-3.5" />
                              ) : (
                                <ThumbsUp className="w-3.5 h-3.5" />
                              )}
                              <span>Berguna</span>
                            </button>
                            <button
                              type="button"
                              disabled={savingFeedback || msg.id.startsWith('temp_')}
                              onClick={() =>
                                handleFeedback(msg, 'inaccurate', msg.feedbackNote || '')
                              }
                              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                msg.feedback === 'inaccurate'
                                  ? 'bg-rose-50 dark:bg-rose-950/60 border-rose-300 dark:border-rose-700 text-rose-800 dark:text-rose-300 font-medium'
                                  : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700'
                              }`}
                            >
                              <ThumbsDown className="w-3.5 h-3.5" />
                              <span>Tidak Akurat</span>
                            </button>
                            <button
                              type="button"
                              disabled={savingFeedback || msg.id.startsWith('temp_')}
                              onClick={() =>
                                handleFeedback(msg, 'outdated', msg.feedbackNote || '')
                              }
                              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                msg.feedback === 'outdated'
                                  ? 'bg-amber-50 dark:bg-amber-950/60 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300 font-medium'
                                  : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700'
                              }`}
                            >
                              <Clock className="w-3.5 h-3.5" />
                              <span>SOP Sudah Usang</span>
                            </button>
                          </div>
                        </div>

                        {noteEditorMsgId === msg.id ? (
                          <div className="space-y-2 bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 rounded-lg p-2.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-[11px] font-medium text-slate-600 dark:text-slate-300">
                                Pilih alasan cepat atau tulis detail:
                              </span>
                              {[
                                'Nominal/plafon sudah berubah',
                                'Langkah di sistem berbeda',
                                'PIC/approver perlu diperbarui',
                                'Penjelasan kurang lengkap',
                              ].map((reason) => (
                                <button
                                  key={reason}
                                  type="button"
                                  onClick={() =>
                                    setNoteDraft((prev) =>
                                      prev.trim()
                                        ? prev.includes(reason)
                                          ? prev
                                          : `${prev.trim()}; ${reason}`
                                        : reason
                                    )
                                  }
                                  className="px-2 py-0.5 text-[11px] rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-sky-50 dark:hover:bg-sky-950/60 hover:border-sky-300 dark:hover:border-sky-700 cursor-pointer"
                                >
                                  + {reason}
                                </button>
                              ))}
                            </div>
                            <div className="flex flex-col sm:flex-row gap-2">
                              <input
                                type="text"
                                autoFocus
                                value={noteDraft}
                                onChange={(e) => setNoteDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    void handleSaveFeedbackNote(msg);
                                  }
                                }}
                                placeholder="Jelaskan bagian mana yang keliru atau sudah berubah agar admin bisa meninjau..."
                                className="flex-1 px-2.5 py-1.5 text-xs bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500"
                              />
                              <div className="flex items-center gap-1.5 shrink-0">
                                <button
                                  type="button"
                                  disabled={savingFeedback}
                                  onClick={() => handleSaveFeedbackNote(msg)}
                                  className="px-3 py-1.5 text-xs font-medium text-white bg-sky-600 hover:bg-sky-700 rounded-md cursor-pointer"
                                >
                                  Simpan Catatan
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setNoteEditorMsgId(null)}
                                  className="px-2.5 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-md cursor-pointer"
                                >
                                  Tutup
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : (
                          (msg.feedback === 'inaccurate' || msg.feedback === 'outdated') && (
                            <div className="flex items-center justify-between gap-2 text-[11px] text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 rounded-md px-2.5 py-1.5">
                              <span className="truncate">
                                {msg.feedbackNote
                                  ? `Catatan Anda: ${msg.feedbackNote}`
                                  : 'Terima kasih atas masukan Anda. Tambahkan catatan detail jika diperlukan.'}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  setNoteEditorMsgId(msg.id);
                                  setNoteDraft(msg.feedbackNote || '');
                                }}
                                className="text-sky-700 dark:text-sky-400 hover:underline font-medium shrink-0 cursor-pointer"
                              >
                                {msg.feedbackNote ? 'Ubah Catatan' : 'Tambah Catatan'}
                              </button>
                            </div>
                          )
                        )}
                      </div>
                      )}
                    </div>
                  )}
                </div>
              ))
            )}

            {errorMsg && (
              <div className="p-3.5 bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800/70 rounded-lg text-xs text-rose-800 dark:text-rose-200">
                {errorMsg}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* Bottom Input Bar */}
        <div className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-3 sm:p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleSend();
            }}
            className="max-w-3xl mx-auto flex items-center gap-2.5"
          >
            <input
              ref={chatInputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Tanyakan prosedur kerja, batas persetujuan, atau formulir SOP..."
              aria-label="Kolom pertanyaan SOP"
              className="flex-1 px-4 py-2.5 text-sm bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500 focus:bg-white dark:focus:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500"
            />
            <button
              type="submit"
              onMouseDown={(e) => e.preventDefault()}
              disabled={!input.trim() || sending}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-sky-600 rounded-lg hover:bg-sky-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Send className="w-4 h-4" />
              <span className="hidden sm:inline">Kirim</span>
            </button>
          </form>
        </div>
      </section>

      {lightboxImage && (
        <div
          onClick={() => setLightboxImage(null)}
          className="fixed inset-0 z-50 bg-slate-900/75 dark:bg-slate-950/85 flex items-center justify-center p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white dark:bg-slate-900 rounded-xl max-w-4xl w-full max-h-[92vh] flex flex-col overflow-hidden border border-slate-200 dark:border-slate-800"
          >
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
              <p className="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate">
                {lightboxImage.title}
              </p>
              <div className="flex items-center gap-2 shrink-0">
                <a
                  href={lightboxImage.url}
                  download={lightboxImage.downloadName}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/60 hover:bg-sky-100 dark:hover:bg-sky-900/60 rounded-md"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Unduh Gambar</span>
                </a>
                <button
                  type="button"
                  onClick={() => setLightboxImage(null)}
                  className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                  aria-label="Tutup gambar"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4 bg-slate-100 dark:bg-slate-950 flex items-center justify-center">
              <img
                src={lightboxImage.url}
                alt={lightboxImage.title}
                className="max-w-full max-h-[78vh] object-contain rounded shadow-sm bg-white"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
