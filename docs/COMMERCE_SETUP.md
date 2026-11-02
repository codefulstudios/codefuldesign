# Codeful Studios commerce setup

This repository hosts the software catalogue, customer portal and admin dashboard. **No live payment is enabled by default.** Do not set `STORE_PAYMENTS_ENABLED=true` until you've completed a verified Stripe test transaction, refund, licence retrieval and download.

## Render environment

- `DATABASE_URL`: Neon pooled PostgreSQL URL (never commit this).
- `NODE_ENV=production`.
- `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`: admin login. Run `node scripts/create-admin-hash.mjs "a-unique-long-password"` locally and use a generated 32+ byte random session secret.
- `STRIPE_SECRET_KEY`: start with `sk_test_...`.
- `STRIPE_WEBHOOK_SECRET`: webhook signing secret from Stripe; create webhook endpoint `https://codefuldesign.onrender.com/api/stripe/webhook` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and `charge.refunded`.
- `LICENSE_ENCRYPTION_KEY`: 32 random bytes encoded as **64 hexadecimal characters**. Store securely and back up: rotating without re-encrypting existing keys makes them unreadable.
- `PUBLIC_BASE_URL=https://codefuldesign.onrender.com`.
- `STORE_PAYMENTS_ENABLED=false` until final verification.

## Private ZIP storage

Use a **private S3-compatible bucket**, not a public directory or Render ephemeral disk. Add:
- `S3_ENDPOINT` HTTPS endpoint.
- `S3_REGION`.
- `S3_BUCKET`.
- `S3_ACCESS_KEY_ID`.
- `S3_SECRET_ACCESS_KEY`.

Bucket CORS must permit PUT from `https://codefuldesign.onrender.com` and allow the `content-type` and `x-amz-checksum-sha256` request headers. Never grant public listing or public reads. Grant the application credentials narrowly scoped to its specific bucket.

In Admin → ZIP Releases, select a ZIP up to 250 MB, provide product slug and version, and upload. The browser uploads directly to private storage using a signed 10-minute URL, then registers the release with Neon. Customer download URLs expire after 2 minutes and are subject to an atomic limit counter.

## Enable checkout

1. Verify admin credentials, customer registration/login, and Neon table migrations.
2. Upload a real ZIP release into the private bucket, then verify the release metadata.
3. Set a product price in Admin → Payments and mark it enabled.
4. Add Stripe test credentials and webhook signing secret to Render.
5. Confirm Stripe webhook signature handling, an actual test-mode card checkout, idempotent payment event delivery, licence retrieval in the account portal, download permissions and count enforcement.
6. Verify a test refund revokes the licence and download entitlement. Check partial refunds do not revoke full access unintentionally.
7. Only after those tests consider setting `STORE_PAYMENTS_ENABLED=true`. Start in Stripe test mode and repeat full verification before switching to live keys.

## Limitations

- Admin orders created manually are draft records and do not grant paid entitlements.
- Automatic licence issuance occurs exclusively from a signed, paid Stripe Checkout webhook, not from a redirect or order record.
- Password reset/email verification, licensing domain limits, email receipts and automated buyer notifications still need production work.
- S3 bucket CORS, Stripe account onboarding and credentials are external prerequisites not provisioned by this repository.
- Customer and admin authenticated end-to-end tests require intentionally created test accounts. Never share production passwords in chat.
