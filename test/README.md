# Nova bKash — Backend E2E Test Guide

## Structure

```
test/
  postman/
    nova-bkash.collection.json    ← import this into Postman
    nova-bkash.environment.json   ← import this as the environment
  concurrency/
    01-payment-queue.js           ← 10+ simultaneous payment initiations
    02-order-create-rate-limit.js ← per-shop 500ms rate limit verification
    03-callback-race.js           ← double-callback race condition
    04-refund-race.js             ← simultaneous refund webhook idempotency
```

---

## Prerequisites

1. **App running**: `npm run dev`
2. **ngrok tunnel** (required for webhooks): `ngrok http 3000` — copy the HTTPS URL
3. **bKash sandbox credentials** configured in the app Settings page
4. **PostgreSQL** running with migrations applied

---

## Step 1 — Import into Postman

1. Open Postman → **Import** → select both JSON files from `test/postman/`
2. Select the **"Nova bKash - Local Dev"** environment from the top-right dropdown
3. Fill in the environment variables:

| Variable | Where to get it |
|---|---|
| `base_url` | `http://localhost:3000` (or your ngrok URL for webhook tests) | cloudflare:
https://fee-organization-flex-kijiji.trycloudflare.com
| `shop_domain` | Your dev store, e.g. `your-store.myshopify.com`  `entry-try-shop.myshopify.com`|
| `cron_secret` | Copy from `.env` → `CRON_SECRET` |
| `shopify_api_secret` | Copy from `.env` → `SHOPIFY_API_SECRET` |
| `shipping_handle` | Get from bKash cart block UI, or Storefront API shipping rates query |
| `test_variant_id` | Any product variant GID from your dev store |
| `test_subtotal` | Must match the actual price of `test_variant_id` |
| `valid_discount_code` | Create a discount in Shopify Admin → Discounts |

---

## Step 2 — Run Postman sections in order

Run each folder top-to-bottom. Some requests auto-save values (like `payment_id`) to env vars for use in later requests.

### Section 01 — Health Check
Just hit run. Should be green immediately.

### Section 02 — Payment Initiate
- **2.1** is the core test. It calls bKash sandbox → creates a real `PendingPayment`.
- After 2.1 passes, `payment_id` and `bkash_payment_id` are auto-saved to env vars.
- **2.2** reuses the same `cartId` — verify it returns the **same** `payment_id`.

### Section 03 — Payment Callback (Cancel/Failure)
- **3.1** and **3.2**: uses `bkash_payment_id` saved from 2.1. Tests cancel + failure redirects.
- Disable **"Follow Redirects"** in Postman Settings → General if you want to inspect the 302 `Location` header directly (otherwise Postman follows it and you see the final page).
- **Success path (3.5 — not in collection)**: Open the `redirectUrl` from test 2.1 in a browser → complete payment in bKash sandbox → bKash redirects to `/api/payment/callback?...&status=success` automatically. Then poll status.

### Section 04 — Payment Status
- **4.1**: Run after 3.1 (cancel) — should show `FAILED`.
- **4.2**: Run after completing a full bKash payment. Set `completed_payment_id` manually first.

### Section 05 — Discount Validate
Requires a real discount code in your dev store. Create one in Shopify Admin → Discounts → Fixed amount.

### Section 06 — Cron Jobs
- Run **6.1** and **6.2** first (auth checks — no DB required).
- **6.3** (cleanup): marks any expired PENDING payments as ABANDONED. Run after some payments have expired.
- **6.5** (billing): only generates invoices for months where GMV exists. Run on the 1st of a month OR seed `OrderSummary` rows in DB manually to test.
- **6.6** (billing idempotency): run 6.5 twice — second run should show `created: 0`.

