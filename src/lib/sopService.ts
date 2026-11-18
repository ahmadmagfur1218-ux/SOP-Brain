import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import type { User as FirebaseUser } from 'firebase/auth';
import { fetchApiJson } from './apiClient';
import {
  BOOTSTRAP_ADMIN_EMAIL,
  OperationType,
  db,
  getFreshIdToken,
  handleFirestoreError,
} from './firebase';
import { SEED_DEPARTMENTS, SEED_DIVISIONS, SEED_SOPS } from './seedData';
import type {
  AccessLevel,
  AuditLog,
  ChatMessage,
  ChatSession,
  CitationSource,
  Department,
  DirectoryMember,
  Division,
  FeedbackType,
  QueryLog,
  SopChunk,
  SopDocument,
  SopStatus,
  SopVersionSnapshot,
  UserProfile,
  UserRole,
} from '../types/sop';

export function makeSafeId(prefix: string): string {
  const clean = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return clean.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 120);
}

export async function syncUserProfileAndDirectory(fbUser: FirebaseUser): Promise<UserProfile> {
  const userRef = doc(db, 'users', fbUser.uid);
  const dirRef = doc(db, 'directory', fbUser.uid);

  try {
    const existingSnap = await getDoc(userRef);
    const isBootstrap = fbUser.email === BOOTSTRAP_ADMIN_EMAIL;

    if (existingSnap.exists()) {
      const data = existingSnap.data() as UserProfile;
      const desiredRole: UserRole = isBootstrap ? 'Super Admin' : data.role;
      const displayName = (fbUser.displayName || data.displayName || fbUser.email || 'Pengguna').slice(0, 120);
      const photoURL = (fbUser.photoURL || data.photoURL || '').slice(0, 500);

      if (data.displayName !== displayName || data.role !== desiredRole) {
        await updateDoc(userRef, {
          displayName,
          photoURL,
          ...(isBootstrap && data.role !== 'Super Admin' ? { role: 'Super Admin' } : {}),
          updatedAt: serverTimestamp(),
        });
      }

      const dirSnap = await getDoc(dirRef);
      const dirPayload = {
        uid: fbUser.uid,
        displayName,
        role: desiredRole,
        divisionId: data.divisionId || '',
        divisionName: data.divisionName || 'Belum Ditetapkan',
        updatedAt: serverTimestamp(),
      };
      if (!dirSnap.exists()) {
        await setDoc(dirRef, dirPayload);
      } else if (
        dirSnap.data().displayName !== displayName ||
        dirSnap.data().role !== desiredRole
      ) {
        await updateDoc(dirRef, {
          displayName,
          ...(isBootstrap ? { role: 'Super Admin', divisionId: data.divisionId || '', divisionName: data.divisionName || 'Belum Ditetapkan' } : {}),
          updatedAt: serverTimestamp(),
        });
      }

      return {
        ...data,
        displayName,
        photoURL,
        role: desiredRole,
      };
    }

    const initialRole: UserRole = isBootstrap ? 'Super Admin' : 'Karyawan';
    const displayName = (fbUser.displayName || fbUser.email?.split('@')[0] || 'Pengguna').slice(0, 120);
    const email = (fbUser.email || '').slice(0, 254);
    const photoURL = (fbUser.photoURL || '').slice(0, 500);

    const newProfile = {
      uid: fbUser.uid,
      email,
      displayName,
      photoURL,
      role: initialRole,
      divisionId: '',
      divisionName: 'Belum Ditetapkan',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    await setDoc(userRef, newProfile);
    await setDoc(dirRef, {
      uid: fbUser.uid,
      displayName,
      role: initialRole,
      divisionId: '',
      divisionName: 'Belum Ditetapkan',
      updatedAt: serverTimestamp(),
    });

    return {
      uid: fbUser.uid,
      email,
      displayName,
      photoURL,
      role: initialRole,
      divisionId: '',
      divisionName: 'Belum Ditetapkan',
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `users/${fbUser.uid}`);
  }
}

export async function fetchDivisions(): Promise<Division[]> {
  try {
    const snap = await getDocs(collection(db, 'divisions'));
    return snap.docs
      .map((d) => d.data() as Division)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'divisions');
  }
}

export async function fetchDepartments(): Promise<Department[]> {
  try {
    const snap = await getDocs(collection(db, 'departments'));
    return snap.docs
      .map((d) => d.data() as Department)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'departments');
  }
}

