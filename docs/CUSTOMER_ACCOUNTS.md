# Customer accounts — Codeful Studios

Customer account area: https://codefuldesign.onrender.com/account

Implemented: registration, login, email-verification tokens (24h), password-reset tokens (30 minutes), password change, logout on all devices, login attempt throttling, purchase history, encrypted licence display and protected version downloads. One-time tokens are SHA-256 hashed in Neon; using a reset invalidates all active customer sessions. Checkout requires a verified email address.

## Email setup (Render → Environment)
- RESEND_API_KEY: your Resend API key (secret).
- MAIL_FROM: verified sender address, for example `Codeful Studios <accounts@your-verified-domain.example>`.
- PUBLIC_BASE_URL: `https://codefuldesign.onrender.com`.

The sender domain must be verified with the email provider. Do not commit secret keys. Password reset requests always use a generic response, so the API does not reveal whether an account exists. Actual email sending requires verified sender/domain and live provider credentials.

## Production verification
1. Register with a test email and verify the email is delivered.
2. Follow the verification link, check account status and sign in again.
3. Request a password reset, test expired/reused links, and check that earlier sessions are invalidated.
4. Change password and confirm all devices are signed out.
5. Confirm order history is restricted to the signed-in user.
6. Confirm refunded/unpaid orders give no ZIP downloads or active entitlements.
7. Check Chrome/mobile, cookie handling, and sign-in rate limiting.

Outstanding before selling: production email-provider credentials, authenticated end-to-end tests, independent security review, private ZIP storage integration, Stripe test-mode completion. Do not enable real sales solely because account routes exist.
