require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = "modpapai@gmail.com";
const OTP_TTL = 5 * 60 * 1000;
const SESSION_TTL = 15 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const TEST_PAYMENT_ENABLED = String(process.env.TEST_PAYMENT_ENABLED || "false").toLowerCase() === "true";

// Cashfree webhook signatures use the exact raw request body.
// Keep this parser before the global JSON parser.
app.use("/api/webhooks/cashfree", express.raw({ type: "application/json", limit: "500kb" }));
app.use(express.json({ limit: "200kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "first.html"));
});

/*
 * Persistent storage: Firebase Cloud Firestore
 *
 * Required Render environment variables:
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY
 *
 * Optional:
 *   FIREBASE_SERVICE_ACCOUNT_JSON
 */
const firebaseProjectId = process.env.FIREBASE_PROJECT_ID || "";
const firebaseClientEmail = process.env.FIREBASE_CLIENT_EMAIL || "";
const firebasePrivateKey = process.env.FIREBASE_PRIVATE_KEY || "";
const firebaseServiceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";

let adminSdk;
try {
    adminSdk = require("firebase-admin");
} catch (error) {
    console.error("Firebase Admin SDK is missing. Run: npm install firebase-admin");
    throw error;
}

let serviceAccount;
if (firebaseServiceAccountJson) {
    try {
        serviceAccount = JSON.parse(firebaseServiceAccountJson);
    } catch (error) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.");
    }
} else if (firebaseProjectId && firebaseClientEmail && firebasePrivateKey) {
    serviceAccount = {
        projectId: firebaseProjectId,
        clientEmail: firebaseClientEmail,
        privateKey: firebasePrivateKey.replace(/\\n/g, "\n")
    };
} else {
    throw new Error(
        "Firebase is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in Render Environment."
    );
}

if (!adminSdk.apps.length) {
    adminSdk.initializeApp({
        credential: adminSdk.credential.cert(serviceAccount)
    });
}

const db = adminSdk.firestore();

const COLLECTIONS = {
    admins: "admins",
    products: "products",
    contacts: "contacts",
    sessions: "admin_sessions",
    otps: "admin_otps",
    purchases: "purchases",
    resellers: "resellers",
    resellerSessions: "reseller_sessions"
};

function cleanEmail(value) {
    return String(value || "").trim().toLowerCase();
}

function docToData(snapshot) {
    return { id: snapshot.id, ...snapshot.data() };
}

async function loadCollection(name) {
    const snapshot = await db.collection(name).get();
    return snapshot.docs.map(docToData);
}

async function getDocument(name, id) {
    const snapshot = await db.collection(name).doc(id).get();
    return snapshot.exists ? docToData(snapshot) : null;
}

/*
 * Seed only when a collection is empty.
 * This imports the existing JSON data once, but never overwrites
 * data already stored in Firestore on later Render deployments.
 */
async function seedCollectionIfEmpty(name, items, idGetter) {
    const snapshot = await db.collection(name).limit(1).get();
    if (!snapshot.empty || !items.length) return;

    const batch = db.batch();
    for (const item of items) {
        const id = String(idGetter(item));
        batch.set(db.collection(name).doc(id), item);
    }
    await batch.commit();
    console.log(`Seeded ${items.length} records into Firestore/${name}`);
}

async function seedFromJsonFiles() {
    const seeds = [
        ["products", "products.json", item => item.id || crypto.randomUUID()],
        ["admins", "admins.json", item => cleanEmail(item.email) || crypto.randomUUID()],
        ["contacts", "contacts.json", item => item.id || crypto.randomUUID()]
    ];

    for (const [collection, fileName, idGetter] of seeds) {
        const filePath = path.join(__dirname, "public", fileName);
        if (!fs.existsSync(filePath)) continue;

        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
            const items = Array.isArray(parsed) ? parsed : [];
            await seedCollectionIfEmpty(collection, items, idGetter);
        } catch (error) {
            console.error(`SEED ERROR (${fileName}):`, error.message);
        }
    }
}

async function loadProducts() {
    const products = await loadCollection(COLLECTIONS.products);
    return products.sort((a, b) => {
        const ao = Number.isFinite(Number(a.order)) ? Number(a.order) : Number.POSITIVE_INFINITY;
        const bo = Number.isFinite(Number(b.order)) ? Number(b.order) : Number.POSITIVE_INFINITY;
        if (ao !== bo) return ao - bo;
        const ac = String(a.createdAt || "");
        const bc = String(b.createdAt || "");
        return ac.localeCompare(bc);
    });
}

async function loadAdmins() {
    return await loadCollection(COLLECTIONS.admins);
}

async function loadContacts() {
    return await loadCollection(COLLECTIONS.contacts);
}

async function saveCollection(name, items, idGetter) {
    const collection = db.collection(name);
    const existing = await collection.get();

    const incomingIds = new Set(items.map(item => String(idGetter(item))));
    const batch = db.batch();

    for (const doc of existing.docs) {
        if (!incomingIds.has(doc.id)) batch.delete(doc.ref);
    }

    for (const item of items) {
        const id = String(idGetter(item));
        batch.set(collection.doc(id), item);
    }

    await batch.commit();
}

async function isSuperAdmin(email) {
    return cleanEmail(email) === ADMIN_EMAIL;
}

async function isAllowedAdmin(email) {
    const normalized = cleanEmail(email);
    if (normalized === ADMIN_EMAIL) return true;

    const snapshot = await db.collection(COLLECTIONS.admins)
        .where("email", "==", normalized)
        .limit(1)
        .get();

    return !snapshot.empty;
}

function getRole(email) {
    return cleanEmail(email) === ADMIN_EMAIL ? "super" : "admin";
}

/* Email: Mailjet */
const MAILJET_API_KEY = process.env.MAILJET_API_KEY || "";
const MAILJET_SECRET_KEY = process.env.MAILJET_SECRET_KEY || "";
const MAIL_FROM = process.env.MAIL_FROM || "modpapai@gmail.com";

// Cashfree Payments — keep credentials only in Render/local environment variables.
const CASHFREE_CLIENT_ID = process.env.CASHFREE_CLIENT_ID || process.env.CASHFREE_APP_ID || "";
const CASHFREE_CLIENT_SECRET = process.env.CASHFREE_CLIENT_SECRET || process.env.CASHFREE_SECRET_KEY || "";
const CASHFREE_ENV = String(process.env.CASHFREE_ENV || "PRODUCTION").toUpperCase() === "SANDBOX" ? "SANDBOX" : "PRODUCTION";
const CASHFREE_API_VERSION = "2025-01-01";
const CASHFREE_ORDER_TTL_SECONDS = Math.max(16 * 60, Math.min(30 * 24 * 60 * 60 - 60, Number(process.env.CASHFREE_ORDER_TTL_SECONDS || 1800)));

function parsePlanAmount(value) {
    const raw = String(value ?? "").trim();
    const cleaned = raw.replace(/[^0-9.]/g, "");
    if (!cleaned) return null;
    const rupees = Number(cleaned);
    if (!Number.isFinite(rupees) || rupees <= 0) return null;
    const paise = Math.round(rupees * 100);
    return paise > 0 ? paise : null;
}

function cashfreeBaseUrl() {
    return CASHFREE_ENV === "SANDBOX" ? "https://sandbox.cashfree.com/pg" : "https://api.cashfree.com/pg";
}

async function cashfreeRequest(endpoint, options = {}) {
    if (!CASHFREE_CLIENT_ID || !CASHFREE_CLIENT_SECRET) {
        throw new Error("Cashfree payment credentials are not configured.");
    }
    const response = await fetch(`${cashfreeBaseUrl()}${endpoint}`, {
        ...options,
        headers: {
            "accept": "application/json",
            "Content-Type": "application/json",
            "x-api-version": CASHFREE_API_VERSION,
            "x-client-id": CASHFREE_CLIENT_ID,
            "x-client-secret": CASHFREE_CLIENT_SECRET,
            ...(options.headers || {})
        }
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { data = { message: text || "Invalid Cashfree response." }; }
    if (!response.ok) {
        const message = data?.message || data?.type || data?.error?.message || `Cashfree API ${response.status}`;
        throw new Error(message);
    }
    return data;
}

function normalizePhone(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
    return digits;
}

async function releaseReservedInventory(purchase) {
    const reservedLicenseKey = String(purchase?.reservedLicenseKey || "").trim();
    const reservedAccount = purchase?.reservedAccount && typeof purchase.reservedAccount === "object" ? purchase.reservedAccount : null;
    if (!reservedLicenseKey && !reservedAccount) return;
    await db.runTransaction(async tx => {
        const ref = db.collection(COLLECTIONS.products).doc(String(purchase.productId));
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const data = snap.data();
        const plans = Array.isArray(data.plans) ? data.plans.map(p => ({
            ...p,
            licenses: Array.isArray(p?.licenses) ? p.licenses.slice() : [],
            accounts: Array.isArray(p?.accounts) ? p.accounts.map(x => ({ ...x })) : []
        })) : [];
        const target = plans[Number(purchase.planIndex)];
        if (!target) return;
        if (reservedLicenseKey && !target.licenses.some(x => String(x).toLowerCase() === reservedLicenseKey.toLowerCase())) target.licenses.push(reservedLicenseKey);
        if (reservedAccount && reservedAccount.username && !target.accounts.some(x => String(x.username).toLowerCase() === String(reservedAccount.username).toLowerCase())) target.accounts.push(reservedAccount);
        tx.update(ref, { plans });
    });
}

async function markCashfreePurchasePaid(purchaseId, paymentId, source = "cashfree") {
    const ref = db.collection(COLLECTIONS.purchases).doc(String(purchaseId));
    let shouldDeliver = false;
    await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new Error("Purchase not found.");
        const purchase = snap.data();
        if (purchase.status === "paid" || purchase.status === "refund") return;
        const mode = ["license", "userpass", "off"].includes(purchase.credentialMode) ? purchase.credentialMode : "license";
        tx.update(ref, {
            status: "paid",
            paymentId: String(paymentId || ""),
            licenseKey: mode === "license" ? (String(purchase.reservedLicenseKey || "").trim() || null) : null,
            account: mode === "userpass" ? (purchase.reservedAccount || null) : null,
            credentialMode: mode,
            downloadUrl: String(purchase.downloadUrl || "").trim(),
            paidAt: adminSdk.firestore.FieldValue.serverTimestamp(),
            paymentConfirmedBy: source,
            reservedLicenseKey: null,
            reservedAccount: null
        });
        shouldDeliver = true;
    });
    if (shouldDeliver) {
        try { await deliverPurchaseEmail(purchaseId); }
        catch (emailError) { console.error("CASHFREE DELIVERY EMAIL FAILED:", emailError); }
    }
}

function escapeEmailHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function buildPurchaseEmail(purchase) {
    const customerName = String(purchase.customerName || "Customer").trim() || "Customer";
    const productName = String(purchase.productName || "GMC Product").trim();
    const brandName = productName || "GMC Product";
    const planLabel = String(purchase.planLabel || "Package").trim();
    const amount = Number(purchase.amountPaise || 0) / 100;
    const mode = ["license", "userpass", "off"].includes(purchase.credentialMode)
        ? purchase.credentialMode
        : "license";
    const licenseKey = String(purchase.licenseKey || "").trim();
    const account = purchase.account && typeof purchase.account === "object"
        ? { username: String(purchase.account.username || "").trim(), password: String(purchase.account.password || "") }
        : null;
    const downloadUrl = String(purchase.downloadUrl || "").trim();

    let credentialHtml = "";
    let credentialText = "";
    if (mode === "license" && licenseKey) {
        credentialHtml = `
            <div style="margin:24px 0;padding:20px;border:1px solid #333;border-radius:14px;background:#111;color:#fff;">
                <div style="font-size:12px;font-weight:800;letter-spacing:1.5px;color:#ff2b2b;margin-bottom:10px;">YOUR LICENSE KEY</div>
                <div style="font-size:20px;font-weight:800;letter-spacing:1px;word-break:break-all;color:#fff;">${escapeEmailHtml(licenseKey)}</div>
                <div style="margin-top:8px;font-size:12px;color:#999;">Keep this key private and do not share it.</div>
            </div>`;
        credentialText = `\nLICENSE KEY: ${licenseKey}\nKeep this key private and do not share it.\n`;
    } else if (mode === "userpass" && account?.username && account?.password) {
        credentialHtml = `
            <div style="margin:24px 0;padding:20px;border:1px solid #333;border-radius:14px;background:#111;color:#fff;">
                <div style="font-size:12px;font-weight:800;letter-spacing:1.5px;color:#ff2b2b;margin-bottom:12px;">YOUR LOGIN DETAILS</div>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="color:#fff;font-size:14px;">
                    <tr><td style="padding:7px 0;color:#999;width:90px;">Username</td><td style="padding:7px 0;font-weight:800;word-break:break-all;">${escapeEmailHtml(account.username)}</td></tr>
                    <tr><td style="padding:7px 0;color:#999;">Password</td><td style="padding:7px 0;font-weight:800;word-break:break-all;">${escapeEmailHtml(account.password)}</td></tr>
                </table>
                <div style="margin-top:8px;font-size:12px;color:#999;">Keep these login details private.</div>
            </div>`;
        credentialText = `\nUSERNAME: ${account.username}\nPASSWORD: ${account.password}\nKeep these login details private.\n`;
    }

    const downloadHtml = downloadUrl
        ? `<a href="${escapeEmailHtml(downloadUrl)}" style="display:inline-block;background:#ff1111;color:#fff;text-decoration:none;font-weight:800;font-size:14px;padding:14px 24px;border-radius:10px;">DOWNLOAD ${escapeEmailHtml(brandName)}</a>`
        : `<div style="padding:14px 16px;border-radius:10px;background:#171717;color:#aaa;font-size:13px;">Your download link will be provided separately.</div>`;
    const downloadText = downloadUrl ? `DOWNLOAD: ${downloadUrl}` : "DOWNLOAD: Link will be provided separately.";

    const htmlPart = `<!doctype html>
<html><body style="margin:0;padding:0;background:#070707;font-family:Arial,Helvetica,sans-serif;color:#222;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#070707;padding:28px 10px;">
<tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#fff;border-radius:18px;overflow:hidden;">
<tr><td style="background:#0b0b0b;padding:28px 30px;text-align:center;border-bottom:3px solid #ff1111;">
<div style="font-size:27px;font-weight:900;letter-spacing:1px;color:#fff;">${escapeEmailHtml(brandName)}</div>
<div style="margin-top:8px;color:#aaa;font-size:12px;letter-spacing:1.5px;">ORDER CONFIRMATION</div>
</td></tr>
<tr><td style="padding:32px 30px;">
<div style="font-size:22px;font-weight:800;color:#111;">Payment successful ✓</div>
<p style="font-size:15px;line-height:1.7;color:#555;margin:10px 0 22px;">Hi <strong>${escapeEmailHtml(customerName)}</strong>, thank you for your purchase. Your <strong>${escapeEmailHtml(brandName)}</strong> order has been confirmed and your access details are below.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:0;background:#f7f7f7;border-radius:12px;margin-bottom:20px;">
<tr><td style="padding:12px 15px;color:#888;font-size:12px;">PRODUCT</td><td align="right" style="padding:12px 15px;color:#111;font-weight:800;font-size:13px;">${escapeEmailHtml(productName)}</td></tr>
<tr><td style="padding:12px 15px;color:#888;font-size:12px;">PACKAGE</td><td align="right" style="padding:12px 15px;color:#111;font-weight:800;font-size:13px;">${escapeEmailHtml(planLabel)}</td></tr>
<tr><td style="padding:12px 15px;color:#888;font-size:12px;">AMOUNT</td><td align="right" style="padding:12px 15px;color:#111;font-weight:800;font-size:13px;">₹${amount.toLocaleString("en-IN")}</td></tr>
</table>
${credentialHtml}
<div style="margin-top:24px;text-align:center;">
${downloadHtml}
</div>
<p style="font-size:12px;line-height:1.6;color:#999;margin:25px 0 0;text-align:center;">Please keep your license/login details private. If you have any issue with your order, reply to this email for support.</p>
</td></tr>
<tr><td style="background:#0b0b0b;padding:20px 30px;text-align:center;color:#777;font-size:11px;">© ${escapeEmailHtml(brandName)} · Automated purchase delivery</td></tr>
</table></td></tr></table>
</body></html>`;

    const textPart = `${brandName}\n\nPayment successful ✓\n\nHi ${customerName}, thank you for your purchase.\n\nPRODUCT: ${productName}\nPACKAGE: ${planLabel}\nAMOUNT: ₹${amount.toLocaleString("en-IN")}\n${credentialText}\n${downloadText}\n\nPlease keep your access details private.`;
    return { htmlPart, textPart };
}

async function deliverPurchaseEmail(purchaseId) {
    const ref = db.collection(COLLECTIONS.purchases).doc(String(purchaseId));
    const snap = await ref.get();
    if (!snap.exists) return { sent: false, skipped: true };
    const purchase = { id: snap.id, ...snap.data() };
    if (purchase.status !== "paid") return { sent: false, skipped: true };
    if (purchase.deliveryEmailSentAt) return { sent: true, alreadySent: true };
    const customerEmail = cleanEmail(purchase.customerEmail);
    if (!customerEmail) return { sent: false, skipped: true };

    const now = Date.now();
    let claimed = false;
    await db.runTransaction(async tx => {
        const fresh = await tx.get(ref);
        if (!fresh.exists) return;
        const data = fresh.data();
        if (data.status !== "paid" || data.deliveryEmailSentAt) return;
        const claimedAt = Number(data.deliveryEmailClaimedAt || 0);
        if (data.deliveryEmailStatus === "sending" && claimedAt && now - claimedAt < 5 * 60 * 1000) return;
        tx.update(ref, { deliveryEmailStatus: "sending", deliveryEmailClaimedAt: now, deliveryEmailError: null });
        claimed = true;
    });

    if (!claimed) return { sent: false, claimedByOther: true };

    try {
        const fresh = await ref.get();
        const data = { id: fresh.id, ...fresh.data() };
        const { htmlPart, textPart } = buildPurchaseEmail(data);
        await sendEmail({
            to: customerEmail,
            subject: `GMC Order Confirmed — ${data.productName || "Your Purchase"}`,
            textPart,
            htmlPart
        });
        await ref.update({
            deliveryEmailStatus: "sent",
            deliveryEmailSentAt: adminSdk.firestore.FieldValue.serverTimestamp(),
            deliveryEmailClaimedAt: null,
            deliveryEmailError: null
        });
        return { sent: true };
    } catch (error) {
        await ref.update({
            deliveryEmailStatus: "failed",
            deliveryEmailClaimedAt: null,
            deliveryEmailError: String(error.message || "Unable to send delivery email.").slice(0, 1000)
        }).catch(() => {});
        throw error;
    }
}


async function sendAccountCreatedEmail({ to, recipientName, role, createdByEmail, discountPercent, productNames }) {
    const safeTo = cleanEmail(to);
    if (!safeTo) throw new Error("Recipient email is invalid.");

    const roleLabel = role === "reseller" ? "Reseller" : "Admin";
    const displayName = String(recipientName || safeTo.split("@")[0] || "there").trim();
    const creator = cleanEmail(createdByEmail || "") || "GMC Administration";
    const productList = Array.isArray(productNames) && productNames.length
        ? productNames.map(name => `<li style="margin:0 0 6px 0;">${escapeHtml(name)}</li>`).join("")
        : "<li>No products assigned yet.</li>";
    const productText = Array.isArray(productNames) && productNames.length
        ? productNames.join(", ")
        : "No products assigned yet.";

    const subject = `Congratulations! Your GMC ${roleLabel} account has been created`;
    const discountLine = role === "reseller"
        ? `<tr><td style="padding:7px 0;color:#777;">Discount</td><td style="padding:7px 0;text-align:right;font-weight:700;">${Number(discountPercent || 0)}%</td></tr>`
        : "";
    const productsBlock = role === "reseller"
        ? `<div style="margin-top:18px;"><div style="font-size:11px;font-weight:800;letter-spacing:1px;color:#ff3030;margin-bottom:8px;">ASSIGNED PRODUCTS</div><ul style="margin:0;padding-left:18px;color:#333;">${productList}</ul></div>`
        : "";

    const htmlPart = `<!doctype html><html><body style="margin:0;background:#f4f4f4;font-family:Arial,sans-serif;color:#111;"><div style="max-width:620px;margin:30px auto;background:#fff;border:1px solid #ddd;border-radius:14px;overflow:hidden;"><div style="background:#0b0b0b;padding:24px 28px;color:#fff;font-size:22px;font-weight:900;">GMC <span style="color:#ff2222;">STEAM TOOL</span></div><div style="padding:28px;"><div style="font-size:11px;font-weight:800;letter-spacing:1px;color:#ff2222;">ACCOUNT CREATED</div><h2 style="margin:8px 0 12px;">Congratulations, ${escapeHtml(displayName)}! 🎉</h2><p style="line-height:1.6;color:#555;">Your GMC ${roleLabel} account has been successfully created by <strong>${escapeHtml(creator)}</strong>.</p><table style="width:100%;border-collapse:collapse;background:#f7f7f7;border-radius:10px;padding:10px;"><tr><td style="padding:7px 0;color:#777;">Account Type</td><td style="padding:7px 0;text-align:right;font-weight:700;">${roleLabel}</td></tr><tr><td style="padding:7px 0;color:#777;">Login Email</td><td style="padding:7px 0;text-align:right;font-weight:700;word-break:break-all;">${escapeHtml(safeTo)}</td></tr>${discountLine}</table>${productsBlock}<div style="margin-top:20px;padding:14px 16px;background:#111;color:#fff;border-radius:10px;line-height:1.6;font-size:13px;">Login using your registered email and OTP from the GMC website.</div><p style="font-size:12px;color:#888;margin-top:22px;">If you did not expect this account, please contact GMC administration.</p></div></div></body></html>`;
    const textPart = [
        `Congratulations, ${displayName}!`,
        `Your GMC ${roleLabel} account has been created.`,
        `Created by: ${creator}`,
        `Login email: ${safeTo}`,
        role === "reseller" ? `Discount: ${Number(discountPercent || 0)}%` : "",
        role === "reseller" ? `Assigned products: ${productText}` : "",
        "Login using your registered email and OTP from the GMC website."
    ].filter(Boolean).join("\\n");

    return sendEmail({ to: safeTo, subject, textPart, htmlPart });
}