export async function fetchDirectoryMembers(): Promise<DirectoryMember[]> {
  try {
    const snap = await getDocs(collection(db, 'directory'));
    return snap.docs
      .map((d) => d.data() as DirectoryMember)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'directory');
  }
}

export async function fetchAdminUsersList(currentUser: UserProfile): Promise<UserProfile[]> {
  try {
    if (currentUser.email === BOOTSTRAP_ADMIN_EMAIL) {
      const snap = await getDocs(collection(db, 'users'));
      return snap.docs.map((d) => d.data() as UserProfile);
    }
    const members = await fetchDirectoryMembers();
    const results: UserProfile[] = [];
    for (const m of members) {
      try {
        const s = await getDoc(doc(db, 'users', m.uid));
        if (s.exists()) {
          results.push(s.data() as UserProfile);
        }
      } catch {
        // Skip inaccessible user docs
      }
    }
    return results;
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'users');
  }
}

export async function updateUserRoleAndDivision(params: {
  targetUid: string;
  role: UserRole;
  divisionId: string;
  divisionName: string;
  allSops: SopDocument[];
  directory?: DirectoryMember[];
  actor?: UserProfile;
}): Promise<void> {
  const { targetUid, role, divisionId, divisionName, allSops, directory = [], actor } = params;
  try {
    await updateDoc(doc(db, 'users', targetUid), {
      role,
      divisionId,
      divisionName: divisionName || 'Belum Ditetapkan',
      updatedAt: serverTimestamp(),
    });
    await updateDoc(doc(db, 'directory', targetUid), {
      role,
      divisionId,
      divisionName: divisionName || 'Belum Ditetapkan',
      updatedAt: serverTimestamp(),
    });

    // Recompute viewerUids on existing SOPs & approved chunks so new role/division permissions apply immediately
    const updatedDirectory: DirectoryMember[] = directory.some((m) => m.uid === targetUid)
      ? directory.map((m) =>
          m.uid === targetUid
            ? { ...m, role, divisionId, divisionName: divisionName || 'Belum Ditetapkan' }
            : m
        )
      : [
          ...directory,
          {
            uid: targetUid,
            displayName: '',
            role,
            divisionId,
            divisionName: divisionName || 'Belum Ditetapkan',
          },
        ];

    for (const s of allSops) {
      const nextViewers = computeViewerUids({
        divisionId: s.divisionId,
        accessLevel: s.accessLevel,
        allowedUserUids: s.allowedUserUids || [],
        createdByUid: s.createdByUid,
        ownerUid: s.ownerUid,
        directory: updatedDirectory,
      });

      const currSet = new Set(s.viewerUids || []);
      const changed =
        nextViewers.length !== currSet.size || nextViewers.some((uid) => !currSet.has(uid));
      if (!changed) continue;

      await updateDoc(doc(db, 'sops', s.id), {
        viewerUids: nextViewers,
        updatedAt: serverTimestamp(),
      });

      if (s.status === 'Disetujui') {
        const chunkQuery =
          !actor || actor.email === BOOTSTRAP_ADMIN_EMAIL
            ? query(collection(db, 'sopChunks'), where('sopId', '==', s.id))
            : query(
                collection(db, 'sopChunks'),
                where('sopId', '==', s.id),
                where('viewerUids', 'array-contains', actor.uid)
              );
        const chunkSnap = await getDocs(chunkQuery);
        for (const cDoc of chunkSnap.docs) {
          await updateDoc(cDoc.ref, { viewerUids: nextViewers });
        }
      }
    }
    void invalidateServerRagCache();
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `users/${targetUid}`);
  }
}

