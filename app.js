import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";

// ── Config ────────────────────────────────────────────────────────────────────
// Firebase web config is safe to commit publicly.
// Security is enforced by Firestore Security Rules AND the ALLOWED_EMAIL check below.
const firebaseConfig = {
  apiKey:            "AIzaSyAS0zUJaiPdSEcPPGhO0VV5oLSsR_C-4Bg",
  authDomain:        "my-notes-a464a.firebaseapp.com",
  projectId:         "my-notes-a464a",
  storageBucket:     "my-notes-a464a.firebasestorage.app",
  messagingSenderId: "248033077250",
  appId:             "1:248033077250:web:f6bd46f4369ad707a39f1b",
};

// ── Firebase ──────────────────────────────────────────────────────────────────
const firebaseApp    = initializeApp(firebaseConfig);
const auth           = getAuth(firebaseApp);
const db             = getFirestore(firebaseApp);
const googleProvider = new GoogleAuthProvider();

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const loadingScreen    = $('loading-screen');
const loginScreen      = $('login-screen');
const appEl            = $('app');
const googleSigninBtn  = $('google-signin-btn');
const signoutBtn       = $('signout-btn');
const userAvatar       = $('user-avatar');
const searchInput      = $('search-input');
const newNoteBtn       = $('new-note-btn');
const notesList        = $('notes-list');
const emptyState       = $('empty-state');
const editorEl         = $('editor');
const noteTitle        = $('note-title');
const noteContent      = $('note-content');
const saveStatus       = $('save-status');
const deleteNoteBtn    = $('delete-note-btn');
const previewBtn       = $('preview-btn');
const previewEl        = $('note-preview');
const deleteModal      = $('delete-modal');
const cancelDeleteBtn  = $('cancel-delete-btn');
const confirmDeleteBtn = $('confirm-delete-btn');
const backBtn          = $('back-btn');

// ── State ─────────────────────────────────────────────────────────────────────
let currentUser       = null;
let notes             = [];       // in-memory snapshot cache, ordered by updatedAt desc
let currentNoteId     = null;
let saveTimer         = null;
let activeSavePromise = null;     // tracks in-flight Firestore write for save-race detection
let openNoteGen       = 0;        // increments on each openNote call to cancel stale ones
let unsubNotes        = null;     // Firestore real-time listener cleanup fn
let isPreviewMode     = false;

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relativeTime(date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs  < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7)  return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── Access control ────────────────────────────────────────────────────────────
// Only this Google account may use the app. Anyone else is signed out immediately.
// Server-side enforcement is in Firestore Security Rules (rules reject other UIDs too).
const ALLOWED_EMAIL = 'REDACTED';


googleSigninBtn.addEventListener('click', async () => {
  googleSigninBtn.disabled = true;
  try {
    // Popup works on personal devices (no cross-origin ITP issue, no redirect loop).
    // If the org browser blocks the popup, fall back to redirect automatically.
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    if (err.code === 'auth/popup-blocked') {
      // Org policy blocks popups — use redirect instead.
      try {
        await signInWithRedirect(auth, googleProvider);
        // Page navigates away; button stays disabled intentionally.
      } catch (redirectErr) {
        console.error('Redirect sign-in error:', redirectErr);
        googleSigninBtn.disabled = false;
        alert(`Sign-in failed.\n\nError: ${redirectErr.code}\n${redirectErr.message}`);
      }
    } else {
      if (err.code !== 'auth/popup-closed-by-user') {
        console.error('Sign-in error:', err);
        alert(`Sign-in failed.\n\nError: ${err.code}\n${err.message}`);
      }
      googleSigninBtn.disabled = false;
    }
  }
});

// Handle the return from a redirect sign-in (org-laptop fallback path).
// onAuthStateChanged fires automatically on success; this only catches errors.
getRedirectResult(auth).catch(err => {
  console.error('Redirect result error:', err);
  alert(`Sign-in failed.\n\nError: ${err.code}\n${err.message}`);
});

signoutBtn.addEventListener('click', async () => {
  try {
    await flushPendingSave();
    await signOut(auth);
  } catch (err) {
    console.error('Sign-out error:', err);
    alert('Sign-out failed. Please try again.');
  }
});

// ── Markdown preview ──────────────────────────────────────────────────────────
const SVG_EYE = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="16" height="16" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.574-3.007-9.964-7.178z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" /></svg>`;
const SVG_PENCIL = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="16" height="16" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931zm0 0L19.5 7.125" /></svg>`;

function enterPreview() {
  if (!window.marked || !window.DOMPurify) {
    alert('Markdown preview unavailable — check your connection and reload.');
    return;
  }
  isPreviewMode = true;
  const raw = window.marked.parse(noteContent.value ?? '');
  previewEl.innerHTML = window.DOMPurify.sanitize(raw);
  // Open links in a new tab safely
  previewEl.querySelectorAll('a').forEach(a => {
    a.target  = '_blank';
    a.rel     = 'noopener noreferrer';
  });
  noteContent.classList.add('hidden');
  previewEl.classList.remove('hidden');
  previewBtn.innerHTML = SVG_PENCIL;
  previewBtn.title       = 'Edit';
  previewBtn.setAttribute('aria-label', 'Edit note');
}

