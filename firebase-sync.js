// Private, free cloud sync for Fly Manager. The public configuration identifies
// the Firebase project; the Firestore rules protect each signed-in person's data.
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { browserLocalPersistence, browserSessionPersistence, getAuth, GoogleAuthProvider, getRedirectResult, onAuthStateChanged, setPersistence, signInWithRedirect, signOut } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
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
const guestModeKey = "fly-manager-guest-mode-v1";
const signInPreferenceKey = "fly-manager-keep-signed-in-v1";
const localOnlyKeys = new Set([guestModeKey, signInPreferenceKey]);
const maximumSyncedCharacters = 850000;
const cloudSyncAvailable = location.protocol === "https:" && location.hostname === "lolalovesgenes.github.io";
let userId = null;
let applyingCloudChange = false;
let stopListening = null;
let syncNotice = "";

function managedKeys() {
  return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter(key => key && key.startsWith(keyPrefix) && !localOnlyKeys.has(key));
}

function isGuest() {
  return localStorage.getItem(guestModeKey) === "true";
}

function ensureWelcomeScreen() {
  if (document.getElementById("sign-in-gate")) return;
  document.body.insertAdjacentHTML("afterbegin", `
    <section id="sign-in-gate" class="sign-in-gate" aria-live="polite">
      <div class="sign-in-card">
        <div class="sign-in-fly">🪰</div>
        <p class="eyebrow">PRIVATE RESEARCH PLANNER</p>
        <h1>Welcome to Fly Manager</h1>
        <p>Sign in to keep your records private and available on your Mac, iPhone, and iPad.</p>
        <label class="stay-signed-in"><input id="keep-signed-in" type="checkbox" checked> Keep me signed in on this device</label>
        <button id="google-sign-in" type="button">Sign in with Google</button>
        <button id="guest-sign-in" class="secondary" type="button">Continue as guest</button>
        <p id="sign-in-message" class="hint">Guest mode saves your work only on this device. You can sign in later from the account icon.</p>
      </div>
    </section>`);
  const style = document.createElement("style");
  style.textContent = `.sign-in-gate{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:1rem;background:linear-gradient(145deg,#e6f3eb,#e6ebf8);overflow:auto}.sign-in-gate.hidden{display:none}.sign-in-card{width:min(100%,430px);padding:2rem;border:1px solid #d7ddea;border-radius:22px;background:#fff;box-shadow:0 1.2rem 3.5rem #2d315033;text-align:center}.sign-in-fly{font-size:2.6rem}.eyebrow{margin:.5rem 0;color:#646180;font-size:.72rem;font-weight:800;letter-spacing:.12em}.sign-in-card h1{margin:.2rem 0 .55rem;color:#282544;font-size:1.65rem}.sign-in-card>p:not(.hint){line-height:1.5;color:#626073}.stay-signed-in{display:flex;align-items:center;justify-content:center;gap:.5rem;margin:1.35rem 0 .8rem;font-size:.92rem}.stay-signed-in input{width:auto}.sign-in-card button{display:block;width:100%;margin:.65rem 0}.sign-in-card .hint{margin:.9rem 0 0;font-size:.82rem;line-height:1.4}.sign-in-error{color:#8a3f25}.account-control{position:fixed;right:.9rem;top:.8rem;z-index:30;width:2.5rem;min-height:2.5rem;padding:0;border:0;border-radius:50%;display:grid;place-items:center;background:#fff;color:#403b68;box-shadow:0 .2rem .7rem #29255222;font-size:1.15rem}@media(max-width:500px){.sign-in-card{padding:1.55rem 1.25rem}}`;
  document.head.append(style);
  document.getElementById("google-sign-in").onclick = beginGoogleSignIn;
  document.getElementById("guest-sign-in").onclick = continueAsGuest;
  const accountButton = document.createElement("button");
  accountButton.id = "account-control";
  accountButton.className = "account-control";
  accountButton.type = "button";
  accountButton.textContent = "◉";
  accountButton.setAttribute("aria-label", "Account options");
  accountButton.onclick = accountOptions;
  document.body.append(accountButton);
}

function setGateMessage(message, error = false) {
  const messageBox = document.getElementById("sign-in-message");
  if (messageBox) {
    messageBox.textContent = message;
    messageBox.classList.toggle("sign-in-error", error);
  }
}

