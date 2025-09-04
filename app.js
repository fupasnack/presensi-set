// app.js — FUPA Snack (Firebase init + shared logic)
// Single source of truth for auth, Firestore, presensi rules, Cloudinary upload, notifications, exports, and PWA bootstrap.
// Import as ES module from your HTML:
//   <script type="module">
//     import { Fupa } from './app.js';
//     await Fupa.init();
//   </script>

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, updateProfile
} from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, serverTimestamp, onSnapshot,
  collection, query, where, orderBy, getDocs, writeBatch, Timestamp, deleteDoc, limit
} from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js';

// ====== CONSTANTS (ENV) ======
const firebaseConfig = {
  apiKey: "AIzaSyCt8OGr4HlmbjdxB0cSbm3_vkzm2NA3AXU",
  authDomain: "presensi-2bbde.firebaseapp.com",
  projectId: "presensi-2bbde",
  storageBucket: "presensi-2bbde.firebasestorage.app",
  messagingSenderId: "853002288058",
  appId: "1:853002288058:web:a276789416fecf2b733b83",
  measurementId: "G-Y1F50VXBDD"
};

const CLOUDINARY = {
  cloudName: 'dn2o2vf04',
  uploadPreset: 'presensi_unsigned',
  folder: 'fupa/presensi'
};

// Admin & karyawan (whitelist hard-coded agar auto-setup tanpa input manual)
const ADMIN = [
  { email: 'karomi@fupa.id', uid: '4umvjsqrVhdJpmhXqTPg2iIsqRM2', name: 'Karomi' },
  { email: 'annisa@fupa.id', uid: 'rPwiF8tnjwZRg0JcI9ZrXUP6Ofy1', name: 'Annisa' }
];
const KARYAWAN = [
  { email: 'cabang1@fupa.id', uid: 'cfs89ed9eccfaB1u3xGEVwpKDHk2', name: 'Cabang 1' },
  { email: 'cabang2@fupa.id', uid: 'dup97Zc5QgP9XHUU354kDdmDeDj2', name: 'Cabang 2' },
  { email: 'cabang3@fupa.id', uid: 'iuCabKgZeTPgMecASCh4p8HxcD13', name: 'Cabang 3' },
  { email: 'cabang4@fupa.id', uid: 'xfncPACSDDZNKykNR1dhISO6Y7h2', name: 'Cabang 4' }
];

// Routes
const ROUTE = {
  index: '/index.html',
  admin: '/admin.html',
  karyawan: '/karyawan.html'
};

// Presensi windows (WIB)
const TZ_OFFSET_MIN = 7 * 60; // UTC+7 (WIB)
const WINDOW = {
  // Berangkat: 04:30–05:30 (tepat), toleransi sampai 06:00 (terlambat)
  berangkat: {
    start: { h: 4, m: 30 }, exactEnd: { h: 5, m: 30 }, tolEnd: { h: 6, m: 0 }
  },
  // Pulang: 10:00–11:00 (tepat), toleransi sampai 11:30 (terlambat)
  pulang: {
    start: { h: 10, m: 0 }, exactEnd: { h: 11, m: 0 }, tolEnd: { h: 11, m: 30 }
  }
};

// ====== STATE (module-internal) ======
let app, auth, db;
let serverOffsetMs = 0; // client_time + offset ~= server_time

// ====== UTIL ======
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const todayISO = () => new Date(Date.now() + serverOffsetMs).toISOString().slice(0, 10);
const toDateAt = (h, m) => {
  const now = new Date(Date.now() + serverOffsetMs);
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  // Convert WIB wall-time to UTC timestamp
  const minutesWIB = h * 60 + m;
  const utcMinutes = minutesWIB - TZ_OFFSET_MIN;
  d.setUTCMinutes(utcMinutes);
  return d;
};
const isSunday = (d) => d.getUTCDay() === ((7 - (TZ_OFFSET_MIN / 60) % 7) % 7) ? false : false; // placeholder (we'll compute with WIB)
const dayOfWeekWIB = () => {
  const t = new Date(Date.now() + serverOffsetMs);
  const utc = new Date(t.getTime() - (TZ_OFFSET_MIN * 60 * 1000));
  return (utc.getUTCDay() + 1 + 6) % 7; // 0=Sun in native; we want 0=Sun too
};
const isSundayWIB = () => dayOfWeekWIB() === 0;

const idPresensi = (uid, dateISO, jenis) => `${uid}|${dateISO}|${jenis}`;

// ====== TIME & STATUS ======
function inRange(now, a, b) { return now >= a && now <= b; }
function computePresensiState(jenis, override) {
  const now = new Date(Date.now() + serverOffsetMs);
  const sun = isSundayWIB();
  if (sun && override?.mode !== 'wajib') {
    return { allowed: false, status: 'non_presensi', reason: 'Minggu (non-presensi).', phase: 'off' };
  }
  const w = WINDOW[jenis];
  const tStart = toDateAt(w.start.h, w.start.m);
  const tExactEnd = toDateAt(w.exactEnd.h, w.exactEnd.m);
  const tTolEnd = toDateAt(w.tolEnd.h, w.tolEnd.m);
  if (now < tStart) return { allowed: false, status: 'awal', reason: 'Belum waktunya presensi.', phase: 'before' };
  if (inRange(now, tStart, tExactEnd)) return { allowed: true, status: 'tepat', reason: 'Dalam rentang tepat waktu.', phase: 'exact' };
  if (inRange(now, tExactEnd, tTolEnd)) return { allowed: true, status: 'terlambat', reason: 'Dalam toleransi keterlambatan.', phase: 'toleransi' };
  return { allowed: false, status: 'alpa', reason: 'Lewat batas toleransi.', phase: 'after' };
}

// Auto-create ALPA entries klien-side (idempoten) bila window lewat dan tidak ada entri
async function ensureAlpa(uid) {
  const dateISO = todayISO();
  for (const jenis of ['berangkat', 'pulang']) {
    const st = computePresensiState(jenis, null);
    if (st.phase === 'after') {
      const ref = doc(db, 'presensi', idPresensi(uid, dateISO, jenis));
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        await setDoc(ref, {
          uid, dateISO, jenis, status: 'alpa',
          waktuServer: serverTimestamp(),
          coords: null, photoURL: null, public_id: null, delete_token: null,
          createdBy: 'system/alpa'
        }, { merge: true });
        await notify(uid, {
          title: 'Status Presensi',
          body: `${jenis.toUpperCase()}: ALPA (melewati batas toleransi)`,
          type: 'presensi'
        });
      }
    }
  }
}

// ====== FIREBASE INIT ======
async function initFirebase() {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
}

// Server clock sync (simple 1-shot offset)
async function syncServerTime() {
  const ref = doc(db, '_meta', '_ts');
  await setDoc(ref, { now: serverTimestamp() }, { merge: true });
  const snap = await getDoc(ref);
  const sv = snap.get('now');
  if (sv instanceof Timestamp) {
    serverOffsetMs = sv.toMillis() - Date.now();
  }
}

// ====== AUTH & USER PROFILE ======
function getRoleFromLists(uid, email) {
  if (ADMIN.some(a => a.uid === uid || a.email === email)) return 'admin';
  if (KARYAWAN.some(a => a.uid === uid || a.email === email)) return 'karyawan';
  return null;
}

