import { useState } from "react";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getShippingRates,
  createShippingRate,
  updateShippingRate,
  deleteShippingRate,
} from "../models/shippingRate.server.js";
import { DIVISIONS } from "../utils/shippingConstants.js";

const PAGE_SIZE = 20;

const EMPTY_FORM = {
  title: "",
  division: "ALL",
  flatAmount: "",
  freeAbove: "",
  estimatedDays: "",
  isActive: true,
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") ?? "1");
  const { rates, total } = await getShippingRates({ shopDomain: session.shop, page, pageSize: PAGE_SIZE });
  return { rates: rates.map(r => ({ ...r, flatAmount: parseFloat(r.flatAmount), freeAbove: r.freeAbove ? parseFloat(r.freeAbove) : null })), total, page, pageSize: PAGE_SIZE };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const body = await request.json();
  const { _action, ...data } = body;

  if (_action === "create") {
    await createShippingRate({ shopDomain, ...data });
    return { success: true };
  }
  if (_action === "update") {
    await updateShippingRate({ shopDomain, ...data });
    return { success: true };
  }
  if (_action === "delete") {
    await deleteShippingRate({ id: data.id, shopDomain });
    return { success: true };
  }

  return { success: false, error: "Unknown action" };
};

export default function ShippingPage() {
  const { rates, total, page, pageSize } = useLoaderData();
  const [, setSearchParams] = useSearchParams();
  const fetcher = useFetcher();
  const totalPages = Math.ceil(total / pageSize);

  const [modalOpen, setModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null); // null = add mode, obj = edit mode
  const [form, setForm] = useState(EMPTY_FORM);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  const openAdd = () => {
    setEditTarget(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  };

  const openEdit = (rate) => {
    setEditTarget(rate);
    setForm({
      title: rate.title,
      division: rate.division,
      flatAmount: String(rate.flatAmount),
      freeAbove: rate.freeAbove != null ? String(rate.freeAbove) : "",
      estimatedDays: rate.estimatedDays ?? "",
      isActive: rate.isActive,
    });
    setModalOpen(true);
  };

  const handleSave = () => {
    if (!form.title || !form.division || !form.flatAmount) return;
    const payload = editTarget
      ? { _action: "update", id: editTarget.id, ...form }
      : { _action: "create", ...form };
    fetcher.submit(payload, { method: "POST", encType: "application/json" });
    setModalOpen(false);
  };

  const handleDelete = (id) => {
    fetcher.submit({ _action: "delete", id }, { method: "POST", encType: "application/json" });
    setDeleteConfirm(null);
  };

  const setPage = (p) => setSearchParams({ page: String(p) });

  const divisionLabel = (d) => d === "ALL" ? "All Divisions" : d;

  return (
    <s-page heading="Shipping Rates">
      <s-section>
        {/* Header row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <p style={{ color: "#6d7175", margin: 0 }}>
            {total} rate{total !== 1 ? "s" : ""} configured
          </p>
          <button
            onClick={openAdd}
            style={{
              background: "#008060", color: "#fff", border: "none", borderRadius: "6px",
              padding: "8px 16px", cursor: "pointer", fontWeight: 600, fontSize: "14px",
            }}
          >
            + Add Shipping Rate
          </button>
        </div>

        {/* Table */}
        {rates.length === 0 ? (
          <div style={{ textAlign: "center", padding: "48px 0", color: "#6d7175" }}>
            <p>No shipping rates yet.</p>
            <p>Click <strong>Add Shipping Rate</strong> to get started.</p>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
                  {["Title", "Division", "Rate (BDT)", "Free Shipping Above", "Est. Delivery", "Status", "Actions"].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "10px 12px", color: "#6d7175", fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rates.map((rate) => (
                  <tr key={rate.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                    <td style={{ padding: "12px" }}>{rate.title}</td>
                    <td style={{ padding: "12px" }}>
                      <span style={{
                        background: rate.division === "ALL" ? "#f6f0fd" : "#f0f7fd",
                        color: rate.division === "ALL" ? "#6941c6" : "#0e6dab",
                        borderRadius: "12px", padding: "2px 10px", fontSize: "12px", fontWeight: 600,
                      }}>
                        {divisionLabel(rate.division)}
                      </span>
                    </td>
                    <td style={{ padding: "12px", fontWeight: 600 }}>
                      {rate.flatAmount === 0 ? "Free" : `৳${rate.flatAmount.toFixed(2)}`}
                    </td>
                    <td style={{ padding: "12px", color: "#6d7175" }}>
                      {rate.freeAbove != null ? `৳${rate.freeAbove.toFixed(2)}` : "—"}
                    </td>
                    <td style={{ padding: "12px", color: "#6d7175" }}>
                      {rate.estimatedDays || "—"}
                    </td>
                    <td style={{ padding: "12px" }}>
                      <span style={{
                        background: rate.isActive ? "#e3f1e5" : "#fdf0e0",
                        color: rate.isActive ? "#1a7f3c" : "#a35200",
                        borderRadius: "12px", padding: "2px 10px", fontSize: "12px", fontWeight: 600,
                      }}>
                        {rate.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td style={{ padding: "12px" }}>
                      <s-stack direction="inline" gap="tight">
                        <button
                          onClick={() => openEdit(rate)}
                          style={{ background: "none", border: "1px solid #c9cccf", borderRadius: "4px", padding: "4px 10px", cursor: "pointer", fontSize: "13px" }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(rate.id)}
                          style={{ background: "none", border: "1px solid #d72c0d", borderRadius: "4px", padding: "4px 10px", cursor: "pointer", fontSize: "13px", color: "#d72c0d" }}
                        >
                          Delete
                        </button>
                      </s-stack>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "center", gap: "8px", marginTop: "20px" }}>
            <button onClick={() => setPage(page - 1)} disabled={page === 1} style={paginationBtn(page === 1)}>← Prev</button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
              <button key={p} onClick={() => setPage(p)} style={paginationBtn(false, p === page)}>{p}</button>
            ))}
            <button onClick={() => setPage(page + 1)} disabled={page === totalPages} style={paginationBtn(page === totalPages)}>Next →</button>
          </div>
        )}
      </s-section>

      {/* Add / Edit Modal */}
      {modalOpen && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
              <h2 style={{ margin: 0, fontSize: "18px" }}>{editTarget ? "Edit Shipping Rate" : "Add Shipping Rate"}</h2>
              <button onClick={() => setModalOpen(false)} style={{ background: "none", border: "none", fontSize: "20px", cursor: "pointer", color: "#6d7175" }}>×</button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <label style={labelStyle}>
                Title *
                <input
                  style={inputStyle}
                  placeholder="e.g. Standard Delivery, Express"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
              </label>

              <label style={labelStyle}>
                Division *
                <select
                  style={inputStyle}
                  value={form.division}
                  onChange={(e) => setForm({ ...form, division: e.target.value })}
                >
                  {DIVISIONS.map((d) => (
                    <option key={d} value={d}>{d === "ALL" ? "All Divisions (Nationwide Fallback)" : d}</option>
                  ))}
                </select>
              </label>

              <label style={labelStyle}>
                Flat Rate (BDT) *
                <input
                  style={inputStyle}
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="e.g. 80"
                  value={form.flatAmount}
                  onChange={(e) => setForm({ ...form, flatAmount: e.target.value })}
                />
                <span style={{ fontSize: "12px", color: "#6d7175" }}>Set to 0 for always-free shipping</span>
              </label>

              <label style={labelStyle}>
                Free Shipping Above (BDT) — optional
                <input
                  style={inputStyle}
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="e.g. 1500 — leave blank to disable"
                  value={form.freeAbove}
                  onChange={(e) => setForm({ ...form, freeAbove: e.target.value })}
                />
                <span style={{ fontSize: "12px", color: "#6d7175" }}>If the cart total reaches this amount, shipping is free</span>
              </label>

              <label style={labelStyle}>
                Estimated Delivery — optional
                <input
                  style={inputStyle}
                  placeholder="e.g. 3-5 business days"
                  value={form.estimatedDays}
                  onChange={(e) => setForm({ ...form, estimatedDays: e.target.value })}
                />
              </label>

              {editTarget && (
                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={form.isActive}
                    onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                  />
                  <span style={{ fontWeight: 600 }}>Active</span>
                </label>
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "24px" }}>
              <button onClick={() => setModalOpen(false)} style={cancelBtnStyle}>Cancel</button>
              <button
                onClick={handleSave}
                disabled={!form.title || !form.division || form.flatAmount === ""}
                style={saveBtnStyle(!form.title || !form.division || form.flatAmount === "")}
              >
                {editTarget ? "Save Changes" : "Add Rate"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm Modal */}
      {deleteConfirm && (
        <div style={overlayStyle}>
          <div style={{ ...modalStyle, maxWidth: "400px" }}>
            <h2 style={{ margin: "0 0 12px", fontSize: "18px" }}>Delete Shipping Rate?</h2>
            <p style={{ color: "#6d7175" }}>This cannot be undone. Any ongoing orders using this rate will not be affected.</p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "20px" }}>
              <button onClick={() => setDeleteConfirm(null)} style={cancelBtnStyle}>Cancel</button>
              <button onClick={() => handleDelete(deleteConfirm)} style={{ ...saveBtnStyle(false), background: "#d72c0d" }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

// ── Styles ──────────────────────────────────────────────────────────────────

const overlayStyle = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999,
};

const modalStyle = {
  background: "#fff", borderRadius: "12px", padding: "28px",
  width: "100%", maxWidth: "520px", boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
};

const labelStyle = {
  display: "flex", flexDirection: "column", gap: "6px",
  fontWeight: 600, fontSize: "14px",
};

const inputStyle = {
  padding: "8px 12px", border: "1px solid #c9cccf", borderRadius: "6px",
  fontSize: "14px", width: "100%", boxSizing: "border-box",
};

const cancelBtnStyle = {
  padding: "8px 16px", border: "1px solid #c9cccf", borderRadius: "6px",
  background: "#fff", cursor: "pointer", fontSize: "14px",
};

const saveBtnStyle = (disabled) => ({
  padding: "8px 20px", border: "none", borderRadius: "6px", fontSize: "14px",
  background: disabled ? "#c9cccf" : "#008060", color: "#fff",
  cursor: disabled ? "not-allowed" : "pointer", fontWeight: 600,
});

const paginationBtn = (disabled, active = false) => ({
  padding: "6px 12px", border: `1px solid ${active ? "#008060" : "#c9cccf"}`,
  borderRadius: "4px", background: active ? "#008060" : "#fff",
  color: active ? "#fff" : disabled ? "#c9cccf" : "#202223",
  cursor: disabled ? "not-allowed" : "pointer", fontSize: "13px",
});

import { useRouteError } from "react-router";
