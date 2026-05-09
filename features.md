# Feature Specifications — Nova bKash Payment App

## 1. Cart Block (Theme Extension)

### Purpose
Replaces Shopify's native checkout flow with a bKash-powered payment form embedded directly on the cart page.

### UI Fields
| Field | Type | Validation |
|---|---|---|
| Full Name | text | required |
| Phone Number | text | required, BD format |
| Email | email | optional |
| Division | select | required |
| District | select | required (filtered by division) |
| Thana/Upazila | select | required (filtered by district) |
| Street Address | textarea | required |
| Shipping Method | radio group | fetched from Shopify, required |
| Discount Code | text + Apply btn | optional, validated via API |
| Order Summary | display only | subtotal, shipping, discount, total |
| Pay with bKash | primary button | disabled until form valid |

### Shipping Rate Fetch Flow
1. Address fields trigger rate fetch (on blur or "Check Shipping Rates" button)
2. Cart block calls **Storefront API GraphQL** directly (public storefront token, Option A):
   - `cartBuyerIdentityUpdate` mutation with the delivery address
   - Reads `cart.deliveryGroups[].deliveryOptions[]` from response
3. Displays rates as radio buttons with title + price
4. On rate selection: recalculates total in UI using the Storefront API-returned price
5. On payment initiation: sends only `{ cartId, shippingHandle }` to backend — **never the price**
6. Backend independently re-queries Storefront API with `cartId` + matches `shippingHandle` → extracts verified title + price. Frontend-supplied price is ignored.

### Discount Code Flow
1. Customer enters code → clicks Apply
2. POST `/api/discount/validate` with `{ code, cartTotal, shopDomain }`
3. Backend validates via Shopify Admin API (PriceRule / DiscountCode endpoints)
4. Response: `{ valid, discountAmount, discountType, finalTotal }`
5. UI updates total; code is locked (greyed out) after valid apply

### Payment Initiation
1. Click "Pay with bKash"
2. POST `/api/payment/initiate` with full payload (cart snapshot + customer info + shipping + discount)
3. Backend returns `{ redirectUrl, paymentId }`
4. Browser opens bKash URL (same tab redirect or popup — confirm with merchant preference)
5. Cart block stores `paymentId` in sessionStorage for polling on return

### Error States
- `FAILED`: show inline banner "Payment failed. Reason: [bKash message]. Please try again."
- `ABANDONED`: show "Session expired. Please try again."
- Network error: show retry option
- Merchant not configured (no bKash credentials): show "Payment not available. Contact store owner."

### Merchant Settings (via Theme Editor)
- Button label text (default: "Pay with bKash")
- Button color
- Show/hide optional fields (email)
- Custom "processing" message text

---

## 2. Thank You Block (Theme Extension)

### Purpose
Confirms order and bKash transaction on the Shopify order status/thank-you page.

### Display
- bKash Transaction ID
- Amount paid
- Order number (with link to Shopify order status page)
- Estimated delivery info (merchant configurable text)
- Custom message from merchant settings

### Behavior
- Reads `paymentId` from URL query param or sessionStorage
- Polls GET `/api/payment/status/:id` every 5 seconds (max 3 minutes)
- On `COMPLETED`: shows confirmation details
- On `FAILED`: shows error with "Go back to cart" link
- On timeout: shows "Payment verification taking longer than expected. Check your bKash app." with order support contact

---

## 3. Checkout Button Hiding (Theme Extension)

### Mechanism
- CSS snippet injected globally via theme extension asset
- Targets: `.checkout-button`, `[href*="/checkouts"]`, `form[action="/checkout"]`, `#checkout`, `input[name="checkout"]`
- Uses `display: none !important` to override any theme styling

### Control
- Toggle per-theme from app settings page
- Stored in `MerchantSettings.enabledThemes[]`
- When toggled off: snippet remains in theme but CSS class is removed via JS check against a public app endpoint

---

## 4. Payment Processing Backend