function invalidateServerRagCache(tokenOverride?: string): Promise<void> {
  return (async () => {
    try {
      const token = tokenOverride || (await getFreshIdToken());
      if (!token) return;
      await fetch('/api/rag/invalidate-cache', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // Non-critical cache invalidation; 60s TTL handles eventual consistency
    }
  })();
}

export function computeViewerUids(params: {
  divisionId: string;
  accessLevel: AccessLevel;
  allowedUserUids: string[];
  createdByUid: string;
  ownerUid: string;
  directory: DirectoryMember[];
}): string[] {
  const set = new Set<string>();
  if (params.createdByUid) set.add(params.createdByUid);
  if (params.ownerUid) set.add(params.ownerUid);

  for (const m of params.directory) {
    if (m.role === 'Super Admin') {
      set.add(m.uid);
    } else if (m.role === 'Admin Divisi' && m.divisionId === params.divisionId) {
      set.add(m.uid);
    } else if (params.accessLevel === 'Per Divisi' && m.divisionId === params.divisionId) {
      set.add(m.uid);
    }
  }

  if (params.accessLevel === 'Rahasia') {
    for (const uid of params.allowedUserUids) {
      if (uid) set.add(uid);
    }
  }

  return Array.from(set).slice(0, 200);
}

export async function fetchAccessibleSops(user: UserProfile): Promise<SopDocument[]> {
  try {
    if (user.email === BOOTSTRAP_ADMIN_EMAIL) {
      const snap = await getDocs(collection(db, 'sops'));
      return snap.docs.map((d) => d.data() as SopDocument);
    }

    const [publicSnap, scopedSnap, ownSnap] = await Promise.all([
      getDocs(
        query(
          collection(db, 'sops'),
          where('status', '==', 'Disetujui'),
          where('accessLevel', '==', 'Umum')
        )
      ),
      getDocs(
        query(collection(db, 'sops'), where('viewerUids', 'array-contains', user.uid))
      ),
      getDocs(
        query(collection(db, 'sops'), where('createdByUid', '==', user.uid))
      ),
    ]);

    const map = new Map<string, SopDocument>();
    for (const snap of [publicSnap, scopedSnap, ownSnap]) {
      for (const d of snap.docs) {
        const data = d.data() as SopDocument;
        map.set(data.id, data);
      }
    }
    return Array.from(map.values());
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'sops');
  }
}

export async function fetchSopById(sopId: string): Promise<SopDocument | null> {
  try {
    const snap = await getDoc(doc(db, 'sops', sopId));
    return snap.exists() ? (snap.data() as SopDocument) : null;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `sops/${sopId}`);
  }
}

export async function fetchSopVersions(sop: SopDocument, user: UserProfile): Promise<SopVersionSnapshot[]> {
  try {
    const colRef = collection(db, 'sops', sop.id, 'versions');
    let q;
    if (user.email === BOOTSTRAP_ADMIN_EMAIL) {
      q = query(colRef, where('sopId', '==', sop.id));
    } else if (sop.status === 'Disetujui' && sop.accessLevel === 'Umum') {
      q = query(
        colRef,
        where('sopId', '==', sop.id),
        where('status', '==', 'Disetujui'),
        where('accessLevel', '==', 'Umum')
      );
    } else {
      q = query(
        colRef,
        where('sopId', '==', sop.id),
        where('viewerUids', 'array-contains', user.uid)
      );
    }

    const snap = await getDocs(q);
    return snap.docs
      .map((d) => d.data() as SopVersionSnapshot)
      .sort((a, b) => b.version - a.version);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, `sops/${sop.id}/versions`);
  }
}

async function deleteExistingSopChunks(sopId: string, user: UserProfile): Promise<void> {
  try {
    const colRef = collection(db, 'sopChunks');
    let snap;
    if (user.email === BOOTSTRAP_ADMIN_EMAIL) {
      snap = await getDocs(query(colRef, where('sopId', '==', sopId)));
    } else {
      snap = await getDocs(
        query(colRef, where('sopId', '==', sopId), where('viewerUids', 'array-contains', user.uid))
      );
    }
    for (const d of snap.docs) {
      await deleteDoc(d.ref);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `sopChunks/${sopId}`);
  }
}

