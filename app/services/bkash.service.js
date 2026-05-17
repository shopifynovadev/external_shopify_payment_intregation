import prisma from "../db.server.js";
import { decrypt } from "../utils/crypto.js";

// bKash token cache — keyed by shopDomain (in-process, lives for the process lifetime)
const tokenCache = new Map();
// { token: string, expiresAt: Date }

// In-flight grant promises — prevents duplicate token grants under concurrent load
const grantInFlight = new Map();

async function getCredentials(shopDomain) {
  const settings = await prisma.merchantSettings.findUnique({
    where: { shopDomain },
    select: {
      bkashAppKey: true,
      bkashAppSecret: true,
      bkashUsername: true,
      bkashPassword: true,
      bkashApiBaseUrl: true,
    },
  });

  if (
    !settings?.bkashAppKey ||
    !settings?.bkashAppSecret ||
    !settings?.bkashUsername ||
    !settings?.bkashPassword ||
    !settings?.bkashApiBaseUrl
  ) {
    throw new Error("bKash credentials not configured for this shop");
  }

  return {
    appKey: decrypt(settings.bkashAppKey),
    appSecret: decrypt(settings.bkashAppSecret),
    username: decrypt(settings.bkashUsername),
    password: decrypt(settings.bkashPassword),
    baseUrl: settings.bkashApiBaseUrl,
  };
}

async function grantToken(shopDomain) {
  console.log(`[bKash token] GRANT called for ${shopDomain}`);
  const creds = await getCredentials(shopDomain);

  const res = await fetch(`${creds.baseUrl}/tokenized/checkout/token/grant`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      username: creds.username,
      password: creds.password,
    },
    body: JSON.stringify({
      app_key: creds.appKey,
      app_secret: creds.appSecret,
    }),
  });

  if (!res.ok) {
    throw new Error(`bKash token grant failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();

  if (data.statusCode !== "0000") {
    throw new Error(`bKash token grant error: ${data.statusMessage}`);
  }

  // bKash tokens expire in 3600 seconds; refresh 5 min early
  const expiresAt = new Date(Date.now() + (data.expires_in - 300) * 1000);
  tokenCache.set(shopDomain, { token: data.id_token, expiresAt });
  console.log(`[bKash token] STORED for ${shopDomain} | expires: ${expiresAt.toISOString()}`);

  return data.id_token;
}

async function getToken(shopDomain) {
  const cached = tokenCache.get(shopDomain);
  console.log(`[bKash token] ${cached ? "HIT " : "MISS"} for ${shopDomain}`);
  if (cached && cached.expiresAt > new Date()) {
    return cached.token;
  }

  if (grantInFlight.has(shopDomain)) {
    return grantInFlight.get(shopDomain);
  }

  const promise = grantToken(shopDomain).finally(() => grantInFlight.delete(shopDomain));
  grantInFlight.set(shopDomain, promise);
  return promise;
}

async function bkashRequest(shopDomain, path, body) {
  const creds = await getCredentials(shopDomain);
  const token = await getToken(shopDomain);

  const res = await fetch(`${creds.baseUrl}/tokenized/checkout${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: token,
      "X-APP-Key": creds.appKey,
    },
    body: JSON.stringify(body),
  });

  // bKash returns 200 even for logical errors — always parse the body
  const data = await res.json();
  return data;
}

export async function createPayment({ shopDomain, amount, merchantInvoiceNumber }) {
  const data = await bkashRequest(shopDomain, "/create", {
    mode: "0011",
    payerReference: merchantInvoiceNumber,
    callbackURL: `${process.env.SHOPIFY_APP_URL}/api/payment/callback`,
    amount: String(amount),
    currency: "BDT",
    intent: "sale",
    merchantInvoiceNumber,
  });

  if (data.statusCode !== "0000") {
    throw new Error(`bKash create payment failed: ${data.statusMessage}`);
  }

  return { paymentID: data.paymentID, bkashURL: data.bkashURL };
}

export async function executePayment({ shopDomain, paymentID }) {
  const data = await bkashRequest(shopDomain, "/execute", { paymentID });

  if (data.statusCode !== "0000" || data.transactionStatus !== "Completed") {
    return { success: false, reason: data.statusMessage || data.transactionStatus };
  }

  return {
    success: true,
    trxID: data.trxID,
    amount: data.amount,
    transactionStatus: data.transactionStatus,
    raw: data,
  };
}

export async function refundPayment({
  shopDomain,
  paymentID,
  trxID,
  amount,
  reason = "",
}) {
  const data = await bkashRequest(shopDomain, "/refund", {
    paymentID,
    amount: String(amount),
    trxID,
    sku: reason,
    reason,
  });

  if (data.statusCode !== "0000" || data.transactionStatus !== "Completed") {
    return {
      success: false,
      reason: data.statusMessage || data.transactionStatus,
    };
  }

  return {
    success: true,
    refundTrxID: data.refundTrxID,
    transactionStatus: data.transactionStatus,
  };
}

export async function queryPayment({ shopDomain, paymentID }) {
  const data = await bkashRequest(shopDomain, "/payment/status", { paymentID });
  return data;
}

// Invalidate cached token for a shop (called after credential update)
export function invalidateToken(shopDomain) {
  tokenCache.delete(shopDomain);
}