### POST /api/payment/initiate
**Input**: `{ cartId, shippingHandle, discountCode, customerInfo, shopDomain }`
**Processing**:
1. Generate idempotency key (`SHA256(cartId + shopDomain + timestamp)`)
2. Check for existing `PendingPayment` with same idempotency key → return existing if found (prevents double-submit)
3. Call Storefront API GraphQL with `cartId` → re-fetch delivery options → find option matching `shippingHandle` → extract verified `shippingTitle` + `shippingPrice` (ignore any price from browser)
4. Validate discount code if provided → calculate final total server-side
5. Validate total: `cartSubtotal + shippingPrice - discountAmount`
6. Decrypt merchant's bKash credentials from `MerchantSettings`
7. Dispatch to payment queue → call bKash `/create` API
8. Store `PendingPayment` with `status: PENDING`, full cart snapshot (including verified shipping values), `bkashPaymentId`
9. Return `{ redirectUrl, paymentId }`

### GET /api/payment/callback
**Triggered by**: bKash redirect after customer action
**Processing**:
1. Extract `paymentID`, `status` from query params
2. Lookup `PendingPayment` by `bkashPaymentId` — 404 if not found
3. If status is `cancel` or `failure` → set `PendingPayment.status = FAILED`, return error payload
4. If status is `success` → set status to `AWAITING_EXECUTE`, dispatch to execute queue
5. Call bKash `/execute` API
6. Verify `transactionStatus === "Completed"` and amount matches snapshot
7. On amount mismatch: mark FAILED, initiate bKash refund automatically
8. On success: dispatch to `orderCreate.queue`
9. Redirect customer to Thank You page with `?paymentId=...`

### GET /api/payment/status/:id
**Used by**: cart block and thank-you block polling
**Returns**: `{ status, shopifyOrderId?, shopifyOrderNumber?, bkashTransactionId?, errorMessage? }`
**No auth required** — `paymentId` is unguessable CUID

---

## 5. Order Creation Queue

### Flow
1. Dequeue job: `{ pendingPaymentId, shopDomain }`
2. Load `PendingPayment` with cart snapshot
3. Fetch fresh Shopify inventory to check stock — on stock failure: mark FAILED, initiate refund
4. Create Shopify Draft Order via `draftOrderCreate` mutation (Admin API 2026-04)
   - Line items from cart snapshot
   - Custom shipping line `{ title, price }`
   - Applied discount if any
   - Customer details
   - Tag with `nova-bkash` + bKash transaction ID
5. Mark draft order as completed: `draftOrderComplete` mutation
6. Mark order as paid via `orderMarkAsPaid` mutation
7. Create `Order` record in DB
8. Upsert `OrderSummary` for today
9. Set `PendingPayment.status = COMPLETED`
10. On any Shopify API error: retry up to 3 times (exponential backoff), then mark FAILED + refund

---

## 6. Refund System

### Trigger
Shopify webhook: `orders/refunded` → POST `/api/refund/webhook`

### Webhook Handler (Idempotent)
```
1. Verify Shopify HMAC signature
2. Extract shopifyRefundId, shopifyOrderId, refundAmount
3. Lookup Order by shopifyOrderId
   - Not found: return HTTP 200 (not our order, ignore safely)
4. Lookup Refund by shopifyRefundId
   - If found AND status === COMPLETED: return HTTP 200 immediately (idempotent)
   - If found AND status === PENDING: continue (retry safe)
5. Create or upsert Refund record (status: PENDING)
6. Dispatch to refund.queue
7. Return HTTP 200 immediately (Shopify won't retry if we return 200)
```

### Refund Queue Worker
```
1. Decrypt merchant bKash credentials
2. Call bKash /refund API with { paymentID, amount, trxID }
3. On success: update Refund.status = COMPLETED, Order.status = REFUNDED/PARTIALLY_REFUNDED
4. On failure: update Refund.status = FAILED, log to AuditLog, alert (future: notify merchant)
5. On bKash rate limit / transient error: retry with exponential backoff (max 5 attempts)
```

---

## 7. Orders Dashboard (App UI)

### Page: /app/orders
- Paginated table: Order#, Customer, Amount, bKash TxnID, Status, Date
- Filters: status, date range, search by order number or customer name
- Each row: "View in Shopify" link → `https://{shop}/admin/orders/{shopifyOrderId}`
- Status badges: Paid, Fulfilled, Refunded, Failed