export async function saveSopWithVersionAndIndex(params: {
  sop: SopDocument;
  isNew: boolean;
  changeNote: string;
  actor: UserProfile;
  directory: DirectoryMember[];
  idToken: string;
}): Promise<SopDocument> {
  const { sop, isNew, changeNote, actor, directory, idToken } = params;

  const viewerUids = computeViewerUids({
    divisionId: sop.divisionId,
    accessLevel: sop.accessLevel,
    allowedUserUids: sop.allowedUserUids,
    createdByUid: sop.createdByUid,
    ownerUid: sop.ownerUid,
    directory,
  });

  const cleanSop: SopDocument = {
    id: sop.id,
    docNumber: sop.docNumber.trim().slice(0, 60),
    title: sop.title.trim().slice(0, 240),
    divisionId: sop.divisionId,
    divisionName: sop.divisionName.slice(0, 120),
    departmentId: sop.departmentId,
    departmentName: sop.departmentName.slice(0, 120),
    purpose: sop.purpose.slice(0, 4000),
    scope: sop.scope.slice(0, 4000),
    ownerUid: sop.ownerUid.slice(0, 128),
    ownerName: sop.ownerName.slice(0, 120),
    relatedRoles: sop.relatedRoles.slice(0, 20),
    sections: sop.sections.slice(0, 40).map((sec, idx) => ({
      id: sec.id || makeSafeId(`sec_${idx + 1}`),
      order: sec.order || idx + 1,
      title: (sec.title || `Bagian ${idx + 1}`).slice(0, 240),
      content: sec.content || '',
      ...(sec.images && sec.images.length > 0
        ? {
            images: sec.images.slice(0, 12).map((im, imIdx) => ({
              id: im.id || makeSafeId(`img_${imIdx + 1}`),
              caption: (im.caption || sec.title || `Gambar ${imIdx + 1}`).slice(0, 240),
              dataUrl: im.dataUrl,
              fileName: (im.fileName || '').slice(0, 160),
              ...(im.ocrText ? { ocrText: im.ocrText.slice(0, 480) } : {}),
              ...(im.aiWarning ? { aiWarning: im.aiWarning.slice(0, 240) } : {}),
            })),
          }
        : {}),
    })),
    attachments: sop.attachments.slice(0, 20),
    effectiveDate: sop.effectiveDate.slice(0, 20),
    nextReviewDate: sop.nextReviewDate.slice(0, 20),
    status: sop.status,
    accessLevel: sop.accessLevel,
    allowedUserUids: sop.allowedUserUids.slice(0, 100),
    viewerUids,
    version: sop.version,
    createdByUid: sop.createdByUid,
    createdByName: sop.createdByName.slice(0, 120),
    approvedByUid: sop.status === 'Disetujui' ? (sop.approvedByUid || actor.uid).slice(0, 128) : sop.approvedByUid.slice(0, 128),
    approvedByName: sop.status === 'Disetujui' ? (sop.approvedByName || actor.displayName).slice(0, 120) : sop.approvedByName.slice(0, 120),
  };

  try {
    const sopRef = doc(db, 'sops', cleanSop.id);
    if (isNew) {
      await setDoc(sopRef, {
        ...cleanSop,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(sopRef, {
        docNumber: cleanSop.docNumber,
        title: cleanSop.title,
        divisionId: cleanSop.divisionId,
        divisionName: cleanSop.divisionName,
        departmentId: cleanSop.departmentId,
        departmentName: cleanSop.departmentName,
        purpose: cleanSop.purpose,
        scope: cleanSop.scope,
        ownerUid: cleanSop.ownerUid,
        ownerName: cleanSop.ownerName,
        relatedRoles: cleanSop.relatedRoles,
        sections: cleanSop.sections,
        attachments: cleanSop.attachments,
        effectiveDate: cleanSop.effectiveDate,
        nextReviewDate: cleanSop.nextReviewDate,
        status: cleanSop.status,
        accessLevel: cleanSop.accessLevel,
        allowedUserUids: cleanSop.allowedUserUids,
        viewerUids: cleanSop.viewerUids,
        version: cleanSop.version,
        approvedByUid: cleanSop.approvedByUid,
        approvedByName: cleanSop.approvedByName,
        updatedAt: serverTimestamp(),
      });
    }

    const versionId = makeSafeId(`v${cleanSop.version}`);
    await setDoc(doc(db, 'sops', cleanSop.id, 'versions', versionId), {
      id: versionId,
      sopId: cleanSop.id,
      version: cleanSop.version,
      docNumber: cleanSop.docNumber,
      title: cleanSop.title,
      purpose: cleanSop.purpose,
      scope: cleanSop.scope,
      relatedRoles: cleanSop.relatedRoles,
      sections: cleanSop.sections,
      attachments: cleanSop.attachments,
      effectiveDate: cleanSop.effectiveDate,
      nextReviewDate: cleanSop.nextReviewDate,
      status: cleanSop.status,
      accessLevel: cleanSop.accessLevel,
      createdByUid: cleanSop.createdByUid,
      ownerUid: cleanSop.ownerUid,
      viewerUids: cleanSop.viewerUids,
      changeNote: (changeNote || (isNew ? 'Pembuatan SOP awal' : 'Pembaruan SOP')).slice(0, 500),
      editedByUid: actor.uid,
      editedByName: actor.displayName.slice(0, 120),
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, isNew ? OperationType.CREATE : OperationType.UPDATE, `sops/${cleanSop.id}`);
  }

  // Sync RAG chunks only if user has approval permission (Super Admin or Admin Divisi)
  if (actor.role === 'Super Admin' || (actor.role === 'Admin Divisi' && actor.divisionId === cleanSop.divisionId)) {
    await deleteExistingSopChunks(cleanSop.id, actor);

    if (cleanSop.status === 'Disetujui') {
      const sopForEmbed: SopDocument = {
        ...cleanSop,
        sections: cleanSop.sections.map((sec) => ({
          ...sec,
          images: sec.images?.map((im) => ({ ...im, dataUrl: '' })),
        })),
        attachments: cleanSop.attachments.map((att) => ({
          ...att,
          visualPages: att.visualPages?.map((vp) => ({ ...vp, dataUrl: '' })),
        })),
      };
      const { chunks } = await fetchApiJson<{ chunks: Omit<SopChunk, 'createdAt'>[] }>(
        '/api/sop/embed',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({ sop: sopForEmbed }),
        },
        'Gagal membuat embedding indeks RAG.'
      );
      try {
        for (const chunk of chunks) {
          await setDoc(doc(db, 'sopChunks', chunk.id), {
            ...chunk,
            createdAt: serverTimestamp(),
          });
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, 'sopChunks');
      }
    } else {
      void invalidateServerRagCache(idToken);
    }
  }

  // Record immutable audit trail
  await recordAuditLog({
    actor,
    action: isNew ? 'Buat SOP' : `Update SOP (${cleanSop.status} v${cleanSop.version})`,
    targetType: 'SOP',
    targetId: cleanSop.id,
    targetLabel: `${cleanSop.docNumber} — ${cleanSop.title}`,
    divisionId: cleanSop.divisionId,
    detail: changeNote || (isNew ? 'Pembuatan SOP baru' : `Status: ${cleanSop.status}`),
    directory,
  });

  return cleanSop;
}

export async function deleteSopAndChunks(
  sop: SopDocument,
  actor: UserProfile,
  directory: DirectoryMember[] = []
): Promise<void> {
  await deleteExistingSopChunks(sop.id, actor);
  try {
    await deleteDoc(doc(db, 'sops', sop.id));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `sops/${sop.id}`);
  }
  void invalidateServerRagCache();
  await recordAuditLog({
    actor,
    action: 'Hapus SOP',
    targetType: 'SOP',
    targetId: sop.id,
    targetLabel: `${sop.docNumber} — ${sop.title}`,
    divisionId: sop.divisionId,
    detail: `Menghapus SOP versi v${sop.version}`,
    directory,
  });
}

export async function createOrUpdateDivision(params: {
  division: Omit<Division, 'createdAt' | 'updatedAt'>;
  isNew: boolean;
}): Promise<void> {
  const { division, isNew } = params;
  try {
    const ref = doc(db, 'divisions', division.id);
    if (isNew) {
      await setDoc(ref, {
        ...division,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        name: division.name,
        code: division.code,
        description: division.description,
        leadUid: division.leadUid,
        leadName: division.leadName,
        suggestedQuestions: division.suggestedQuestions,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `divisions/${division.id}`);
  }
}

export async function createDepartment(dept: Omit<Department, 'createdAt' | 'updatedAt'>): Promise<void> {
  try {
    await setDoc(doc(db, 'departments', dept.id), {
      ...dept,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `departments/${dept.id}`);
  }
}

export async function deleteDivision(divisionId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'divisions', divisionId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `divisions/${divisionId}`);
  }
}

export async function deleteDepartment(departmentId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'departments', departmentId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `departments/${departmentId}`);
  }
}