### Section 07 — Webhooks (Refund)
- The **pre-request script** auto-computes the `X-Shopify-Hmac-SHA256` header using `shopify_api_secret`.
- **7.1**: fires for an unknown order → server skips it, returns 200.
- **7.2**: fires for a real completed order. Set `completed_shopify_order_gid` first (get from DB: `SELECT shopify_order_id FROM orders LIMIT 1`).
- **7.3**: same payload as 7.2 → verify only one bKash refund is triggered (check DB + server logs).
- **7.4**: bad HMAC → should get 401 or 403.

### Section 08 — CORS / Security
Verifies CORS headers are present on public routes and that `storefront-config` returns usable data.

### Section 09 — OTP Flow
Cannot be tested via Postman (requires Shopify admin session). **Test manually via the app UI** — see instructions in the collection description.

---

## Step 3 — Concurrency Tests (Node.js)

Run from the **repo root** after `npm run dev` is running.

### 10.1 + 10.2 — Payment queue (10+ simultaneous initiations)
```bash
BASE_URL=http://localhost:3000 \
SHOP_DOMAIN=your-store.myshopify.com \
VARIANT_ID="gid://shopify/ProductVariant/YOUR_ID" \
SHIPPING_HANDLE="shopify-Standard Shipping-10.00" \
node test/concurrency/01-payment-queue.js
```
**Pass criteria**: All requests succeed, all `paymentId`s are unique.

### 10.3 + 10.4 — Order-create rate limiting (per-shop 500ms interval)
```bash
node test/concurrency/02-order-create-rate-limit.js
```
**Pass criteria**: Same-shop calls >= 500ms apart; different-shop calls run in parallel.

### 10.5 — Callback race condition (double-callback for same paymentID)
```bash
# First complete a payment in bKash sandbox. Then immediately:
BASE_URL=http://localhost:3000 \
BKASH_PAYMENT_ID=your_bkash_payment_id \
node test/concurrency/03-callback-race.js
```
**Pass criteria**: Both return clean redirects; DB has exactly 1 order for that payment.

### 10.6 — Refund webhook idempotency (3 simultaneous webhooks)
```bash
BASE_URL=http://localhost:3000 \
SHOPIFY_API_SECRET=your_secret \
SHOPIFY_ORDER_GID="gid://shopify/Order/123456" \
SHOP_DOMAIN=your-store.myshopify.com \
node test/concurrency/04-refund-race.js
```
**Pass criteria**: All return 200; DB has exactly 1 Refund row for the test refundId.

---

## DB Queries for Manual Verification

```sql
-- See all pending payments and their status
SELECT id, status, bkash_payment_id, expires_at, created_at
FROM pending_payments ORDER BY created_at DESC LIMIT 10;

-- See all orders
SELECT shopify_order_number, bkash_transaction_id, total_amount, status, created_at
FROM orders ORDER BY created_at DESC LIMIT 10;

-- See refunds
SELECT shopify_refund_id, status, refund_amount, bkash_refund_id, created_at
FROM refunds ORDER BY created_at DESC LIMIT 10;

-- See OTP requests
SELECT shop_domain, email, purpose, attempts, is_used, locked_until, expires_at
FROM otp_requests ORDER BY created_at DESC LIMIT 5;

-- See invoices
SELECT shop_domain, period_start, period_end, gmv_total, invoice_amount, is_prorated_first, status
FROM invoices ORDER BY created_at DESC LIMIT 10;

-- See audit log
SELECT action, actor, metadata, created_at
FROM audit_logs ORDER BY created_at DESC LIMIT 20;
```

---

## What Requires the bKash Sandbox

These tests require going through the bKash sandbox payment UI in a browser:

| Test | How |
|---|---|
| Full happy path (PENDING → COMPLETED → Order created) | Run 2.1, open `redirectUrl` in browser, complete payment |
| Callback success path (4.2 status = COMPLETED) | Same as above — bKash redirects automatically |
| Refund flow (7.2) | Need a completed order first |
| Concurrency 03 (callback race) | Need a payment that bKash has accepted |