function enterEdit() {
  isPreviewMode = false;
  previewEl.classList.add('hidden');
  noteContent.classList.remove('hidden');
  noteContent.focus();
  previewBtn.innerHTML = SVG_EYE;
  previewBtn.title       = 'Preview';
  previewBtn.setAttribute('aria-label', 'Preview note');
}

previewBtn.addEventListener('click', () => {
  isPreviewMode ? enterEdit() : enterPreview();
});


let authResolved = false;
onAuthStateChanged(auth, async user => {
  // First callback: dismiss loading screen and reveal the correct view.
  if (!authResolved) {
    authResolved = true;
    loadingScreen.classList.add('hidden');
  }
  currentUser = user;
  if (user) {
    // Reject anyone who isn't the allowed account — sign them out immediately.
    if (user.email?.toLowerCase() !== ALLOWED_EMAIL.toLowerCase()) {
      await signOut(auth);
      alert(`Access denied.\n\nReceived email: ${user.email}\nExpected: ${ALLOWED_EMAIL}\n\nIf this is you, update ALLOWED_EMAIL in app.js.`);
      return;
    }
    userAvatar.src = user.photoURL ?? '';
    userAvatar.alt = user.displayName ?? 'User';
    loginScreen.classList.add('hidden');
    appEl.classList.remove('hidden');
    subscribeNotes();
  } else {
    if (unsubNotes) { unsubNotes(); unsubNotes = null; }
    notes             = [];
    currentNoteId     = null;
    clearTimeout(saveTimer);
    saveTimer         = null;
    activeSavePromise = null;
    // Clear all UI state to prevent stale note content being visible after sign-out.
    closeModal();
    $('sync-error').classList.add('hidden');
    noteTitle.value        = '';
    noteContent.value      = '';
    saveStatus.textContent = '';
    notesList.innerHTML    = '';
    editorEl.classList.add('hidden');
    emptyState.classList.remove('hidden');
    // Reset preview state so next login opens in edit mode.
    isPreviewMode = false;
    previewEl.classList.add('hidden');
    noteContent.classList.remove('hidden');
    previewBtn.innerHTML = SVG_EYE;
    previewBtn.title = 'Preview';
    previewBtn.setAttribute('aria-label', 'Preview note');
    appEl.classList.add('hidden');
    loginScreen.classList.remove('hidden');
  }
});

// ── Firestore ─────────────────────────────────────────────────────────────────
function notesCol() {
  return collection(db, 'users', currentUser.uid, 'notes');
}

function noteRef(id) {
  return doc(db, 'users', currentUser.uid, 'notes', id);
}

function subscribeNotes() {
  if (unsubNotes) unsubNotes();
  const q = query(notesCol(), orderBy('updatedAt', 'desc'));
  unsubNotes = onSnapshot(q, snap => {
    $('sync-error').classList.add('hidden');
    notes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderList();
    // If the open note was deleted (e.g. from another device), close the editor.
    if (currentNoteId && !notes.find(n => n.id === currentNoteId)) {
      currentNoteId = null;
      showEmptyState();
    }
  }, err => {
    console.error('Notes listener error:', err);
    $('sync-error').classList.remove('hidden');
  });
}

async function persistNote(id, title, content) {
  await updateDoc(noteRef(id), { title, content, updatedAt: serverTimestamp() });
}

// ── Pending-save flush ────────────────────────────────────────────────────────
async function flushPendingSave() {
  // If a debounce timer is pending, fire the save immediately.
  if (saveTimer && currentNoteId) {
    clearTimeout(saveTimer);
    saveTimer = null;
    const p = persistNote(currentNoteId, noteTitle.value, noteContent.value);
    activeSavePromise = p;
    p.catch(console.error).finally(() => { if (activeSavePromise === p) activeSavePromise = null; });
  }
  // Await any in-flight write (timer already fired but Firestore write is still pending).
  if (activeSavePromise) {
    try { await activeSavePromise; } catch (_) { /* best-effort */ }
  }
}