export async function ensureDivisionAndDepartment(params: {
  actor: UserProfile;
  divisions: Division[];
  departments: Department[];
  preferredDivisionId?: string;
  preferredDepartmentId?: string;
  suggestedDivisionName?: string;
  suggestedDepartmentName?: string;
}): Promise<{ division: Division; department: Department; created: boolean }> {
  const {
    actor,
    divisions,
    departments,
    preferredDivisionId,
    preferredDepartmentId,
    suggestedDivisionName,
    suggestedDepartmentName,
  } = params;

  let created = false;
  let division =
    divisions.find((d) => d.id === preferredDivisionId) ||
    (suggestedDivisionName
      ? divisions.find((d) =>
          d.name.toLowerCase().includes(suggestedDivisionName.toLowerCase())
        )
      : undefined) ||
    divisions[0];

  if (!division) {
    if (actor.role !== 'Super Admin') {
      throw new Error(
        'Divisi belum tersedia. Hubungi Super Admin untuk membuat atau memuat struktur Divisi terlebih dahulu.'
      );
    }
    const cleanName = (suggestedDivisionName || 'Operasional Umum').trim().slice(0, 120);
    const codeRaw = cleanName
      .replace(/[^a-zA-Z\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 6);
    const divId = makeSafeId('div');
    const newDiv: Omit<Division, 'createdAt' | 'updatedAt'> = {
      id: divId,
      name: cleanName,
      code: codeRaw || 'OPS',
      description: 'Dibuat otomatis saat penyimpanan SOP',
      leadUid: actor.uid,
      leadName: actor.displayName.slice(0, 120),
      suggestedQuestions: [],
    };
    await createOrUpdateDivision({ division: newDiv, isNew: true });
    division = newDiv;
    created = true;
  }

  let department =
    departments.find((d) => d.id === preferredDepartmentId && d.divisionId === division!.id) ||
    (suggestedDepartmentName
      ? departments.find(
          (d) =>
            d.divisionId === division!.id &&
            d.name.toLowerCase().includes(suggestedDepartmentName.toLowerCase())
        )
      : undefined) ||
    departments.find((d) => d.divisionId === division!.id);

  if (!department) {
    const canCreateDept =
      actor.role === 'Super Admin' ||
      (actor.role === 'Admin Divisi' && actor.divisionId === division.id);
    if (!canCreateDept) {
      throw new Error(
        `Departemen untuk divisi "${division.name}" belum tersedia. Hubungi Admin Divisi atau Super Admin.`
      );
    }
    const deptName = (suggestedDepartmentName || 'Umum').trim().slice(0, 120);
    const deptCodeRaw = deptName
      .replace(/[^a-zA-Z\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 6);
    const deptId = makeSafeId('dept');
    const newDept: Omit<Department, 'createdAt' | 'updatedAt'> = {
      id: deptId,
      divisionId: division.id,
      divisionName: division.name,
      name: deptName,
      code: `${division.code}-${deptCodeRaw || 'GEN'}`.slice(0, 20),
      description: 'Dibuat otomatis saat penyimpanan SOP',
    };
    await createDepartment(newDept);
    department = newDept;
    created = true;
  }

  return { division, department, created };
}

export async function fetchChatSessions(userId: string): Promise<ChatSession[]> {
  try {
    const snap = await getDocs(
      query(collection(db, 'chatSessions'), where('userId', '==', userId))
    );
    return snap.docs
      .map((d) => d.data() as ChatSession)
      .sort((a, b) => {
        const ta = (a.updatedAt as { seconds?: number })?.seconds || 0;
        const tb = (b.updatedAt as { seconds?: number })?.seconds || 0;
        return tb - ta;
      })
      .slice(0, 30);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'chatSessions');
  }
}

export async function createChatSession(params: {
  user: UserProfile;
  title: string;
}): Promise<ChatSession> {
  const id = makeSafeId('chat');
  const session: ChatSession = {
    id,
    userId: params.user.uid,
    userName: params.user.displayName.slice(0, 120),
    divisionId: params.user.divisionId || '',
    title: params.title.slice(0, 200),
  };
  try {
    await setDoc(doc(db, 'chatSessions', id), {
      ...session,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return session;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `chatSessions/${id}`);
  }
}

export async function deleteChatSession(sessionId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'chatSessions', sessionId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `chatSessions/${sessionId}`);
  }
}

