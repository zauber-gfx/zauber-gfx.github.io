const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse(null, 204, env);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/submit-order" && request.method === "POST") {
        return await handleSubmitOrder(request, env);
      }
      if (path === "/upload-reference" && request.method === "POST") {
        return await handleUploadReference(request, env);
      }
      if (path === "/admin/set-done" && request.method === "POST") {
        return await handleAdminSetDone(request, env);
      }
      if (path === "/admin/update-status" && request.method === "POST") {
        return await handleAdminUpdateStatus(request, env);
      }
      if (path === "/admin/delete-order" && request.method === "POST") {
        return await handleAdminDelete(request, env);
      }

      return corsResponse({ error: "Not found" }, 404, env);
    } catch (err) {
      console.error("Worker error:", err);
      return corsResponse({ error: "Internal server error" }, 500, env);
    }
  }
};

// ── Submit order ──
async function handleSubmitOrder(request, env) {
  const body = await request.json();

  // Validate required fields
  const required = ["userId", "discord", "title", "description", "orderType"];
  for (const k of required) {
    if (!body[k] || typeof body[k] !== "string" || !body[k].trim()) {
      return corsResponse({ error: `Missing required field: ${k}` }, 400, env);
    }
  }

  // Sanitize all string inputs
  const order = {
    userId:        sanitize(body.userId),
    discord:       sanitize(body.discord),
    title:         sanitize(body.title),
    description:   sanitize(body.description),
    additional:    sanitize(body.additional || ""),
    orderType:     sanitize(body.orderType),
    referenceUrls: Array.isArray(body.referenceUrls) ? body.referenceUrls.slice(0, 5).map(sanitize) : [],
    status:        "submitted",
    createdAt:     new Date().toISOString()
  };

  // Write to Firestore
  const db = getFirestoreBase(env);
  const ref = await firestorePost(db, "orders", order, env);

  return corsResponse({ success: true, orderId: ref.name.split("/").pop() }, 200, env);
}

// ── Upload reference image ──
async function handleUploadReference(request, env) {
  const body = await request.json();
  const { userId, fileName, fileType, data } = body;

  if (!userId || !fileName || !fileType || !data) {
    return corsResponse({ error: "Missing fields" }, 400, env);
  }
  if (!ALLOWED_TYPES.includes(fileType)) {
    return corsResponse({ error: "File type not allowed" }, 400, env);
  }

  const binaryStr = atob(data);
  if (binaryStr.length > MAX_FILE_SIZE) {
    return corsResponse({ error: "File too large" }, 400, env);
  }

  const safeName  = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").substring(0, 80);
  const storagePath = `references/${sanitize(userId)}/${Date.now()}_${safeName}`;

  const url = await uploadToStorage(storagePath, data, fileType, env);
  return corsResponse({ url }, 200, env);
}

// ── Admin: set order to Done + upload result ──
async function handleAdminSetDone(request, env) {
  const verified = await verifyAdminToken(request, env);
  if (!verified) return corsResponse({ error: "Unauthorized" }, 401, env);

  const body = await request.json();
  const { orderId, fileName, fileType, data } = body;

  if (!orderId || !fileName || !fileType || !data) {
    return corsResponse({ error: "Missing fields" }, 400, env);
  }
  if (!ALLOWED_TYPES.includes(fileType)) {
    return corsResponse({ error: "File type not allowed" }, 400, env);
  }

  const safeName    = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").substring(0, 80);
  const storagePath = `results/${sanitize(orderId)}/${Date.now()}_${safeName}`;

  const resultUrl = await uploadToStorage(storagePath, data, fileType, env);

  // Update Firestore order
  const db = getFirestoreBase(env);
  await firestorePatch(db, `orders/${orderId}`, { status: "done", resultUrl }, env);

  // Log
  await logAdminAction(db, "success", `Marked order ${orderId} as done`, env);

  return corsResponse({ success: true, resultUrl }, 200, env);
}

// ── Admin: update status (submitted / in_work) ──
async function handleAdminUpdateStatus(request, env) {
  const verified = await verifyAdminToken(request, env);
  if (!verified) return corsResponse({ error: "Unauthorized" }, 401, env);

  const body = await request.json();
  const { orderId, status } = body;
  const allowed = ["submitted", "in_work", "done"];

  if (!orderId || !allowed.includes(status)) {
    return corsResponse({ error: "Invalid parameters" }, 400, env);
  }

  const db = getFirestoreBase(env);
  await firestorePatch(db, `orders/${orderId}`, { status }, env);
  await logAdminAction(db, "info", `Updated order ${orderId} to status: ${status}`, env);

  return corsResponse({ success: true }, 200, env);
}