async function ensureUserDoc(user) {
  const uref = doc(db, 'users', user.uid);
  const snap = await getDoc(uref);
  const role = getRoleFromLists(user.uid, user.email) || 'karyawan';
  const base = {
    uid: user.uid,
    email: user.email || '',
    name: user.displayName || user.email?.split('@')[0] || 'Pengguna',
    role,
    photoURL: user.photoURL || '',
    address: '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    requireAttendance: true // default; bisa di-override admin
  };
  if (!snap.exists()) {
    await setDoc(uref, base, { merge: true });
  } else {
    await updateDoc(uref, { role, updatedAt: serverTimestamp(), email: user.email || '' });
  }
  return { ...(snap.exists() ? snap.data() : base), role };
}

async function signIn(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  const profile = await ensureUserDoc(cred.user);
  cacheSession(cred.user, profile.role);
  return { user: cred.user, role: profile.role };
}

async function createKaryawanAuth(email, password) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await ensureUserDoc(cred.user);
  return cred.user;
}

async function signOutAll() {
  clearSession();
  await signOut(auth);
}

function onAuth(cb) {
  return onAuthStateChanged(auth, cb);
}

// ====== SESSION ROUTING ======
function cacheSession(user, role) {
  const session = { uid: user.uid, email: user.email, role, ts: Date.now() };
  localStorage.setItem('fupa.session', JSON.stringify(session));
}
function readSession() {
  try {
    return JSON.parse(localStorage.getItem('fupa.session') || 'null');
  } catch { return null; }
}
function clearSession() { localStorage.removeItem('fupa.session'); }

async function guard(requiredRole = null) {
  const session = readSession();
  if (!session) { location.replace(ROUTE.index); return Promise.reject('no-session'); }
  await syncServerTime();
  // Role guard
  if (requiredRole && session.role !== requiredRole) {
    const to = session.role === 'admin' ? ROUTE.admin : ROUTE.karyawan;
    location.replace(to);
    return Promise.reject('wrong-role');
  }
  return session;
}

function routeByRole(role) {
  if (role === 'admin') location.replace(ROUTE.admin);
  else if (role === 'karyawan') location.replace(ROUTE.karyawan);
}

// ====== FIRESTORE DATA MODEL HELPERS ======
// Notifications
async function notify(toUid, { title, body, type = 'general', meta = {} }) {
  const ref = doc(collection(db, 'users', toUid, 'inbox'));
  await setDoc(ref, {
    id: ref.id, title, body, type, meta,
    read: false, ts: serverTimestamp()
  });
}

// Announcements (admin)
async function postAnnouncement({ whenISO, text }) {
  const ref = doc(collection(db, 'announcements'));
  await setDoc(ref, { id: ref.id, whenISO, text, ts: serverTimestamp() });
}

// Overrides (admin)
async function setOverride({ mode, startISO, endISO = null, description = '' }) {
  const ref = doc(collection(db, 'overrides'));
  await setDoc(ref, { id: ref.id, mode, startISO, endISO, description, ts: serverTimestamp() });
}
async function getTodayOverride() {
  const d = todayISO();
  const qy = query(collection(db, 'overrides'), where('startISO', '<=', d), orderBy('startISO', 'desc'), limit(1));
  const ss = await getDocs(qy);
  if (ss.empty) return null;
  const ov = ss.docs[0].data();
  if (ov.endISO && ov.endISO < d) return null;
  return ov;
}

// ====== GEOLOCATION ======
function getLocationOnce() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolokasi tidak didukung'));
    navigator.geolocation.getCurrentPosition(
      pos => resolve({
        lat: +pos.coords.latitude.toFixed(6),
        lng: +pos.coords.longitude.toFixed(6),
        accuracy: Math.round(pos.coords.accuracy)
      }),
      err => reject(err),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

// ====== IMAGE CAPTURE/COMPRESS/UPLOAD ======
async function compressToJPEG(blob, maxKB = 50, maxW = 1280, maxH = 1280) {
  const img = await createImageBitmap(blob);
  const [sw, sh] = [img.width, img.height];
  let [dw, dh] = [sw, sh];
  // scale if too large
  const ratio = Math.min(1, maxW / sw, maxH / sh);
  dw = Math.round(sw * ratio);
  dh = Math.round(sh * ratio);
  const canvas = new OffscreenCanvas(dw, dh);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.drawImage(img, 0, 0, dw, dh);
  let quality = 0.8;
  let out = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  while (out.size > maxKB * 1024 && quality > 0.4) {
    quality -= 0.1;
    out = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  }
  return out;
}

async function uploadCloudinary(blob, publicIdHint) {
  const fd = new FormData();
  fd.append('file', blob);
  fd.append('upload_preset', CLOUDINARY.uploadPreset);
  fd.append('folder', CLOUDINARY.folder);
  fd.append('public_id', publicIdHint);
  fd.append('return_delete_token', 'true'); // store for potential deletion from admin UI (time-limited)
  const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY.cloudName}/upload`;
  const res = await fetch(url, { method: 'POST', body: fd });
  if (!res.ok) throw new Error('Upload Cloudinary gagal.');
  const data = await res.json();
  return { secure_url: data.secure_url, public_id: data.public_id, delete_token: data.delete_token || null };
}

async function deleteCloudinaryByToken(delete_token) {
  if (!delete_token) throw new Error('Delete token tidak tersedia.');
  const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY.cloudName}/delete_by_token`;
  const fd = new FormData();
  fd.append('token', delete_token);
  const res = await fetch(url, { method: 'POST', body: fd });
  if (!res.ok) throw new Error('Gagal hapus Cloudinary.');
  const data = await res.json();
  if (data.result !== 'ok') throw new Error('Hapus Cloudinary gagal.');
  return true;
}

// ====== PRESENSI CORE ======
async function savePresensi({ uid, jenis, coords, imageBlob, override }) {
  const dateISO = todayISO();
  const guard = computePresensiState(jenis, override);
  if (!guard.allowed) throw new Error(guard.reason);
  // compress and upload
  const jpeg = await compressToJPEG(imageBlob, 50);
  const publicId = `uid_${uid}/${dateISO}_${jenis}`;
  const upl = await uploadCloudinary(jpeg, publicId);
  const ref = doc(db, 'presensi', idPresensi(uid, dateISO, jenis));
  const nowStatus = computePresensiState(jenis, override).status; // re-eval
  await setDoc(ref, {
    uid, dateISO, jenis, status: nowStatus,
    waktuServer: serverTimestamp(),
    coords, photoURL: upl.secure_url, public_id: upl.public_id, delete_token: upl.delete_token || null,
    provider: 'webcam'
  }, { merge: true });
  await notify(uid, {
    title: 'Presensi tersimpan',
    body: `${jenis.toUpperCase()} — ${nowStatus.toUpperCase()}`,
    type: 'presensi',
    meta: { dateISO, jenis }
  });
  return { id: ref.id, ...upl };
}

function subscribePresensi(uid, cb) {
  const qy = query(collection(db, 'presensi'), where('uid', '==', uid), orderBy('waktuServer', 'desc'));
  return onSnapshot(qy, ss => cb(ss.docs.map(d => ({ id: d.id, ...d.data() }))));
}