### Page: /app/orders/:id
- Full order details
- Customer info, line items, shipping, discount
- bKash transaction details
- Refund history
- Link to Shopify admin order page
- "Initiate Refund" button (for manual refund trigger — calls same refund flow)

---

## 8. Revenue Analytics (App UI)

### Page: /app/analytics
- Line chart: last 6 months of monthly GMV (from `OrderSummary` grouped by month)
- Bar chart: order count per month
- Summary cards: total orders, total GMV, total app revenue (1% of GMV)
- Data source: `OrderSummary` aggregated by month — fast, no live Shopify API calls needed

---

## 9. Billing System

### Invoice Generation (Cron: 1st of each month, 00:05 UTC)
```
For each active merchant:
  1. Determine billing period:
     - Normal: previous full calendar month
     - First invoice (partial month):
         periodStart = installedAt date
         periodEnd   = last day of that month
  2. Sum OrderSummary.totalAmount for that period
  3. invoiceAmount = sum * 0.01 (1%)
  4. Create Invoice record
  5. Log to AuditLog
```

### Page: /app/billing
- Table of all invoices: Period, GMV, Invoice Amount, Status, Created Date
- Status: Unpaid / Paid / Waived
- Download invoice (future feature)
- Note: payment collection mechanism for invoices is out of scope for now — manual process

---

## 10. Settings — bKash Credentials

### Page: /app/settings (credentials section)

**Display (masked)**:
- bKash Number: `••••••7890`
- Username: `••••••••••`
- API Base URL: `https://tokenized.sandbox.bka.sh/...` (not masked)

**Update Flow (OTP-gated)**:
1. Merchant clicks "Update bKash Credentials"
2. Form shows: bKash Number, Username, Password, App Key, App Secret, API Base URL
3. On submit → POST `/api/settings/otp/send`
   - System sends OTP to merchant's Shopify account email
   - OTP: 6-digit, expires in 2 minutes, max 3 attempts, 15-min lockout on failure
4. OTP entry modal appears
5. POST `/api/settings/otp/verify` with `{ otp, pendingUpdate }` 
6. On success: credentials are encrypted + stored, AuditLog entry created
7. On lockout: "Too many attempts. Try again in 15 minutes."

---

## 11. Settings — Theme Management

### Page: /app/settings/themes

**Theme List** (fetched from Shopify Admin API):
| Theme Name | Role | Cart Block | TY Block | Checkout Hidden | Actions |
|---|---|---|---|---|---|
| Dawn | Live | ✅ Added | ✅ Added | ✅ On | Manage |
| Debut | Unpublished | ❌ | ❌ | ❌ | Manage |

**Per-Theme Actions**:
- "Add Cart Block" → opens Shopify theme editor deeplink
- "Add Thank You Block" → opens Shopify theme editor deeplink
- "Toggle checkout hiding" → updates `MerchantSettings.enabledThemes`

**Deep Link Format**:
```
https://{shop}/admin/themes/{themeId}/editor?template=cart&addAppBlockId={EXTENSION_ID}/cart_block
https://{shop}/admin/themes/{themeId}/editor?template=customers/order&addAppBlockId={EXTENSION_ID}/thankyou_block
```

---

## 12. Edge Cases — Complete Register

