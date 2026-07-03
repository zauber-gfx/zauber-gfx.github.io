// ============================================================
//  Cloudflare Worker — gfx-studio-worker (kein Storage!)
//  Bilder werden als Base64 direkt in Firestore gespeichert.
//
//  Environment Variables (Cloudflare Dashboard → Worker → Settings → Variables):
//    FIREBASE_API_KEY     — AIzaSyCnTXWLnGs3ZqqB0EgjyOX5RhHmQ4qjRB4
//    FIREBASE_PROJECT_ID  — zauber-gfx
//    ADMIN_EMAIL          — rechts-glamour.0a@icloud.com
//    ALLOWED_ORIGIN       — * (dev) oder deine GitHub Pages URL
// ============================================================

const ALLOWED_IMAGE_TYPES = ["image/png","image/jpeg","image/jpg","image/gif","image/webp"];
const MAX_REF_BYTES       = 10 * 1024 * 1024; // 10 MB pro Referenzbild
const MAX_RESULT_BYTES    = 50 * 1024 * 1024; // 50 MB für fertiges GFX

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return cors(null, 204, env);
    const path = new URL(request.url).pathname;
    try {
      if (path === "/submit-order"        && request.method === "POST") return handleSubmit(request, env);
      if (path === "/admin/set-done"      && request.method === "POST") return handleSetDone(request, env);
      if (path === "/admin/update-status" && request.method === "POST") return handleUpdateStatus(request, env);
      if (path === "/admin/delete-order"  && request.method === "POST") return handleDelete(request, env);
      return cors({ error: "Not found" }, 404, env);
    } catch (err) {
      console.error("Worker error:", err.message);
      return cors({ error: err.message || "Internal server error" }, 500, env);
    }
  }
};

// ── Submit order (inkl. Referenzbilder als Base64 in Firestore) ──
async function handleSubmit(request, env) {
  const body = await request.json();

  for (const k of ["userId","discord","title","description","orderType"]) {
    if (!body[k] || !String(body[k]).trim())
      return cors({ error: `Missing: ${k}` }, 400, env);
  }

  const idToken = getToken(request);
  if (!idToken) return cors({ error: "No auth token" }, 401, env);

  // Referenzbilder validieren (Base64 bleibt direkt drin)
  const refs = Array.isArray(body.referenceImages) ? body.referenceImages.slice(0, 5) : [];
  for (const ref of refs) {
    if (!ALLOWED_IMAGE_TYPES.includes(ref.type))
      return cors({ error: `Invalid file type: ${ref.type}` }, 400, env);
    const bytes = atob(ref.data).length;
    if (bytes > MAX_REF_BYTES)
      return cors({ error: `File too large: ${ref.name}` }, 400, env);
  }

  const order = {
    userId:          clean(body.userId),
    discord:         clean(body.discord),
    title:           clean(body.title),
    description:     clean(body.description),
    additional:      clean(body.additional || ""),
    orderType:       clean(body.orderType),
    status:          "submitted",
    createdAt:       new Date().toISOString(),
    // Bilder als Array von {name, type, data} — data ist Base64
    referenceImages: refs.map(r => ({
      name: clean(r.name || "image"),
      type: r.type,
      data: r.data  // Base64 string
    }))
  };

  const fsBase = fsUrl(env);
  const res = await fetch(`${fsBase}/orders`, {
    method: "POST",
    headers: { "Content-Type":"application/json", "Authorization":`Bearer ${idToken}` },
    body: JSON.stringify({ fields: toFS(order) })
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Firestore write failed:", err);
    return cors({ error: "Database write failed" }, 500, env);
  }

  const doc   = await res.json();
  const docId = doc.name.split("/").pop();
  return cors({ success: true, orderId: docId }, 200, env);
}

// ── Admin: Mark as Done + fertiges GFX als Base64 in Firestore ──
async function handleSetDone(request, env) {
  const adminToken = getToken(request);
  if (!await verifyAdmin(adminToken, env)) return cors({ error: "Unauthorized" }, 401, env);

  const { orderId, fileName, fileType, data } = await request.json();
  if (!orderId || !fileName || !fileType || !data)
    return cors({ error: "Missing fields" }, 400, env);
  if (!ALLOWED_IMAGE_TYPES.includes(fileType))
    return cors({ error: "File type not allowed" }, 400, env);

  const bytes = atob(data).length;
  if (bytes > MAX_RESULT_BYTES)
    return cors({ error: "File too large (max 50 MB)" }, 400, env);

  // Speichere Base64 direkt in Firestore
  await patchOrder(orderId, {
    status:     "done",
    resultName: clean(fileName),
    resultType: fileType,
    resultData: data   // Base64
  }, adminToken, env);

  await writeLog("success", `Marked order ${orderId} as done`, adminToken, env);
  return cors({ success: true }, 200, env);
}

// ── Admin: Update Status ──
async function handleUpdateStatus(request, env) {
  const adminToken = getToken(request);
  if (!await verifyAdmin(adminToken, env)) return cors({ error: "Unauthorized" }, 401, env);

  const { orderId, status } = await request.json();
  if (!orderId || !["submitted","in_work","done"].includes(status))
    return cors({ error: "Invalid parameters" }, 400, env);

  await patchOrder(orderId, { status }, adminToken, env);
  await writeLog("info", `Updated order ${orderId} to ${status}`, adminToken, env);
  return cors({ success: true }, 200, env);
}

// ── Admin: Delete Order ──
async function handleDelete(request, env) {
  const adminToken = getToken(request);
  if (!await verifyAdmin(adminToken, env)) return cors({ error: "Unauthorized" }, 401, env);

  const { orderId } = await request.json();
  if (!orderId) return cors({ error: "Missing orderId" }, 400, env);

  const res = await fetch(`${fsUrl(env)}/orders/${orderId}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${adminToken}` }
  });

  if (!res.ok && res.status !== 404)
    return cors({ error: "Delete failed" }, 500, env);

  await writeLog("warn", `Deleted order ${orderId}`, adminToken, env);
  return cors({ success: true }, 200, env);
}