async function deletePresensiEntry(entry, options = { alsoCloudinary: true }) {
  // entry: { id, uid, public_id, delete_token, photoURL }
  if (options.alsoCloudinary && entry.delete_token) {
    try { await deleteCloudinaryByToken(entry.delete_token); } catch (e) { /* swallow; UI tetap sinkron */ }
  }
  await deleteDoc(doc(db, 'presensi', entry.id));
}

// ====== CUTI ======
async function requestCuti(uid, { jenis, startISO, endISO, alasan }) {
  const ref = doc(collection(db, 'cuti_requests'));
  const payload = {
    id: ref.id, uid, jenis, startISO, endISO, alasan,
    status: 'pending', createdAt: serverTimestamp()
  };
  await setDoc(ref, payload);
  // notify admins
  for (const a of ADMIN) {
    await notify(a.uid, { title: 'Permintaan cuti', body: `${uid} mengajukan ${jenis}`, type: 'cuti', meta: { requestId: ref.id } });
  }
  return ref.id;
}

function subscribeCutiRequestsForAdmin(cb) {
  const qy = query(collection(db, 'cuti_requests'), orderBy('createdAt', 'desc'));
  return onSnapshot(qy, ss => cb(ss.docs.map(d => ({ id: d.id, ...d.data() }))));
}

async function decideCuti({ requestId, approve, adminUid }) {
  const ref = doc(db, 'cuti_requests', requestId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Request cuti tidak ditemukan.');
  const req = snap.data();
  const status = approve ? 'approved' : 'rejected';
  await updateDoc(ref, { status, decidedBy: adminUid, decidedAt: serverTimestamp() });
  if (approve) {
    // Auto-generate presensi entries with status "cuti" for the range
    const dates = expandDates(req.startISO, req.endISO);
    const batch = writeBatch(db);
    for (const d of dates) {
      for (const jenis of ['berangkat', 'pulang']) {
        const pRef = doc(db, 'presensi', idPresensi(req.uid, d, jenis));
        batch.set(pRef, {
          uid: req.uid, dateISO: d, jenis, status: 'cuti',
          waktuServer: serverTimestamp(), coords: null, photoURL: null, public_id: null, delete_token: null,
          createdBy: `system/cuti/${requestId}`
        }, { merge: true });
      }
    }
    await batch.commit();
    await notify(req.uid, { title: 'Cuti disetujui', body: `${req.jenis} ${req.startISO}–${req.endISO}`, type: 'cuti', meta: { requestId } });
  } else {
    await notify(req.uid, { title: 'Cuti ditolak', body: `${req.jenis}: ${req.alasan || ''}`, type: 'cuti', meta: { requestId } });
  }
}

// Expand inclusive date range (YYYY-MM-DD)
function expandDates(startISO, endISO) {
  const out = [];
  const start = new Date(startISO + 'T00:00:00Z');
  const end = new Date((endISO || startISO) + 'T00:00:00Z');
  for (let d = start; d <= end; d = new Date(d.getTime() + 86400000)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// ====== NOTIFICATIONS (IN-APP) ======
function subscribeInbox(uid, cb) {
  const qy = query(collection(db, 'users', uid, 'inbox'), orderBy('ts', 'desc'));
  return onSnapshot(qy, ss => cb(ss.docs.map(d => ({ id: d.id, ...d.data() }))));
}
async function markRead(uid, id, read = true) {
  await updateDoc(doc(db, 'users', uid, 'inbox', id), { read });
}
async function deleteInbox(uid, id) {
  await deleteDoc(doc(db, 'users', uid, 'inbox', id));
}

// ====== USERS (PROFILE & ADMIN OPS) ======
async function getUserProfile(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? snap.data() : null;
}
async function updateUserProfile(uid, { name, address, photoURL }) {
  await updateDoc(doc(db, 'users', uid), {
    ...(name ? { name } : {}), ...(address ? { address } : {}), ...(photoURL ? { photoURL } : {}),
    updatedAt: serverTimestamp()
  });
}

async function adminCreateKaryawan({ email, password, targetUid }) {
  // Tahap 1: buat akun Auth
  const user = await createKaryawanAuth(email, password);
  // Tahap 2: mapping (pakai UID aktual dari Auth bila tidak disediakan)
  const uid = targetUid || user.uid;
  const role = 'karyawan';
  await setDoc(doc(db, 'users', uid), {
    uid, email, role, name: email.split('@')[0], createdAt: serverTimestamp(), updatedAt: serverTimestamp(), address: '', photoURL: ''
  }, { merge: true });
  return uid;
}

// ====== EXPORTS (CSV) ======
function toCSV(rows, headers) {
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    if (/[",\n]/.test(s)) return `"${s}"`;
    return s;
  };
  const head = headers.map(h => esc(h.label)).join(',');
  const body = rows.map(r => headers.map(h => esc(h.get(r))).join(',')).join('\n');
  return head + '\n' + body;
}

async function exportPresensiCSV({ nameFilter = '', range = 'harian', startISO = null, endISO = null }) {
  let qy = query(collection(db, 'presensi'), orderBy('waktuServer', 'desc'));
  const ss = await getDocs(qy);
  let rows = ss.docs.map(d => ({ id: d.id, ...d.data() }));
  if (nameFilter) {
    const names = new Map();
    // prefetch names
    const uids = [...new Set(rows.map(r => r.uid))];
    for (const uid of uids) {
      const p = await getUserProfile(uid);
      names.set(uid, p?.name || uid);
    }
    rows = rows.filter(r => (names.get(r.uid) || '').toLowerCase().includes(nameFilter.toLowerCase()));
  }
  if (startISO || endISO) {
    rows = rows.filter(r => (!startISO || r.dateISO >= startISO) && (!endISO || r.dateISO <= endISO));
  }
  const headers = [
    { label: 'Tanggal', get: r => r.dateISO },
    { label: 'Waktu', get: r => r.waktuServer?.toDate ? r.waktuServer.toDate().toLocaleString('id-ID') : '' },
    { label: 'Nama', get: r => r.name || '' },
    { label: 'UID', get: r => r.uid },
    { label: 'Jenis', get: r => r.jenis },
    { label: 'Status', get: r => r.status },
    { label: 'Koordinat', get: r => r.coords ? `${r.coords.lat},${r.coords.lng} (±${r.coords.accuracy}m)` : '' },
    { label: 'FotoURL', get: r => r.photoURL || '' },
    { label: 'public_id', get: r => r.public_id || '' }
  ];
  // enrich names
  const nameCache = {};
  for (const r of rows) {
    if (!nameCache[r.uid]) {
      const p = await getUserProfile(r.uid);
      nameCache[r.uid] = p?.name || r.uid;
    }
    r.name = nameCache[r.uid];
  }
  return toCSV(rows, headers);
}

// ====== PWA BOOTSTRAP ======
async function registerSW() {
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
      return reg;
    } catch (e) {
      // ignore
    }
  }
  return null;
}

// ====== PAGE HELPERS ======
function persistClock(el) {
  let timer = null;
  const render = () => {
    const d = new Date(Date.now() + serverOffsetMs);
    const optsDate = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const optsTime = { hour: '2-digit', minute: '2-digit', second: '2-digit' };
    el.textContent = d.toLocaleDateString('id-ID', optsDate) + ' — ' + d.toLocaleTimeString('id-ID', optsTime) + ' WIB';
  };
  render();
  timer = setInterval(render, 1000);
  return () => { if (timer) clearInterval(timer); };
}

function computeHeaderStatusText(override) {
  if (isSundayWIB() && (!override || override.mode !== 'wajib')) return 'Tidak wajib presensi';
  const ber = computePresensiState('berangkat', override);
  const pul = computePresensiState('pulang', override);
  if (ber.allowed || pul.allowed) return 'Waktunya presensi';
  return 'Di luar waktu presensi';
}

function untilNextMinute(cb) {
  const now = Date.now();
  const ms = 60000 - (now % 60000);
  return setTimeout(() => {
    cb();
    setInterval(cb, 60000);
  }, ms);
}

function el(q, root = document) {
  const n = root.querySelector(q);
  if (!n) throw new Error(`Element not found: ${q}`);
  return n;
}

function els(q, root = document) {
  return Array.from(root.querySelectorAll(q));
}

function setLoading(btn, loading = true, text = 'Memproses...') {
  if (!btn) return;
  if (loading) {
    btn.dataset.original = btn.textContent;
    btn.textContent = text;
    btn.disabled = true;
    btn.classList.add('is-loading');
  } else {
    if (btn.dataset.original) btn.textContent = btn.dataset.original;
    btn.disabled = false;
    btn.classList.remove('is-loading');
  }
}

function toast(msg, type = 'info', timeout = 3000) {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    host.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
    document.body.appendChild(host);
  }
  const node = document.createElement('div');
  node.textContent = msg;
  node.style.cssText = 'pointer-events:auto;min-width:280px;max-width:90vw;padding:10px 14px;border-radius:10px;color:#fff;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.25);backdrop-filter:blur(6px);';
  node.style.background = type === 'success' ? 'linear-gradient(135deg,#00B894,#00CEC9)'
                     : type === 'error' ? 'linear-gradient(135deg,#D63031,#E17055)'
                     : type === 'warn' ? 'linear-gradient(135deg,#E1B12C,#FBC531)'
                     : 'linear-gradient(135deg,#0984E3,#74B9FF)';
  host.appendChild(node);
  setTimeout(() => node.remove(), timeout);
}

function formatCoord(c) {
  if (!c) return '-';
  return `${c.lat}, ${c.lng} (±${c.accuracy}m)`;
}

function todayRangeISO() {
  const d = new Date(Date.now() + serverOffsetMs);
  const iso = d.toISOString().slice(0, 10);
  return { startISO: iso, endISO: iso };
}

function rangeFromPreset(preset) {
  const now = new Date(Date.now() + serverOffsetMs);
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const startOfDay = (t) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d;
  };
  const endOfDay = (t) => {
    const d = new Date(t);
    d.setHours(23, 59, 59, 999);
    return d;
  };

  let start, end;
  switch (preset) {
    case 'harian':
      start = startOfDay(now);
      end = endOfDay(now);
      break;
    case 'mingguan': {
      const day = now.getDay(); // 0=Sun
      const diffToMon = (day + 6) % 7;
      start = startOfDay(new Date(now.getTime() - diffToMon * 86400000));
      end = endOfDay(new Date(start.getTime() + 6 * 86400000));
      break;
    }
    case 'bulanan': {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      break;
    }
    case 'tahunan': {
      start = new Date(now.getFullYear(), 0, 1);
      end = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
      break;
    }
    default:
      start = startOfDay(now);
      end = endOfDay(now);
  }
  return { startISO: iso(start), endISO: iso(end) };
}

