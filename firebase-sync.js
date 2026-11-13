// Private, free cloud sync for Fly Manager. The public configuration identifies
// the Firebase project; the Firestore rules protect each signed-in person's data.
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { browserLocalPersistence, browserSessionPersistence, createUserWithEmailAndPassword, getAuth, GoogleAuthProvider, onAuthStateChanged, setPersistence, signInWithEmailAndPassword, signInWithPopup, signOut, updateProfile } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
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
let currentUser = null;
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
        <label>Username<input id="username-sign-in" autocomplete="username" placeholder="Choose or enter a username"></label>
        <label>Password<input id="password-sign-in" type="password" autocomplete="current-password" placeholder="At least 6 characters"></label>
        <label class="stay-signed-in"><input id="keep-signed-in" type="checkbox" checked> Keep me signed in on this device</label>
        <button id="username-password-sign-in" type="button">Log in</button>
        <button id="username-password-create" class="secondary" type="button">Create account</button>
        <button id="google-sign-in" class="secondary" type="button">Use Google instead</button>
        <button id="guest-sign-in" class="secondary" type="button">Continue as guest</button>
        <p id="sign-in-message" class="hint">A username and password give this account private cloud sync. Guest mode saves your work only on this device.</p>
      </div>
    </section>`);
  const style = document.createElement("style");
  style.textContent = `.sign-in-gate{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:1rem;background:linear-gradient(145deg,#e6f3eb,#e6ebf8);overflow:auto}.sign-in-gate.hidden{display:none}.sign-in-card{width:min(100%,430px);padding:2rem;border:1px solid #d7ddea;border-radius:22px;background:#fff;box-shadow:0 1.2rem 3.5rem #2d315033;text-align:center}.sign-in-fly{font-size:2.6rem}.eyebrow{margin:.5rem 0;color:#646180;font-size:.72rem;font-weight:800;letter-spacing:.12em}.sign-in-card h1{margin:.2rem 0 .55rem;color:#282544;font-size:1.65rem}.sign-in-card>p:not(.hint){line-height:1.5;color:#626073}.stay-signed-in{display:flex;align-items:center;justify-content:center;gap:.5rem;margin:1.35rem 0 .8rem;font-size:.92rem}.stay-signed-in input{width:auto}.sign-in-card button{display:block;width:100%;margin:.65rem 0}.sign-in-card .hint{margin:.9rem 0 0;font-size:.82rem;line-height:1.4}.sign-in-error{color:#8a3f25}@media(max-width:500px){.sign-in-card{padding:1.55rem 1.25rem}}`;
  document.head.append(style);
  document.getElementById("username-password-sign-in").onclick = () => beginUsernamePasswordSignIn(false);
  document.getElementById("username-password-create").onclick = () => beginUsernamePasswordSignIn(true);
  document.getElementById("google-sign-in").onclick = beginGoogleSignIn;
  document.getElementById("guest-sign-in").onclick = continueAsGuest;
  ensureLogoutButton();
}

function ensureLogoutButton() {
  if (document.getElementById("home-logout-button")) return;
  const header = document.querySelector("header");
  if (!header) return;
  const button = document.createElement("button");
  button.id = "home-logout-button";
  button.className = "secondary hidden";
  button.type = "button";
  button.textContent = "Log out";
  header.append(button);
  button.onclick = async () => {
    localStorage.removeItem(guestModeKey);
    if (currentUser) await signOut(auth);
    else showWelcomeScreen();
  };
  document.head.insertAdjacentHTML("beforeend", `<style>header{display:flex;align-items:center;justify-content:space-between;gap:1rem}#home-logout-button{white-space:nowrap}#home-logout-button.hidden{display:none!important}.sign-in-card label:not(.stay-signed-in){display:flex;text-align:left;margin:.7rem 0}.sign-in-card label:not(.stay-signed-in) input{margin-top:.25rem}</style>`);
}

function setGateMessage(message, error = false) {
  const messageBox = document.getElementById("sign-in-message");
  if (messageBox) {
    messageBox.textContent = message;
    messageBox.classList.toggle("sign-in-error", error);
  }
}

function showWelcomeScreen(message = "Guest mode saves your work only on this device.", error = false) {
  ensureWelcomeScreen();
  document.getElementById("sign-in-gate").classList.remove("hidden");
  setGateMessage(message, error);
}

function hideWelcomeScreen() {
  ensureWelcomeScreen();
  document.getElementById("sign-in-gate").classList.add("hidden");
}

function updateAccountControl() {
  ensureLogoutButton();
  document.getElementById("home-logout-button")?.classList.toggle("hidden", !currentUser && !isGuest());
}

function usernameEmail(value) {
  const username = value.trim().toLowerCase();
  if (username.includes("@")) return username;
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) return "";
  return `${username}@flymanager.local`;
}

async function beginUsernamePasswordSignIn(createAccount) {
  if (!cloudSyncAvailable) { setGateMessage("Username/password sign-in is available on your published Fly Manager website, not in this local preview.", true); return; }
  const rawUsername = document.getElementById("username-sign-in").value.trim();
  const password = document.getElementById("password-sign-in").value;
  const email = usernameEmail(rawUsername);
  if (!email || password.length < 6) { setGateMessage("Use a username with 3–32 letters, numbers, dots, dashes, or underscores, and a password of at least 6 characters.", true); return; }
  const keepSignedIn = document.getElementById("keep-signed-in").checked;
  localStorage.setItem(signInPreferenceKey, keepSignedIn ? "permanent" : "session");
  localStorage.removeItem(guestModeKey);
  setGateMessage(createAccount ? "Creating your account…" : "Logging in…");
  try {
    await setPersistence(auth, keepSignedIn ? browserLocalPersistence : browserSessionPersistence);
    const credential = createAccount ? await createUserWithEmailAndPassword(auth, email, password) : await signInWithEmailAndPassword(auth, email, password);
    if (createAccount && !rawUsername.includes("@")) await updateProfile(credential.user, { displayName: rawUsername });
  } catch (error) {
    const message = error.code === "auth/operation-not-allowed" ? "Username/password login needs to be enabled once in Firebase Authentication before it can be used." : error.code === "auth/email-already-in-use" ? "That username is already taken. Use Log in instead." : error.code === "auth/invalid-credential" ? "That username or password was not recognized." : "Login could not finish. Please try again.";
    setGateMessage(message, true);
  }
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
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (error) {
    setGateMessage(error.code==="auth/popup-blocked"?"Your browser blocked the Google sign-in window. Allow pop-ups for Fly Manager, then try again.":"Sign-in could not finish. Please try again.", true);
    console.error("Fly Manager sign-in error", error);
  }
}

function continueAsGuest() {
  localStorage.setItem(guestModeKey, "true");
  hideWelcomeScreen();
  updateAccountControl("Guest mode — tap to sign in later");
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
    currentUser = null;
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
  currentUser = user;
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
  onAuthStateChanged(auth, handleAuthState);
} else {
  hideWelcomeScreen();
  updateAccountControl("Local preview");
}
