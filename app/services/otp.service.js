import { createHash, randomInt } from "crypto";
import { createTransport } from "nodemailer";
import prisma from "../db.server.js";

const OTP_TTL_MS = 2 * 60 * 1000; // 2 minutes
const MAX_ATTEMPTS = 3;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function hashOtp(otp) {
  return createHash("sha256").update(`${otp}:${process.env.APP_SECRET}`).digest("hex");
}

function getTransport() {
  return createTransport({
    host: process.env.OTP_SMTP_HOST,
    port: parseInt(process.env.OTP_SMTP_PORT ?? "587"),
    secure: false,
    auth: {
      user: process.env.OTP_SMTP_USER,
      pass: process.env.OTP_SMTP_PASS,
    },
  });
}

export async function sendOtp({ shopDomain, email, purpose }) {
  const otp = String(randomInt(100000, 999999)); // 6-digit
  const otpHash = hashOtp(otp);

  await prisma.otpRequest.create({
    data: {
      shopDomain,
      email,
      otpHash,
      purpose,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    },
  });

  const transport = getTransport();
  await transport.sendMail({
    from: process.env.OTP_EMAIL_FROM,
    to: email,
    subject: "Nova bKash — Verification Code",
    text: `Your verification code is: ${otp}\n\nThis code expires in 2 minutes. Do not share it with anyone.`,
    html: `<p>Your verification code is: <strong>${otp}</strong></p><p>This code expires in 2 minutes. Do not share it with anyone.</p>`,
  });

  return { sent: true };
}

export async function verifyOtp({ shopDomain, otp, purpose }) {
  const record = await prisma.otpRequest.findFirst({
    where: {
      shopDomain,
      purpose,
      isUsed: false,
    },
    orderBy: { createdAt: "desc" },
  });

  if (!record) {
    return { valid: false, reason: "No OTP request found. Please request a new code." };
  }

  // Check lockout
  if (record.lockedUntil && record.lockedUntil > new Date()) {
    const minutes = Math.ceil((record.lockedUntil - Date.now()) / 60000);
    return { valid: false, reason: `Too many attempts. Try again in ${minutes} minute(s).` };
  }

  // Check expiry
  if (record.expiresAt < new Date()) {
    return { valid: false, reason: "OTP has expired. Please request a new code." };
  }

  const inputHash = hashOtp(otp);

  if (inputHash !== record.otpHash) {
    const newAttempts = record.attempts + 1;
    const shouldLock = newAttempts >= MAX_ATTEMPTS;

    await prisma.otpRequest.update({
      where: { id: record.id },
      data: {
        attempts: newAttempts,
        lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_MS) : null,
      },
    });

    if (shouldLock) {
      return { valid: false, reason: "Too many incorrect attempts. Try again in 15 minutes." };
    }

    const remaining = MAX_ATTEMPTS - newAttempts;
    return { valid: false, reason: `Incorrect code. ${remaining} attempt(s) remaining.` };
  }

  await prisma.otpRequest.update({ where: { id: record.id }, data: { isUsed: true } });
  return { valid: true };
}