// ── Helpers ──

function getToken(req) {
  const h = req.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

async function verifyAdmin(idToken, env) {
  if (!idToken) return false;
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,
      { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ idToken }) }
    );
    if (!res.ok) return false;
    const d = await res.json();
    return d.users?.[0]?.email === env.ADMIN_EMAIL;
  } catch { return false; }
}

async function patchOrder(orderId, data, idToken, env) {
  const fields = toFS(data);
  const mask   = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join("&");
  const res = await fetch(`${fsUrl(env)}/orders/${orderId}?${mask}`, {
    method: "PATCH",
    headers: { "Content-Type":"application/json", "Authorization":`Bearer ${idToken}` },
    body: JSON.stringify({ fields })
  });
  if (!res.ok) throw new Error("Firestore patch failed: " + await res.text());
}

async function writeLog(level, message, idToken, env) {
  try {
    await fetch(`${fsUrl(env)}/admin_logs`, {
      method: "POST",
      headers: { "Content-Type":"application/json", "Authorization":`Bearer ${idToken}` },
      body: JSON.stringify({ fields: toFS({ level, message, timestamp: new Date().toISOString() }) })
    });
  } catch (_) {}
}

function fsUrl(env) {
  return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
}

// Firestore REST field converter
function toFS(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string")       out[k] = { stringValue: v };
    else if (typeof v === "boolean") out[k] = { booleanValue: v };
    else if (typeof v === "number")  out[k] = { integerValue: String(v) };
    else if (Array.isArray(v)) {
      out[k] = {
        arrayValue: {
          values: v.map(item =>
            typeof item === "object"
              ? { mapValue: { fields: toFS(item) } }
              : { stringValue: String(item) }
          )
        }
      };
    }
    else if (v === null) out[k] = { nullValue: null };
  }
  return out;
}

function clean(str) {
  if (typeof str !== "string") return "";
  return str.replace(/<[^>]*>/g,"").replace(/[<>"'`]/g,"").trim().substring(0, 5000);
}

function cors(body, status, env) {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": env?.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods":"GET,POST,OPTIONS",
      "Access-Control-Allow-Headers":"Content-Type,Authorization",
      "Access-Control-Max-Age":      "86400",
      "X-Content-Type-Options":      "nosniff"
    }
  });
}