async function sendEmail({ to, subject, textPart, htmlPart, replyTo }) {
    if (!MAILJET_API_KEY || !MAILJET_SECRET_KEY) {
        throw new Error("Mailjet API credentials are not configured.");
    }

    const payload = {
        Messages: [{
            From: {
                Email: MAIL_FROM,
                Name: "GMC Website"
            },
            To: [{
                Email: to
            }],
            Subject: subject,
            TextPart: textPart,
            HTMLPart: htmlPart
        }]
    };

    if (replyTo) {
        payload.Messages[0].ReplyTo = { Email: replyTo };
    }

    const auth = Buffer
        .from(`${MAILJET_API_KEY}:${MAILJET_SECRET_KEY}`)
        .toString("base64");

    const response = await fetch("https://api.mailjet.com/v3.1/send", {
        method: "POST",
        headers: {
            "Authorization": `Basic ${auth}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
    });

    const body = await response.text();

    if (!response.ok) {
        throw new Error(`Mailjet API ${response.status}: ${body}`);
    }

    let result;
    try {
        result = JSON.parse(body);
    } catch {
        throw new Error("Mailjet returned an invalid response.");
    }

    const messageStatus = result?.Messages?.[0]?.Status;
    if (messageStatus && messageStatus.toLowerCase() !== "success") {
        throw new Error(`Mailjet rejected the message: ${body}`);
    }

    return result;
}

console.log("================================");
console.log("GMC ADMIN SERVER");
console.log("================================");
console.log("FIREBASE:", serviceAccount ? "SET" : "NOT SET");
console.log("MAILJET API KEY:", MAILJET_API_KEY ? "SET" : "NOT SET");
console.log("MAIL FROM:", MAIL_FROM);

/* OTP — stored per email in Firestore, so simultaneous logins do not overwrite each other. */
app.post("/api/send-otp", async (req, res) => {
    const email = cleanEmail(req.body.email);
    console.log("OTP REQUEST:", email);
    try {
        const adminAllowed = email && await isAllowedAdmin(email);
        const reseller = !adminAllowed && email ? await getResellerByEmail(email) : null;
        if (!adminAllowed && (!reseller || reseller.active === false)) {
            return res.status(403).json({ message: "This email is not authorized for admin or reseller access." });
        }
        if (!MAILJET_API_KEY || !MAILJET_SECRET_KEY) {
            return res.status(500).json({ message: "Mailjet email service is not configured." });
        }
        const otp = crypto.randomInt(100000, 1000000).toString();
        const otpDocId = encodeURIComponent(email);
        const otpHash = crypto.createHash("sha256").update(otp).digest("hex");
        const role = adminAllowed ? (getRole(email) === "super" ? "super" : "admin") : "reseller";
        await db.collection(COLLECTIONS.otps).doc(otpDocId).set({
            email, hash: otpHash, role, expires: Date.now() + OTP_TTL, attempts: 0,
            createdAt: adminSdk.firestore.FieldValue.serverTimestamp()
        });
        const roleName = role === "super" ? "Super Admin" : role === "admin" ? "Admin" : "Reseller";
        try {
            await sendEmail({
                to: email,
                subject: `GMC ${roleName} Login OTP`,
                textPart: `Your GMC ${roleName} verification code is: ${otp}\n\nThis OTP expires in 5 minutes and can only be used once. If you did not request this code, ignore this email.`,
                htmlPart: `<div style="font-family:Arial,sans-serif;background:#080808;color:#fff;padding:30px"><div style="max-width:500px;margin:auto;border:1px solid #ff2222;border-radius:14px;padding:28px;background:#0d0d0d"><h2 style="color:#ff2222;margin-top:0">GMC ${escapeHtml(roleName).toUpperCase()}</h2><p>Your verification code is:</p><div style="font-size:34px;font-weight:900;letter-spacing:8px;color:#fff;background:#151515;border:1px solid #333;border-radius:10px;padding:16px;text-align:center">${otp}</div><p style="color:#999">This OTP expires in 5 minutes and can only be used once.</p></div></div>`
            });
            console.log(`${roleName.toUpperCase()} OTP EMAIL SENT TO:`, email);
            return res.json({ message: `OTP sent to ${email}.`, role });
        } catch (error) {
            await db.collection(COLLECTIONS.otps).doc(otpDocId).delete().catch(() => {});
            console.error("EMAIL SEND FAILED:", error);
            return res.status(500).json({ message: "Failed to send OTP. Check Mailjet settings and sender verification." });
        }
    } catch (error) {
        console.error("OTP REQUEST FAILED:", error);
        return res.status(500).json({ message: "Unable to process OTP request." });
    }
});

app.post("/api/verify-otp", async (req, res) => {
    const email = cleanEmail(req.body.email);
    const otp = String(req.body.otp || "").trim();
    try {
        const adminAllowed = email && await isAllowedAdmin(email);
        const reseller = !adminAllowed && email ? await getResellerByEmail(email) : null;
        if (!adminAllowed && (!reseller || reseller.active === false)) {
            return res.status(403).json({ message: "This email is not authorized for admin or reseller access." });
        }
        const otpDocId = encodeURIComponent(email);
        const ref = db.collection(COLLECTIONS.otps).doc(otpDocId);
        const snapshot = await ref.get();
        if (!snapshot.exists) return res.status(400).json({ message: "No OTP requested for this email." });
        const otpData = snapshot.data();
        if (Date.now() >= otpData.expires) { await ref.delete(); return res.status(400).json({ message: "OTP expired. Request a new OTP." }); }
        if ((otpData.attempts || 0) >= MAX_OTP_ATTEMPTS) { await ref.delete(); return res.status(429).json({ message: "Too many attempts. Request a new OTP." }); }
        const nextAttempts = (otpData.attempts || 0) + 1;
        await ref.update({ attempts: nextAttempts });
        const hash = crypto.createHash("sha256").update(otp).digest("hex");
        if (hash !== otpData.hash) return res.status(401).json({ message: "Invalid OTP." });
        await ref.delete();
        const role = adminAllowed ? (getRole(email) === "super" ? "super" : "admin") : "reseller";
        if (role === "reseller") {
            const token = crypto.randomBytes(32).toString("hex");
            const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
            await db.collection(COLLECTIONS.resellerSessions).doc(token).set({ resellerId: reseller.id, email: reseller.email, expiresAt, createdAt: adminSdk.firestore.FieldValue.serverTimestamp() });
            const secure = process.env.NODE_ENV === "production" || String(process.env.PUBLIC_BASE_URL || "").startsWith("https://") ? "; Secure" : "";
            res.setHeader("Set-Cookie", `gmc_reseller_session=${token}; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax${secure}`);
            return res.json({ message: "OTP verified. Reseller access granted.", role, email, reseller: { id: reseller.id, name: reseller.name, email: reseller.email, discountPercent: Number(reseller.discountPercent || 0), productIds: Array.isArray(reseller.productIds) ? reseller.productIds : [], bypassPayment: reseller.bypassPayment === true, showBuy: reseller.showBuy === true } });
        }
        const expiresAt = await createSession(res, email, role);
        console.log(`${role.toUpperCase()} LOGIN SUCCESS — SESSION 15 MINUTES — ${email}`);
        return res.json({ message: "OTP verified. Admin access granted.", expiresAt, role, email });
    } catch (error) {
        console.error("OTP VERIFY FAILED:", error);
        return res.status(500).json({ message: "Unable to verify OTP." });
    }
});

/* Sessions — persistent in Firestore so a Render restart does not silently log everyone out. */
async function createSession(res, email, role) {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + SESSION_TTL;

    await db.collection(COLLECTIONS.sessions).doc(token).set({
        email,
        role,
        expiresAt,
        createdAt: adminSdk.firestore.FieldValue.serverTimestamp()
    });

    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader(
        "Set-Cookie",
        `gmc_admin_session=${token}; Max-Age=900; Path=/; HttpOnly; SameSite=Lax${secure}`
    );

    return expiresAt;
}

function parseCookies(req) {
    const result = {};
    const header = req.headers.cookie || "";
    header.split(";").forEach(part => {
        const index = part.indexOf("=");
        if (index < 0) return;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        try {
            result[key] = decodeURIComponent(value);
        } catch {
            result[key] = value;
        }
    });
    return result;
}

async function getSession(req) {
    const token = parseCookies(req).gmc_admin_session;
    if (!token) return null;

    const snapshot = await db.collection(COLLECTIONS.sessions).doc(token).get();
    if (!snapshot.exists) return null;

    const data = snapshot.data();
    if (Date.now() >= Number(data.expiresAt || 0)) {
        await snapshot.ref.delete().catch(() => {});
        return null;
    }

    return { token, ...data };
}

async function requireAdmin(req, res, next) {
    try {
        const session = await getSession(req);
        if (!session) return res.status(401).json({ message: "Admin session expired. Please login again." });
        req.adminSession = session;
        next();
    } catch (error) {
        console.error("SESSION CHECK ERROR:", error);
        return res.status(500).json({ message: "Unable to check admin session." });
    }
}

async function requireSuperAdmin(req, res, next) {
    try {
        const session = await getSession(req);
        if (!session) return res.status(401).json({ message: "Admin session expired. Please login again." });
        if (session.role !== "super") return res.status(403).json({ message: "Super Admin access required." });
        req.adminSession = session;
        next();
    } catch (error) {
        console.error("SUPER SESSION CHECK ERROR:", error);
        return res.status(500).json({ message: "Unable to check admin session." });
    }
}

async function clearSession(res, req) {
    const session = await getSession(req);
    if (session) await db.collection(COLLECTIONS.sessions).doc(session.token).delete().catch(() => {});
    res.setHeader("Set-Cookie", "gmc_admin_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax");
}

app.get("/api/admin-status", async (req, res) => {
    try {
        const session = await getSession(req);
        res.json({
            authenticated: !!session,
            expiresAt: session ? session.expiresAt : 0,
            role: session ? session.role : null,
            email: session ? session.email : null
        });
    } catch (error) {
        console.error("ADMIN STATUS ERROR:", error);
        res.status(500).json({ authenticated: false, expiresAt: 0, role: null, email: null });
    }
});

app.get("/api/site-session", async (req, res) => {
    try {
        const adminSession = await getSession(req);
        if (adminSession) return res.json({ authenticated: true, type: "admin", role: adminSession.role, email: adminSession.email });
        const resellerSession = await getResellerSession(req);
        if (resellerSession) {
            const reseller = await getDocument(COLLECTIONS.resellers, resellerSession.resellerId);
            if (reseller && reseller.active !== false) return res.json({ authenticated: true, type: "reseller", role: "reseller", email: reseller.email, reseller: { id: reseller.id, name: reseller.name, email: reseller.email, discountPercent: Number(reseller.discountPercent || 0), productIds: Array.isArray(reseller.productIds) ? reseller.productIds : [], bypassPayment: reseller.bypassPayment === true, showBuy: reseller.showBuy === true } });
        }
        res.json({ authenticated: false, type: null, role: null, email: null });
    } catch (error) { console.error("SITE SESSION ERROR:", error); res.status(500).json({ authenticated: false, type: null, role: null, email: null }); }
});

app.post("/api/auth-logout", async (req, res) => {
    try {
        const adminSession = await getSession(req);
        if (adminSession) await db.collection(COLLECTIONS.sessions).doc(adminSession.token).delete().catch(() => {});
        const resellerSession = await getResellerSession(req);
        if (resellerSession) await db.collection(COLLECTIONS.resellerSessions).doc(resellerSession.token).delete().catch(() => {});
    } catch (error) { console.error("AUTH LOGOUT ERROR:", error); }
    res.setHeader("Set-Cookie", [
        "gmc_admin_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Lax",
        "gmc_reseller_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Lax"
    ]);
    res.json({ ok: true });
});

app.post("/api/logout", async (req, res) => {
    try {
        // Revoke the server-side session when possible.
        const session = await getSession(req);
        if (session) {
            await db.collection(COLLECTIONS.sessions).doc(session.token).delete().catch(() => {});
        }
    } catch (error) {
        console.error("LOGOUT SESSION REVOKE ERROR:", error);
    }

    // Always expire the browser cookie, even if the session is already gone.
    res.setHeader(
        "Set-Cookie",
        "gmc_admin_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Lax"
    );
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.json({ message: "Logged out." });
});

/* Admin management — Super Admin only */
app.get("/api/admins", requireSuperAdmin, async (req, res) => {
    try {
        res.json((await loadAdmins()).map(a => ({ email: a.email })));
    } catch (error) {
        console.error("ADMIN LIST ERROR:", error);
        res.status(500).json({ message: "Unable to load admins." });
    }
});

app.post("/api/admins", requireSuperAdmin, async (req, res) => {
    try {
        const email = cleanEmail(req.body.email);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: "Enter a valid admin email." });
        if (email === ADMIN_EMAIL) return res.status(400).json({ message: "Super Admin email is already configured." });

        const ref = db.collection(COLLECTIONS.admins).doc(encodeURIComponent(email));
        if ((await ref.get()).exists) return res.status(409).json({ message: "This admin email already exists." });

        await ref.set({ email, createdAt: new Date().toISOString(), createdByEmail: cleanEmail(req.adminSession.email || ADMIN_EMAIL), createdByRole: "super" });
        let emailSent = false;
        try {
            await sendAccountCreatedEmail({
                to: email,
                recipientName: email.split("@")[0],
                role: "admin",
                createdByEmail: req.adminSession.email || ADMIN_EMAIL
            });
            emailSent = true;
        } catch (mailError) {
            console.error("ADMIN WELCOME EMAIL ERROR:", mailError);
        }
        res.status(201).json({ message: emailSent ? "Admin email added and congratulation email sent." : "Admin email added, but congratulation email could not be sent.", emailSent, admins: (await loadAdmins()).map(a => ({ email: a.email })) });
    } catch (error) {
        console.error("ADMIN ADD ERROR:", error);
        res.status(500).json({ message: "Unable to add admin." });
    }
});

app.delete("/api/admins/:email", requireSuperAdmin, async (req, res) => {
    try {
        const email = cleanEmail(decodeURIComponent(req.params.email));
        if (email === ADMIN_EMAIL) return res.status(400).json({ message: "Super Admin cannot be removed." });

        const ref = db.collection(COLLECTIONS.admins).doc(encodeURIComponent(email));
        if (!(await ref.get()).exists) return res.status(404).json({ message: "Admin email not found." });

        await ref.delete();
        res.json({ message: "Admin email removed." });
    } catch (error) {
        console.error("ADMIN DELETE ERROR:", error);
        res.status(500).json({ message: "Unable to remove admin." });
    }
});

/* Contact settings */
app.get("/api/contacts", async (req, res) => {
    try {
        res.json(await loadContacts());
    } catch (error) {
        console.error("CONTACT LOAD ERROR:", error);
        res.status(500).json({ message: "Unable to load contact information." });
    }
});

app.put("/api/contacts", requireAdmin, async (req, res) => {
    try {
        const incoming = Array.isArray(req.body.contacts) ? req.body.contacts : [];
        if (!incoming.length || incoming.length > 12) {
            return res.status(400).json({ message: "Invalid contact list." });
        }

        const contacts = incoming.map((item, index) => ({
            id: String(item.id || `contact-${index + 1}`).trim().slice(0, 50),
            icon: String(item.icon || "◉").trim().slice(0, 8),
            title: String(item.title || "CONTACT").trim().slice(0, 60),
            description: String(item.description || "").trim().slice(0, 200),
            text: String(item.text || "").trim().slice(0, 200),
            url: String(item.url || "").trim().slice(0, 1000)
        }));

        await saveCollection(COLLECTIONS.contacts, contacts, item => item.id);
        res.json({ message: "Contact information saved.", contacts });
    } catch (error) {
        console.error("CONTACT SAVE ERROR:", error);
        res.status(500).json({ message: "Unable to save contact information." });
    }
});

/* Public runtime config — never expose payment credentials. */
/* Purchase logs — admin only. Returns completed purchases with delivery details. */
app.get("/api/purchase-logs", async (req, res) => {
    const adminSession = await getSession(req);
    const resellerSession = !adminSession ? await getResellerSession(req) : null;
    if (!adminSession && !resellerSession) return res.status(401).json({ message: "Please login first." });
    let viewerResellerId = null;
    if (resellerSession) {
        const viewerReseller = await getDocument(COLLECTIONS.resellers, resellerSession.resellerId);
        if (!viewerReseller || viewerReseller.active === false) return res.status(403).json({ message: "Reseller access is disabled." });
        viewerResellerId = String(viewerReseller.id);
    }
    try {
        const snapshot = await db.collection(COLLECTIONS.purchases).get();
        const stale = snapshot.docs.filter(doc => {
            const p = doc.data() || {};
            const status = String(p.status || "").toLowerCase().trim();
            return ["pending", "user_dropped"].includes(status) && Number(p.expiresAt || 0) > 0 && Date.now() >= Number(p.expiresAt);
        });
        for (const doc of stale) {
            const purchase = doc.data() || {};
            try {
                await releaseReservedInventory(purchase);
                await doc.ref.update({
                    status: "expired",
                    paymentMessage: "Payment session expired.",
                    paymentUpdatedAt: adminSdk.firestore.FieldValue.serverTimestamp(),
                    reservedLicenseKey: null,
                    reservedAccount: null
                });
            } catch (cleanupError) {
                console.error("PURCHASE EXPIRY CLEANUP ERROR:", cleanupError);
            }
        }
        const logs = (await db.collection(COLLECTIONS.purchases).get()).docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            // Show all customer-visible payment states. "creating" is an
            // internal pre-Cashfree state and is intentionally hidden.
            .filter(p => {
                const status = String(p.status || "").toLowerCase().trim();
                if (!status || status === "creating") return false;
                if (viewerResellerId && String(p.resellerId || "") !== viewerResellerId) return false;
                return true;
            })
            .sort((a, b) => {
                const ta = a.paidAt?.toMillis?.() || a.createdAt?.toMillis?.() || Number(a.paidAt || a.createdAt || 0) || 0;
                const tb = b.paidAt?.toMillis?.() || b.createdAt?.toMillis?.() || Number(b.paidAt || b.createdAt || 0) || 0;
                return tb - ta;
            })
            .map(p => {
                const account = p.account && typeof p.account === "object" ? p.account : {};
                const amount = Number(p.amountPaise || 0) / 100;
                const planLabel = String(p.planLabel || "").trim();
                return {
                    id: p.id,
                    customerName: String(p.customerName || "").trim(),
                    email: String(p.customerEmail || "").trim(),
                    phone: String(p.customerPhone || p.phone || "").trim(),
                    username: p.credentialMode === "userpass" ? String(account.username || "").trim() : "",
                    password: p.credentialMode === "userpass" ? String(account.password || "") : "",
                    license: p.credentialMode === "license" ? String(p.licenseKey || "").trim() : "",
                    productName: String(p.productName || "").trim(),
                    planDetails: planLabel + (amount ? ` — ₹${amount.toLocaleString("en-IN")}` : ""),
                    purchaseDate: p.paidAt?.toDate?.()?.toISOString?.() || p.createdAt?.toDate?.()?.toISOString?.() || null,
                    paymentId: String(p.paymentId || p.lastPaymentId || "").trim(),
                    status: String(p.status || "pending").toLowerCase().trim(),
                    paymentMessage: String(p.paymentMessage || p.error || p.paymentFailureReason || "").trim(),
                    refundAmount: Number(p.refundAmountPaise || 0) / 100,
                    refundId: String(p.refundId || p.cashfreeRefundId || "").trim(),
                    refundedAt: p.refundedAt?.toDate?.()?.toISOString?.() || p.refundUpdatedAt?.toDate?.()?.toISOString?.() || null,
                    testPayment: Boolean(p.testPayment)
                };
            });
        res.json({ ok: true, logs });
    } catch (error) {
        console.error("PURCHASE LOGS ERROR:", error);
        res.status(500).json({ message: "Unable to load purchase logs." });
    }
});

app.get("/api/config", (req, res) => {
    res.json({
        ok: true,
        test_payment_enabled: TEST_PAYMENT_ENABLED,
        buy_license_url: process.env.BUY_LICENSE_URL || "",
        cashfree_mode: CASHFREE_ENV.toLowerCase()
    });
});


/* Reseller access and pricing */
async function getResellerByEmail(email) {
    const normalized = cleanEmail(email);
    if (!normalized) return null;
    const snap = await db.collection(COLLECTIONS.resellers).where("email", "==", normalized).limit(1).get();
    return snap.empty ? null : docToData(snap.docs[0]);
}

async function getResellerSession(req) {
    const token = parseCookies(req).gmc_reseller_session;
    if (!token) return null;
    const snap = await db.collection(COLLECTIONS.resellerSessions).doc(token).get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (Date.now() >= Number(data.expiresAt || 0)) {
        await snap.ref.delete().catch(() => {});
        return null;
    }
    return { token, ...data };
}

async function requireReseller(req, res, next) {
    try {
        const session = await getResellerSession(req);
        if (!session) return res.status(401).json({ message: "Reseller session expired. Please login again." });
        const reseller = await getDocument(COLLECTIONS.resellers, session.resellerId);
        if (!reseller || reseller.active === false) return res.status(403).json({ message: "Reseller access is disabled." });
        req.resellerSession = session;
        req.reseller = reseller;
        next();
    } catch (error) {
        console.error("RESELLER SESSION CHECK ERROR:", error);
        return res.status(500).json({ message: "Unable to check reseller session." });
    }
}

function resellerDiscountedAmountPaise(amountPaise, discountPercent) {
    const amount = Math.max(0, Number(amountPaise) || 0);
    const discount = Math.max(0, Math.min(100, Number(discountPercent) || 0));
    return Math.max(1, Math.round(amount * (100 - discount) / 100));
}

function resellerCanBuyProduct(reseller, productId) {
    return Array.isArray(reseller?.productIds) && reseller.productIds.map(String).includes(String(productId));
}

/* Reseller login is intentionally email-based, as requested. */
app.post("/api/reseller-login", async (req, res) => {
    try {
        const email = cleanEmail(req.body?.email);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: "Enter a valid reseller email." });
        const reseller = await getResellerByEmail(email);
        if (!reseller || reseller.active === false) return res.status(403).json({ message: "This email is not registered as an active reseller." });
        const token = crypto.randomBytes(32).toString("hex");
        const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
        await db.collection(COLLECTIONS.resellerSessions).doc(token).set({ resellerId: reseller.id, email: reseller.email, expiresAt, createdAt: adminSdk.firestore.FieldValue.serverTimestamp() });
        const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
        res.setHeader("Set-Cookie", `gmc_reseller_session=${token}; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax${secure}`);
        return res.json({ ok: true, reseller: { id: reseller.id, name: reseller.name, email: reseller.email, discountPercent: Number(reseller.discountPercent || 0), productIds: Array.isArray(reseller.productIds) ? reseller.productIds : [], bypassPayment: reseller.bypassPayment === true, showBuy: reseller.showBuy === true } });
    } catch (error) {
        console.error("RESELLER LOGIN ERROR:", error);
        return res.status(500).json({ message: "Unable to login as reseller." });
    }
});

app.get("/api/reseller-status", async (req, res) => {
    try {
        const session = await getResellerSession(req);
        if (!session) return res.json({ authenticated: false });
        const reseller = await getDocument(COLLECTIONS.resellers, session.resellerId);
        if (!reseller || reseller.active === false) return res.json({ authenticated: false });
        return res.json({ authenticated: true, reseller: { id: reseller.id, name: reseller.name, email: reseller.email, discountPercent: Number(reseller.discountPercent || 0), productIds: Array.isArray(reseller.productIds) ? reseller.productIds : [], bypassPayment: reseller.bypassPayment === true, showBuy: reseller.showBuy === true } });
    } catch (error) {
        console.error("RESELLER STATUS ERROR:", error);
        res.status(500).json({ authenticated: false });
    }
});

app.post("/api/reseller-logout", async (req, res) => {
    try {
        const session = await getResellerSession(req);
        if (session) await db.collection(COLLECTIONS.resellerSessions).doc(session.token).delete().catch(() => {});
    } catch (error) { console.error("RESELLER LOGOUT ERROR:", error); }
    res.setHeader("Set-Cookie", "gmc_reseller_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Lax");
    res.json({ ok: true });
});

/* Admin reseller management — creators own their resellers; Super Admin owns/controls everything. */
function canManageReseller(session, reseller) {
    if (!session || !reseller) return false;
    if (session.role === "super") return true;
    const owner = cleanEmail(reseller.createdByEmail || "");
    return !!owner && owner === cleanEmail(session.email || "");
}

app.get("/api/resellers", requireAdmin, async (req, res) => {
    try {
        const [allResellers, products] = await Promise.all([loadCollection(COLLECTIONS.resellers), loadProducts()]);
        const isSuper = req.adminSession.role === "super";
        const viewerEmail = cleanEmail(req.adminSession.email || "");
        const resellers = allResellers.filter(r => isSuper || cleanEmail(r.createdByEmail || "") === viewerEmail);
        res.json({ resellers, products: products.map(p => ({ id: p.id, name: p.name })) });
    } catch (error) {
        console.error("RESELLER LIST ERROR:", error);
        res.status(500).json({ message: "Unable to load resellers." });
    }
});

app.post("/api/resellers", requireAdmin, async (req, res) => {
    try {
        const name = String(req.body?.name || "").trim().slice(0, 120);
        const email = cleanEmail(req.body?.email);
        const discountPercent = Number(req.body?.discountPercent);
        const productIds = Array.isArray(req.body?.productIds) ? [...new Set(req.body.productIds.map(x => String(x).trim()).filter(Boolean))] : [];
        if (!name) return res.status(400).json({ message: "Reseller name is required." });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: "Enter a valid reseller email." });
        if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) return res.status(400).json({ message: "Discount must be between 0 and 100%." });
        const existing = await getResellerByEmail(email);
        if (existing) return res.status(409).json({ message: "This reseller email already exists." });
        const productSnap = await db.collection(COLLECTIONS.products).get();
        const validIds = new Set(productSnap.docs.map(d => d.id));
        const cleanProductIds = productIds.filter(id => validIds.has(id));
        const ref = db.collection(COLLECTIONS.resellers).doc();
        const now = new Date().toISOString();
        const reseller = {
            name,
            email,
            discountPercent: Math.round(discountPercent * 100) / 100,
            productIds: cleanProductIds,
            bypassPayment: req.body?.bypassPayment === true,
            showBuy: req.body?.showBuy === true,
            active: true,
            createdAt: now,
            createdByEmail: cleanEmail(req.adminSession.email || ""),
            createdByRole: req.adminSession.role || "admin"
        };
        await ref.set(reseller);
        let emailSent = false;
        try {
            const productMap = new Map(productSnap.docs.map(d => [d.id, String(d.data()?.name || d.id)]));
            const productNames = cleanProductIds.map(id => productMap.get(id)).filter(Boolean);
            await sendAccountCreatedEmail({
                to: email,
                recipientName: name,
                role: "reseller",
                createdByEmail: req.adminSession.email || ADMIN_EMAIL,
                discountPercent: reseller.discountPercent,
                productNames
            });
            emailSent = true;
        } catch (mailError) {
            console.error("RESELLER WELCOME EMAIL ERROR:", mailError);
        }
        res.status(201).json({ id: ref.id, ...reseller, emailSent });
    } catch (error) {
        console.error("RESELLER ADD ERROR:", error);
        res.status(500).json({ message: "Unable to add reseller." });
    }
});

app.put("/api/resellers/:id", requireAdmin, async (req, res) => {
    try {
        const ref = db.collection(COLLECTIONS.resellers).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ message: "Reseller not found." });
        const old = snap.data();
        if (!canManageReseller(req.adminSession, old)) return res.status(403).json({ message: "You can only edit resellers created by you." });
        const name = String(req.body?.name ?? old.name ?? "").trim().slice(0, 120);
        const email = cleanEmail(req.body?.email ?? old.email);
        const discountPercent = Number(req.body?.discountPercent ?? old.discountPercent ?? 0);
        const productIds = Array.isArray(req.body?.productIds) ? [...new Set(req.body.productIds.map(x => String(x).trim()).filter(Boolean))] : (Array.isArray(old.productIds) ? old.productIds : []);
        if (!name) return res.status(400).json({ message: "Reseller name is required." });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: "Enter a valid reseller email." });
        if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) return res.status(400).json({ message: "Discount must be between 0 and 100%." });
        const other = await getResellerByEmail(email);
        if (other && other.id !== ref.id) return res.status(409).json({ message: "This reseller email already exists." });
        const productSnap = await db.collection(COLLECTIONS.products).get();
        const validIds = new Set(productSnap.docs.map(d => d.id));
        const cleanProductIds = productIds.filter(id => validIds.has(id));
        const updated = {
            ...old,
            name,
            email,
            discountPercent: Math.round(discountPercent * 100) / 100,
            productIds: cleanProductIds,
            bypassPayment: req.body?.bypassPayment === true,
            showBuy: req.body?.showBuy === true,
            active: req.body?.active === false ? false : true,
            createdByEmail: cleanEmail(old.createdByEmail || ""),
            createdByRole: old.createdByRole || "admin"
        };
        await ref.set(updated);
        res.json({ id: ref.id, ...updated });
    } catch (error) {
        console.error("RESELLER UPDATE ERROR:", error);
        res.status(500).json({ message: "Unable to update reseller." });
    }
});

app.delete("/api/resellers/:id", requireAdmin, async (req, res) => {
    try {
        const ref = db.collection(COLLECTIONS.resellers).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ message: "Reseller not found." });
        if (!canManageReseller(req.adminSession, snap.data())) return res.status(403).json({ message: "You can only remove resellers created by you." });
        await ref.delete();
        const sessions = await db.collection(COLLECTIONS.resellerSessions).where("resellerId", "==", req.params.id).get();
        const batch = db.batch(); sessions.docs.forEach(d => batch.delete(d.ref)); if (!sessions.empty) await batch.commit();
        res.json({ ok: true });
    } catch (error) {
        console.error("RESELLER DELETE ERROR:", error);
        res.status(500).json({ message: "Unable to delete reseller." });
    }
});

/* Products */
app.get("/api/products", async (req, res) => {
    try {
        const products = await loadProducts();
        const resellerSession = await getResellerSession(req);
        if (!resellerSession) return res.json(products);
        const reseller = await getDocument(COLLECTIONS.resellers, resellerSession.resellerId);
        if (!reseller || reseller.active === false) return res.json([]);
        const allowed = new Set((Array.isArray(reseller.productIds) ? reseller.productIds : []).map(String));
        const discountPercent = Math.max(0, Math.min(100, Number(reseller.discountPercent || 0)));
        const filtered = products.filter(p => allowed.has(String(p.id))).map(p => ({
            ...p,
            resellerDiscountPercent: discountPercent,
            resellerShowBuy: reseller.showBuy === true,
            resellerBypassPayment: reseller.bypassPayment === true,
            plans: (Array.isArray(p.plans) ? p.plans : []).map(plan => {
                const originalPaise = parsePlanAmount(plan.price);
                const discountedPaise = originalPaise ? resellerDiscountedAmountPaise(originalPaise, discountPercent) : 0;
                return { ...plan, resellerPrice: discountedPaise ? `₹${(discountedPaise / 100).toLocaleString("en-IN")}` : plan.price, resellerOriginalPrice: originalPaise ? `₹${(originalPaise / 100).toLocaleString("en-IN")}` : plan.price };
            })
        }));
        res.json(filtered);
    } catch (error) {
        console.error("PRODUCT LIST ERROR:", error);
        res.status(500).json({ message: "Unable to load products." });
    }
});

function normalizeProductPlans(incomingPlans, oldPlans = []) {
    const previous=Array.isArray(oldPlans)?oldPlans:[],used=new Set();
    return (Array.isArray(incomingPlans)?incomingPlans:[]).slice(0,20).map(raw=>{
        const label=String(raw?.label||"").trim(),price=String(raw?.price||"").trim(),iid=String(raw?.id||"").trim();let mi=-1;
        if(iid)mi=previous.findIndex((p,i)=>!used.has(i)&&String(p?.id||"")===iid);
        if(mi<0&&label)mi=previous.findIndex((p,i)=>!used.has(i)&&String(p?.label||"").trim()===label);
        const old=mi>=0?previous[mi]:null;if(mi>=0)used.add(mi);
        const licenses=Array.isArray(raw?.licenses)?raw.licenses.map(x=>String(x).trim()).filter(Boolean).slice(0,5000):(Array.isArray(old?.licenses)?old.licenses.map(x=>String(x).trim()).filter(Boolean).slice(0,5000):[]);
        const accounts=Array.isArray(raw?.accounts)?raw.accounts.map(x=>({username:String(x?.username||"").trim(),password:String(x?.password||"")})).filter(x=>x.username&&x.password).slice(0,5000):(Array.isArray(old?.accounts)?old.accounts.map(x=>({username:String(x?.username||"").trim(),password:String(x?.password||"")})).filter(x=>x.username&&x.password).slice(0,5000):[]);
        const credentialMode=["license","userpass","off"].includes(raw?.credentialMode)?raw.credentialMode:(old?.credentialMode||"license");
        return {id:iid||String(old?.id||crypto.randomUUID()),label,price,licenses,accounts,credentialMode};
    }).filter(p=>p.label||p.price);
}

app.post("/api/products", requireAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        if (!String(body.name || "").trim()) return res.status(400).json({ message: "Product name is required." });

        const product = {
            id: crypto.randomUUID(),
            icon: String(body.icon || "📦").trim(),
            tag: String(body.tag || "NEW").trim(),
            name: String(body.name).trim(),
            description: String(body.description || "").trim(),
            contentType: ["plans", "image", "both"].includes(body.contentType) ? body.contentType : "plans",
            imageUrl: String(body.imageUrl || "").trim(),
            downloadUrl: String(body.downloadUrl || "").trim(),
            plans: normalizeProductPlans(body.plans, []),
            buttons: Array.isArray(body.buttons) && body.buttons.length
                ? body.buttons.slice(0, 2)
                : [{ text: String(body.buttonText || "GET PRODUCT"), link: String(body.buttonLink || "#") }],
            buyEnabled: Boolean(body.buyEnabled),
            createdAt: new Date().toISOString(),
            order: Date.now()
        };

        await db.collection(COLLECTIONS.products).doc(product.id).set(product);
        res.status(201).json(product);
    } catch (error) {
        console.error("PRODUCT ADD ERROR:", error);
        res.status(500).json({ message: "Unable to save product." });
    }
});

app.post("/api/products/reorder", requireAdmin, async (req, res) => {
    try {
        const productIds = Array.isArray(req.body?.productIds)
            ? req.body.productIds.map(x => String(x).trim()).filter(Boolean)
            : [];
        if (!productIds.length) return res.status(400).json({ message: "No product order received." });

        const uniqueIds = [...new Set(productIds)];
        const snapshot = await db.collection(COLLECTIONS.products).get();
        const existingIds = snapshot.docs.map(doc => doc.id);
        const existingSet = new Set(existingIds);
        if (uniqueIds.length !== existingIds.length || uniqueIds.some(id => !existingSet.has(id))) {
            return res.status(400).json({ message: "Product list changed. Please refresh and try again." });
        }

        await db.runTransaction(async tx => {
            for (let i = 0; i < uniqueIds.length; i++) {
                tx.update(db.collection(COLLECTIONS.products).doc(uniqueIds[i]), { order: i });
            }
        });

        res.json({ ok: true, products: await loadProducts() });
    } catch (error) {
        console.error("PRODUCT REORDER ERROR:", error);
        res.status(500).json({ message: "Unable to save product order." });
    }
});

app.put("/api/products/:id", requireAdmin, async (req, res) => {
    try {
        const ref = db.collection(COLLECTIONS.products).doc(req.params.id);
        const snapshot = await ref.get();
        if (!snapshot.exists) return res.status(404).json({ message: "Product not found." });

        const old = snapshot.data();
        const body = req.body || {};
        const updated = {
            ...old,
            icon: String(body.icon ?? old.icon ?? "📦").trim(),
            tag: String(body.tag ?? old.tag ?? "NEW").trim(),
            name: String(body.name ?? old.name ?? "").trim(),
            description: String(body.description ?? old.description ?? "").trim(),
            contentType: ["plans", "image", "both"].includes(body.contentType) ? body.contentType : (old.contentType || "plans"),
            imageUrl: String(body.imageUrl ?? old.imageUrl ?? "").trim(),
            downloadUrl: String(body.downloadUrl ?? old.downloadUrl ?? "").trim(),
            plans: Array.isArray(body.plans) ? normalizeProductPlans(body.plans, old.plans || []) : (old.plans || []),
            buttons: Array.isArray(body.buttons) && body.buttons.length
                ? body.buttons.slice(0, 2)
                : (old.buttons || [{ text: "GET PRODUCT", link: "#" }]),
            buyEnabled: typeof body.buyEnabled === "boolean" ? body.buyEnabled : Boolean(old.buyEnabled)
        };

        if (!updated.name) return res.status(400).json({ message: "Product name is required." });
        await ref.set(updated);
        res.json({ id: ref.id, ...updated });
    } catch (error) {
        console.error("PRODUCT UPDATE ERROR:", error);
        res.status(500).json({ message: "Unable to update product." });
    }
});

app.post("/api/products/:id/licenses/bulk", requireAdmin, async (req,res)=>{
 try{const ref=db.collection(COLLECTIONS.products).doc(req.params.id),keys=Array.isArray(req.body?.keys)?req.body.keys.map(x=>String(x).trim()).filter(Boolean):[],pi=Number(req.body?.planIndex);if(!Number.isInteger(pi)||pi<0)return res.status(400).json({message:"Invalid plan."});if(!keys.length)return res.status(400).json({message:"No license keys found."});
  const result=await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists)throw new Error("Product not found.");const data=snap.data(),plans=Array.isArray(data.plans)?data.plans.map(p=>({...p,licenses:Array.isArray(p?.licenses)?p.licenses.slice():[]})):[];if(!plans[pi])throw new Error("Selected plan is not available.");const seen=new Set(plans.flatMap(p=>p.licenses.map(x=>String(x).toLowerCase())));let added=0,duplicates=0;for(const key of keys){const k=key.toLowerCase();if(seen.has(k)){duplicates++;continue;}seen.add(k);plans[pi].licenses.push(key);added++;}tx.update(ref,{plans});return {added,duplicates,available:plans[pi].licenses.length};});res.json({ok:true,...result});
 }catch(error){console.error("LICENSE BULK ADD ERROR:",error);res.status(500).json({message:error.message||"Unable to import license keys."})}
});

app.delete("/api/products/:id", requireAdmin, async (req, res) => {
    try {
        const ref = db.collection(COLLECTIONS.products).doc(req.params.id);
        const snapshot = await ref.get();
        if (!snapshot.exists) return res.status(404).json({ message: "Product not found." });

        await ref.delete();
        res.json({ message: "Product deleted." });
    } catch (error) {
        console.error("PRODUCT DELETE ERROR:", error);
        res.status(500).json({ message: "Unable to delete product." });
    }
});



/* Cashfree webhook — production payment confirmation. */
app.post("/api/webhooks/cashfree", async (req, res) => {
    try {
        if (!CASHFREE_CLIENT_SECRET) return res.status(503).send("Cashfree webhook secret is not configured.");
        const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
        const signature = String(req.get("x-webhook-signature") || "").trim();
        const timestamp = String(req.get("x-webhook-timestamp") || "").trim();
        if (!signature || !timestamp || !rawBody) return res.status(400).send("Missing webhook signature data.");
        const expected = crypto.createHmac("sha256", CASHFREE_CLIENT_SECRET).update(timestamp + rawBody).digest("base64");
        const sigBuf = Buffer.from(signature, "utf8");
        const expBuf = Buffer.from(expected, "utf8");
        if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return res.status(401).send("Invalid signature.");
        const payload = JSON.parse(rawBody);
        const eventType = String(payload?.type || "").trim();

        // Cashfree refund webhook: when a refund is successfully processed in
        // the Cashfree Dashboard/API, mark the matching GMC purchase as refunded.
        if (eventType === "REFUND_STATUS_WEBHOOK" || eventType === "AUTO_REFUND_STATUS_WEBHOOK") {
            const refund = payload?.data?.refund || payload?.data?.auto_refund || {};
            const refundStatus = String(refund.refund_status || "").trim().toUpperCase();
            const orderId = String(refund.order_id || "").trim();
            if (!orderId || !["SUCCESS", "PROCESSED"].includes(refundStatus)) {
                return res.json({ ok: true, ignored: true });
            }
            const snapshot = await db.collection(COLLECTIONS.purchases).where("cashfreeOrderId", "==", orderId).limit(1).get();
            if (snapshot.empty) return res.status(202).json({ ok: true, ignored: true, reason: "purchase_not_found" });
            const purchaseRef = snapshot.docs[0].ref;
            await purchaseRef.update({
                status: "refund",
                refundStatus: refundStatus.toLowerCase(),
                refundId: String(refund.refund_id || "").trim(),
                cashfreeRefundId: String(refund.cf_refund_id || "").trim(),
                refundAmountPaise: Math.round(Number(refund.refund_amount || 0) * 100),
                refundArn: String(refund.refund_arn || "").trim(),
                refundedAt: refund.processed_at || refund.created_at || adminSdk.firestore.FieldValue.serverTimestamp(),
                refundUpdatedAt: adminSdk.firestore.FieldValue.serverTimestamp()
            });
            return res.json({ ok: true, received: true, status: "refund" });
        }

        const orderId = String(payload?.data?.order?.order_id || "").trim();
        const payment = payload?.data?.payment || {};
        const paymentStatus = String(payment.payment_status || "").trim().toUpperCase();
        const paymentId = String(payment.cf_payment_id || "").trim();

        // Cashfree sends separate webhooks for failed payments and for users
        // who drop out of the payment flow. Keep these attempts visible in
        // GMC logs, while still allowing a later successful retry to become PAID.
        const nonSuccessStatuses = {
            "PAYMENT_FAILED_WEBHOOK": "failed",
            "PAYMENT_USER_DROPPED_WEBHOOK": "user_dropped"
        };
        if (Object.prototype.hasOwnProperty.call(nonSuccessStatuses, eventType)) {
            if (!orderId) return res.json({ ok: true, ignored: true });
            const snapshot = await db.collection(COLLECTIONS.purchases).where("cashfreeOrderId", "==", orderId).limit(1).get();
            if (snapshot.empty) return res.status(202).json({ ok: true, ignored: true, reason: "purchase_not_found" });
            const purchaseRef = snapshot.docs[0].ref;
            const current = snapshot.docs[0].data();
            // Never downgrade a purchase that has already become paid/refunded.
            if (current.status === "paid" || current.status === "refund") {
                return res.json({ ok: true, ignored: true, reason: "already_final" });
            }
            const errorDetails = payload?.data?.error_details || {};
            const message = String(
                payment.payment_message ||
                errorDetails.error_description ||
                errorDetails.error_reason ||
                (eventType === "PAYMENT_USER_DROPPED_WEBHOOK" ? "User dropped payment." : "Payment failed.")
            ).trim();
            await purchaseRef.update({
                status: nonSuccessStatuses[eventType],
                lastPaymentId: paymentId || null,
                paymentStatus,
                paymentMessage: message,
                paymentFailureReason: String(errorDetails.error_reason || "").trim(),
                paymentUpdatedAt: adminSdk.firestore.FieldValue.serverTimestamp()
            });
            return res.json({ ok: true, received: true, status: nonSuccessStatuses[eventType] });
        }

        if (eventType !== "PAYMENT_SUCCESS_WEBHOOK") return res.json({ ok: true, ignored: true });
        const paymentAmount = Number(payment.payment_amount || 0);
        if (!orderId || paymentStatus !== "SUCCESS") return res.json({ ok: true, ignored: true });
        const snapshot = await db.collection(COLLECTIONS.purchases).where("cashfreeOrderId", "==", orderId).limit(1).get();
        if (snapshot.empty) return res.status(202).json({ ok: true, ignored: true, reason: "purchase_not_found" });
        const purchaseId = snapshot.docs[0].id;
        const purchase = snapshot.docs[0].data();
        if (Math.round(paymentAmount * 100) !== Number(purchase.amountPaise || 0)) return res.status(400).send("Payment amount mismatch.");
        await markCashfreePurchasePaid(purchaseId, paymentId, "cashfree_webhook");
        return res.json({ ok: true, received: true });
    } catch (error) {
        console.error("CASHFREE WEBHOOK ERROR:", error);
        return res.status(500).json({ message: "Webhook processing failed." });
    }
});

/* Local test payment flow. */
app.post("/api/payment/test-success", async (req, res) => {
    if (!TEST_PAYMENT_ENABLED) return res.status(404).json({ message: "Test payment is disabled." });
    try {
        const productId = String(req.body?.productId || "").trim();
        const planIndex = Number(req.body?.planIndex);
        const customerName = String(req.body?.name || "").trim().slice(0, 120);
        const customerEmail = cleanEmail(req.body?.email);
        if (!productId || !Number.isInteger(planIndex) || planIndex < 0) return res.status(400).json({ message: "Invalid product or package." });
        if (customerName.length < 2) return res.status(400).json({ message: "Enter your name." });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) return res.status(400).json({ message: "Enter a valid email address." });
        const product = await getDocument(COLLECTIONS.products, productId);
        if (!product) return res.status(404).json({ message: "Product not found." });
        const plans = Array.isArray(product.plans) ? product.plans : [];
        const selectedPlan = plans[planIndex];
        if (!selectedPlan) return res.status(400).json({ message: "Selected package is not available." });
        const originalAmountPaise = parsePlanAmount(selectedPlan.price);
        if (!originalAmountPaise) return res.status(400).json({ message: "This package does not have a valid numeric price." });
        const resellerSession = await getResellerSession(req);
        let reseller = null;
        if (resellerSession) { reseller = await getDocument(COLLECTIONS.resellers, resellerSession.resellerId); if (!reseller || reseller.active === false) return res.status(403).json({ message: "Reseller access is disabled." }); if (!resellerCanBuyProduct(reseller, productId)) return res.status(403).json({ message: "This product is not assigned to your reseller account." }); }
        const resellerDiscountPercent = reseller ? Math.max(0, Math.min(100, Number(reseller.discountPercent || 0))) : 0;
        const amountPaise = reseller ? resellerDiscountedAmountPaise(originalAmountPaise, resellerDiscountPercent) : originalAmountPaise;
        const purchaseRef = db.collection(COLLECTIONS.purchases).doc();
        let reservedLicenseKey = "", reservedAccount = null, credentialMode = "license";
        await db.runTransaction(async tx => {
            const pref = db.collection(COLLECTIONS.products).doc(productId); const snap = await tx.get(pref);
            if (!snap.exists) throw new Error("Product not found.");
            const data = snap.data(); const pp = Array.isArray(data.plans) ? data.plans.map(p => ({ ...p, licenses: Array.isArray(p?.licenses) ? p.licenses.slice() : [], accounts: Array.isArray(p?.accounts) ? p.accounts.map(x => ({ ...x })) : [] })) : [];
            const plan = pp[planIndex]; if (!plan) throw new Error("Selected package is not available.");
            credentialMode = ["license", "userpass", "off"].includes(plan.credentialMode) ? plan.credentialMode : "license";
            if (credentialMode === "off") throw new Error("This plan is currently disabled.");
            if (credentialMode === "license") { if (!plan.licenses.length) throw new Error("This plan is currently out of stock."); reservedLicenseKey = String(plan.licenses.shift()).trim(); }
            else if (credentialMode === "userpass") { if (!plan.accounts.length) throw new Error("This plan is currently out of stock."); reservedAccount = plan.accounts.shift(); }
            tx.update(pref, { plans: pp });
        });
        const downloadUrl = String(product.downloadUrl || "").trim();
        await purchaseRef.set({ productId, productName: String(product.name || ""), planIndex, planLabel: String(selectedPlan.label || `Package ${planIndex + 1}`), amountPaise, originalAmountPaise, resellerId: reseller?.id || null, resellerName: reseller?.name || null, resellerEmail: reseller?.email || null, resellerDiscountPercent, customerName, customerEmail, reservedLicenseKey, reservedAccount, credentialMode, downloadUrl, status: "paid", paymentId: `TEST_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`, licenseKey: credentialMode === "license" ? (reservedLicenseKey || null) : null, account: credentialMode === "userpass" ? reservedAccount : null, testPayment: true, paidAt: adminSdk.firestore.FieldValue.serverTimestamp() });
        let emailStatus = "pending";
        try { const delivery = await deliverPurchaseEmail(purchaseRef.id); emailStatus = delivery.sent || delivery.alreadySent ? "sent" : (delivery.claimedByOther ? "sending" : "pending"); } catch { emailStatus = "failed"; }
        return res.json({ ok: true, testPayment: true, status: "paid", purchaseId: purchaseRef.id, amount: amountPaise / 100, productName: String(product.name || ""), planLabel: String(selectedPlan.label || ""), emailStatus, downloadUrl: downloadUrl || null });
    } catch (error) { console.error("TEST PAYMENT FAILED:", error); return res.status(400).json({ message: error.message || "Unable to complete test payment." }); }
});

/* Reseller payment-bypass checkout. Server-side reseller permission is required. */
app.post("/api/payment/reseller-bypass", async (req, res) => {
    try {
        const resellerSession = await getResellerSession(req);
        if (!resellerSession) return res.status(401).json({ message: "Reseller login is required." });
        const reseller = await getDocument(COLLECTIONS.resellers, resellerSession.resellerId);
        if (!reseller || reseller.active === false) return res.status(403).json({ message: "Reseller access is disabled." });
        if (reseller.bypassPayment !== true) return res.status(403).json({ message: "Payment bypass is not enabled for this reseller." });

        const productId = String(req.body?.productId || "").trim();
        const planIndex = Number(req.body?.planIndex);
        const customerName = String(req.body?.name || "").trim().slice(0, 120);
        const customerEmail = cleanEmail(req.body?.email);
        const customerPhone = normalizePhone(req.body?.phone);
        if (!productId || !Number.isInteger(planIndex) || planIndex < 0) return res.status(400).json({ message: "Invalid product or package." });
        if (customerName.length < 2) return res.status(400).json({ message: "Enter the customer name." });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) return res.status(400).json({ message: "Enter a valid email address." });
        if (!/^[6-9]\d{9}$/.test(customerPhone)) return res.status(400).json({ message: "Enter a valid 10-digit Indian mobile number." });
        if (!resellerCanBuyProduct(reseller, productId)) return res.status(403).json({ message: "This product is not assigned to your reseller account." });

        const product = await getDocument(COLLECTIONS.products, productId);
        if (!product) return res.status(404).json({ message: "Product not found." });
        const plans = Array.isArray(product.plans) ? product.plans : [];
        const selectedPlan = plans[planIndex];
        if (!selectedPlan) return res.status(400).json({ message: "Selected package is not available." });
        const originalAmountPaise = parsePlanAmount(selectedPlan.price);
        if (!originalAmountPaise) return res.status(400).json({ message: "This package does not have a valid price." });
        const discountPercent = Math.max(0, Math.min(100, Number(reseller.discountPercent || 0)));
        const amountPaise = resellerDiscountedAmountPaise(originalAmountPaise, discountPercent);
        if (!amountPaise) return res.status(400).json({ message: "Calculated reseller amount is invalid." });

        const purchaseRef = db.collection(COLLECTIONS.purchases).doc();
        let reservedLicenseKey = "", reservedAccount = null, credentialMode = "license";
        await db.runTransaction(async tx => {
            const pref = db.collection(COLLECTIONS.products).doc(productId);
            const snap = await tx.get(pref);
            if (!snap.exists) throw new Error("Product not found.");
            const data = snap.data();
            const pp = Array.isArray(data.plans) ? data.plans.map(p => ({ ...p, licenses: Array.isArray(p?.licenses) ? p.licenses.slice() : [], accounts: Array.isArray(p?.accounts) ? p.accounts.map(x => ({ ...x })) : [] })) : [];
            const plan = pp[planIndex];
            if (!plan) throw new Error("Selected package is not available.");
            credentialMode = ["license", "userpass", "off"].includes(plan.credentialMode) ? plan.credentialMode : "license";
            if (credentialMode === "off") throw new Error("This plan is currently disabled.");
            if (credentialMode === "license") {
                if (!plan.licenses.length) throw new Error("This plan is currently out of stock.");
                reservedLicenseKey = String(plan.licenses.shift()).trim();
            } else if (credentialMode === "userpass") {
                if (!plan.accounts.length) throw new Error("This plan is currently out of stock.");
                reservedAccount = plan.accounts.shift();
            }
            tx.update(pref, { plans: pp });
        });

        const purchase = {
            productId, productName: String(product.name || ""), planIndex,
            planLabel: String(selectedPlan.label || `Package ${planIndex + 1}`),
            amountPaise, originalAmountPaise,
            resellerId: reseller.id, resellerName: reseller.name || null, resellerEmail: reseller.email || null,
            resellerDiscountPercent: discountPercent,
            customerName, customerEmail, customerPhone,
            reservedLicenseKey, reservedAccount, credentialMode,
            downloadUrl: String(product.downloadUrl || "").trim(),
            status: "paid", paymentId: `RESELLER_BYPASS_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
            paymentMethod: "reseller_bypass", bypassPayment: true,
            paidAt: adminSdk.firestore.FieldValue.serverTimestamp(),
            createdAt: adminSdk.firestore.FieldValue.serverTimestamp()
        };
        await purchaseRef.set(purchase);
        let emailStatus = "pending";
        try {
            const delivery = await deliverPurchaseEmail(purchaseRef.id);
            emailStatus = delivery.sent || delivery.alreadySent ? "sent" : (delivery.claimedByOther ? "sending" : "pending");
        } catch (mailError) { console.error("RESELLER BYPASS DELIVERY ERROR:", mailError); emailStatus = "failed"; }
        return res.json({ ok: true, bypassPayment: true, status: "paid", purchaseId: purchaseRef.id, amount: amountPaise / 100, productName: String(product.name || ""), planLabel: String(selectedPlan.label || ""), licenseKey: credentialMode === "license" ? reservedLicenseKey : null, account: credentialMode === "userpass" ? reservedAccount : null, emailStatus, downloadUrl: String(product.downloadUrl || "").trim() || null });
    } catch (error) {
        console.error("RESELLER BYPASS FAILED:", error);
        return res.status(400).json({ message: error.message || "Unable to generate reseller license." });
    }
});