| # | Scenario | Handling |
|---|---|---|
| 1 | Customer double-taps "Pay Now" | Idempotency key prevents duplicate PendingPayment; second request returns existing |
| 2 | bKash callback race (arrives before redirect) | PendingPayment state machine is idempotent; AWAITING_EXECUTE → COMPLETED is safe to process from either path |
| 3 | Network drop after bKash success, before order creation | orderCreate.queue retries 3x; on exhaustion: mark FAILED + auto-initiate bKash refund |
| 4 | Cart changes between initiate and execute | Amount snapshot checked on execute — reject if mismatch, auto-refund bKash charge |
| 5 | Discount code expires mid-flow | Amount verified from snapshot; lock-in at initiation time |
| 6 | Item out of stock at order creation | Shopify draft order returns inventory error; catch → mark FAILED + auto-refund |
| 7 | Merchant has no bKash credentials set | Cart block checks `/api/payment/status/configured` → hides "Pay Now", shows message |
| 8 | bKash token expired during payment | Proactive refresh 5 min before expiry; on-demand refresh on 401 response from bKash |
| 9 | Shopify API rate limit during order creation | Per-shop queue with 500ms interval; rate-limited retries with 429 handling |
| 10 | Customer navigates away mid-payment | PendingPayment TTL 30 min; cron marks ABANDONED; bKash auto-expires |
| 11 | Shopify refund webhook duplicate delivery | Handler checks DB: if Refund.status === COMPLETED → return HTTP 200 immediately |
| 12 | Shopify refund webhook, order not in our DB | Return HTTP 200 (not our order) — Shopify stops retrying |
| 13 | Multiple shops, same bKash account | Supported by design: credentials stored per-shop in MerchantSettings, all point to same bKash number |
| 14 | Merchant installs mid-month | First invoice pro-rated from installedAt date to end of that month |
| 15 | OTP brute force | Max 3 attempts → 15-min lockout. OTP expires in 2 minutes |
| 16 | Amount mismatch bKash returns vs our total | Hard reject on execute; auto-initiate full refund for the bKash-charged amount |
| 17 | Shopify draft order creation succeeds but markAsPaid fails | Retry markAsPaid separately (idempotent mutation); draft order is not duplicated |
| 18 | bKash refund API failure | Retry up to 5x (exponential backoff); on exhaustion: mark Refund.FAILED, log to AuditLog for manual review |
| 19 | Merchant uninstalls app | `app/uninstalled` webhook → deactivate MerchantSettings, preserve historical Order/Invoice records |
| 20 | Billing cron fails mid-run | Each merchant's invoice is committed independently in a transaction; partial runs are safe to re-run |
| 21 | Daily reconciliation finds missing order | Log to AuditLog, self-heal OrderSummary, flag for review (future: alert email) |
| 22 | bKash credential update while a payment is in-flight | Queue drains before credential is swapped; token refresh uses the new credentials |

---

## 13. Notifications (Shopify Native)

Shopify handles all transactional emails and SMS natively when an order is created through the Admin API. No custom email/SMS implementation needed from our side. Triggers:
- Order confirmation email/SMS → on `draftOrderComplete` + `orderMarkAsPaid`
- Fulfillment notification → on order fulfillment (standard Shopify flow)
- Refund notification → on Shopify refund creation (standard Shopify flow)

---

## 14. Health & Observability

### GET /health
```json
{
  "status": "ok",
  "db": "connected",
  "queues": {
    "payment": { "size": 0, "active": 0 },
    "orderCreate": { "size": 2, "active": 1 },
    "refund": { "size": 0, "active": 0 }
  },
  "timestamp": "2026-05-09T10:00:00Z"
}
```

### Audit Log Actions
```
BKASH_CREDENTIALS_UPDATED
BKASH_CREDENTIALS_VIEW_ATTEMPTED
OTP_SENT
OTP_VERIFIED
OTP_FAILED
OTP_LOCKOUT
PAYMENT_INITIATED
PAYMENT_COMPLETED
PAYMENT_FAILED
REFUND_INITIATED
REFUND_COMPLETED
REFUND_FAILED
ORDER_CREATED
INVOICE_GENERATED
APP_INSTALLED
APP_UNINSTALLED
RECONCILIATION_DISCREPANCY_FOUND
```

---

## 15. Public App Shopify Policy Note

bKash targets the Bangladesh market exclusively. Shopify Payments is **not available in Bangladesh**, which qualifies this app for third-party payment gateway approval under Shopify's app review policy. Key requirements for App Store approval:
- App must be transparent about redirecting to an external payment page
- Must handle failed payments gracefully (no half-created orders)
- Must support refunds (covered)
- Must not store raw card data (we don't — bKash handles all payment data)
- Merchant must comply with bKash's terms of service independently

Recommendation: Submit as a custom/unlisted app first for initial merchants, then apply for public listing after validating the flow end-to-end with real bKash merchant accounts.
