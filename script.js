// ============================================================
//  script.js — Homepage
// ============================================================
"use strict";

(async function () {
  initTheme();
  initNav();

  // Fix showcase image — show placeholder if it fails to load
  const img = document.getElementById("showcaseImg");
  const placeholder = document.getElementById("showcasePlaceholder");
  if (img && placeholder) {
    img.addEventListener("error", () => {
      img.style.display = "none";
      placeholder.style.display = "flex";
    });
    // If already broken (cached 404)
    if (img.complete && img.naturalWidth === 0) {
      img.style.display = "none";
      placeholder.style.display = "flex";
    }
  }

  // Ratings ticker — works even without Firebase
  await loadRatings();

  // Stats — try Firebase, graceful fallback
  try {
    getFirebaseApp();
    await loadStats();
  } catch (_) {
    document.getElementById("stat-orders").textContent = "0";
  }

  // Reveal animations after content is ready
  initReveal();
})();

// ── Ratings ──
async function loadRatings() {
  const track = document.getElementById("ratingsTrack");
  if (!track) return;

  let files    = [];
  let captions = {};

  try {
    const res = await fetch("ratings/manifest.json");
    if (res.ok) {
      const data = await res.json();
      files    = data.files    || [];
      captions = data.captions || {};
    }
  } catch (_) {}

  // Always show demo cards so the ticker is visible
  const demoFiles = ["demo1", "demo2", "demo3", "demo4", "demo5"];
  const demoCaps  = {
    demo1: { text: "Absolutely insane quality. Got it in under 24 hours.", author: "~ Creator_X" },
    demo2: { text: "My thumbnail CTR literally doubled. Unreal work.",      author: "~ StreamerGG" },
    demo3: { text: "The icon is exactly what I imagined. Super clean.",      author: "~ PixelPro" },
    demo4: { text: "Best free GFX I've ever seen. Will order again for sure.", author: "~ YTGamer" },
    demo5: { text: "Delivered fast and looks super professional. 10/10.",    author: "~ NightOwl" },
  };

  const useFiles    = files.length > 0 ? files    : demoFiles;
  const useCaptions = files.length > 0 ? captions : demoCaps;
  const isDummy     = files.length === 0;

  function makeCard(file) {
    const cap    = useCaptions[file] || {};
    const text   = sanitize(cap.text   || "Great quality graphics!");
    const author = sanitize(cap.author || "~ Anonymous");

    return `
      <div class="rating-card">
        ${isDummy
          ? `<div class="rating-card-img" style="background:linear-gradient(135deg,var(--bg-3),var(--border));display:flex;align-items:center;justify-content:center;color:var(--text-tertiary);font-size:13px;font-weight:500;">Sample Work</div>`
          : `<img class="rating-card-img" src="ratings/${file}" alt="Rating" loading="lazy" onerror="this.style.background='var(--bg-3)'">`
        }
        <div class="rating-card-body">
          <p class="rating-card-text">${text}</p>
          <p class="rating-card-author">${author}</p>
        </div>
      </div>`;
  }

  // Triple for seamless loop
  const all = [...useFiles, ...useFiles, ...useFiles];
  track.innerHTML = all.map(makeCard).join("");

  const speed = Math.max(25, useFiles.length * 9);
  track.style.animationDuration = `${speed}s`;
}

// ── Stats ──
async function loadStats() {
  const el = document.getElementById("stat-orders");
  try {
    const db   = firebase.firestore();
    const snap = await db.collection("orders").where("status", "==", "done").get();
    animateCounter(el, snap.size);
  } catch (_) {
    if (el) el.textContent = "0";
  }
}

// ── Counter animation ──
function animateCounter(el, target) {
  if (!el) return;
  if (target === 0) { el.textContent = "0"; return; }
  const dur   = 1800;
  const start = performance.now();
  function tick(now) {
    const t    = Math.min((now - start) / dur, 1);
    const ease = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(ease * target);
    if (t < 1) requestAnimationFrame(tick);
  }
  const io = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) { requestAnimationFrame(tick); io.disconnect(); }
  }, { threshold: 0.4 });
  io.observe(el);
}