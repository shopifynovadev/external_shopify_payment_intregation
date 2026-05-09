import { useState, useCallback } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { json } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server.js";
import { decrypt } from "../utils/crypto.js";

const THEMES_QUERY = `
  query GetThemes {
    themes(first: 20) {
      nodes { id name role }
    }
  }
`;

function maskValue(encrypted) {
  if (!encrypted) return null;
  try {
    const v = decrypt(encrypted);
    return v.length > 4 ? "•".repeat(v.length - 4) + v.slice(-4) : "••••";
  } catch { return "••••"; }
}

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const [settings, themesRes] = await Promise.all([
    prisma.merchantSettings.findUnique({
      where: { shopDomain: shop },
      select: { bkashNumber: true, bkashUsername: true, bkashPassword: true, bkashAppKey: true, bkashAppSecret: true, bkashApiBaseUrl: true, enabledThemes: true, hideCheckout: true },
    }),
    admin.graphql(THEMES_QUERY),
  ]);

  const themesJson = await themesRes.json();
  const themes = themesJson.data?.themes?.nodes ?? [];
  const extensionId = process.env.SHOPIFY_EXTENSION_ID ?? "";

  return json({
    credentials: {
      bkashNumber: maskValue(settings?.bkashNumber),
      bkashUsername: maskValue(settings?.bkashUsername),
      bkashPassword: settings?.bkashPassword ? "••••••••" : null,
      bkashAppKey: maskValue(settings?.bkashAppKey),
      bkashAppSecret: maskValue(settings?.bkashAppSecret),
      bkashApiBaseUrl: settings?.bkashApiBaseUrl ?? "",
      isConfigured: !!(settings?.bkashAppKey && settings?.bkashAppSecret),
    },
    themes,
    enabledThemes: settings?.enabledThemes ?? [],
    extensionId,
    shop,
  });
};

const EMPTY_CREDS = { bkashNumber: "", bkashUsername: "", bkashPassword: "", bkashAppKey: "", bkashAppSecret: "", bkashApiBaseUrl: "" };

