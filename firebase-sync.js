// Private, free cloud sync for Fly Manager. The configuration identifies the
// Firebase project; the database rules, not this public configuration, protect data.
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, getRedirectResult, onAuthStateChanged, signInWithRedirect, signOut } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { collection, deleteDoc, doc, getDocs, getFirestore, onSnapshot, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBQJ98OSUtUSjTG5iYBMhw9mjYRMe7hmK0",
  authDomain: "fly-manager-fecec.firebaseapp.com",
  projectId: "fly-manager-fecec",
  storageBucket: "fly-manager-fecec.firebasestorage.app",
  messagingSenderId: "666597854791",
  appId: "1:666597854791:web:6f7db3d766efe538552b62"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const keyPrefix = "fly-manager-";
const maximumSyncedCharacters = 850000;
let userId = null;
let applyingCloudChange = false;
let stopListening = null;
let syncNotice = "";

function managedKeys() {
  return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter(key => key && key.startsWith(keyPrefix));
}

function syncPanel() {
  if (document.getElementById("cloud-sync-panel")) return;
  const intro = document.querySelector("#home-page .intro");
  if (!intro) return;
  intro.insertAdjacentHTML("afterend", `
    <section class="cloud-sync" id="cloud-sync-panel" aria-live="polite">
      <div>
        <strong>☁️ Private cloud sync</strong>
        <p id="cloud-sync-status">Sign in to keep your records the same on your Mac, iPhone, and iPad.</p>
      </div>
      <button id="cloud-sync-action" type="button">Sign in with Google</button>
    </section>`);
  const style = document.createElement("style");
  style.textContent = `.cloud-sync{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin:1rem 0 1.25rem;padding:1rem 1.1rem;border:1px solid #b8d6c2;border-radius:14px;background:#f5fbf6}.cloud-sync strong{color:#244e35}.cloud-sync p{margin:.25rem 0 0;font-size:.92rem}.cloud-sync button{white-space:nowrap}.cloud-sync-warning{color:#87521b}@media(max-width:600px){.cloud-sync{align-items:flex-start;flex-direction:column}.cloud-sync button{width:100%}}`;
  document.head.append(style);
  document.getElementById("cloud-sync-action").onclick = () => {
    if (userId) signOut(auth);
    else signInWithRedirect(auth, new GoogleAuthProvider());
  };
}

function updatePanel(message, signedIn = false, warning = false) {
  syncPanel();
  const status = document.getElementById("cloud-sync-status");
  const action = document.getElementById("cloud-sync-action");
  if (status) {
    status.textContent = message;
    status.classList.toggle("cloud-sync-warning", warning);
  }
  if (action) action.textContent = signedIn ? "Sign out" : "Sign in with Google";
}

async function writeKey(key, value) {
  if (!userId || applyingCloudChange || !key.startsWith(keyPrefix)) return;
  if (String(value).length > maximumSyncedCharacters) {
    syncNotice = "A large photo attachment is saved on this device only.";
    updatePanel(`Sync is on. ${syncNotice}`, true, true);
    return;
  }
  try {
    await setDoc(doc(db, "users", userId, "appData", key), { value: String(value), updatedAt: serverTimestamp() });
    updatePanel(syncNotice ? `Sync is on. ${syncNotice}` : "Sync is on. Your private records are up to date.", true, Boolean(syncNotice));
  } catch (error) {
    updatePanel("Sync could not save just now. Your information is still safe on this device.", true, true);
    console.error("Fly Manager sync error", error);
  }
}

const originalSetItem = Storage.prototype.setItem;
Storage.prototype.setItem = function (key, value) {
  originalSetItem.call(this, key, value);
  if (this === localStorage) void writeKey(String(key), value);
};

const originalRemoveItem = Storage.prototype.removeItem;
Storage.prototype.removeItem = function (key) {
  originalRemoveItem.call(this, key);
  if (!userId || applyingCloudChange || this !== localStorage || !String(key).startsWith(keyPrefix)) return;
  deleteDoc(doc(db, "users", userId, "appData", String(key))).catch(error => console.error("Fly Manager sync delete error", error));
};

async function firstSync(uid) {
  const dataCollection = collection(db, "users", uid, "appData");
  const snapshot = await getDocs(dataCollection);
  const cloud = new Map(snapshot.docs.map(item => [item.id, item.data().value]));
  let changedHere = false;
  applyingCloudChange = true;
  for (const [key, value] of cloud) {
    if (localStorage.getItem(key) !== value) {
      originalSetItem.call(localStorage, key, value);
      changedHere = true;
    }
  }
  applyingCloudChange = false;
  for (const key of managedKeys()) {
    if (!cloud.has(key)) void writeKey(key, localStorage.getItem(key));
  }
  if (changedHere) {
    updatePanel("Your private records were restored from the cloud. Refreshing…", true);
    window.setTimeout(() => window.location.reload(), 600);
  } else {
    updatePanel(syncNotice ? `Sync is on. ${syncNotice}` : "Sync is on. Your private records are up to date.", true, Boolean(syncNotice));
  }
}

function listenForChanges(uid) {
  if (stopListening) stopListening();
  stopListening = onSnapshot(collection(db, "users", uid, "appData"), snapshot => {
    let changedHere = false;
    applyingCloudChange = true;
    for (const change of snapshot.docChanges()) {
      const key = change.doc.id;
      if (!key.startsWith(keyPrefix)) continue;
      if (change.type === "removed") {
        if (localStorage.getItem(key) !== null) {
          originalRemoveItem.call(localStorage, key);
          changedHere = true;
        }
      } else {
        const value = change.doc.data().value;
        if (localStorage.getItem(key) !== value) {
          originalSetItem.call(localStorage, key, value);
          changedHere = true;
        }
      }
    }
    applyingCloudChange = false;
    if (changedHere) window.setTimeout(() => window.location.reload(), 350);
  }, error => {
    updatePanel("Sync is temporarily unavailable. Your records remain saved on this device.", true, true);
    console.error("Fly Manager sync listener error", error);
  });
}

getRedirectResult(auth).catch(error => {
  updatePanel("Sign-in did not finish. Please try again.", false, true);
  console.error("Fly Manager sign-in error", error);
});

onAuthStateChanged(auth, async user => {
  if (!user) {
    userId = null;
    if (stopListening) stopListening();
    stopListening = null;
    updatePanel("Sign in to keep your records the same on your Mac, iPhone, and iPad.");
    return;
  }
  userId = user.uid;
  updatePanel("Connecting your private records…", true);
  try {
    await firstSync(user.uid);
    listenForChanges(user.uid);
  } catch (error) {
    updatePanel("Sync could not connect. Your records are still saved on this device.", true, true);
    console.error("Fly Manager initial sync error", error);
  }
});

syncPanel();
