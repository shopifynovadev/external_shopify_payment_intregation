# Nova bKash Payment App — Claude Project Context

## What This Is
A Shopify public app (targeting Bangladesh market) that replaces Shopify's native checkout with a bKash MFS payment flow. Merchants install this app to accept bKash payments from their Shopify storefront. All native Shopify checkout buttons are hidden via theme extension CSS injection. A custom cart block handles address collection, shipping rate selection, discount application, and payment initiation. A thank-you block handles post-payment order confirmation.

## Tech Stack
| Layer | Technology |
|---|---|
| Runtime | Node.js >=20 (ES modules, ES6+ throughout) |
| Framework | React Router v7 (Remix-based SSR) |
| Database | PostgreSQL via Prisma ORM |
| Shopify SDK | @shopify/shopify-app-react-router |
| Shopify API Version | **2026-04** (never change) |
| In-process Queue | p-queue (concurrency-controlled, swappable to BullMQ+Redis) |
| Payment Gateway | bKash Tokenized Checkout API |
| App UI | Shopify Polaris |
| Theme Extensions | Shopify Theme App Extensions (Liquid + JS) |
| Encryption | AES-256-GCM for bKash credentials at rest |
| Email (OTP) | Shopify Email or Nodemailer — email only, no SMS |

## Key Architectural Decisions (Do Not Change Without Discussion)
- **No Redis currently** — p-queue handles in-process concurrency. Interface is abstracted so BullMQ can drop in later. Max 100 concurrent requests is the design target.
- **PostgreSQL, not MongoDB** — financial/relational data needs ACID transactions. Prisma handles all DB access; no raw SQL unless there is a proven performance reason.
- **bKash Tokenized Checkout API** — not PGW v1.2.
- **Multiple stores, one bKash account** — bKash credentials are stored per `MerchantSettings` record keyed by shop domain. Multiple shops belonging to the same merchant owner can point to the same bKash number/credentials. This is intentional and supported.
- **Billing is 1% GMV of previous month**, invoiced on the 1st of each month. Pro-rated from the merchant's install date if they installed mid-month (e.g., installed on the 20th of a 30-day month → first partial invoice covers 10 days, calculated proportionally).
- **OTP expires in 2 minutes**. Max 3 attempts before 15-minute lockout.
- **Shopify app distribution** — targeting public App Store. Bangladesh market exemption applies (Shopify Payments not available in BD), which allows third-party payment gateways. Verify Shopify review policy before submission.

## Project Structure
```
app/
  routes/               # React Router routes — both UI pages and API endpoints
  models/               # Prisma query helpers, never call prisma directly in routes
  services/             # Business logic (bkash.service.js, billing.service.js, etc.)
  queues/               # p-queue workers (payment, order-create, refund, billing)
  utils/                # crypto.js, rateLimit.js, idempotency.js
  jobs/                 # Cron jobs (billing, reconciliation, pending-payment cleanup)
  middleware/           # Webhook signature verification, request validation

extensions/
  cart-block/           # Theme block: cart page payment form
  thankyou-block/       # Theme block: thank-you page order confirmation

prisma/
  schema.prisma         # PostgreSQL schema
  migrations/
```

## Payment State Machine
Every payment is tracked with strict state transitions. Do not skip states.
```
PENDING → AWAITING_EXECUTE → COMPLETED
                           → FAILED
                           → REFUNDED
PENDING → ABANDONED (TTL 30 min, cleaned by cron)
```

## Critical Rules (Read Before Touching Any Payment Code)
1. **Never call bKash API directly from a route handler** — always dispatch to the payment queue.
2. **Never create a Shopify order without first verifying bKash payment** via the execute/verify step.
3. **All webhook handlers must be idempotent** — check DB state before any side effect. If already processed, return HTTP 200 immediately.
4. **Webhook refund handler**: check DB for `orderId`; if `status === 'REFUNDED'` already, return 200 immediately. Shopify retries until it gets 200.
5. **Cart snapshot** — capture cart line items, total, and shipping selection into `PendingPayment` at initiation time. Verify amounts match on execute step.
6. **bKash token refresh** — proactively refresh before expiry, never on a live payment request.
7. **Never log bKash credentials, raw tokens, or customer payment data**.
8. **Shopify API rate limit** — order creation queue is per-shop, respects Shopify's 2 req/s bucket (leaky bucket).

## API Response Convention
All JSON API responses follow this envelope:
```js
{ success: true, data: { ... } }
{ success: false, error: "human-readable message", code: "MACHINE_CODE" }
```

## Code Style
- ES6+ only: `import/export`, `async/await`, optional chaining `?.`, nullish coalescing `??`
- No TypeScript for now — JSDoc where types matter for clarity
- No comments unless the WHY is non-obvious (a hidden constraint, workaround, subtle invariant)
- No docstring blocks — keep it clean
- Prisma for all DB access via model helper functions in `app/models/`
- Environment secrets via `.env` — never hardcode

## Shopify Scopes Needed
```
read_orders, write_orders,
read_draft_orders, write_draft_orders,
read_products, read_inventory,
read_shipping, write_shipping,
read_customers, write_customers,
read_themes, write_themes,
write_metafields, read_metafields,
read_metaobjects, write_metaobjects,
read_fulfillments, write_fulfillments
```

## Environment Variables
```
SHOPIFY_API_KEY
SHOPIFY_API_SECRET
SHOPIFY_APP_URL
SCOPES
DATABASE_URL              # PostgreSQL connection string
BKASH_ENCRYPTION_KEY      # AES-256 key for encrypting bKash credentials
OTP_EMAIL_FROM            # sender email for OTP
APP_SECRET                # for signing internal tokens
CRON_SECRET               # for securing cron job endpoints
```