export default function Settings() {
  const { credentials, themes, extensionId, shop } = useLoaderData();
  const fetcher = useFetcher();

  const [otpStep, setOtpStep] = useState("idle"); // idle | form | otp | success
  const [formCreds, setFormCreds] = useState(EMPTY_CREDS);
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");

  const handleOpenForm = () => { setOtpStep("form"); setError(""); };

  const handleSendOtp = useCallback(async () => {
    setError("");
    const res = await fetch("/api/settings/otp/send", { method: "POST" });
    const json = await res.json();
    if (json.success) {
      setOtpStep("otp");
    } else {
      setError(json.error ?? "Failed to send OTP");
    }
  }, []);

  const handleVerifyOtp = useCallback(async () => {
    setError("");
    const res = await fetch("/api/settings/otp/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ otp, credentials: formCreds }),
    });
    const data = await res.json();
    if (data.success) {
      setOtpStep("success");
      setOtp("");
      setTimeout(() => { setOtpStep("idle"); window.location.reload(); }, 2000);
    } else {
      setError(data.error ?? "Verification failed");
    }
  }, [otp, formCreds]);

  const themeEditorUrl = (themeId, block) => {
    const template = block === "cart" ? "cart" : "customers/order";
    const blockHandle = block === "cart" ? "cart-payment-form" : "thankyou-confirmation";
    return `https://${shop}/admin/themes/${themeId}/editor?template=${template}&addAppBlockId=${extensionId}/${blockHandle}`;
  };

  const inputStyle = { padding: "8px 12px", border: "1px solid #c9cccf", borderRadius: "6px", width: "100%", fontSize: "14px" };
  const labelStyle = { display: "block", marginBottom: "4px", color: "#6d7175", fontSize: "13px" };

  return (
    <s-page heading="Settings">
      {/* bKash Credentials */}
      <s-section heading="bKash Credentials">
        {credentials.isConfigured ? (
          <s-banner status="success">
            <s-paragraph>bKash is configured and accepting payments.</s-paragraph>
          </s-banner>
        ) : (
          <s-banner status="critical">
            <s-paragraph>bKash credentials are not set. Customers cannot pay until configured.</s-paragraph>
          </s-banner>
        )}

        <table style={{ fontSize: "14px", width: "100%", borderCollapse: "collapse", marginTop: "12px" }}>
          <tbody>
            {[
              ["bKash Number", credentials.bkashNumber],
              ["Username", credentials.bkashUsername],
              ["Password", credentials.bkashPassword],
              ["App Key", credentials.bkashAppKey],
              ["App Secret", credentials.bkashAppSecret],
              ["API Base URL", credentials.bkashApiBaseUrl || "—"],
            ].map(([label, val]) => (
              <tr key={label} style={{ borderBottom: "1px solid #f6f6f7" }}>
                <td style={{ padding: "8px 12px", color: "#6d7175", width: "160px" }}>{label}</td>
                <td style={{ padding: "8px 12px", fontFamily: "monospace" }}>{val ?? <s-text tone="subdued">Not set</s-text>}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ marginTop: "16px" }}>
          <s-button onClick={handleOpenForm}>
            {credentials.isConfigured ? "Update Credentials" : "Configure bKash"}
          </s-button>
        </div>
      </s-section>

      {/* Credential update modal */}
      {otpStep !== "idle" && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}>
          <div style={{ background: "#fff", borderRadius: "12px", padding: "32px", width: "480px", maxWidth: "90vw", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            {otpStep === "form" && (
              <>
                <h2 style={{ margin: "0 0 20px", fontSize: "18px" }}>Update bKash Credentials</h2>
                <s-paragraph>Fill in the fields you want to update. Leave blank to keep existing.</s-paragraph>
                <div style={{ marginTop: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
                  {[
                    ["bKash Number", "bkashNumber", "text"],
                    ["Username", "bkashUsername", "text"],
                    ["Password", "bkashPassword", "password"],
                    ["App Key", "bkashAppKey", "text"],
                    ["App Secret", "bkashAppSecret", "password"],
                    ["API Base URL", "bkashApiBaseUrl", "url"],
                  ].map(([label, key, type]) => (
                    <div key={key}>
                      <label style={labelStyle}>{label}</label>
                      <input
                        type={type}
                        value={formCreds[key]}
                        onChange={(e) => setFormCreds((p) => ({ ...p, [key]: e.target.value }))}
                        placeholder={`Enter new ${label.toLowerCase()}...`}
                        style={inputStyle}
                      />
                    </div>
                  ))}
                </div>
                {error && <p style={{ color: "#d72c0d", fontSize: "13px", marginTop: "8px" }}>{error}</p>}
                <div style={{ display: "flex", gap: "12px", marginTop: "20px" }}>
                  <s-button onClick={handleSendOtp}>Send Verification Code</s-button>
                  <s-button variant="plain" onClick={() => setOtpStep("idle")}>Cancel</s-button>
                </div>
              </>
            )}
            {otpStep === "otp" && (
              <>
                <h2 style={{ margin: "0 0 12px", fontSize: "18px" }}>Enter Verification Code</h2>
                <s-paragraph>A 6-digit code was sent to your Shopify account email. It expires in 2 minutes.</s-paragraph>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                  placeholder="123456"
                  style={{ ...inputStyle, marginTop: "16px", fontSize: "24px", textAlign: "center", letterSpacing: "8px" }}
                />
                {error && <p style={{ color: "#d72c0d", fontSize: "13px", marginTop: "8px" }}>{error}</p>}
                <div style={{ display: "flex", gap: "12px", marginTop: "20px" }}>
                  <s-button onClick={handleVerifyOtp} disabled={otp.length !== 6}>Verify & Save</s-button>
                  <s-button variant="plain" onClick={() => setOtpStep("idle")}>Cancel</s-button>
                </div>
              </>
            )}
            {otpStep === "success" && (
              <>
                <h2 style={{ margin: "0 0 12px", fontSize: "18px", color: "#008060" }}>Credentials Updated</h2>
                <s-paragraph>Your bKash credentials have been saved securely. Refreshing...</s-paragraph>
              </>
            )}
          </div>
        </div>
      )}

      {/* Theme Management */}
      <s-section heading="Theme Management">
        <s-paragraph>
          Add Nova bKash blocks to your themes using the buttons below. The theme editor will open with the block ready to place.
        </s-paragraph>

        {themes.length === 0 ? (
          <s-paragraph>No themes found.</s-paragraph>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px", marginTop: "16px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                {["Theme", "Role", "Cart Block", "Thank You Block"].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "8px 12px", color: "#6d7175" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {themes.map((theme) => {
                const themeIdNum = theme.id.split("/").pop();
                return (
                  <tr key={theme.id} style={{ borderBottom: "1px solid #f6f6f7" }}>
                    <td style={{ padding: "10px 12px", fontWeight: 500 }}>{theme.name}</td>
                    <td style={{ padding: "10px 12px" }}>
                      <s-badge status={theme.role === "MAIN" ? "success" : "default"}>
                        {theme.role}
                      </s-badge>
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <s-button
                        size="slim"
                        onClick={() => window.open(themeEditorUrl(themeIdNum, "cart"), "_blank")}
                      >
                        Add Cart Block ↗
                      </s-button>
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <s-button
                        size="slim"
                        onClick={() => window.open(themeEditorUrl(themeIdNum, "thankyou"), "_blank")}
                      >
                        Add Thank You Block ↗
                      </s-button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() { return boundary.error(); }
export const headers = (h) => boundary.headers(h);
