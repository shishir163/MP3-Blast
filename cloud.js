// Saves the small details document to Firestore so every device shows the same thing.
import { getApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getFirestore, doc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

let ref = null;
let unsubscribe = null;
let timer = 0;
let latest = null;
let statusCallback = () => {};

export function connect(uid, { onRemote, onStatus }) {
  disconnect();
  statusCallback = onStatus || (() => {});
  try {
    ref = doc(getFirestore(getApp()), "users", uid, "mp3blast", "meta");
    unsubscribe = onSnapshot(
      ref,
      (snap) => {
        if (snap.metadata && snap.metadata.hasPendingWrites) return;
        statusCallback("ok");
        onRemote(snap.exists() ? snap.data() : null);
      },
      (err) => statusCallback("error", err)
    );
  } catch (err) {
    statusCallback("error", err);
  }
}

export function push(data) {
  if (!ref) return;
  latest = data;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      await setDoc(ref, JSON.parse(JSON.stringify(latest)));
      statusCallback("ok");
    } catch (err) {
      statusCallback("error", err);
    }
  }, 800);
}

export function disconnect() {
  clearTimeout(timer);
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  ref = null;
}
