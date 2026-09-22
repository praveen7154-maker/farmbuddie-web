import { initializeApp } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

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
export const db = getFirestore(app);