/* Cashfree customer-facing checkout flow. */
app.post("/api/payment/qr", async (req, res) => {
    try {
        const productId = String(req.body?.productId || "").trim();
        const planIndex = Number(req.body?.planIndex);
        const customerName = String(req.body?.name || "").trim().slice(0, 120);
        const customerEmail = cleanEmail(req.body?.email);
        const customerPhone = normalizePhone(req.body?.phone);
        if (!productId) return res.status(400).json({ message: "Product is required." });
        if (!Number.isInteger(planIndex) || planIndex < 0) return res.status(400).json({ message: "Invalid package selected." });
        if (customerName.length < 2) return res.status(400).json({ message: "Enter your name." });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) return res.status(400).json({ message: "Enter a valid email address." });
        if (!/^[6-9]\d{9}$/.test(customerPhone)) return res.status(400).json({ message: "Enter a valid 10-digit Indian mobile number." });
        if (!CASHFREE_CLIENT_ID || !CASHFREE_CLIENT_SECRET) return res.status(503).json({ message: "Cashfree payment service is not configured on the server." });
        const product = await getDocument(COLLECTIONS.products, productId);
        if (!product) return res.status(404).json({ message: "Product not found." });
        const plans = Array.isArray(product.plans) ? product.plans : [];
        const selectedPlan = plans[planIndex];
        if (!selectedPlan) return res.status(400).json({ message: "Selected package is not available." });
        const originalAmountPaise = parsePlanAmount(selectedPlan.price);
        if (!originalAmountPaise) return res.status(400).json({ message: "This package does not have a valid numeric price." });

        // Apply the logged-in reseller's server-side discount. Never trust the price sent by the browser.
        const resellerSession = await getResellerSession(req);
        let reseller = null;
        if (resellerSession) {
            reseller = await getDocument(COLLECTIONS.resellers, resellerSession.resellerId);
            if (!reseller || reseller.active === false) return res.status(403).json({ message: "Reseller access is disabled." });
            if (!resellerCanBuyProduct(reseller, productId)) return res.status(403).json({ message: "This product is not assigned to your reseller account." });
        }
        const resellerDiscountPercent = reseller ? Math.max(0, Math.min(100, Number(reseller.discountPercent || 0))) : 0;
        const amountPaise = reseller ? resellerDiscountedAmountPaise(originalAmountPaise, resellerDiscountPercent) : originalAmountPaise;
        if (!amountPaise) return res.status(400).json({ message: "The calculated payment amount is invalid." });

        const purchaseRef = db.collection(COLLECTIONS.purchases).doc();
        const purchaseId = purchaseRef.id;
        let reservedLicenseKey = "", reservedAccount = null, credentialMode = "license";
        await db.runTransaction(async tx => {
            const pref = db.collection(COLLECTIONS.products).doc(productId); const snap = await tx.get(pref);
            if (!snap.exists) throw new Error("Product not found.");
            const data = snap.data(); const pp = Array.isArray(data.plans) ? data.plans.map(p => ({ ...p, licenses: Array.isArray(p?.licenses) ? p.licenses.slice() : [], accounts: Array.isArray(p?.accounts) ? p.accounts.map(x => ({ ...x })) : [] })) : [];
            const plan = pp[planIndex]; if (!plan) throw new Error("Selected package is not available.");
            credentialMode = ["license", "userpass", "off"].includes(plan.credentialMode) ? plan.credentialMode : "license";
            if (credentialMode === "off") throw new Error("This plan is currently disabled.");
            if (credentialMode === "license") { if (!plan.licenses.length) throw new Error("This plan is currently out of stock."); reservedLicenseKey = String(plan.licenses.shift()).trim(); }
            else if (credentialMode === "userpass") { if (!plan.accounts.length) throw new Error("This plan is currently out of stock."); reservedAccount = plan.accounts.shift(); }
            tx.update(pref, { plans: pp });
        });
        const expiresAt = Date.now() + CASHFREE_ORDER_TTL_SECONDS * 1000;
        const cashfreeOrderId = `gmc_${purchaseId}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 45);
        await purchaseRef.set({ productId, productName: String(product.name || ""), planIndex, planLabel: String(selectedPlan.label || `Package ${planIndex + 1}`), amountPaise, originalAmountPaise, resellerId: reseller?.id || null, resellerName: reseller?.name || null, resellerEmail: reseller?.email || null, resellerDiscountPercent, customerName, customerEmail, customerPhone, reservedLicenseKey, reservedAccount, credentialMode, downloadUrl: String(product.downloadUrl || "").trim(), status: "creating", createdAt: adminSdk.firestore.FieldValue.serverTimestamp(), expiresAt, cashfreeOrderId });
        try {
            const origin = String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
            const order = await cashfreeRequest("/orders", { method: "POST", headers: { "x-request-id": purchaseId, "x-idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ order_id: cashfreeOrderId, order_amount: amountPaise / 100, order_currency: "INR", customer_details: { customer_id: `gmc_${purchaseId}`, customer_name: customerName, customer_email: customerEmail, customer_phone: customerPhone }, order_meta: { return_url: `${origin}/cashfree-return.html?cashfree_order_id=${encodeURIComponent(cashfreeOrderId)}`, notify_url: `${origin}/api/webhooks/cashfree` }, order_expiry_time: new Date(expiresAt).toISOString(), order_note: `${String(product.name || "GMC").slice(0, 80)} - ${String(selectedPlan.label || "Package").slice(0, 80)}`, order_tags: { purchase_id: purchaseId, product_id: productId } }) });
            const sessionId = String(order.payment_session_id || "").trim();
            if (!sessionId) throw new Error("Cashfree did not return a payment session.");
            await purchaseRef.update({ status: "pending", cashfreePaymentSessionId: sessionId, cashfreeCfOrderId: String(order.cf_order_id || "") });
            return res.json({ ok: true, purchaseId, orderId: cashfreeOrderId, paymentSessionId: sessionId, amount: amountPaise / 100, amountPaise, originalAmount: originalAmountPaise / 100, resellerDiscountPercent, productName: String(product.name || ""), planLabel: String(selectedPlan.label || ""), customerEmail, expiresAt, cashfreeMode: CASHFREE_ENV.toLowerCase() });
        } catch (error) {
            await purchaseRef.update({ status: "failed", error: String(error.message || "Unable to create Cashfree order.") }).catch(() => {});
            await releaseReservedInventory({ productId, planIndex, reservedLicenseKey, reservedAccount }).catch(() => {});
            console.error("CASHFREE ORDER CREATE FAILED:", error);
            return res.status(502).json({ message: `Unable to create Cashfree payment: ${error.message || "Unknown error."}` });
        }
    } catch (error) { console.error("PAYMENT REQUEST FAILED:", error); return res.status(500).json({ message: error.message || "Unable to start payment." }); }
});

/* Cancel a customer payment attempt when the checkout window is closed.
 * Do a server-side Cashfree status check first so a race with a successful
 * payment cannot accidentally turn a paid order into a cancelled order.
 */
app.post("/api/payment/cancel/:purchaseId", async (req, res) => {
    try {
        const purchaseId = String(req.params.purchaseId || "").trim();
        if (!purchaseId) return res.status(400).json({ message: "Purchase ID is required." });

        const ref = db.collection(COLLECTIONS.purchases).doc(purchaseId);
        const snapshot = await ref.get();
        if (!snapshot.exists) return res.status(404).json({ message: "Payment session not found." });

        const purchase = snapshot.data();
        if (purchase.status === "paid") {
            return res.json({ ok: true, status: "paid" });
        }
        if (purchase.status === "refund") {
            return res.json({ ok: true, status: "refund" });
        }

        const orderId = String(purchase.cashfreeOrderId || "").trim();
        if (orderId) {
            const order = await cashfreeRequest(`/orders/${encodeURIComponent(orderId)}`, { method: "GET" });
            if (String(order.order_status || "").toUpperCase() === "PAID") {
                if (Math.round(Number(order.order_amount || 0) * 100) !== Number(purchase.amountPaise || 0)) {
                    return res.status(400).json({ message: "Payment amount mismatch." });
                }
                const payments = await cashfreeRequest(`/orders/${encodeURIComponent(orderId)}/payments`, { method: "GET" }).catch(() => []);
                const success = Array.isArray(payments)
                    ? payments.find(p => String(p?.payment_status || "").toUpperCase() === "SUCCESS" && Math.round(Number(p?.payment_amount || 0) * 100) === Number(purchase.amountPaise || 0))
                    : null;
                await markCashfreePurchasePaid(purchaseId, success?.cf_payment_id || "", "cashfree_close_status_check");
                return res.json({ ok: true, status: "paid" });
            }
        }

        let shouldRelease = false;
        let finalStatus = "cancelled";
        await db.runTransaction(async tx => {
            const freshSnap = await tx.get(ref);
            if (!freshSnap.exists) throw new Error("Payment session not found.");
            const fresh = freshSnap.data();
            if (fresh.status === "paid" || fresh.status === "refund") {
                finalStatus = fresh.status;
                return;
            }
            if (Date.now() >= Number(fresh.expiresAt || 0)) {
                finalStatus = "expired";
            }
            tx.update(ref, {
                status: finalStatus,
                paymentMessage: finalStatus === "expired" ? "Payment session expired." : "Customer closed the payment window.",
                paymentUpdatedAt: adminSdk.firestore.FieldValue.serverTimestamp(),
                reservedLicenseKey: null,
                reservedAccount: null
            });
            shouldRelease = true;
        });

        if (shouldRelease) await releaseReservedInventory(purchase).catch(() => {});
        return res.json({ ok: true, status: finalStatus });
    } catch (error) {
        console.error("CANCEL PAYMENT ERROR:", error);
        return res.status(502).json({ message: `Unable to cancel payment: ${error.message || "Unknown error."}` });
    }
});

app.get("/api/payment/qr/:purchaseId", async (req, res) => {
    try {
        const purchaseId = String(req.params.purchaseId || "").trim();
        if (!purchaseId) return res.status(400).json({ message: "Purchase ID is required." });
        const ref = db.collection(COLLECTIONS.purchases).doc(purchaseId); const snapshot = await ref.get();
        if (!snapshot.exists) return res.status(404).json({ message: "Payment session not found." });
        let purchase = snapshot.data();
        if (purchase.status === "refund") {
            return res.json({ ok: true, status: "refund", amount: Number(purchase.amountPaise || 0) / 100, productName: purchase.productName || "", planLabel: purchase.planLabel || "", paymentId: purchase.paymentId || null, downloadUrl: null });
        }
        if (purchase.status === "paid") {
            let emailStatus = purchase.deliveryEmailSentAt ? "sent" : (purchase.deliveryEmailStatus || "pending");
            if (!purchase.deliveryEmailSentAt) { try { const delivery = await deliverPurchaseEmail(purchaseId); emailStatus = delivery.sent || delivery.alreadySent ? "sent" : (delivery.claimedByOther ? "sending" : emailStatus); } catch { emailStatus = "failed"; } }
            return res.json({ ok: true, status: "paid", amount: Number(purchase.amountPaise || 0) / 100, productName: purchase.productName || "", planLabel: purchase.planLabel || "", paymentId: purchase.paymentId || null, downloadUrl: String(purchase.downloadUrl || "") || null, emailStatus });
        }
        if (Date.now() >= Number(purchase.expiresAt || 0)) {
            if (purchase.status !== "expired" && purchase.status !== "paid") { await releaseReservedInventory(purchase).catch(() => {}); await ref.update({ status: "expired", reservedLicenseKey: null, reservedAccount: null }).catch(() => {}); }
            return res.json({ ok: true, status: "expired" });
        }
        const orderId = String(purchase.cashfreeOrderId || "").trim();
        if (!orderId) return res.status(409).json({ message: "Cashfree order is not ready yet." });
        const order = await cashfreeRequest(`/orders/${encodeURIComponent(orderId)}`, { method: "GET" });
        if (String(order.order_status || "").toUpperCase() === "PAID") {
            if (Math.round(Number(order.order_amount || 0) * 100) !== Number(purchase.amountPaise || 0)) return res.status(400).json({ message: "Payment amount mismatch." });
            const payments = await cashfreeRequest(`/orders/${encodeURIComponent(orderId)}/payments`, { method: "GET" }).catch(() => []);
            const success = Array.isArray(payments) ? payments.find(p => String(p?.payment_status || "").toUpperCase() === "SUCCESS" && Math.round(Number(p?.payment_amount || 0) * 100) === Number(purchase.amountPaise || 0)) : null;
            await markCashfreePurchasePaid(purchaseId, success?.cf_payment_id || "", "cashfree_status_check");
            const fresh = (await ref.get()).data() || {};
            const delivery = fresh.deliveryEmailSentAt ? "sent" : (fresh.deliveryEmailStatus || "pending");
            return res.json({ ok: true, status: "paid", amount: Number(purchase.amountPaise || 0) / 100, productName: purchase.productName || "", planLabel: purchase.planLabel || "", paymentId: success?.cf_payment_id || null, downloadUrl: String(purchase.downloadUrl || "") || null, emailStatus: delivery });
        }
        return res.json({ ok: true, status: "pending", amount: Number(purchase.amountPaise || 0) / 100 });
    } catch (error) { console.error("CASHFREE PAYMENT STATUS FAILED:", error); return res.status(502).json({ message: `Unable to check payment: ${error.message || "Unknown error."}` }); }
});

/* Google Drive image proxy */
function getGoogleDriveFileId(rawUrl) {
    try {
        const u = new URL(rawUrl);
        const host = u.hostname.toLowerCase();
        if (!host.includes("drive.google.com") && !host.includes("docs.google.com")) return null;

        const fileMatch = u.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
        if (fileMatch) return fileMatch[1];

        const id = u.searchParams.get("id");
        if (id && /^[a-zA-Z0-9_-]+$/.test(id)) return id;
        return null;
    } catch {
        return null;
    }
}

function buildImageTargets(rawUrl) {
    const driveId = getGoogleDriveFileId(rawUrl);
    if (driveId) {
        return [
            `https://drive.google.com/thumbnail?id=${encodeURIComponent(driveId)}&sz=w1600`,
            `https://drive.google.com/uc?export=view&id=${encodeURIComponent(driveId)}`,
            `https://drive.usercontent.google.com/download?id=${encodeURIComponent(driveId)}&export=download&confirm=t`
        ];
    }
    return [rawUrl];
}

