export type UserRole = 'Super Admin' | 'Admin Divisi' | 'Penulis' | 'Karyawan';

export type SopStatus = 'Draft' | 'Review' | 'Disetujui' | 'Arsip';

export type AccessLevel = 'Umum' | 'Per Divisi' | 'Rahasia';

export type FeedbackType = 'none' | 'helpful' | 'inaccurate' | 'outdated';

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  role: UserRole;
  divisionId: string;
  divisionName: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface DirectoryMember {
  uid: string;
  displayName: string;
  role: UserRole;
  divisionId: string;
  divisionName: string;
  updatedAt?: unknown;
}

export interface Division {
  id: string;
  name: string;
  code: string;
  description: string;
  leadUid: string;
  leadName: string;
  suggestedQuestions: string[];
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Department {
  id: string;
  divisionId: string;
  divisionName: string;
  name: string;
  code: string;
  description: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface SopSectionImage {
  id: string;
  caption: string;
  dataUrl: string;
  fileName?: string;
  ocrText?: string;
  aiWarning?: string;
}

export interface SopSection {
  id: string;
  order: number;
  title: string;
  content: string;
  images?: SopSectionImage[];
}

export interface SopAttachmentVisualPage {
  pageNumber: number;
  caption: string;
  dataUrl: string;
}

export interface SopAttachment {
  id: string;
  name: string;
  fileType: string;
  sizeLabel: string;
  extractedText: string;
  visualPages?: SopAttachmentVisualPage[];
}

export interface SopDocument {
  id: string;
  docNumber: string;
  title: string;
  divisionId: string;
  divisionName: string;
  departmentId: string;
  departmentName: string;
  purpose: string;
  scope: string;
  ownerUid: string;
  ownerName: string;
  relatedRoles: string[];
  sections: SopSection[];
  attachments: SopAttachment[];
  effectiveDate: string;
  nextReviewDate: string;
  status: SopStatus;
  accessLevel: AccessLevel;
  allowedUserUids: string[];
  viewerUids: string[];
  version: number;
  createdByUid: string;
  createdByName: string;
  approvedByUid: string;
  approvedByName: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface SopVersionSnapshot {
  id: string;
  sopId: string;
  version: number;
  docNumber: string;
  title: string;
  purpose: string;
  scope: string;
  relatedRoles: string[];
  sections: SopSection[];
  attachments: SopAttachment[];
  effectiveDate: string;
  nextReviewDate: string;
  status: SopStatus;
  accessLevel: AccessLevel;
  createdByUid: string;
  ownerUid: string;
  viewerUids: string[];
  changeNote: string;
  editedByUid: string;
  editedByName: string;
  createdAt?: unknown;
}

export interface SopChunk {
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
  embedding: number[];
  status: 'Disetujui';
  accessLevel: AccessLevel;
  viewerUids: string[];
  ownerUid: string;
  ownerName: string;
  createdAt?: unknown;
}

export interface CitationSource {
  sopId: string;
  docNumber: string;
  title: string;
  version: number;
  sectionTitle: string;
  divisionName: string;
}

export interface ChatSession {
  id: string;
  userId: string;
  userName: string;
  divisionId: string;
  title: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  userId: string;
  role: 'user' | 'assistant';
  content: string;
  citations: CitationSource[];
  hasConflict: boolean;
  answered: boolean;
  suggestedContact: string;
  feedback: FeedbackType;
  feedbackNote: string;
  logId: string;
  createdAt?: unknown;
}

export interface QueryLog {
  id: string;
  userId: string;
  userName: string;
  divisionId: string;
  divisionName: string;
  question: string;
  answered: boolean;
  matchedSopIds: string[];
  primarySopId: string;
  primarySopTitle: string;
  primarySopDocNumber: string;
  feedback: FeedbackType;
  feedbackNote: string;
  resolvedAsSopId: string;
  adminViewerUids: string[];
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface AiSopDraft {
  title: string;
  docNumber: string;
  suggestedDivisionName: string;
  suggestedDepartmentName: string;
  purpose: string;
  scope: string;
  relatedRoles: string[];
  sections: { title: string; content: string }[];
  attachmentSummary: string;
}

export interface AuditLog {
  id: string;
  actorUid: string;
  actorName: string;
  action: string;
  targetType: 'SOP' | 'USER' | 'DIVISION' | 'DEPARTMENT';
  targetId: string;
  targetLabel: string;
  divisionId: string;
  detail: string;
  adminViewerUids: string[];
  createdAt?: unknown;
}

export type ConflictType = 'Konflik Aturan' | 'Duplikasi' | 'Tumpang Tindih PIC';

export interface SopConflictItem {
  sopAId: string;
  sopADocNumber: string;
  sopATitle: string;
  sopBId: string;
  sopBDocNumber: string;
  sopBTitle: string;
  conflictType?: ConflictType;
  severity: 'Tinggi' | 'Sedang' | 'Rendah';
  description: string;
  recommendation: string;
}

export interface PrePublishConflictItem {
  existingSopId: string;
  existingDocNumber: string;
  existingTitle: string;
  conflictType: ConflictType;
  severity: 'Tinggi' | 'Sedang' | 'Rendah';
  description: string;
  recommendation: string;
}

export interface PrePublishConflictReport {
  hasIssues: boolean;
  summary: string;
  checkedCount: number;
  conflicts: PrePublishConflictItem[];
}

export interface SopFeedbackRevisionResult {
  title: string;
  purpose: string;
  scope: string;
  relatedRoles: string[];
  sections: { id?: string; title: string; content: string }[];
  changeSummary: string;
  revisionNotes: string;
}