export async function fetchChatMessages(sessionId: string, userId: string): Promise<ChatMessage[]> {
  try {
    const snap = await getDocs(
      query(
        collection(db, 'chatSessions', sessionId, 'messages'),
        where('userId', '==', userId)
      )
    );
    return snap.docs
      .map((d) => d.data() as ChatMessage)
      .sort((a, b) => {
        const ta = (a.createdAt as { seconds?: number })?.seconds || 0;
        const tb = (b.createdAt as { seconds?: number })?.seconds || 0;
        return ta - tb;
      });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, `chatSessions/${sessionId}/messages`);
  }
}

export async function saveChatMessage(params: {
  sessionId: string;
  userId: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: CitationSource[];
  hasConflict?: boolean;
  answered?: boolean;
  suggestedContact?: string;
  logId?: string;
}): Promise<ChatMessage> {
  const id = makeSafeId('msg');
  const payload: ChatMessage = {
    id,
    sessionId: params.sessionId,
    userId: params.userId,
    role: params.role,
    content: params.content.slice(0, 24000),
    citations: (params.citations || []).slice(0, 12),
    hasConflict: Boolean(params.hasConflict),
    answered: params.answered ?? true,
    suggestedContact: (params.suggestedContact || '').slice(0, 300),
    feedback: 'none',
    feedbackNote: '',
    logId: (params.logId || '').slice(0, 128),
  };

  try {
    await Promise.all([
      setDoc(doc(db, 'chatSessions', params.sessionId, 'messages', id), {
        ...payload,
        createdAt: serverTimestamp(),
      }),
      updateDoc(doc(db, 'chatSessions', params.sessionId), {
        updatedAt: serverTimestamp(),
      }),
    ]);
    return payload;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `chatSessions/${params.sessionId}/messages/${id}`);
  }
}