function showWelcomeScreen(message = "Guest mode saves your work only on this device. You can sign in later from the account icon.", error = false) {
  ensureWelcomeScreen();
  document.getElementById("sign-in-gate").classList.remove("hidden");
  setGateMessage(message, error);
}

function hideWelcomeScreen() {
  ensureWelcomeScreen();
  document.getElementById("sign-in-gate").classList.add("hidden");
}

function updateAccountControl(message = "Account options") {
  const button = document.getElementById("account-control");
  if (button) button.title = message;
}

async function beginGoogleSignIn() {
  if (!cloudSyncAvailable) {
    setGateMessage("Google sync is available on your published Fly Manager website, not in this local preview.", true);
    return;
  }
  const keepSignedIn = document.getElementById("keep-signed-in").checked;
  localStorage.setItem(signInPreferenceKey, keepSignedIn ? "permanent" : "session");
  localStorage.removeItem(guestModeKey);
  setGateMessage("Opening Google sign-in…");
  try {
    await setPersistence(auth, keepSignedIn ? browserLocalPersistence : browserSessionPersistence);
    await signInWithRedirect(auth, new GoogleAuthProvider());
  } catch (error) {
    setGateMessage("Sign-in could not start. Please try again.", true);
    console.error("Fly Manager sign-in error", error);
  }
}

function continueAsGuest() {
  localStorage.setItem(guestModeKey, "true");
  hideWelcomeScreen();
  updateAccountControl("Guest mode — tap to sign in later");
}

function accountOptions() {
  if (userId) {
    if (confirm("Sign out of private cloud sync on this device? Your saved cloud data will remain protected.")) signOut(auth);
    return;
  }
  if (isGuest() && confirm("Would you like to sign in with Google and turn on private cloud sync?")) {
    localStorage.removeItem(guestModeKey);
    showWelcomeScreen("Sign in with Google to turn on private cloud sync.");
  }
}

async function writeKey(key, value) {
  if (!userId || applyingCloudChange || !key.startsWith(keyPrefix) || localOnlyKeys.has(key)) return;
  if (String(value).length > maximumSyncedCharacters) {
    syncNotice = "A large photo attachment is saved on this device only.";
    updateAccountControl(syncNotice);
    return;
  }
  try {
    await setDoc(doc(db, "users", userId, "appData", key), { value: String(value), updatedAt: serverTimestamp() });
    updateAccountControl(syncNotice || "Private cloud sync is on");
  } catch (error) {
    updateAccountControl("Cloud sync could not save just now");
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
  if (!userId || applyingCloudChange || this !== localStorage || !String(key).startsWith(keyPrefix) || localOnlyKeys.has(String(key))) return;
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
  if (changedHere) window.setTimeout(() => window.location.reload(), 500);
}

function listenForChanges(uid) {
  if (stopListening) stopListening();
  stopListening = onSnapshot(collection(db, "users", uid, "appData"), snapshot => {
    let changedHere = false;
    applyingCloudChange = true;
    for (const change of snapshot.docChanges()) {
      const key = change.doc.id;
      if (!key.startsWith(keyPrefix) || localOnlyKeys.has(key)) continue;
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
    updateAccountControl("Cloud sync is temporarily unavailable");
    console.error("Fly Manager sync listener error", error);
  });
}

async function handleAuthState(user) {
  if (!user) {
    userId = null;
    if (stopListening) stopListening();
    stopListening = null;
    if (isGuest() || !cloudSyncAvailable) {
      hideWelcomeScreen();
      updateAccountControl(isGuest() ? "Guest mode — tap to sign in later" : "Local preview");
    } else {
      showWelcomeScreen();
      updateAccountControl("Account options");
    }
    return;
  }
  userId = user.uid;
  localStorage.removeItem(guestModeKey);
  hideWelcomeScreen();
  updateAccountControl("Private cloud sync is on — tap to sign out");
  try {
    await firstSync(user.uid);
    listenForChanges(user.uid);
  } catch (error) {
    updateAccountControl("Cloud sync could not connect");
    console.error("Fly Manager initial sync error", error);
  }
}

ensureWelcomeScreen();
if (cloudSyncAvailable) {
  getRedirectResult(auth).catch(error => {
    showWelcomeScreen("Sign-in did not finish. Please try again.", true);
    console.error("Fly Manager sign-in error", error);
  });
  onAuthStateChanged(auth, handleAuthState);
} else {
  hideWelcomeScreen();
  updateAccountControl("Local preview");
}
