# System Architecture — Nova bKash Payment App

## High-Level Flow

```
Customer (Browser / Shopify Storefront)
  │
  │  1. Views cart → Cart Block (Theme Extension) renders
  │  2. Enters address → fetches shipping rates from Shopify AJAX API
  │  3. Selects rate, applies discount, clicks "Pay Now"
  │
  ▼
Our Backend (React Router v7 / Node.js)
  │  POST /api/payment/initiate
  │    - Validates cart snapshot, discount, shipping
  │    - Creates PendingPayment (state: PENDING)
  │    - Dispatches to payment-queue → calls bKash Tokenized API
  │    - Returns bKash redirect URL
  │
  ▼
bKash Payment Page (external)
  │
  │  Customer completes or cancels payment
  │
  ▼
Our Backend
  │  GET /api/payment/callback?paymentID=...&status=success|cancel|failure
  │    - Verifies callback signature
  │    - Updates PendingPayment state → AWAITING_EXECUTE
  │    - Calls bKash /execute API to confirm payment
  │    - On success: dispatches to order-create-queue
  │    - On failure: marks FAILED, returns error payload for cart display
  │
  ▼
Order Create Queue (per-shop, rate-limited)
  │  - Verifies cart snapshot still matches (amount, items)
  │  - Creates Shopify Draft Order via Admin API 2026-04
  │  - Marks Draft Order as paid (orderMarkAsPaid mutation)
  │  - Stores Order record in DB
  │  - Updates PendingPayment state → COMPLETED
  │  - Updates OrderSummary (daily aggregate)
  │
  ▼
Customer redirected to Shopify Thank You page
  │  Thank You Block (Theme Extension) renders
  │  - Polls /api/payment/status/:id until COMPLETED
  │  - Displays order ID, bKash txn ID, amount
```

---

## Component Map

### Theme Extensions

#### 1. `cart-block` (Cart Page)
- Replaces / supplements the native cart — renders inside the cart template
- Fields: customer name, phone, email, delivery address (division/district/thana/address line)
- Shipping: on address entry, fetches `/cart/shipping_rates.json?shipping_address[...]` from Shopify AJAX API, renders rates as radio buttons
- Discount: text input → validates via `/api/discount/validate` before payment
- "Pay Now" button → POST `/api/payment/initiate`
- Polls `/api/payment/status/:id` (max 3 min, 5s intervals) while bKash redirect is open
- Shows inline error on FAILED state (no page reload)
- Settings exposed to merchant: button color, button text, show/hide fields

#### 2. `thankyou-block` (Thank You / Order Status Page)
- Injected into the order-status template
- Reads `paymentId` from URL params or session storage
- Polls `/api/payment/status/:id` if not yet COMPLETED
- Displays: order number, bKash transaction ID, amount paid, estimated delivery
- Merchant settings: custom message, show/hide fields

#### 3. CSS injection (global snippet in theme extension)
- Hides `[href*="/checkouts"]`, `.checkout-button`, `#checkout`, `form[action="/checkout"]`
- Applied globally across all theme pages
- Merchant can toggle this from app settings (on/off per theme)

---

## Backend Routes (React Router v7)

### Public / Storefront API Routes (no Shopify auth required, HMAC or custom auth)
```
POST   /api/payment/initiate          Initiate bKash payment
GET    /api/payment/callback           bKash redirects here after payment
POST   /api/payment/execute            Internal: confirm + create order (called by queue)
GET    /api/payment/status/:id         Poll payment state (cart block polls this)
POST   /api/discount/validate          Validate discount code + return calculated total
GET    /api/shipping/rates             Proxy Shopify shipping rates for a given address
POST   /api/refund/webhook            Shopify webhook: orders/refunded
POST   /api/orders/webhook            Shopify webhook: orders/paid / orders/fulfilled
POST   /webhooks/app/uninstalled      Shopify webhook: cleanup on uninstall
POST   /webhooks/app/scopes_update    Shopify webhook: scope changes
```

### App UI Routes (Shopify embedded auth required)
```
GET    /app                           Dashboard home (recent orders, revenue chart)
GET    /app/orders                    Full orders list (paginated, filterable)
GET    /app/orders/:id                Order detail + link to Shopify admin
GET    /app/billing                   Billing / invoices page
GET    /app/settings                  Settings (bKash credentials, theme management)
GET    /app/settings/themes           Theme management: add blocks per theme
POST   /app/settings/bkash            Update bKash credentials (triggers OTP flow)
POST   /app/settings/otp/send         Send OTP for credential change
POST   /app/settings/otp/verify       Verify OTP → allow credential update
GET    /app/analytics                 Revenue chart (last 6 months)
GET    /health                        Health check
```

