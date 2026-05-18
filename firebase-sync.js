/* ================================================================
   FIREBASE-SYNC — alle cloud-functionaliteit op één plek

   Verzorgt:
     - Initialisatie van Firebase
     - Google-inloggen / uitloggen
     - Lezen en schrijven van het user-document in Firestore
     - Realtime listener voor wijzigingen op andere apparaten

   Wordt geïmporteerd door app.js als ES-module.
   ================================================================ */

import { initializeApp } from
  'https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager
} from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js';

/* ── Config ─────────────────────────────────────────────────── */
const firebaseConfig = {
  apiKey:            "AIzaSyBtqPGRx__LghtGwHKzob0d1kCrULyhFHI",
  authDomain:        "takenlijst-29bf6.firebaseapp.com",
  projectId:         "takenlijst-29bf6",
  storageBucket:     "takenlijst-29bf6.firebasestorage.app",
  messagingSenderId: "982568633752",
  appId:             "1:982568633752:web:f5574404b459e5789497ed",
};

/* ── Initialisatie ──────────────────────────────────────────── */
const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Firestore met offline-cache zodat de app ook zonder internet werkt
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
});

const provider = new GoogleAuthProvider();

/* ── Publieke API ───────────────────────────────────────────── */

/**
 * Start Google-inloggen via een popup. Geeft het user-object terug
 * of gooit een fout (bijv. wanneer de popup is gesloten).
 */
export async function signInWithGoogle() {
  const result = await signInWithPopup(auth, provider);
  return result.user;
}

/**
 * Logt de huidige gebruiker uit.
 */
export async function signOutUser() {
  await signOut(auth);
}

/**
 * Registreert een callback die afgaat zodra de auth-status verandert
 * (inloggen, uitloggen, of bij opstarten als de gebruiker al ingelogd was).
 * Callback krijgt het user-object of null.
 */
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

/**
 * Geeft het pad naar het user-document in Firestore terug.
 */
function userDoc(uid) {
  return doc(db, 'users', uid);
}

/**
 * Haalt het opgeslagen state-document van een gebruiker eenmalig op.
 * Geeft { tasks, categories } terug, of null als er nog niets staat.
 */
export async function fetchRemoteState(uid) {
  const snap = await getDoc(userDoc(uid));
  if (!snap.exists()) return null;
  const data = snap.data();
  return {
    tasks:      Array.isArray(data.tasks)      ? data.tasks      : [],
    categories: Array.isArray(data.categories) ? data.categories : [],
  };
}

/**
 * Schrijft de gehele state weg naar Firestore. Overschrijft het document.
 */
export async function pushRemoteState(uid, state) {
  await setDoc(userDoc(uid), {
    tasks:      state.tasks,
    categories: state.categories,
    updatedAt:  serverTimestamp(),
  });
}

/**
 * Zet een realtime listener op het user-document. De callback ontvangt
 * { tasks, categories } bij elke wijziging die op de server bekend is.
 * Geeft een unsubscribe-functie terug om de listener weer op te ruimen.
 */
export function subscribeRemoteState(uid, callback) {
  return onSnapshot(userDoc(uid), (snap) => {
    if (!snap.exists()) {
      callback(null);
      return;
    }
    const data = snap.data();
    callback({
      tasks:      Array.isArray(data.tasks)      ? data.tasks      : [],
      categories: Array.isArray(data.categories) ? data.categories : [],
    });
  }, (err) => {
    console.warn('Firestore listener error:', err);
  });
}
