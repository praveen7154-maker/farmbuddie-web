import { initializeApp } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBc60gFaq3Vfrxyi53nrOWRvhXZDCOHUJM",
  authDomain: "farmbuddie-cloud.firebaseapp.com",
  projectId: "farmbuddie-cloud",
  storageBucket: "farmbuddie-cloud.firebasestorage.app",
  messagingSenderId: "127153884699",
  appId: "1:127153884699:web:4383dc1c337bcbecc532be"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

// Every admin page is a full reload (no SPA routing here), so every
// listener data-store.js opens would otherwise wait on a fresh network
// round-trip before showing anything, every single navigation - this is
// what made pages feel like "loading, then the values pop in". A
// persistent IndexedDB cache means onSnapshot can serve the last-known
// data instantly from disk the moment the page's JS runs, then reconciles
// with the server in the background - multipleTabManager so it still
// works correctly with several admin tabs/pages open at once (the normal
// way this panel gets used), instead of only the first tab getting the
// cache.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