---

## Database Schema (PostgreSQL via Prisma)

```prisma
model Session {
  id                  String    @id
  shop                String
  state               String
  isOnline            Boolean   @default(false)
  scope               String?
  expires             DateTime?
  accessToken         String
  userId              BigInt?
  firstName           String?
  lastName            String?
  email               String?
  accountOwner        Boolean   @default(false)
  locale              String?
  collaborator        Boolean?  @default(false)
  emailVerified       Boolean?  @default(false)
  refreshToken        String?
  refreshTokenExpires DateTime?
}

// One record per installed shop
model MerchantSettings {
  id                String    @id @default(cuid())
  shopDomain        String    @unique
  installedAt       DateTime  @default(now())
  isActive          Boolean   @default(true)

  // bKash credentials — AES-256-GCM encrypted
  bkashNumber       String?   // encrypted
  bkashUsername     String?   // encrypted
  bkashPassword     String?   // encrypted
  bkashAppKey       String?   // encrypted
  bkashAppSecret    String?   // encrypted
  bkashApiBaseUrl   String?   // sandbox or production URL

  // Theme settings
  enabledThemes     String[]  // array of theme IDs where blocks are active
  hideCheckout      Boolean   @default(true)

  // Billing
  billingStartDate  DateTime  @default(now()) // used for pro-rated first invoice

  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  orders            Order[]
  invoices          Invoice[]
  otpRequests       OtpRequest[]
  auditLogs         AuditLog[]
  orderSummaries    OrderSummary[]
}

// Pending payment — created before bKash redirect, acts as idempotency record
model PendingPayment {
  id                String    @id @default(cuid())
  shopDomain        String
  idempotencyKey    String    @unique   // cartId + timestamp hash
  bkashPaymentId    String?   @unique   // assigned by bKash on create
  status            PaymentStatus @default(PENDING)

  // Snapshotted at initiation — used to verify amounts on execute
  cartSnapshot      Json      // { lineItems, subtotal, shippingTitle, shippingPrice, discountCode, discountAmount, total }
  customerInfo      Json      // { name, phone, email, address }
  totalAmount       Decimal   @db.Decimal(12, 2)
  currency          String    @default("BDT")

  bkashExecuteResponse Json?  // raw response from bKash execute API
  errorDetails      String?

  expiresAt         DateTime  // 30 min TTL
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  order             Order?
}

enum PaymentStatus {
  PENDING
  AWAITING_EXECUTE
  COMPLETED
  FAILED
  ABANDONED
  REFUNDED
}

// Our record for each order created through the app
model Order {
  id                  String    @id @default(cuid())
  shopDomain          String
  shopifyOrderId      String    @unique  // Shopify GID
  shopifyOrderNumber  String
  shopifyDraftOrderId String?

  pendingPaymentId    String    @unique
  pendingPayment      PendingPayment @relation(fields: [pendingPaymentId], references: [id])

  merchantSettings    MerchantSettings @relation(fields: [shopDomain], references: [shopDomain])

  bkashTransactionId  String    @unique
  totalAmount         Decimal   @db.Decimal(12, 2)
  currency            String    @default("BDT")
  status              OrderStatus @default(PAID)

  customerName        String
  customerPhone       String
  customerEmail       String?
  deliveryAddress     Json

  shippingTitle       String
  shippingPrice       Decimal   @db.Decimal(10, 2)
  discountCode        String?
  discountAmount      Decimal?  @db.Decimal(10, 2)

  refunds             Refund[]

  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
}

enum OrderStatus {
  PAID
  FULFILLED
  REFUNDED
  PARTIALLY_REFUNDED
  CANCELLED
}

// Daily order aggregate — used for billing calculation and revenue chart
model OrderSummary {
  id            String    @id @default(cuid())
  shopDomain    String
  date          DateTime  @db.Date  // truncated to day
  orderCount    Int       @default(0)
  totalAmount   Decimal   @db.Decimal(14, 2) @default(0)

  merchantSettings MerchantSettings @relation(fields: [shopDomain], references: [shopDomain])

  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  @@unique([shopDomain, date])
}

// Refund records
model Refund {
  id                  String    @id @default(cuid())
  shopDomain          String
  orderId             String
  order               Order     @relation(fields: [orderId], references: [id])
  shopifyRefundId     String    @unique  // Shopify refund GID

  bkashRefundId       String?   @unique
  bkashTransactionId  String
  refundAmount        Decimal   @db.Decimal(12, 2)
  status              RefundStatus @default(PENDING)
  reason              String?
  errorDetails        String?

  initiatedAt         DateTime  @default(now())
  completedAt         DateTime?
  updatedAt           DateTime  @updatedAt
}

enum RefundStatus {
  PENDING
  COMPLETED
  FAILED
}

// Monthly billing invoices — 1% of GMV
model Invoice {
  id            String    @id @default(cuid())
  shopDomain    String
  merchantSettings MerchantSettings @relation(fields: [shopDomain], references: [shopDomain])

  periodStart   DateTime  // first day of the invoiced month
  periodEnd     DateTime  // last day of the invoiced month
  gmvTotal      Decimal   @db.Decimal(14, 2)
  invoiceAmount Decimal   @db.Decimal(12, 2)   // 1% of gmvTotal
  isProratedFirst Boolean @default(false)       // true if first invoice was partial month
  status        InvoiceStatus @default(UNPAID)

  createdAt     DateTime  @default(now())
  paidAt        DateTime?
}

enum InvoiceStatus {
  UNPAID
  PAID
  WAIVED
}

// OTP records for sensitive credential changes
model OtpRequest {
  id            String    @id @default(cuid())
  shopDomain    String
  merchantSettings MerchantSettings @relation(fields: [shopDomain], references: [shopDomain])

  email         String
  otpHash       String    // bcrypt hash of the OTP
  purpose       String    // e.g. "CHANGE_BKASH_CREDENTIALS"
  attempts      Int       @default(0)
  isUsed        Boolean   @default(false)
  lockedUntil   DateTime?
  expiresAt     DateTime  // now + 2 minutes

  createdAt     DateTime  @default(now())
}

// Append-only audit log for sensitive operations
model AuditLog {
  id            String    @id @default(cuid())
  shopDomain    String
  merchantSettings MerchantSettings @relation(fields: [shopDomain], references: [shopDomain])

  action        String    // e.g. "BKASH_CREDENTIALS_UPDATED", "REFUND_INITIATED"
  actor         String    // shop domain or "SYSTEM"
  metadata      Json?
  createdAt     DateTime  @default(now())
}
```