export async function logQueryAndAnswer(params: {
  id?: string;
  user: UserProfile;
  question: string;
  answered: boolean;
  matchedSopIds: string[];
  primaryCitation?: CitationSource;
  directory: DirectoryMember[];
}): Promise<string> {
  const id = params.id || makeSafeId('qlog');
  const adminViewerUids = Array.from(
    new Set(
      params.directory
        .filter((m) => m.role === 'Super Admin' || (m.role === 'Admin Divisi' && m.divisionId === params.user.divisionId))
        .map((m) => m.uid)
    )
  ).slice(0, 50);

  try {
    await setDoc(doc(db, 'queryLogs', id), {
      id,
      userId: params.user.uid,
      userName: params.user.displayName.slice(0, 120),
      divisionId: params.user.divisionId || 'general',
      divisionName: params.user.divisionName || 'Umum',
      question: params.question.slice(0, 1000),
      answered: params.answered,
      matchedSopIds: params.matchedSopIds.slice(0, 10),
      primarySopId: params.primaryCitation?.sopId || '',
      primarySopTitle: params.primaryCitation?.title || '',
      primarySopDocNumber: params.primaryCitation?.docNumber || '',
      feedback: 'none',
      feedbackNote: '',
      resolvedAsSopId: '',
      adminViewerUids,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return id;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `queryLogs/${id}`);
  }
}

export async function submitAnswerFeedback(params: {
  sessionId: string;
  messageId: string;
  logId: string;
  feedback: FeedbackType;
  feedbackNote?: string;
}): Promise<void> {
  const note = (params.feedbackNote || '').slice(0, 500);
  try {
    const updates: Promise<void>[] = [
      updateDoc(doc(db, 'chatSessions', params.sessionId, 'messages', params.messageId), {
        feedback: params.feedback,
        feedbackNote: note,
      }),
    ];
    if (params.logId) {
      updates.push(
        updateDoc(doc(db, 'queryLogs', params.logId), {
          feedback: params.feedback,
          feedbackNote: note,
          updatedAt: serverTimestamp(),
        })
      );
    }
    await Promise.all(updates);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `chatSessions/${params.sessionId}/messages/${params.messageId}`);
  }
}

export async function fetchQueryLogsForAdmin(user: UserProfile): Promise<QueryLog[]> {
  try {
    let snap;
    if (user.email === BOOTSTRAP_ADMIN_EMAIL) {
      snap = await getDocs(collection(db, 'queryLogs'));
    } else {
      snap = await getDocs(
        query(collection(db, 'queryLogs'), where('adminViewerUids', 'array-contains', user.uid))
      );
    }
    return snap.docs
      .map((d) => d.data() as QueryLog)
      .sort((a, b) => {
        const ta = (a.createdAt as { seconds?: number })?.seconds || 0;
        const tb = (b.createdAt as { seconds?: number })?.seconds || 0;
        return tb - ta;
      });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'queryLogs');
  }
}