app.get("/api/image-proxy", async (req, res) => {
    const raw = String(req.query.url || "").trim();
    if (!raw) return res.status(400).send("Missing image URL.");

    const targets = buildImageTargets(raw);
    let lastStatus = 502;
    let lastMessage = "Unable to fetch image.";

    for (const targetUrl of targets) {
        let target;
        try {
            target = new URL(targetUrl);
        } catch {
            continue;
        }

        if (!/^https?:$/.test(target.protocol)) continue;

        try {
            const response = await fetch(target, {
                redirect: "follow",
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
                    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
                }
            });

            if (!response.ok) {
                lastStatus = response.status;
                lastMessage = `Image request failed (${response.status}).`;
                continue;
            }

            const type = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
            const buffer = Buffer.from(await response.arrayBuffer());
            if (buffer.length > 8 * 1024 * 1024) {
                return res.status(413).send("Image is too large (max 8 MB).");
            }

            if (!type.startsWith("image/")) {
                lastStatus = 415;
                lastMessage = "Google Drive did not return an image. Make the file public.";
                continue;
            }

            res.setHeader("Cache-Control", "public, max-age=3600");
            res.setHeader("Content-Type", type);
            return res.send(buffer);
        } catch (error) {
            lastStatus = 502;
            lastMessage = error.message || "Unable to fetch image.";
        }
    }

    console.error("IMAGE PROXY FAILED:", raw, lastMessage);
    return res.status(lastStatus).send(
        lastStatus === 415
            ? "Google Drive image is not publicly accessible. Set General access to Anyone with the link -> Viewer."
            : lastMessage
    );
});