// ── Admin: delete order ──
async function handleAdminDelete(request, env) {
  const verified = await verifyAdminToken(request, env);
  if (!verified) return corsResponse({ error: "Unauthorized" }, 401, env);

  const { orderId } = await request.json();
  if (!orderId) return corsResponse({ error: "Missing orderId" }, 400, env);

  const db = getFirestoreBase(env);
  await firestoreDelete(db, `orders/${orderId}`, env);
  await logAdminAction(db, "warn", `Deleted order ${orderId}`, env);

  return corsResponse({ success: true }, 200, env);
}

// ── Firebase Auth token verification ──
async function verifyAdminToken(request, env) {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  const token = auth.slice(7);

  // Verify Firebase ID token via Google's tokeninfo endpoint
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_WEB_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: token })
      }
    );
    if (!res.ok) return false;
    const data = await res.json();
    const user = data.users?.[0];
    return user?.email === env.ADMIN_EMAIL;
  } catch {
    return false;
  }
}

// ── Firebase Storage upload (REST API) ──
async function uploadToStorage(path, base64Data, mimeType, env) {
  const encodedPath = encodeURIComponent(path);
  const bucket = env.STORAGE_BUCKET;
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodedPath}`;

  const accessToken = await getStorageAccessToken(env);

  const binaryStr = atob(base64Data);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type":  mimeType,
      "Authorization": `Bearer ${accessToken}`
    },
    body: bytes
  });

  if (!res.ok) throw new Error(`Storage upload failed: ${res.status}`);
  const obj = await res.json();

  // Make public (or use signed URL — simpler for GitHub Pages use case)
  const publicUrl = `https://storage.googleapis.com/${bucket}/${path}`;
  return publicUrl;
}

// ── Get Google access token via service account JWT ──
async function getStorageAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    sub: env.FIREBASE_CLIENT_EMAIL,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
    scope: "https://www.googleapis.com/auth/devstorage.read_write https://www.googleapis.com/auth/datastore"
  };

  // Sign JWT with private key
  const privateKey = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");
  const token = await signJWT(payload, privateKey);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${token}`
  });

  const data = await res.json();
  return data.access_token;
}

// ── JWT signing (RS256) using Web Crypto ──
async function signJWT(payload, pemKey) {
  const header  = { alg: "RS256", typ: "JWT" };
  const encode  = (obj) => btoa(JSON.stringify(obj)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const b64Payload = encode(payload);
  const b64Header  = encode(header);
  const data       = `${b64Header}.${b64Payload}`;

  const keyData = pemToArrayBuffer(pemKey);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );

  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(data));
  const b64Sig = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");

  return `${data}.${b64Sig}`;
}

function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

// ── Firestore REST helpers ──
function getFirestoreBase(env) {
  return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
}

async function firestorePost(base, collection, data, env) {
  const token = await getStorageAccessToken(env);
  const res = await fetch(`${base}/${collection}`, {
    method: "POST",
    headers: { "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
    body: JSON.stringify({ fields: toFirestoreFields(data) })
  });
  if (!res.ok) throw new Error(`Firestore POST failed: ${res.status}`);
  return res.json();
}

async function firestorePatch(base, docPath, data, env) {
  const token = await getStorageAccessToken(env);
  const fields = toFirestoreFields(data);
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join("&");
  const res = await fetch(`${base}/${docPath}?${mask}`, {
    method: "PATCH",
    headers: { "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
    body: JSON.stringify({ fields })
  });
  if (!res.ok) throw new Error(`Firestore PATCH failed: ${res.status}`);
  return res.json();
}

async function firestoreDelete(base, docPath, env) {
  const token = await getStorageAccessToken(env);
  const res = await fetch(`${base}/${docPath}`, {
    method: "DELETE",
    headers: { "Authorization":`Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Firestore DELETE failed: ${res.status}`);
}

function toFirestoreFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string")  out[k] = { stringValue: v };
    else if (typeof v === "boolean") out[k] = { booleanValue: v };
    else if (typeof v === "number")  out[k] = { integerValue: String(v) };
    else if (Array.isArray(v)) out[k] = { arrayValue: { values: v.map(i => ({ stringValue: String(i) })) }};
    else if (v === null) out[k] = { nullValue: null };
  }
  return out;
}

async function logAdminAction(db, level, message, env) {
  await firestorePost(db, "admin_logs", {
    level, message,
    timestamp: new Date().toISOString()
  }, env);
}

// ── XSS sanitizer ──
function sanitize(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/[<>'"&]/g, c => ({ "<":"&lt;", ">":"&gt;", "'":"&#x27;", '"':"&quot;", "&":"&amp;" }[c]))
    .trim()
    .substring(0, 5000);
}

// ── CORS response ──
function corsResponse(body, status, env) {
  const origin = env?.ALLOWED_ORIGIN || "*";
  const headers = {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods":"GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type, Authorization",
    "X-Content-Type-Options":      "nosniff",
    "X-Frame-Options":             "DENY"
  };
  return new Response(body ? JSON.stringify(body) : null, { status, headers });
}