// ====== NOTIFICATIONS UI ======
function mountNotifications({ bellBtn, popup, badgeEl, uid }) {
  let inboxUnsub = null;

  const renderList = (items) => {
    popup.innerHTML = '';
    if (!items.length) {
      popup.innerHTML = '<div class="empty">Tidak ada notifikasi</div>';
      badgeEl.textContent = '';
      badgeEl.style.display = 'none';
      return;
    }
    const unread = items.filter(i => !i.read).length;
    if (unread > 0) {
      badgeEl.textContent = String(unread);
      badgeEl.style.display = 'inline-block';
    } else {
      badgeEl.textContent = '';
      badgeEl.style.display = 'none';
    }
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'notif-item';
      row.innerHTML = `
        <div class="title">${it.title}</div>
        <div class="body">${it.body || ''}</div>
        <div class="meta">${it.type || ''} • ${it.ts?.toDate ? it.ts.toDate().toLocaleString('id-ID') : ''}</div>
        <div class="actions">
          <button class="btn mark">${it.read ? 'Tandai belum dibaca' : 'Tandai dibaca'}</button>
          <button class="btn danger del">Hapus</button>
        </div>
      `;
      row.querySelector('.mark').onclick = () => markRead(uid, it.id, !it.read).catch(e => toast(e.message, 'error'));
      row.querySelector('.del').onclick = () => deleteInbox(uid, it.id).catch(e => toast(e.message, 'error'));
      popup.appendChild(row);
    }
  };

  bellBtn.addEventListener('click', () => {
    popup.classList.toggle('open');
  });

  inboxUnsub = subscribeInbox(uid, renderList);
  return () => { if (inboxUnsub) inboxUnsub(); };
}

// ====== PROFILE MENU UI ======
function mountProfileMenu({ triggerBtn, popup, user, onLogout }) {
  const nameEl = popup.querySelector('[data-prof=name]');
  const addrEl = popup.querySelector('[data-prof=address]');
  const photoEl = popup.querySelector('[data-prof=photo]');
  const saveBtn = popup.querySelector('[data-prof=save]');
  const logoutBtn = popup.querySelector('[data-prof=logout]');
  const fileBtn = popup.querySelector('[data-prof=pick]');

  // Hydrate
  nameEl.value = user.name || '';
  addrEl.value = user.address || '';
  if (user.photoURL) {
    photoEl.src = user.photoURL;
  }

  triggerBtn.addEventListener('click', () => {
    popup.classList.toggle('open');
  });

  fileBtn.addEventListener('click', async () => {
    try {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.click();
      input.onchange = async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        // We use default upload (presensi folder) for simplicity, but segregate id
        const blob = f;
        const publicId = `uid_${user.uid}/profile_${Date.now()}`;
        const up = await uploadCloudinary(blob, publicId);
        photoEl.src = up.secure_url;
        await updateUserProfile(user.uid, { photoURL: up.secure_url });
        toast('Foto profil diperbarui', 'success');
      };
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  saveBtn.addEventListener('click', async () => {
    try {
      setLoading(saveBtn, true, 'Menyimpan...');
      const name = nameEl.value.trim();
      const address = addrEl.value.trim();
      await updateUserProfile(user.uid, { name, address });
      toast('Profil disimpan', 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setLoading(saveBtn, false);
    }
  });

  logoutBtn.addEventListener('click', async () => {
    await signOutAll();
    onLogout && onLogout();
  });
}

// ====== CAMERA UI ======
async function startCamera(videoEl) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });
  videoEl.srcObject = stream;
  await videoEl.play();
  return stream;
}

function stopCamera(stream) {
  if (!stream) return;
  for (const t of stream.getTracks()) t.stop();
}

async function captureFrame(videoEl, mime = 'image/jpeg', quality = 0.92) {
  const canvas = document.createElement('canvas');
  canvas.width = videoEl.videoWidth || 1280;
  canvas.height = videoEl.videoHeight || 720;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  return await new Promise(res => canvas.toBlob(res, mime, quality));
}