// ── New Note ──────────────────────────────────────────────────────────────────
newNoteBtn.addEventListener('click', async () => {
  await flushPendingSave();
  newNoteBtn.disabled = true;
  try {
    const ref = await addDoc(notesCol(), {
      title:     '',
      content:   '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    currentNoteId     = ref.id;
    noteTitle.value   = '';
    noteContent.value = '';
    saveStatus.textContent = '';
    showEditor();
    noteTitle.focus();
  } catch (err) {
    console.error('Create note error:', err);
    alert('Failed to create note. Check your connection.');
  } finally {
    newNoteBtn.disabled = false;
  }
});

// ── Auto-save (1.5 s debounce) ────────────────────────────────────────────────
function scheduleAutoSave() {
  if (!currentNoteId) return;
  setSaveStatus('saving');
  clearTimeout(saveTimer);
  const savedForId = currentNoteId;   // capture at schedule time to detect note switches
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const p = persistNote(savedForId, noteTitle.value, noteContent.value);
    activeSavePromise = p;
    try {
      await p;
      if (currentNoteId === savedForId) {
        setSaveStatus('saved');
        setTimeout(() => { if (currentNoteId === savedForId) setSaveStatus(''); }, 2000);
      }
    } catch (err) {
      console.error('Auto-save failed:', err);
      if (currentNoteId === savedForId) setSaveStatus('error');
    } finally {
      if (activeSavePromise === p) activeSavePromise = null;
    }
  }, 1500);
}

noteTitle.addEventListener('input', scheduleAutoSave);
noteContent.addEventListener('input', scheduleAutoSave);

function setSaveStatus(state) {
  const text = { saving: 'Saving…', saved: 'Saved', error: 'Save failed', '': '' };
  saveStatus.textContent = text[state] ?? '';
}

// ── Search ────────────────────────────────────────────────────────────────────
searchInput.addEventListener('input', renderList);

// ── Delete ────────────────────────────────────────────────────────────────────
deleteNoteBtn.addEventListener('click', () => {
  deleteModal.classList.remove('hidden');
  confirmDeleteBtn.focus();
});

cancelDeleteBtn.addEventListener('click', closeModal);

deleteModal.addEventListener('click', e => {
  if (e.target === deleteModal) closeModal();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !deleteModal.classList.contains('hidden')) closeModal();
});

confirmDeleteBtn.addEventListener('click', async () => {
  closeModal();
  if (!currentNoteId) return;
  const id = currentNoteId;
  // Flush pending edits first — if delete fails, the note still exists with latest content.
  await flushPendingSave();
  currentNoteId     = null;
  activeSavePromise = null;
  showEmptyState();
  try {
    await deleteDoc(noteRef(id));
  } catch (err) {
    console.error('Delete error:', err);
    alert('Failed to delete note.');
  }
});

function closeModal() {
  deleteModal.classList.add('hidden');
}

// ── Render list ───────────────────────────────────────────────────────────────
function renderList() {
  const q = searchInput.value.trim().toLowerCase();
  const visible = q
    ? notes.filter(n =>
        (n.title ?? '').toLowerCase().includes(q) ||
        (n.content ?? '').toLowerCase().includes(q))
    : notes;

  notesList.innerHTML = '';

  if (visible.length === 0) {
    const p = document.createElement('p');
    p.className   = 'notes-empty';
    p.textContent = q ? 'No matching notes.' : 'No notes yet.';
    notesList.appendChild(p);
    return;
  }

  for (const note of visible) {
    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'note-item' + (note.id === currentNoteId ? ' active' : '');
    btn.setAttribute('role', 'listitem');

    const title   = note.title?.trim() || 'Untitled';
    const preview = (note.content ?? '').replace(/\n+/g, ' ').trim().slice(0, 80);
    const time = typeof note.updatedAt?.toDate === 'function'
      ? relativeTime(note.updatedAt.toDate()) : '';

    btn.innerHTML = `
      <span class="ni-title">${esc(title)}</span>
      <span class="ni-preview">${esc(preview)}</span>
      <span class="ni-time">${time}</span>`;

    btn.addEventListener('click', () => openNote(note.id));
    notesList.appendChild(btn);
  }
}

// ── Open note ─────────────────────────────────────────────────────────────────
async function openNote(id) {
  const gen = ++openNoteGen;  // capture generation; stale calls bail out after their await
  if (currentNoteId && currentNoteId !== id) await flushPendingSave();
  if (gen !== openNoteGen) return;  // a newer openNote call has already taken over
  const note = notes.find(n => n.id === id);
  if (!note) return;
  currentNoteId     = id;
  noteTitle.value   = note.title ?? '';
  noteContent.value = note.content ?? '';
  saveStatus.textContent = '';
  // Always open in edit mode so the user can immediately type.
  if (isPreviewMode) enterEdit();
  showEditor();
  renderList();  // update active highlight
}

// ── Show / hide ───────────────────────────────────────────────────────────────
function showEditor() {
  emptyState.classList.add('hidden');
  editorEl.classList.remove('hidden');
  appEl.classList.add('note-open');     // mobile: switch to editor panel
}

function showEmptyState() {
  editorEl.classList.add('hidden');
  emptyState.classList.remove('hidden');
  appEl.classList.remove('note-open'); // mobile: switch back to list panel
  renderList();
}

// Back button (mobile only — desktop keeps it hidden via CSS)
backBtn.addEventListener('click', async () => {
  await flushPendingSave();
  currentNoteId = null;
  showEmptyState();
});
