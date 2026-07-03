// ============================================================
//  js/order-form.js — Shared form logic (kein Storage)
// ============================================================
"use strict";

initTheme();
initNav();
getFirebaseApp();

const ALLOWED_TYPES = ["image/png","image/jpeg","image/jpg","image/gif","image/webp"];
const MAX_FILES     = 5;
const MAX_MB        = 10;
let selectedFiles   = [];

document.addEventListener("DOMContentLoaded", () => {
  const form        = document.getElementById("orderForm");
  const successCard = document.getElementById("successCard");
  const submitBtn   = document.getElementById("submitBtn");
  const fileInput   = document.getElementById("referenceFiles");
  const fileDrop    = document.getElementById("fileDrop");
  const filePreview = document.getElementById("filePreview");
  if (!form) return;

  // ── File drag & drop ──
  fileDrop?.addEventListener("dragover",  e => { e.preventDefault(); fileDrop.classList.add("drag-over"); });
  fileDrop?.addEventListener("dragleave", ()  => fileDrop.classList.remove("drag-over"));
  fileDrop?.addEventListener("drop",      e  => {
    e.preventDefault(); fileDrop.classList.remove("drag-over");
    addFiles(Array.from(e.dataTransfer.files));
  });
  fileInput?.addEventListener("change", () => { addFiles(Array.from(fileInput.files)); fileInput.value = ""; });

  function addFiles(files) {
    for (const f of files) {
      if (selectedFiles.length >= MAX_FILES) { showToast(`Max ${MAX_FILES} Dateien erlaubt.`); break; }
      if (!ALLOWED_TYPES.includes(f.type))   { showToast(`"${f.name.substring(0,30)}" ist kein gültiges Bildformat.`); continue; }
      if (f.size > MAX_MB * 1024 * 1024)     { showToast(`"${f.name.substring(0,30)}" ist zu groß (max ${MAX_MB} MB).`); continue; }
      selectedFiles.push(f);
    }
    renderPreviews();
  }

  function renderPreviews() {
    if (!filePreview) return;
    filePreview.innerHTML = selectedFiles.map((f,i) =>
      `<div class="file-chip">📎 ${sanitize(f.name.substring(0,30))}<button type="button" onclick="removeFile(${i})" title="Entfernen">✕</button></div>`
    ).join("");
  }
  window.removeFile = i => { selectedFiles.splice(i,1); renderPreviews(); };

  // ── Validation ──
  const validate = (group, input) => {
    const ok = !input.required || !!input.value.trim();
    group.classList.toggle("error", !ok);
    return ok;
  };
  form.querySelectorAll(".field-input,.field-textarea").forEach(inp =>
    inp.addEventListener("input", () => {
      const g = inp.closest(".field-group");
      if (g?.classList.contains("error")) validate(g, inp);
    })
  );

  // ── Submit ──
  form.addEventListener("submit", async e => {
    e.preventDefault();

    let valid = true;
    form.querySelectorAll(".field-group").forEach(g => {
      const inp = g.querySelector(".field-input,.field-textarea");
      if (inp && !validate(g, inp)) valid = false;
    });
    if (!valid) { showToast("Bitte alle Pflichtfelder ausfüllen."); return; }

    submitBtn.disabled  = true;
    submitBtn.innerHTML = `<span class="spinner"></span> Wird gesendet…`;

    try {
      const uid     = await getUserId();
      const idToken = await firebase.auth().currentUser.getIdToken();

      const strip = s => (s||"").replace(/<[^>]*>/g,"").replace(/[<>"'`]/g,"").trim().substring(0,3000);

      // Referenzbilder → Base64 konvertieren
      const referenceImages = [];
      for (const file of selectedFiles) {
        const data = await toBase64(file);
        referenceImages.push({ name: file.name, type: file.type, data });
      }

      const res = await fetch(`${WORKER_URL}/submit-order`, {
        method: "POST",
        headers: { "Content-Type":"application/json", "Authorization":`Bearer ${idToken}` },
        body: JSON.stringify({
          userId:          uid,
          discord:         strip(document.getElementById("discord")?.value),
          title:           strip(document.getElementById("title")?.value),
          description:     strip(document.getElementById("description")?.value),
          additional:      strip(document.getElementById("additional")?.value),
          orderType:       document.body.dataset.orderType || "unknown",
          referenceImages,
          status:          "submitted",
          createdAt:       new Date().toISOString()
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Submit fehlgeschlagen");
      }

      // ✅ Erfolg
      form.style.display        = "none";
      successCard.style.display = "block";

    } catch (err) {
      console.error(err);
      showToast("Fehler: " + err.message);
      submitBtn.disabled  = false;
      submitBtn.innerHTML = "Submit Order &nbsp;➔";
    }
  });
});

function toBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result.split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}