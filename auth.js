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

function saveToken(token) {
  tokenRecord = { token, exp: Date.now() + TOKEN_TTL_MS };
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

export async function signOutUser() {
  tokenRecord = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  if (auth) await signOut(auth);
}