/* Contact form */
app.post("/api/contact", async (req, res) => {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim();
    const subject = String(req.body.subject || "").trim();
    const phone = String(req.body.phone || "").trim();
    const message = String(req.body.message || "").trim();

    // Contact number is optional.
    if (!name || !email || !subject || !message) return res.status(400).json({ message: "Please fill in all required fields." });
    if (name.length > 100 || email.length > 200 || subject.length > 200 || phone.length > 30 || message.length > 5000) return res.status(400).json({ message: "One or more fields are too long." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: "Please enter a valid email address." });
    if (!MAILJET_API_KEY || !MAILJET_SECRET_KEY) {
        return res.status(500).json({ message: "Mailjet email service is not configured." });
    }

    try {
        await sendEmail({
            to: ADMIN_EMAIL,
            replyTo: email,
            subject: `[GMC Contact] ${subject}`,
            textPart: `New contact message from GMC website

Name: ${name}
Email: ${email}
Contact No.: ${phone || "Not provided"}
Subject: ${subject}

Message:
${message}`,
            htmlPart: `<!doctype html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#070707;font-family:Arial,Helvetica,sans-serif;color:#f5f5f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#070707;margin:0;padding:28px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:680px;background:#0d0d0d;border:1px solid #4a1116;border-radius:18px;overflow:hidden;">
<tr><td style="padding:24px 28px;background:linear-gradient(135deg,#160709,#0d0d0d);border-bottom:1px solid #4a1116;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td><div style="font-size:28px;font-weight:900;letter-spacing:3px;color:#ffffff;">GMC</div><div style="font-size:10px;letter-spacing:2px;color:#ff2029;margin-top:4px;font-weight:700;">WEBSITE CONTACT</div></td>
<td align="right"><span style="display:inline-block;padding:7px 11px;border:1px solid #ff2029;border-radius:999px;color:#ff3038;font-size:10px;font-weight:800;letter-spacing:1px;">NEW MESSAGE</span></td>
</tr></table>
</td></tr>
<tr><td style="padding:28px;">
<div style="font-size:24px;font-weight:800;color:#ffffff;margin-bottom:7px;">New Contact Message</div>
<div style="font-size:13px;color:#888;margin-bottom:24px;">Someone submitted the contact form on your GMC website.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #292929;border-radius:12px;overflow:hidden;">
<tr><td style="padding:14px 16px;border-bottom:1px solid #252525;background:#101010;width:120px;color:#888;font-size:11px;font-weight:700;letter-spacing:1px;">NAME</td><td style="padding:14px 16px;border-bottom:1px solid #252525;color:#f2f2f2;font-size:14px;">${escapeHtml(name)}</td></tr>
<tr><td style="padding:14px 16px;border-bottom:1px solid #252525;background:#101010;color:#888;font-size:11px;font-weight:700;letter-spacing:1px;">EMAIL</td><td style="padding:14px 16px;border-bottom:1px solid #252525;font-size:14px;"><a href="mailto:${escapeHtml(email)}" style="color:#ff3038;text-decoration:none;">${escapeHtml(email)}</a></td></tr>
<tr><td style="padding:14px 16px;border-bottom:1px solid #252525;background:#101010;color:#888;font-size:11px;font-weight:700;letter-spacing:1px;">CONTACT NO.</td><td style="padding:14px 16px;border-bottom:1px solid #252525;color:#f2f2f2;font-size:14px;">${phone ? escapeHtml(phone) : "Not provided"}</td></tr>
<tr><td style="padding:14px 16px;background:#101010;color:#888;font-size:11px;font-weight:700;letter-spacing:1px;">SUBJECT</td><td style="padding:14px 16px;color:#f2f2f2;font-size:14px;">${escapeHtml(subject)}</td></tr>
</table>
<div style="margin-top:22px;font-size:11px;color:#888;font-weight:700;letter-spacing:1px;">MESSAGE</div>
<div style="margin-top:8px;padding:18px;background:#101010;border:1px solid #292929;border-radius:12px;color:#e8e8e8;font-size:14px;line-height:1.7;white-space:pre-wrap;word-break:break-word;">${escapeHtml(message)}</div>
<div style="margin-top:24px;"><a href="mailto:${escapeHtml(email)}?subject=Re: ${encodeURIComponent(subject)}" style="display:inline-block;padding:12px 20px;background:#ef0b12;color:#ffffff;text-decoration:none;border-radius:9px;font-size:12px;font-weight:800;letter-spacing:.4px;">REPLY TO ${escapeHtml(name).toUpperCase()}</a></div>
</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid #242424;color:#666;font-size:11px;text-align:center;">GMC Website &nbsp;•&nbsp; Automated contact notification</td></tr>
</table>
</td></tr></table>
</body></html>`
        });
        console.log("CONTACT EMAIL SENT FROM:", email);
        res.json({ message: "Message sent successfully." });
    } catch (error) {
        console.error("CONTACT EMAIL FAILED:", error);
        res.status(500).json({ message: "Could not send the message right now. Please try again later." });
    }
});

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));
}

async function startServer() {
    try {
        await seedFromJsonFiles();
        app.listen(PORT, () => {
            console.log(`GMC Admin server running on port ${PORT}`);
        });
    } catch (error) {
        console.error("FIREBASE STARTUP FAILED:", error);
        process.exit(1);
    }
}

// Vercel imports this file as a serverless function. Only start a TCP
// listener when this file is executed directly (local/Render deployment).
if (require.main === module) {
    startServer();
}

module.exports = app;