export async function markQueryGapResolved(logId: string, sopId: string): Promise<void> {
  try {
    await updateDoc(doc(db, 'queryLogs', logId), {
      resolvedAsSopId: sopId,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `queryLogs/${logId}`);
  }
}

export function stripSopMediaForAi(sop: SopDocument): SopDocument {
  return {
    ...sop,
    sections: sop.sections.map((sec) => ({
      ...sec,
      images: sec.images?.map((im) => ({ ...im, dataUrl: '' })),
    })),
    attachments: sop.attachments.map((att) => ({
      ...att,
      visualPages: att.visualPages?.map((vp) => ({ ...vp, dataUrl: '' })),
    })),
  };
}

export async function runPrePublishConflictCheck(params: {
  candidateSop: SopDocument;
  allSops: SopDocument[];
  idToken: string;
}): Promise<import('../types/sop').PrePublishConflictReport> {
  const approvedOthers = params.allSops
    .filter((s) => s.status === 'Disetujui' && s.id !== params.candidateSop.id)
    .map(stripSopMediaForAi);

  if (approvedOthers.length === 0) {
    return {
      hasIssues: false,
      checkedCount: 0,
      summary: 'Belum ada SOP Disetujui lain untuk dibandingkan.',
      conflicts: [],
    };
  }

  return fetchApiJson<import('../types/sop').PrePublishConflictReport>(
    '/api/ai/check-publish-conflicts',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.idToken}`,
      },
      body: JSON.stringify({
        candidateSop: stripSopMediaForAi(params.candidateSop),
        existingApprovedSops: approvedOthers,
      }),
    },
    'Gagal memeriksa konflik antar SOP sebelum penyimpanan.'
  );
}

export async function recordAuditLog(params: {
  actor: UserProfile;
  action: string;
  targetType: AuditLog['targetType'];
  targetId: string;
  targetLabel: string;
  divisionId: string;
  detail: string;
  directory: DirectoryMember[];
}): Promise<void> {
  const id = makeSafeId('audit');
  const adminViewerUids = Array.from(
    new Set(
      params.directory
        .filter(
          (m) =>
            m.role === 'Super Admin' ||
            (m.role === 'Admin Divisi' && m.divisionId === params.divisionId)
        )
        .map((m) => m.uid)
    )
  ).slice(0, 50);

  try {
    await setDoc(doc(db, 'auditLogs', id), {
      id,
      actorUid: params.actor.uid,
      actorName: params.actor.displayName.slice(0, 120),
      action: params.action.slice(0, 80),
      targetType: params.targetType,
      targetId: params.targetId.slice(0, 128),
      targetLabel: params.targetLabel.slice(0, 240),
      divisionId: params.divisionId.slice(0, 128),
      detail: params.detail.slice(0, 500),
      adminViewerUids,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `auditLogs/${id}`);
  }
}

export async function fetchAuditLogs(user: UserProfile): Promise<AuditLog[]> {
  try {
    let snap;
    if (user.email === BOOTSTRAP_ADMIN_EMAIL) {
      snap = await getDocs(collection(db, 'auditLogs'));
    } else {
      snap = await getDocs(
        query(collection(db, 'auditLogs'), where('adminViewerUids', 'array-contains', user.uid))
      );
    }
    return snap.docs
      .map((d) => d.data() as AuditLog)
      .sort((a, b) => {
        const ta = (a.createdAt as { seconds?: number })?.seconds || 0;
        const tb = (b.createdAt as { seconds?: number })?.seconds || 0;
        return tb - ta;
      })
      .slice(0, 100);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'auditLogs');
  }
}

export async function seedInitialEnterpriseData(params: {
  actor: UserProfile;
  directory: DirectoryMember[];
  idToken: string;
  onProgress?: (label: string) => void;
}): Promise<void> {
  const { actor, directory, idToken, onProgress } = params;

  onProgress?.('Membuat struktur Divisi & Departemen...');
  for (const div of SEED_DIVISIONS) {
    await setDoc(doc(db, 'divisions', div.id), {
      ...div,
      leadUid: actor.uid,
      leadName: actor.displayName.slice(0, 120),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  for (const dept of SEED_DEPARTMENTS) {
    await setDoc(doc(db, 'departments', dept.id), {
      ...dept,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  for (const tpl of SEED_SOPS) {
    onProgress?.(`Mengindeks ${tpl.docNumber}: ${tpl.title}...`);
    const sop: SopDocument = {
      id: tpl.id,
      docNumber: tpl.docNumber,
      title: tpl.title,
      divisionId: tpl.divisionId,
      divisionName: tpl.divisionName,
      departmentId: tpl.departmentId,
      departmentName: tpl.departmentName,
      purpose: tpl.purpose,
      scope: tpl.scope,
      ownerUid: tpl.assignOwner ? actor.uid : '',
      ownerName: tpl.assignOwner ? actor.displayName : '',
      relatedRoles: tpl.relatedRoles,
      sections: tpl.sections,
      attachments: tpl.attachments,
      effectiveDate: tpl.effectiveDate,
      nextReviewDate: tpl.nextReviewDate,
      status: tpl.status,
      accessLevel: tpl.accessLevel,
      allowedUserUids: tpl.accessLevel === 'Rahasia' ? [actor.uid] : [],
      viewerUids: [actor.uid],
      version: 1,
      createdByUid: actor.uid,
      createdByName: actor.displayName,
      approvedByUid: actor.uid,
      approvedByName: actor.displayName,
    };

    await saveSopWithVersionAndIndex({
      sop,
      isNew: true,
      changeNote: 'Inisialisasi SOP standar perusahaan',
      actor,
      directory,
      idToken,
    });
  }
}