---

## Queue Architecture (p-queue, no Redis)

```
queues/
  payment.queue.js      concurrency: 10  (bKash payment create/execute calls)
  orderCreate.queue.js  concurrency: 5   per-shop rate-limited (Shopify 2 req/s)
  refund.queue.js       concurrency: 5   (bKash refund calls)
  billing.queue.js      concurrency: 2   (monthly invoice generation)
```

Each queue module exports:
- `enqueue(job)` — add work with priority
- `getStats()` — size, pending, active counts (for /health endpoint)

The queue interface is designed so that swapping to BullMQ later only requires changing the queue module internals — callers are unaffected.

Per-shop rate limiting for Shopify order creation: each shop gets its own sub-queue with a 500ms interval (≈ 2 req/s). If a shop has no sub-queue, one is created lazily.

---

## bKash Tokenized Checkout API Flow

### Token Management
```
1. On first use (or token expiry): POST /token/grant   → store token + expiry
2. Before each API call: check token TTL. If < 5 min remaining → proactive refresh
3. Token stored in MerchantSettings (encrypted), never in memory across requests
```

### Payment Creation
```
POST /create                          (from payment.queue)
  body: { amount, currency:"BDT", intent:"sale", merchantInvoiceNumber: pendingPaymentId }
  response: { paymentID, bkashURL }

→ Store bkashPaymentId in PendingPayment
→ Return bkashURL to cart block for redirect
```

### Payment Execute (called by callback handler after customer returns)
```
POST /execute                         (idempotent — bkash deduplicates on paymentID)
  body: { paymentID }
  response: { trxID, amount, transactionStatus:"Completed" }

→ Verify transactionStatus === "Completed"
→ Verify amount matches PendingPayment.totalAmount (reject if mismatch → auto-refund)
→ Dispatch to orderCreate.queue
```

### Refund
```
POST /refund                          (from refund.queue, triggered by Shopify webhook)
  body: { paymentID, amount, trxID, sku }
  response: { refundTrxID, transactionStatus }
```

---

## Shipping Rate Flow

