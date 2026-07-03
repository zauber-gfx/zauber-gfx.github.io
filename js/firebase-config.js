// ============================================================
//  firebase-config.js — shared across all pages
// ============================================================

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyCnTXWLnGs3ZqqB0EgjyOX5RhHmQ4qjRB4",
  authDomain:        "zauber-gfx.firebaseapp.com",
  databaseURL:       "https://zauber-gfx-default-rtdb.firebaseio.com",
  projectId:         "zauber-gfx",
  storageBucket:     "zauber-gfx.firebasestorage.app",
  messagingSenderId: "13079274353",
  appId:             "1:13079274353:web:ac7030631fc49823ed0cd0",
  measurementId:     "G-JX4HRREWZ5"
};

const WORKER_URL  = "https://sparkling-credit-cb26.julian-neustadtresponse.workers.dev";
const ADMIN_EMAIL = "rechts-glamour.0a@icloud.com";

// ── Init Firebase (safe to call multiple times) ──
function getFirebaseApp() {
  if (!firebase.apps || !firebase.apps.length) {
    firebase.initializeApp(FIREBASE_CONFIG);
  }
  return firebase.app();
}

// ── Theme ──
function initTheme() {
  const saved       = localStorage.getItem("theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme       = saved || (prefersDark ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
  updateThemeIcon(theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  const next    = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
  updateThemeIcon(next);
}

function updateThemeIcon(theme) {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  btn.innerHTML = theme === "dark"
    ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`
    : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
}

// ── Toast ──
function showToast(msg, duration = 3500) {
  let wrap = document.querySelector(".toast-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "toast-wrap";
    document.body.appendChild(wrap);
  }
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = msg;
  wrap.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("out");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
  }, duration);
}

// ── XSS sanitizer (display only) ──
function sanitize(str) {
  if (typeof str !== "string") return "";
  const d = document.createElement("div");
  d.appendChild(document.createTextNode(str));
  return d.innerHTML;
}

// ── Status helpers ──
const STATUS = {
  submitted: { label: "Submitted", dot: "submitted", info: "Your order is in the queue." },
  in_work:   { label: "In Work",   dot: "in-work",   info: "We're currently working on your GFX!" },
  done:      { label: "Done",      dot: "done",       info: "Your GFX is complete and ready to download!" }
};

// ── Scroll reveal ──
function initReveal() {
  const els = document.querySelectorAll(".reveal");
  if (!els.length) return;
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add("visible"); io.unobserve(e.target); }
    });
  }, { threshold: 0.08 });
  els.forEach(el => io.observe(el));
}

// ── Nav ──
function initNav() {
  document.getElementById("theme-toggle")?.addEventListener("click", toggleTheme);
}

// ── Modal ──
function openModal(id)  { document.getElementById(id)?.classList.add("open"); }
function closeModal(id) { document.getElementById(id)?.classList.remove("open"); }

// ── Anonymous Auth — persistent per browser ──
async function getUserId() {
  getFirebaseApp();
  const auth = firebase.auth();
  return new Promise((resolve, reject) => {
    const unsub = auth.onAuthStateChanged(async (user) => {
      unsub();
      if (user) {
        resolve(user.uid);
      } else {
        try {
          const cred = await auth.signInAnonymously();
          resolve(cred.user.uid);
        } catch (err) {
          reject(err);
        }
      }
    });
  });
}