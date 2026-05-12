/**
 * Seed bKash sandbox credentials directly into MerchantSettings.
 * Use this for backend testing without going through the app UI OTP flow.
 *
 * Usage:
 *   node test/seed-merchant.js
 *
 * Required env vars (in your .env):
 *   BKASH_ENCRYPTION_KEY
 *   DATABASE_URL
 *
 * Fill in your bKash sandbox values in the CONFIG section below.
 */

import { createCipheriv, randomBytes, scryptSync } from "crypto";
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";
import { resolve } from "path";

// ─── Load .env manually (no dotenv dependency needed) ────────────────────────
const envPath = resolve(process.cwd(), ".env");
try {
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      const val = match[2].trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {
  console.error("Could not read .env file — make sure you run this from the repo root");
  process.exit(1);
}

// ─── CONFIG — fill in your bKash sandbox values ──────────────────────────────
const CONFIG = {
  shopDomain: "entry-try-shop.myshopify.com",  // your dev store
  bkashUsername:  "sandboxUser",   // from bKash developer portal
  bkashPassword:  "sandboxPass",
  bkashAppKey:    "your_app_key",
  bkashAppSecret: "your_app_secret",
  bkashNumber:    "01616131448",
  bkashApiBaseUrl: "https://tokenized.sandbox.bka.sh/v1.2.0-beta",  // leave as-is
};

// ─────────────────────────────────────────────────────────────────────────────

const MISSING = Object.entries(CONFIG)
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (MISSING.length) {
  console.error(`\nFill in these values in CONFIG inside test/seed-merchant.js:\n  ${MISSING.join("\n  ")}`);
  process.exit(1);
}

// ─── Encryption (mirrors app/utils/crypto.js exactly) ────────────────────────
const ALGORITHM = "aes-256-gcm";
const SALT = "nova-bkash-v1-salt";

function getKey() {
  const master = process.env.BKASH_ENCRYPTION_KEY;
  if (!master) throw new Error("BKASH_ENCRYPTION_KEY not set in .env");
  return scryptSync(master, SALT, 32);
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  const key = getKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}
// ─────────────────────────────────────────────────────────────────────────────

const prisma = new PrismaClient();

async function main() {
  console.log(`\nSeeding bKash credentials for: ${CONFIG.shopDomain}`);

  const encrypted = {
    bkashUsername:  encrypt(CONFIG.bkashUsername),
    bkashPassword:  encrypt(CONFIG.bkashPassword),
    bkashAppKey:    encrypt(CONFIG.bkashAppKey),
    bkashAppSecret: encrypt(CONFIG.bkashAppSecret),
    bkashNumber:    encrypt(CONFIG.bkashNumber),
  };

  const result = await prisma.merchantSettings.upsert({
    where: { shopDomain: CONFIG.shopDomain },
    update: {
      ...encrypted,
      bkashApiBaseUrl: CONFIG.bkashApiBaseUrl,
      isActive: true,
    },
    create: {
      shopDomain: CONFIG.shopDomain,
      ...encrypted,
      bkashApiBaseUrl: CONFIG.bkashApiBaseUrl,
      isActive: true,
      billingStartDate: new Date(),
    },
  });

  console.log(`\n✓ MerchantSettings upserted (id: ${result.id})`);
  console.log(`  shopDomain:     ${result.shopDomain}`);
  console.log(`  isActive:       ${result.isActive}`);
  console.log(`  bkashAppKey:    [encrypted, ${result.bkashAppKey?.length} chars]`);
  console.log(`  bkashApiBaseUrl: ${result.bkashApiBaseUrl}`);
  console.log(`\nYou can now run the payment initiate test in Postman.\n`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
