import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { firebaseConfig, DRIVE_SCOPE } from "./firebase-config.js";

const TOKEN_KEY = "mb.token";
// Google access tokens last about 60 minutes; treat them as expired a little early.
const TOKEN_TTL_MS = 55 * 60 * 1000;

export const isConfigured = !String(firebaseConfig.apiKey || "").startsWith("YOUR_");

let auth = null;
let tokenRecord = null;

if (isConfigured) {
  auth = getAuth(initializeApp(firebaseConfig));
}

function makeProvider() {
  const provider = new GoogleAuthProvider();
  provider.addScope(DRIVE_SCOPE);
  const hint = auth?.currentUser?.email;
  if (hint) provider.setCustomParameters({ login_hint: hint });
  return provider;
}

function saveToken(token, ttlMs = TOKEN_TTL_MS) {
  tokenRecord = { token, exp: Date.now() + ttlMs };
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(tokenRecord));
  } catch {
    /* ignore */
  }
}

function storeFromResult(result) {
  const credential = GoogleAuthProvider.credentialFromResult(result);
  if (credential && credential.accessToken) saveToken(credential.accessToken);
}

export function getToken() {
  if (!tokenRecord) {
    try {
      tokenRecord = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
    } catch {
      tokenRecord = null;
    }
  }
  return tokenRecord && tokenRecord.exp > Date.now() ? tokenRecord.token : null;
}

export function currentUser() {
  return auth ? auth.currentUser : null;
}

export function onAuth(callback) {
  if (!auth) {
    callback(null);
    return;
  }
  onAuthStateChanged(auth, callback);
}

// Handles the return trip when the browser could not use a popup.
export async function finishRedirect() {
  if (!auth) return null;
  const result = await getRedirectResult(auth);
  if (result) storeFromResult(result);
  return result ? result.user : null;
}

export async function signIn() {
  try {
    const result = await signInWithPopup(auth, makeProvider());
    storeFromResult(result);
    return result.user;
  } catch (err) {
    if (
      err.code === "auth/popup-blocked" ||
      err.code === "auth/operation-not-supported-in-this-environment"
    ) {
      await signInWithRedirect(auth, makeProvider());
      return null;
    }
    throw err;
  }
}

// ---------- renewing the Drive token straight through Google ----------
// Signing in through Firebase sends the browser via <project>.firebaseapp.com, which some mobile
// networks cannot reach. Renewing the Drive token with Google's own library skips that hop.
// If anything about it fails, we fall back to the Firebase sign-in above.
// The client ID is public (it is the web client Firebase created); it can be overridden with
// `googleClientId` in firebase-config.js.
const GOOGLE_CLIENT_ID =
  firebaseConfig.googleClientId || "145293097897-8t0am87si49uab6rb2jau39ncmnucbdr.apps.googleusercontent.com";
const GIS_SRC = "https://accounts.google.com/gsi/client";

let gisStarted = false;
let tokenClient = null;
let pendingGis = null;

function gisSettle(done) {
  const p = pendingGis;
  pendingGis = null;
  if (p) done(p);
}

function setupTokenClient() {
  try {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: (resp) => {
        if (resp && resp.access_token) {
          const secs = Number(resp.expires_in) || 3600;
          // keep a five-minute margin, like the 55 of 60 minutes used for Firebase tokens
          saveToken(resp.access_token, Math.max(60, secs - 300) * 1000);
          gisSettle((p) => p.ok());
        } else if (resp && resp.error === "access_denied") {
          gisSettle((p) => p.cancel());
        } else {
          gisSettle((p) => p.fallback());
        }
      },
      error_callback: (err) => {
        if (err && err.type === "popup_closed") gisSettle((p) => p.cancel());
        else gisSettle((p) => p.fallback());
      },
    });
  } catch {
    tokenClient = null;
  }
}

// Loads Google's library in the background so a click can open the sign-in window at once.
export function preloadGoogle() {
  if (!isConfigured || gisStarted) return;
  gisStarted = true;
  const script = document.createElement("script");
  script.src = GIS_SRC;
  script.async = true;
  script.onload = setupTokenClient;
  document.head.appendChild(script);
}

// Brings back a fresh Drive token for the signed-in user.
// Must be called straight from a tap so the browser lets the sign-in window open.
export function reconnectDrive() {
  const user = auth ? auth.currentUser : null;
  if (!tokenClient || !user) return signIn();
  // a second tap while the window is open just waits for the first; an old unanswered request is dropped
  if (pendingGis && Date.now() - pendingGis.at < 2 * 60 * 1000) return pendingGis.promise;
  const promise = new Promise((resolve, reject) => {
    pendingGis = {
      at: Date.now(),
      ok: () => resolve(user),
      cancel: () => reject({ code: "auth/popup-closed-by-user" }),
      fallback: () => signIn().then(resolve, reject),
    };
  });
  pendingGis.promise = promise;
  try {
    tokenClient.requestAccessToken({ prompt: "", hint: user.email || undefined });
  } catch {
    gisSettle((p) => p.fallback());
  }
  return promise;
}

export async function signOutUser() {
  tokenRecord = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  if (auth) await signOut(auth);
}