// ====== KARYAWAN PAGE BOOTSTRAP ======
function bootstrapKaryawanPage(sel = {}) {
  // Selectors (defaults)
  const $ = {
    clock: el(sel.clock || '#clock'),
    status: el(sel.status || '#status'),
    coordBtn: el(sel.coordBtn || '#btn-coord'),
    coordLabel: el(sel.coordLabel || '#coord-label'),
    jenisSelect: el(sel.jenisSelect || '#jenis'),
    video: el(sel.video || '#video'),
    captureBtn: el(sel.captureBtn || '#btn-capture'),
    retakeBtn: el(sel.retakeBtn || '#btn-retake'),
    previewImg: el(sel.previewImg || '#preview'),
    saveBtn: el(sel.saveBtn || '#btn-save'),
    historyList: el(sel.historyList || '#history'),
    notifBtn: el(sel.notifBtn || '#notif-btn'),
    notifBadge: el(sel.notifBadge || '#notif-badge'),
    notifPopup: el(sel.notifPopup || '#notif-popup'),
    profBtn: el(sel.profBtn || '#prof-btn'),
    profPopup: el(sel.profPopup || '#prof-popup'),
    cutiFab: el(sel.cutiFab || '#fab-cuti'),
    cutiForm: el(sel.cutiForm || '#cuti-form'),
    cutiJenis: el(sel.cutiJenis || '#cuti-jenis'),
    cutiStart: el(sel.cutiStart || '#cuti-start'),
    cutiEnd: el(sel.cutiEnd || '#cuti-end'),
    cutiAlasan: el(sel.cutiAlasan || '#cuti-alasan'),
  };

  let sessionUser = null;
  let profile = null;
  let stopClock = null;
  let inboxUnsub = null;
  let presensiUnsub = null;
  let camStream = null;
  let capturedBlob = null;
  let lastCoords = null;
  let headerTimer = null;

  const hydrateHeader = async () => {
    const ov = await getTodayOverride();
    $.status.textContent = computeHeaderStatusText(ov);
  };

  const renderHistory = (items) => {
    $.historyList.innerHTML = '';
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'history-item';
      row.innerHTML = `
        <div class="left">
          <div class="date">${it.dateISO || '-'}</div>
          <div class="time">${it.waktuServer?.toDate ? it.waktuServer.toDate().toLocaleTimeString('id-ID') : ''}</div>
        </div>
        <div class="mid">
          <div class="jenis">${(it.jenis || '').toUpperCase()}</div>
          <div class="status">${(it.status || '').toUpperCase()}</div>
          <div class="coord">${formatCoord(it.coords)}</div>
        </div>
        <div class="right">
          ${it.photoURL ? `<a class="photo" href="${it.photoURL}" target="_blank" rel="noopener">Foto</a>` : '<span class="photo muted">-</span>'}
        </div>
      `;
      $.historyList.appendChild(row);
    }
  };

  const init = async () => {
    const sess = await guard('karyawan').catch(() => null);
    if (!sess) return;
    sessionUser = sess;
    await syncServerTime();

    // UI clock
    stopClock = persistClock($.clock);
    hydrateHeader();
    headerTimer = untilNextMinute(hydrateHeader);

    // Load profile
    profile = await getUserProfile(sessionUser.uid);
    // Notifications
    inboxUnsub = mountNotifications({
      bellBtn: $.notifBtn, popup: $.notifPopup, badgeEl: $.notifBadge, uid: sessionUser.uid
    });

    // Profile menu
    mountProfileMenu({
      triggerBtn: $.profBtn, popup: $.profPopup, user: profile,
      onLogout: () => location.replace(ROUTE.index)
    });

    // Ensure ALPA generation for past windows
    await ensureAlpa(sessionUser.uid);

    // Subscribe history
    presensiUnsub = subscribePresensi(sessionUser.uid, renderHistory);

    // Geolocation button
    $.coordBtn.addEventListener('click', async () => {
      try {
        $.coordBtn.disabled = true;
        $.coordBtn.textContent = 'Mendapatkan lokasi...';
        const c = await getLocationOnce();
        lastCoords = c;
        $.coordLabel.textContent = formatCoord(c);
        toast('Lokasi terdeteksi', 'success');
      } catch (e) {
        toast('Izin lokasi ditolak/tergagal. Aktifkan GPS lalu coba lagi.', 'error');
      } finally {
        $.coordBtn.disabled = false;
        $.coordBtn.textContent = 'Sesuaikan Koordinat';
      }
    });

    // Camera
    try {
      camStream = await startCamera($.video);
    } catch (e) {
      toast('Izin kamera ditolak. Aktifkan izin kamera untuk presensi.', 'error');
    }

    $.captureBtn.addEventListener('click', async () => {
      try {
        if (!$.video.srcObject) {
          camStream = await startCamera($.video);
        }
        setLoading($.captureBtn, true, 'Mengambil...');
        const raw = await captureFrame($.video);
        capturedBlob = raw;
        $.previewImg.src = URL.createObjectURL(capturedBlob);
        $.previewImg.classList.add('visible');
        $.retakeBtn.style.display = 'inline-flex';
        toast('Foto diambil. Periksa pratinjau.', 'success');
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        setLoading($.captureBtn, false);
      }
    });

    $.retakeBtn.addEventListener('click', async () => {
      try {
        capturedBlob = null;
        $.previewImg.src = '';
        $.previewImg.classList.remove('visible');
        if (!$.video.srcObject) camStream = await startCamera($.video);
      } catch (e) {
        toast(e.message, 'error');
      }
    });

    $.saveBtn.addEventListener('click', async () => {
      try {
        const jenis = $.jenisSelect.value;
        if (!jenis) return toast('Pilih jenis: Berangkat / Pulang', 'warn');
        if (!capturedBlob) return toast('Ambil foto terlebih dahulu', 'warn');
        if (!lastCoords) return toast('Ambil koordinat lokasi terlebih dahulu', 'warn');

        setLoading($.saveBtn, true, 'Menyimpan...');
        const ov = await getTodayOverride();
        const out = await savePresensi({
          uid: sessionUser.uid, jenis, coords: lastCoords, imageBlob: capturedBlob, override: ov
        });
        toast('Presensi tersimpan', 'success');
        // reset state
        capturedBlob = null;
        $.previewImg.src = '';
        $.previewImg.classList.remove('visible');
        $.retakeBtn.style.display = 'none';
        hydrateHeader();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        setLoading($.saveBtn, false);
      }
    });

    // Cuti form
    $.cutiFab.addEventListener('click', () => {
      $.cutiForm.classList.add('open');
    });
    $.cutiForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const jenis = $.cutiJenis.value;
        const startISO = $.cutiStart.value;
        const endISO = $.cutiEnd.value || $.cutiStart.value;
        const alasan = $.cutiAlasan.value.trim();
        if (!jenis || !startISO || !alasan) return toast('Lengkapi form cuti', 'warn');
        setLoading($.cutiForm.querySelector('button[type=submit]'), true, 'Mengirim...');
        const id = await requestCuti(sessionUser.uid, { jenis, startISO, endISO, alasan });
        toast('Permintaan cuti dikirim', 'success');
        $.cutiForm.reset();
        $.cutiForm.classList.remove('open');
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        setLoading($.cutiForm.querySelector('button[type=submit]'), false);
      }
    });

    // Recompute ALPA and header status every minute
    setInterval(async () => {
      await ensureAlpa(sessionUser.uid);
      hydrateHeader();
    }, 60000);
  };

  init().catch(e => toast(e.message, 'error'));

  window.addEventListener('beforeunload', () => {
    if (stopClock) stopClock();
    if (inboxUnsub) inboxUnsub();
    if (presensiUnsub) presensiUnsub();
    stopCamera(camStream);
  });
}

