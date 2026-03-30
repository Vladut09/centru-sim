# Quick Payment System Setup Guide

## 5-Minute Setup

### Step 1: Install Stripe Package
```bash
npm install
```

### Step 2: Get Stripe Keys
1. Go to https://dashboard.stripe.com/apikeys
2. Copy your **Secret Key** (starts with `sk_test_`)
3. Copy your **Publishable Key** (starts with `pk_test_`)

### Step 3: Create .env File
Create a file named `.env` in your project root:

```env
STRIPE_SECRET_KEY=sk_test_YOUR_KEY_HERE
STRIPE_WEBHOOK_SECRET=whsec_test_YOUR_KEY_HERE
PAYMENT_DOMAIN=http://localhost:3000
```

Replace `YOUR_KEY_HERE` with your actual Stripe keys from the dashboard.

### Step 4: Add dotenv to server.js
At the very top of `server.js`, add:

```javascript
import dotenv from 'dotenv';
dotenv.config();
```

Then update the Stripe configuration:
```javascript
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_1234567890';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_1234567890';
```

Also install dotenv:
```bash
npm install dotenv
```

### Step 5: Start Server
```bash
npm start
```

Your server is now running at `http://localhost:3000`

---

## Test the System

1. **Open Payment Page**: http://localhost:3000/payment.html
2. **Login** if not already logged in
3. **Select Premium** tier ($9.99/month)
4. **Choose Payment Method**: Credit Card
5. **Use Test Card**:
   - Number: `4242 4242 4242 4242`
   - Expiry: Any future date (e.g., `12/25`)
   - CVC: Any 3 digits (e.g., `123`)
6. **Click "Proceed to Payment"**
7. **Confirm** on Stripe checkout page
8. **See Success** page with confirmation

---

## Check Admin Dashboard

1. **Login as Admin**:
   - Email: `admin@evalprep.ro`
   - Password: `admin123`
2. **Open Admin Page**: http://localhost:3000/payment-admin.html
3. **See All Payments** and subscription status
4. **Filter** by status, tier, or search by email

---

## Database Changes

The system automatically creates 3 new tables:

| Table | Purpose |
|-------|---------|
| `payments` | Track all payment transactions |
| `subscriptions` | Store user subscription status |
| `payment_methods` | Save customer payment methods |

You can view data with:
```bash
sqlite3 db/evalprep.db
sqlite> SELECT * FROM payments;
sqlite> SELECT * FROM subscriptions;
sqlite> .exit
```

---

## Files Added/Modified

### New Files Created:
- ✅ `payment.html` - User payment selection page
- ✅ `payment-success.html` - Success confirmation page
- ✅ `payment-admin.html` - Admin payment dashboard
- ✅ `PAYMENT_SYSTEM.md` - Full documentation
- ✅ `SETUP_PAYMENTS.md` - This file

### Files Modified:
- ✅ `server.js` - Added 4 database tables + payment routes
- ✅ `package.json` - Added Stripe dependency

---

## Payment Routes Available

### For Users:
- `GET /api/payment/config` - Get tiers and current subscription
- `POST /api/payment/checkout` - Create Stripe checkout session
- `GET /api/payment/status/:sessionId` - Check payment status
- `GET /api/subscriptions` - Get active subscription
- `POST /api/subscriptions/cancel` - Cancel subscription
- `GET /api/payment/methods` - Get saved payment methods

### For Admins:
- `GET /api/admin/payments` - View all payments (admin only)

### Stripe Webhook:
- `POST /api/payment/webhook` - Handles Stripe events

---

## Troubleshooting

### "Cannot find module 'stripe'"
```bash
npm install
```

### Stripe keys not working
- Check `.env` file exists in project root
- Verify keys are correct (copy-paste from Stripe dashboard)
- Make sure no extra spaces in `.env`

### Webhook not working
- Webhook only works when Stripe calls it (after real payment)
- In test mode, payment happens immediately
- No separate webhook configuration needed for local testing

### Need to update tier structure?
Edit `PAYMENT_TIERS` in `server.js`:
```javascript
const PAYMENT_TIERS = {
  free: { name: 'Free', price: 0, interval: null },
  premium: { name: 'Premium', price: 999, interval: 'month' },
  pro: { name: 'Pro', price: 2999, interval: 'month' }
  // Add new tiers here
};
```

---

## Production Deployment

### Before Going Live:

1. **Switch to Live Keys**
   - Get live keys from Stripe dashboard
   - Update `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` with live keys

2. **Update Domain**
   - Change `PAYMENT_DOMAIN` to your actual domain

3. **Enable HTTPS**
   - Required for Stripe
   - Use Let's Encrypt or your hosting provider's SSL

4. **Configure Webhook**
   - Go to Stripe Dashboard → Webhooks
   - Add endpoint: `https://yourdomain.com/api/payment/webhook`
   - Select events: `checkout.session.completed`, `customer.subscription.*`

5. **Secure Secrets**
   - Store `.env` file securely (never commit to git)
   - Add `.env` to `.gitignore`
   - Use environment variables on production server

---

## Questions?

- **Stripe Docs**: https://stripe.com/docs
- **Test Cards**: https://stripe.com/docs/testing
- **API Reference**: https://stripe.com/docs/api

---

## Summary of Features

✅ **3 Payment Tiers**
- Free, Premium ($9.99), Pro ($29.99)

✅ **Payment Methods**
- Credit Card (fully integrated)
- PayPal (UI ready, needs Stripe setup)
- Bank Transfer (UI ready)

✅ **Security**
- No card data stored on server
- Stripe handles all tokenization
- PCI compliant
- Webhook validation

✅ **Database**
- Payments table tracks all transactions
- Subscriptions table stores status
- Payment methods table for saved cards

✅ **Admin Dashboard**
- View all payments
- Search and filter
- Real-time statistics
- Recent activity feed

✅ **User Interface**
- Clean, modern design
- Payment method selector
- Form validation
- Success/error messages
- Subscription management

---

You're all set! Start with `npm install` and `.env` configuration, then visit `http://localhost:3000/payment.html` to test.