```
Cart Block (browser — Storefront API GraphQL, Option A):
1. Customer fills address fields
2. Cart block calls Storefront API directly using the shop's public storefront token:

   mutation cartBuyerIdentityUpdate($cartId: ID!, $address: MailingAddressInput!) {
     cartBuyerIdentityUpdate(cartId: $cartId, buyerIdentity: {
       deliveryAddressPreferences: [{ deliveryAddress: $address }]
     }) {
       cart {
         deliveryGroups {
           deliveryOptions {
             handle       ← this is what we store
             title
             estimatedCost { amount currencyCode }
           }
         }
       }
     }
   }

3. Renders rates as radio group: "Standard Shipping — ৳60"
4. Customer selects a rate → cart block stores selected handle
5. On "Pay Now": POST /api/payment/initiate sends { cartId, shippingHandle, ...rest }
   — NOTE: price is NOT sent from browser. Backend verifies it independently.

Backend (initiate — Storefront API GraphQL verification):
6. Receives { cartId, shippingHandle } from cart block
7. Calls Storefront API (using shop's storefront access token from session):

   query GetCart($cartId: ID!) {
     cart(id: $cartId) {
       deliveryGroups {
         deliveryOptions {
           handle
           title
           estimatedCost { amount currencyCode }
         }
       }
     }
   }

8. Finds the deliveryOption matching shippingHandle
9. Extracts verified { shippingTitle, shippingPrice } from Shopify's response
10. Uses these server-verified values for totalAmount calculation and cartSnapshot
    — Frontend-supplied price is ignored entirely

Backend (order create queue):
11. Creates Shopify Draft Order with:
    shippingLine: { title: shippingTitle, price: shippingPrice, custom: true }
    — title and price came from Shopify's own Storefront API, not from the browser
12. Shopify validates inventory and order — handles stock issues
```

---

## Billing System

### Monthly Invoice Job (runs 1st of each month at 00:05 UTC)
```
1. Query all active MerchantSettings
2. For each merchant:
   a. Determine period: first day of previous month → last day of previous month
   b. If first invoice: check installedAt — adjust periodStart to installedAt date
      (pro-rate: if installed on 20th of a 30-day month, period = 20th–30th = 11 days)
   c. SUM(totalAmount) from OrderSummary WHERE shopDomain = X AND date BETWEEN periodStart AND periodEnd
   d. invoiceAmount = gmvTotal * 0.01
   e. Create Invoice record
   f. Log to AuditLog
```

### OrderSummary Upsert (every time an order is created)
```
UPSERT OrderSummary
  WHERE shopDomain = X AND date = today
  SET orderCount += 1, totalAmount += order.totalAmount
```

---

## Order Reconciliation Job (runs daily at 02:00 UTC)

```
1. For each shop, query Shopify for orders created_at_min = yesterday 00:00 UTC
   (using Admin API orders list, paginated)
2. Cross-check against our Order table for the same date range
3. For each Shopify order with our bKash txn tag:
   a. If exists in our DB: verify amounts match — log discrepancy if not
   b. If NOT in our DB: flag as MISSING — alert (log to AuditLog, future: email alert)
4. Update OrderSummary if any gaps found (self-healing)
```

---

## Theme Management (Merchant Settings UI)

```
1. App fetches all themes via Admin API:
   GET /admin/api/2026-04/themes.json
   Response includes: id, name, role (main/unpublished/demo)

2. Merchant sees list of themes with status badges
3. Per theme, merchant can:
   - Add Cart Block → deeplink to theme editor:
     https://{shop}/admin/themes/{themeId}/editor?template=cart&addAppBlockId={EXT_ID}/cart_block
   - Add Thank You Block → deeplink to theme editor:
     https://{shop}/admin/themes/{themeId}/editor?template=customers/order&addAppBlockId={EXT_ID}/thankyou_block
   - Toggle checkout button hiding (on/off per theme)

4. Active theme IDs stored in MerchantSettings.enabledThemes[]
```

---

## Security Architecture

| Concern | Approach |
|---|---|
| bKash credentials | AES-256-GCM encrypted at rest, decrypted only in service layer |
| Shopify webhooks | HMAC-SHA256 signature verification on every webhook |
| bKash callbacks | Verify paymentID exists in our DB before processing |
| OTP brute force | 3 attempts max, 15-min lockout, 2-min expiry |
| SQL injection | Prisma parameterized queries |
| XSS | React/Polaris handle escaping; Liquid auto-escapes |
| Sensitive logging | Strip credentials, tokens, card data from all logs |
| Audit trail | AuditLog for all sensitive mutations |
| Cart tampering | Amount verified server-side from PendingPayment snapshot |

---

## Concurrency & Performance (100 concurrent requests target)

- Node.js event loop handles I/O concurrency natively
- p-queue serializes bKash API calls (avoid duplicate payments)
- PostgreSQL connection pool: max 20 connections (Prisma default, tune per deployment)
- Per-shop Shopify rate limiting: 500ms interval per shop queue
- Idempotency keys on all payment creation requests
- DB indexes on: `PendingPayment.idempotencyKey`, `PendingPayment.bkashPaymentId`, `Order.shopifyOrderId`, `Order.bkashTransactionId`, `OrderSummary.(shopDomain, date)`
- Heavy DB queries (billing calc, reconciliation) run in off-peak cron jobs, not on the request path