// ====== ADMIN PAGE BOOTSTRAP ======
function subscribeAllPresensi(cb) {
  const qy = query(collection(db, 'presensi'), orderBy('waktuServer', 'desc'));
  return onSnapshot(qy, ss => cb(ss.docs.map(d => ({ id: d.id, ...d.data() }))));
}

function bootstrapAdminPage(sel = {}) {
  const $ = {
    clock: el(sel.clock || '#clock'),
    notifBtn: el(sel.notifBtn || '#notif-btn'),
    notifBadge: el(sel.notifBadge || '#notif-badge'),
    notifPopup: el(sel.notifPopup || '#notif-popup'),
    profBtn: el(sel.profBtn || '#prof-btn'),
    profPopup: el(sel.profPopup || '#prof-popup'),

    // Header: table + filters + export
    tableBody: el(sel.tableBody || '#presensi-tbody'),
    filterName: el(sel.filterName || '#filter-name'),
    filterPreset: el(sel.filterPreset || '#filter-preset'),
    filterStart: el(sel.filterStart || '#filter-start'),
    filterEnd: el(sel.filterEnd || '#filter-end'),
    btnApplyFilter: el(sel.btnApplyFilter || '#btn-apply-filter'),
    btnExport: el(sel.btnExport || '#btn-export'),

    // Override FAB
    fabOverride: el(sel.fabOverride || '#fab-override'),
    formOverride: el(sel.formOverride || '#override-form'),
    overrideMode: el(sel.overrideMode || '#override-mode'),
    overrideStart: el(sel.overrideStart || '#override-start'),
    overrideEnd: el(sel.overrideEnd || '#override-end'),
    overrideDesc: el(sel.overrideDesc || '#override-desc'),

    // Pengumuman
    formAnn: el(sel.formAnn || '#ann-form'),
    annTime: el(sel.annTime || '#ann-time'),
    annDate: el(sel.annDate || '#ann-date'),
    annText: el(sel.annText || '#ann-text'),

    // Create karyawan
    formCreate: el(sel.formCreate || '#create-form'),
    createEmail: el(sel.createEmail || '#create-email'),
    createPass: el(sel.createPass || '#create-pass'),
    createUid: el(sel.createUid || '#create-uid'),
  };

  let sessionUser = null;
  let profile = null;
  let stopClock = null;
  let inboxUnsub = null;
  let tableUnsub = null;
  let currentRows = [];

  const renderTable = (rows) => {
    $.tableBody.innerHTML = '';
    for (const r of rows) {
      const tr = document.createElement('tr');
      const timeStr = r.waktuServer?.toDate ? r.waktuServer.toDate().toLocaleString('id-ID') : '';
      const coord = formatCoord(r.coords);
      tr.innerHTML = `
        <td>${r.dateISO || ''}</td>
        <td>${timeStr}</td>
        <td data-uid="${r.uid}">${r.uid}</td>
        <td>${(r.jenis || '').toUpperCase()}</td>
        <td>${(r.status || '').toUpperCase()}</td>
        <td>${coord}</td>
        <td>${r.photoURL ? `<a href="${r.photoURL}" target="_blank" rel="noopener">Foto</a>` : '-'}</td>
        <td><button class="btn danger btn-del" data-id="${r.id}">Hapus</button></td>
      `;
      $.tableBody.appendChild(tr);
    }
    // Enrich names asynchronously
    (async () => {
      const seen = new Set();
      for (const cell of els('td[data-uid]', $.tableBody)) {
        const uid = cell.getAttribute('data-uid');
        if (seen.has(uid)) continue;
        seen.add(uid);
        const p = await getUserProfile(uid);
        const name = p?.name || uid;
        for (const c2 of els(`td[data-uid="${uid}"]`, $.tableBody)) {
          c2.textContent = name;
        }
      }
    })();

    // Bind delete
    for (const btn of els('.btn-del', $.tableBody)) {
      btn.onclick = async () => {
        const id = btn.getAttribute('data-id');
        const entry = rows.find(x => x.id === id);
        if (!entry) return;
        const ok = confirm('Hapus entri ini? Foto Cloudinary akan dihapus bila token tersedia.');
        if (!ok) return;
        setLoading(btn, true, 'Menghapus...');
        try {
          await deletePresensiEntry(entry, { alsoCloudinary: true });
          toast('Entri dihapus', 'success');
        } catch (e) {
          toast(e.message, 'error');
        } finally {
          setLoading(btn, false);
        }
      };
    }
  };

  const applyFilters = () => {
    const nameFilter = $.filterName.value.trim().toLowerCase();
    let { startISO, endISO } = $.filterStart.value || $.filterEnd.value
      ? { startISO: $.filterStart.value, endISO: $.filterEnd.value || $.filterStart.value }
      : rangeFromPreset($.filterPreset.value || 'harian');

    let rows = currentRows.filter(r =>
      (!startISO || r.dateISO >= startISO) && (!endISO || r.dateISO <= endISO)
    );

    // We do name filtering after name enrichment; temp filter on uid then refine
    if (nameFilter) {
      rows = rows.filter(r => (r.uid || '').toLowerCase().includes(nameFilter));
    }
    renderTable(rows);
  };

  const init = async () => {
    const sess = await guard('admin').catch(() => null);
    if (!sess) return;
    sessionUser = sess;
    await syncServerTime();
    stopClock = persistClock($.clock);

    // Profile
    profile = await getUserProfile(sessionUser.uid);
    mountProfileMenu({
      triggerBtn: $.profBtn, popup: $.profPopup, user: profile,
      onLogout: () => location.replace(ROUTE.index)
    });

    // Notifications (cuti requests + others)
    inboxUnsub = mountNotifications({
      bellBtn: $.notifBtn, popup: $.notifPopup, badgeEl: $.notifBadge, uid: sessionUser.uid
    });

    // Table subscribe
    tableUnsub = subscribeAllPresensi((rows) => {
      currentRows = rows;
      applyFilters();
    });

    // Filters
    $.btnApplyFilter.addEventListener('click', applyFilters);
    $.filterPreset.addEventListener('change', () => {
      const { startISO, endISO } = rangeFromPreset($.filterPreset.value);
      $.filterStart.value = startISO;
      $.filterEnd.value = endISO;
      applyFilters();
    });

    // Export CSV
    $.btnExport.addEventListener('click', async () => {
      try {
        setLoading($.btnExport, true, 'Mengekspor...');
        const nameFilter = $.filterName.value.trim();
        const { startISO, endISO } = $.filterStart.value || $.filterEnd.value
          ? { startISO: $.filterStart.value, endISO: $.filterEnd.value || $.filterStart.value }
          : rangeFromPreset($.filterPreset.value || 'harian');
        const csv = await exportPresensiCSV({ nameFilter, startISO, endISO });
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `presensi_${startISO || 'all'}_${endISO || 'all'}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        setLoading($.btnExport, false);
      }
    });

    // Override
    $.fabOverride.addEventListener('click', () => $.formOverride.classList.add('open'));
    $.formOverride.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const mode = $.overrideMode.value; // 'wajib' | 'tidak'
        const startISO = $.overrideStart.value;
        const endISO = $.overrideEnd.value || null;
        const description = $.overrideDesc.value.trim();
        if (!mode || !startISO) return toast('Isi mode dan tanggal mulai', 'warn');
        setLoading($.formOverride.querySelector('button[type=submit]'), true, 'Menyimpan...');
        await setOverride({ mode, startISO, endISO, description });
        toast('Override disimpan', 'success');
        $.formOverride.reset();
        $.formOverride.classList.remove('open');
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        setLoading($.formOverride.querySelector('button[type=submit]'), false);
      }
    });

// ====== (lanjutan) ADMIN PAGE BOOTSTRAP: Pengumuman ======
    $.formAnn.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const date = $.annDate.value;   // YYYY-MM-DD
        const time = $.annTime.value;   // HH:mm
        const text = $.annText.value.trim();
        if (!date || !time || !text) return toast('Lengkapi pengumuman', 'warn');
        setLoading($.formAnn.querySelector('button[type=submit]'), true, 'Mengirim...');
        const whenISO = `${date}T${time}:00`;
        await postAnnouncement({ whenISO, text });
        toast('Pengumuman diposting', 'success');
        $.formAnn.reset();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        setLoading($.formAnn.querySelector('button[type=submit]'), false);
      }
    });

    // Create karyawan (2 tahap sesuai spesifikasi)
    $.formCreate.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const email = $.createEmail.value.trim();
        const password = $.createPass.value;
        const targetUid = $.createUid.value.trim() || null;
        if (!email || !password) return toast('Isi email dan password', 'warn');
        setLoading($.formCreate.querySelector('button[type=submit]'), true, 'Membuat...');
        const uid = await adminCreateKaryawan({ email, password, targetUid });
        toast(`Akun karyawan dibuat (UID: ${uid})`, 'success');
        $.formCreate.reset();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        setLoading($.formCreate.querySelector('button[type=submit]'), false);
      }
    });

    // Cuti: daftar + aksi approve/tolak
    const cutiList = el(sel.cutiList || '#cuti-list');
    const renderCuti = (items) => {
      cutiList.innerHTML = '';
      if (!items.length) {
        cutiList.innerHTML = '<div class="empty">Belum ada permintaan cuti</div>';
        return;
      }
      for (const it of items) {
        const row = document.createElement('div');
        row.className = 'cuti-item';
        const range = it.endISO && it.endISO !== it.startISO ? `${it.startISO}–${it.endISO}` : it.startISO;
        row.innerHTML = `
          <div class="left">
            <div class="name" data-uid="${it.uid}">${it.uid}</div>
            <div class="desc">${it.jenis?.toUpperCase() || '-'} • ${range}</div>
            <div class="alasan">${it.alasan || ''}</div>
            <div class="status">Status: ${(it.status || 'pending').toUpperCase()}</div>
          </div>
          <div class="right">
            ${it.status === 'pending' ? `
              <button class="btn success btn-approve" data-id="${it.id}">Setujui</button>
              <button class="btn danger btn-reject" data-id="${it.id}">Tolak</button>
            ` : `<span class="badge ${it.status}">${it.status.toUpperCase()}</span>`}
          </div>
        `;
        cutiList.appendChild(row);
      }
      // Enrich names
      (async () => {
        const seen = new Set();
        for (const cell of els('[data-uid]', cutiList)) {
          const uid = cell.getAttribute('data-uid');
          if (seen.has(uid)) continue;
          seen.add(uid);
          const p = await getUserProfile(uid);
          const name = p?.name || uid;
          for (const c2 of els(`[data-uid="${uid}"]`, cutiList)) c2.textContent = name;
        }
      })();

      // Bind actions
      for (const btn of els('.btn-approve', cutiList)) {
        btn.onclick = async () => {
          const id = btn.getAttribute('data-id');
          setLoading(btn, true, 'Menyetujui...');
          try {
            await decideCuti({ requestId: id, approve: true, adminUid: sessionUser.uid });
            toast('Cuti disetujui', 'success');
          } catch (e) {
            toast(e.message, 'error');
          } finally {
            setLoading(btn, false);
          }
        };
      }
      for (const btn of els('.btn-reject', cutiList)) {
        btn.onclick = async () => {
          const id = btn.getAttribute('data-id');
          setLoading(btn, true, 'Menolak...');
          try {
            await decideCuti({ requestId: id, approve: false, adminUid: sessionUser.uid });
            toast('Cuti ditolak', 'success');
          } catch (e) {
            toast(e.message, 'error');
          } finally {
            setLoading(btn, false);
          }
        };
      }
    };

    subscribeCutiRequestsForAdmin(renderCuti);
  };

  init().catch(e => toast(e.message, 'error'));

  window.addEventListener('beforeunload', () => {
    if (stopClock) stopClock();
    if (inboxUnsub) inboxUnsub();
    if (tableUnsub) tableUnsub();
  });
}

// ====== INDEX (LOGIN) PAGE BOOTSTRAP ======
function bootstrapIndexPage(sel = {}) {
  const $ = {
    logo: el(sel.logo || '#logo'),
    form: el(sel.form || '#login-form'),
    email: el(sel.email || '#email'),
    pass: el(sel.pass || '#password'),
    toggle: el(sel.toggle || '#toggle-pass'),
    submit: el(sel.submit || '#btn-login'),
    helper: el(sel.helper || '#helper'),
    notif: el(sel.notif || '#login-notif')
  };

  const attachToggle = () => {
    $.toggle.addEventListener('click', () => {
      const type = $.pass.getAttribute('type') === 'password' ? 'text' : 'password';
      $.pass.setAttribute('type', type);
      $.toggle.setAttribute('aria-pressed', type === 'text' ? 'true' : 'false');
    });
  };

  const autoRedirectIfSession = () => {
    const sess = readSession();
    if (sess && sess.role) {
      routeByRole(sess.role);
      return true;
    }
    return false;
  };

  const init = async () => {
    await syncServerTime();
    attachToggle();

    // Persistensi sesi: jika sudah login, langsung redirect
    if (autoRedirectIfSession()) return;

    // Form submit
    $.form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const email = $.email.value.trim();
        const password = $.pass.value;
        if (!email || !password) return toast('Isi email dan password', 'warn');

        setLoading($.submit, true, 'Masuk...');
        let out;
        try {
          out = await signIn(email, password);
        } catch (e) {
          // Fallback: coba auto-create jika user belum ada (opsional, sesuai instruksi "selesaikan sendiri")
          // Catatan: UID akan dibuat oleh Firebase, role akan dipetakan via email whitelist.
          if (String(e.message || e).toLowerCase().includes('user-not-found')) {
            await createKaryawanAuth(email, password);
            out = await signIn(email, password);
          } else {
            throw e;
          }
        }
        toast('Login berhasil', 'success');
        routeByRole(out.role);
      } catch (e) {
        $.helper.textContent = e.message || 'Gagal login';
        toast(e.message || 'Gagal login', 'error');
      } finally {
        setLoading($.submit, false);
      }
    });
  };

  init().catch(e => toast(e.message, 'error'));
}

// ====== PUBLIC API (MODULE EXPORT) ======
async function init() {
  await initFirebase();
  await syncServerTime();
  await registerSW();
  // Keep server time fresh on focus
  window.addEventListener('focus', () => { syncServerTime(); });
}

const Fupa = {
  // Core init
  init,

  // Routing/session
  guard,
  routeByRole,
  readSession,
  clearSession,

  // Auth
  signIn,
  signOutAll,
  createKaryawanAuth,

  // Pages
  bootstrapIndexPage,
  bootstrapKaryawanPage,
  bootstrapAdminPage,

// ====== QUALITY/COMPAT: POLYFILLS & GLOBAL MONITORS ======

// OffscreenCanvas polyfill (Android 9 / older browsers)
(() => {
  if (typeof OffscreenCanvas === 'undefined') {
    class OffscreenCanvasShim {
      constructor(w, h) {
        this.canvas = document.createElement('canvas');
        this.canvas.width = w;
        this.canvas.height = h;
        this.ctx = this.canvas.getContext('2d', { alpha: false });
      }
      getContext(type) { return this.ctx; }
      async convertToBlob(opts = {}) {
        const { type = 'image/jpeg', quality = 0.8 } = opts;
        return await new Promise(res => this.canvas.toBlob(res, type, quality));
      }
    }
    // Expose
    // noinspection JSUnresolvedVariable
    window.OffscreenCanvas = OffscreenCanvasShim;
  }
})();

// Global auth/network error translator (optional use)
function translateError(e) {
  const msg = (e && (e.code || e.message || e.toString())) || '';
  const map = [
    { k: 'auth/invalid-email', v: 'Email tidak valid.' },
    { k: 'auth/missing-password', v: 'Password belum diisi.' },
    { k: 'auth/wrong-password', v: 'Password salah.' },
    { k: 'auth/user-not-found', v: 'Akun belum terdaftar. Sistem akan mencoba membuatkannya.' },
    { k: 'auth/too-many-requests', v: 'Terlalu banyak percobaan. Coba lagi nanti.' },
    { k: 'Failed to fetch', v: 'Koneksi internet bermasalah. Periksa jaringan Anda.' }
  ];
  for (const m of map) if (msg.includes(m.k)) return m.v;
  return e?.message || 'Terjadi kesalahan.';
}

// Network status monitor (shows toast and returns cleanup)
function monitorNetworkStatus() {
  const on = () => toast('Koneksi tersambung', 'success', 2000);
  const off = () => toast('Anda offline. Perubahan akan tersinkron saat online.', 'warn', 3000);
  window.addEventListener('online', on);
  window.addEventListener('offline', off);
  if (!navigator.onLine) off();
  return () => {
    window.removeEventListener('online', on);
    window.removeEventListener('offline', off);
  };
}

// ====== PWA INSTALL HANDLER ======
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

async function promptInstall() {
  if (!deferredInstallPrompt) throw new Error('Install tidak tersedia saat ini.');
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  return outcome; // 'accepted' | 'dismissed'
}

// ====== ANNOUNCEMENTS SUBSCRIPTION (OPTIONAL UI HOOK) ======
function subscribeAnnouncements(cb) {
  const qy = query(collection(db, 'announcements'), orderBy('whenISO', 'desc'));
  return onSnapshot(qy, (ss) => {
    cb(ss.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

// ====== OPTIONAL: AUTO STATUS BAR (HEADER STATUS RE-COMPUTE) ======
// Call this if you want an auto-updating status text element anywhere.
function mountAutoStatus(elm, jenis = null) {
  let timer = null;
  const tick = async () => {
    const ov = await getTodayOverride();
    if (jenis) {
      const s = computePresensiState(jenis, ov);
      elm.textContent = s.allowed ? (s.status === 'tepat' ? 'Tepat waktu' : s.status.toUpperCase()) : (s.status === 'awal' ? 'Belum waktu' : s.status.toUpperCase());
    } else {
      elm.textContent = computeHeaderStatusText(ov);
    }
  };
  tick();
  timer = setInterval(tick, 60000);
  return () => clearInterval(timer);
}

// ====== OPTIONAL: SEED NODES (IDEMPOTEN) ======
// Membuat dokumen users/ untuk daftar UID statis jika belum ada (tanpa mengubah yang sudah ada).
async function seedStaticUsersDocs() {
  const seedOne = async (u, role) => {
    const ref = doc(db, 'users', u.uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        uid: u.uid, email: u.email, name: u.name || u.email.split('@')[0],
        role, address: '', photoURL: '', createdAt: serverTimestamp(), updatedAt: serverTimestamp(), requireAttendance: true
      }, { merge: true });
    }
  };
  for (const a of ADMIN) await seedOne(a, 'admin');
  for (const k of KARYAWAN) await seedOne(k, 'karyawan');
}

// Jalankan seeding ringan setelah init agar koleksi ada (tanpa ganggu UX)
(async () => {
  // Tunda sampai Firebase siap
  const waitFor = (cond, timeout = 8000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const id = setInterval(() => {
      if (cond()) { clearInterval(id); res(); }
      else if (Date.now() - t0 > timeout) { clearInterval(id); rej(new Error('Timeout init.')); }
    }, 50);
  });
  try {
    await waitFor(() => !!(window && document));
    // Heuristic: db is set in init(); if not yet, try initialize
    if (!db) {
      await initFirebase();
    }
    await seedStaticUsersDocs();
  } catch (_) {
    // no-op; seeding bukan critical path
  }
})();

// ====== GLOBAL UX ENHANCERS (OPTIONAL) ======
// Prevent double-submit by disabling buttons with [data-once]
document.addEventListener('submit', (e) => {
  const form = e.target;
  const btn = form?.querySelector('button[type="submit"][data-once]');
  if (btn) {
    btn.disabled = true;
    setTimeout(() => { btn.disabled = false; }, 5000);
  }
}, true);

// Unhandled errors -> visible toast (without leaking internals)
window.addEventListener('unhandledrejection', (ev) => {
  const msg = translateError(ev.reason || ev);
  toast(msg, 'error');
});
window.addEventListener('error', (ev) => {
  const msg = translateError(ev.error || ev.message || ev);
  toast(String(msg), 'error');
});

// ====== ATTACH UTILITIES TO FUPA AND DEFAULT EXPORT ======
const VERSION = '2025.09.04';

Fupa.version = VERSION;
Fupa.constants = { ROUTE, WINDOW, CLOUDINARY, TZ_OFFSET_MIN };
Fupa.utils = { toast, setLoading, el, els, formatCoord, rangeFromPreset, todayISO, translateError };
Fupa.camera = { startCamera, stopCamera, captureFrame };
Fupa.geo = { getLocationOnce };
Fupa.time = { syncServerTime, now: () => new Date(Date.now() + serverOffsetMs), serverOffsetMs: () => serverOffsetMs };

Fupa.notifications = { notify, subscribeInbox, markRead, deleteInbox, subscribeAnnouncements, monitorNetworkStatus };
Fupa.cuti = { requestCuti, subscribeCutiRequestsForAdmin, decideCuti };
Fupa.override = { getTodayOverride, setOverride };
Fupa.export = { exportPresensiCSV, toCSV };
Fupa.install = { promptInstall, registerSW };

if (typeof window !== 'undefined') {
  // Optional global for quick access in console
  window.Fupa = Fupa;
}

export default Fupa;