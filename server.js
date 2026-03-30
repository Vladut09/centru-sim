import express from 'express';
import session from 'express-session';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import Stripe from 'stripe';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;

// ─── Stripe Configuration ──────────────────────────────────────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_51234567890';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_1234567890';
const PAYMENT_DOMAIN = process.env.PAYMENT_DOMAIN || 'http://localhost:3000';
const stripe = new Stripe(STRIPE_SECRET_KEY);

// Payment tier configuration
const PAYMENT_TIERS = {
  free: { name: 'Free', price: 0, interval: null },
  premium: { name: 'Premium', price: 999, interval: 'month' }, // $9.99/month in cents
  pro: { name: 'Pro', price: 2999, interval: 'month' } // $29.99/month in cents
};

// ─── Ensure directories ────────────────────────────────────────────────────────
const dirs = ['db', 'uploads/pdfs', 'uploads/submissions'];
dirs.forEach(d => fs.mkdirSync(path.join(__dirname, d), { recursive: true }));

// ─── Database ──────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'db', 'evalprep.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'student',
    tier TEXT NOT NULL DEFAULT 'free',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS simulations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    subject TEXT NOT NULL,
    description TEXT,
    pdf_filename TEXT NOT NULL,
    original_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions_exam (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    simulation_id INTEGER NOT NULL,
    started_at DATETIME NOT NULL,
    timer_ends_at DATETIME NOT NULL,
    upload_ends_at DATETIME NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_progress',
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (simulation_id) REFERENCES simulations(id)
  );

  CREATE TABLE IF NOT EXISTS submission_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions_exam(id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    stripe_payment_intent_id TEXT UNIQUE,
    amount INTEGER NOT NULL,
    currency TEXT DEFAULT 'usd',
    payment_method TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    stripe_subscription_id TEXT UNIQUE,
    tier TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'active',
    current_period_start DATETIME,
    current_period_end DATETIME,
    cancel_at_period_end INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS payment_methods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    stripe_payment_method_id TEXT UNIQUE,
    type TEXT NOT NULL,
    brand TEXT,
    last4 TEXT,
    is_default INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ─── Seed admin account ────────────────────────────────────────────────────────
const adminEmail = 'admin@evalprep.ro';
const existingAdmin = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
if (!existingAdmin) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run('Administrator', adminEmail, hash, 'admin');
  console.log('Admin account created: admin@evalprep.ro / admin123');
}

// ─── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(__dirname));

// ─── Multer for PDFs ───────────────────────────────────────────────────────────
const pdfStorage = multer.diskStorage({
  destination: path.join(__dirname, 'uploads', 'pdfs'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `sim-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  }
});
const uploadPdf = multer({
  storage: pdfStorage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Doar fișiere PDF sunt acceptate.'));
  },
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ─── Multer for submission images ──────────────────────────────────────────────
const imgStorage = multer.diskStorage({
  destination: path.join(__dirname, 'uploads', 'submissions'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `sub-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  }
});
const uploadImages = multer({
  storage: imgStorage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Doar imagini sunt acceptate.'));
  },
  limits: { fileSize: 20 * 1024 * 1024 }
});

// ─── Auth helpers ──────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Trebuie să fii autentificat.' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Trebuie să fii autentificat.' });
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Acces interzis.' });
  next();
}

// ─── AUTH ROUTES ───────────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Toate câmpurile sunt obligatorii.' });
  if (password.length < 6) return res.status(400).json({ error: 'Parola trebuie să aibă minim 6 caractere.' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Un cont cu acest email există deja.' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)').run(name, email, hash);

  req.session.userId = result.lastInsertRowid;
  req.session.role = 'student';
  req.session.userName = name;

  res.json({ success: true, user: { id: result.lastInsertRowid, name, email, role: 'student' } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email și parola sunt obligatorii.' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Email sau parolă incorectă.' });
  }

  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.userName = user.name;

  res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Neautentificat.' });
  const user = db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Neautentificat.' });
  res.json({ user });
});

// ─── ADMIN ROUTES ──────────────────────────────────────────────────────────────
app.get('/api/admin/simulations', requireAdmin, (req, res) => {
  const sims = db.prepare('SELECT * FROM simulations ORDER BY created_at DESC').all();
  res.json({ simulations: sims });
});

app.post('/api/admin/simulations', requireAdmin, uploadPdf.single('pdf'), (req, res) => {
  const { title, subject, description } = req.body;
  if (!title || !subject || !req.file) {
    return res.status(400).json({ error: 'Titlu, materie și PDF sunt obligatorii.' });
  }

  const result = db.prepare(
    'INSERT INTO simulations (title, subject, description, pdf_filename, original_name) VALUES (?, ?, ?, ?, ?)'
  ).run(title, subject, description || '', req.file.filename, req.file.originalname);

  res.json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/admin/simulations/:id', requireAdmin, uploadPdf.single('pdf'), (req, res) => {
  const { title, subject, description } = req.body;
  const sim = db.prepare('SELECT * FROM simulations WHERE id = ?').get(req.params.id);
  if (!sim) return res.status(404).json({ error: 'Simulare negăsită.' });

  if (req.file) {
    // Delete old PDF
    const oldPath = path.join(__dirname, 'uploads', 'pdfs', sim.pdf_filename);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);

    db.prepare(
      'UPDATE simulations SET title = ?, subject = ?, description = ?, pdf_filename = ?, original_name = ? WHERE id = ?'
    ).run(title || sim.title, subject || sim.subject, description ?? sim.description, req.file.filename, req.file.originalname, req.params.id);
  } else {
    db.prepare(
      'UPDATE simulations SET title = ?, subject = ?, description = ? WHERE id = ?'
    ).run(title || sim.title, subject || sim.subject, description ?? sim.description, req.params.id);
  }

  res.json({ success: true });
});

app.delete('/api/admin/simulations/:id', requireAdmin, (req, res) => {
  const sim = db.prepare('SELECT * FROM simulations WHERE id = ?').get(req.params.id);
  if (!sim) return res.status(404).json({ error: 'Simulare negăsită.' });

  const oldPath = path.join(__dirname, 'uploads', 'pdfs', sim.pdf_filename);
  if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);

  db.prepare('DELETE FROM simulations WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Admin: view all submissions
app.get('/api/admin/submissions', requireAdmin, (req, res) => {
  const submissions = db.prepare(`
    SELECT se.id, se.status, se.started_at, se.timer_ends_at, se.upload_ends_at,
           u.name as student_name, u.email as student_email,
           s.title as simulation_title, s.subject as simulation_subject
    FROM sessions_exam se
    JOIN users u ON se.user_id = u.id
    JOIN simulations s ON se.simulation_id = s.id
    ORDER BY se.started_at DESC
  `).all();

  // Attach images to each submission
  const getImages = db.prepare('SELECT id, filename, original_name, uploaded_at FROM submission_images WHERE session_id = ?');
  for (const sub of submissions) {
    sub.images = getImages.all(sub.id);
  }

  res.json({ submissions });
});

// Serve submission images to admin
app.get('/api/admin/submissions/:sessionId/images/:filename', requireAdmin, (req, res) => {
  const filePath = path.join(__dirname, 'uploads', 'submissions', req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Imagine negăsită.' });
  res.sendFile(filePath);
});

// ─── STUDENT ROUTES ────────────────────────────────────────────────────────────
// List available simulations
app.get('/api/simulations', requireAuth, (req, res) => {
  const sims = db.prepare('SELECT id, title, subject, description, created_at FROM simulations ORDER BY created_at DESC').all();

  // Add user's session status for each simulation
  const getSession = db.prepare(
    'SELECT id, status, started_at, timer_ends_at, upload_ends_at FROM sessions_exam WHERE user_id = ? AND simulation_id = ? ORDER BY started_at DESC LIMIT 1'
  );

  for (const sim of sims) {
    const sess = getSession.get(req.session.userId, sim.id);
    sim.session = sess || null;
  }

  res.json({ simulations: sims });
});

// Start a simulation
app.post('/api/simulations/:id/start', requireAuth, (req, res) => {
  const sim = db.prepare('SELECT * FROM simulations WHERE id = ?').get(req.params.id);
  if (!sim) return res.status(404).json({ error: 'Simulare negăsită.' });

  // Check if already has active session
  const active = db.prepare(
    "SELECT * FROM sessions_exam WHERE user_id = ? AND simulation_id = ? AND status IN ('in_progress', 'uploading')"
  ).get(req.session.userId, req.params.id);
  if (active) {
    return res.json({ session: active, alreadyStarted: true });
  }

  const now = new Date();
  const timerEnd = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2 hours
  const uploadEnd = new Date(timerEnd.getTime() + 5 * 60 * 1000); // +5 minutes

  const result = db.prepare(
    'INSERT INTO sessions_exam (user_id, simulation_id, started_at, timer_ends_at, upload_ends_at, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.session.userId, req.params.id, now.toISOString(), timerEnd.toISOString(), uploadEnd.toISOString(), 'in_progress');

  const session = db.prepare('SELECT * FROM sessions_exam WHERE id = ?').get(result.lastInsertRowid);
  res.json({ session, alreadyStarted: false });
});

// Get simulation session status
app.get('/api/simulations/:id/status', requireAuth, (req, res) => {
  const session = db.prepare(
    'SELECT * FROM sessions_exam WHERE user_id = ? AND simulation_id = ? ORDER BY started_at DESC LIMIT 1'
  ).get(req.session.userId, req.params.id);

  if (!session) return res.status(404).json({ error: 'Nicio sesiune activă.' });

  // Auto-update status based on time
  const now = new Date();
  const timerEnd = new Date(session.timer_ends_at);
  const uploadEnd = new Date(session.upload_ends_at);

  if (session.status === 'in_progress' && now >= timerEnd) {
    if (now < uploadEnd) {
      db.prepare("UPDATE sessions_exam SET status = 'uploading' WHERE id = ?").run(session.id);
      session.status = 'uploading';
    } else {
      db.prepare("UPDATE sessions_exam SET status = 'expired' WHERE id = ?").run(session.id);
      session.status = 'expired';
    }
  } else if (session.status === 'uploading' && now >= uploadEnd) {
    db.prepare("UPDATE sessions_exam SET status = 'expired' WHERE id = ?").run(session.id);
    session.status = 'expired';
  }

  const images = db.prepare('SELECT id, original_name, uploaded_at FROM submission_images WHERE session_id = ?').all(session.id);
  session.images = images;

  res.json({ session });
});

// Serve PDF to authenticated student
app.get('/api/simulations/:id/pdf', requireAuth, (req, res) => {
  const sim = db.prepare('SELECT * FROM simulations WHERE id = ?').get(req.params.id);
  if (!sim) return res.status(404).json({ error: 'Simulare negăsită.' });

  // Check that user has an active session for this simulation
  const session = db.prepare(
    "SELECT * FROM sessions_exam WHERE user_id = ? AND simulation_id = ? AND status IN ('in_progress', 'uploading') ORDER BY started_at DESC LIMIT 1"
  ).get(req.session.userId, req.params.id);

  // Admins can always access
  if (!session && req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Trebuie să începi simularea pentru a accesa PDF-ul.' });
  }

  const filePath = path.join(__dirname, 'uploads', 'pdfs', sim.pdf_filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'PDF negăsit.' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${sim.original_name || sim.pdf_filename}"`);
  res.sendFile(filePath);
});

// Upload submission images
app.post('/api/simulations/:id/submit', requireAuth, uploadImages.array('images', 10), (req, res) => {
  const session = db.prepare(
    "SELECT * FROM sessions_exam WHERE user_id = ? AND simulation_id = ? AND status IN ('in_progress', 'uploading') ORDER BY started_at DESC LIMIT 1"
  ).get(req.session.userId, req.params.id);

  if (!session) return res.status(403).json({ error: 'Nicio sesiune activă pentru încărcare.' });

  const now = new Date();
  const timerEnd = new Date(session.timer_ends_at);
  const uploadEnd = new Date(session.upload_ends_at);

  // Update status if needed
  if (now >= timerEnd && session.status === 'in_progress') {
    db.prepare("UPDATE sessions_exam SET status = 'uploading' WHERE id = ?").run(session.id);
  }

  // Check if upload window has passed
  if (now >= uploadEnd) {
    db.prepare("UPDATE sessions_exam SET status = 'expired' WHERE id = ?").run(session.id);
    return res.status(403).json({ error: 'Fereastra de încărcare a expirat.' });
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Nicio imagine selectată.' });
  }

  const insertImage = db.prepare('INSERT INTO submission_images (session_id, filename, original_name) VALUES (?, ?, ?)');
  const insertMany = db.transaction((files) => {
    for (const file of files) {
      insertImage.run(session.id, file.filename, file.originalname);
    }
  });
  insertMany(req.files);

  // Mark as completed
  db.prepare("UPDATE sessions_exam SET status = 'completed' WHERE id = ?").run(session.id);

  res.json({ success: true, count: req.files.length });
});

// Dashboard data
app.get('/api/dashboard', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?').get(req.session.userId);

  const sessions = db.prepare(`
    SELECT se.*, s.title as simulation_title, s.subject as simulation_subject
    FROM sessions_exam se
    JOIN simulations s ON se.simulation_id = s.id
    WHERE se.user_id = ?
    ORDER BY se.started_at DESC
  `).all(req.session.userId);

  const getImages = db.prepare('SELECT id, original_name, uploaded_at FROM submission_images WHERE session_id = ?');
  for (const sess of sessions) {
    sess.images = getImages.all(sess.id);
  }

  const totalSimulations = sessions.length;
  const completedSimulations = sessions.filter(s => s.status === 'completed').length;

  res.json({ user, sessions, stats: { totalSimulations, completedSimulations } });
});

// ─── PAYMENT ROUTES ────────────────────────────────────────────────────────────

// Get payment tiers and current user subscription
app.get('/api/payment/config', requireAuth, (req, res) => {
  const user = db.prepare('SELECT tier FROM users WHERE id = ?').get(req.session.userId);
  const subscription = db.prepare('SELECT * FROM subscriptions WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1')
    .get(req.session.userId, 'active');

  res.json({
    tiers: PAYMENT_TIERS,
    currentTier: user?.tier || 'free',
    subscription: subscription || null
  });
});

// Create a checkout session
app.post('/api/payment/checkout', requireAuth, (req, res) => {
  const { tier, paymentMethod } = req.body;
  if (!tier || !Object.keys(PAYMENT_TIERS).includes(tier)) {
    return res.status(400).json({ error: 'Invalid payment tier.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  const tierInfo = PAYMENT_TIERS[tier];

  try {
    if (tier === 'free') {
      // Free tier - no payment needed
      db.prepare('UPDATE users SET tier = ? WHERE id = ?').run('free', req.session.userId);
      db.prepare('INSERT OR REPLACE INTO subscriptions (user_id, tier, status) VALUES (?, ?, ?)')
        .run(req.session.userId, 'free', 'active');
      return res.json({ success: true, tier: 'free' });
    }

    if (!paymentMethod) {
      return res.status(400).json({ error: 'Payment method required.' });
    }

    // Create payment intent for one-time payment or subscription
    if (tierInfo.interval) {
      // Create subscription
      const session = stripe.checkout.sessions.create({
        customer_email: user.email,
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: { name: `${tierInfo.name} Subscription` },
              recurring: { interval: tierInfo.interval },
              unit_amount: tierInfo.price
            },
            quantity: 1
          }
        ],
        mode: 'subscription',
        success_url: `${PAYMENT_DOMAIN}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${PAYMENT_DOMAIN}/payment.html?tier=${tier}`
      });

      // Store temporary session
      db.prepare('INSERT INTO payments (user_id, stripe_payment_intent_id, amount, payment_method, status) VALUES (?, ?, ?, ?, ?)')
        .run(req.session.userId, session.id, tierInfo.price, paymentMethod, 'pending');

      res.json({ success: true, sessionId: session.id, url: session.url });
    } else {
      res.status(400).json({ error: 'One-time payments not implemented.' });
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Handle Stripe webhook
app.post('/api/payment/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const payment = db.prepare('SELECT user_id FROM payments WHERE stripe_payment_intent_id = ?').get(session.id);

      if (payment) {
        const tier = session.metadata?.tier || 'premium';
        db.prepare('UPDATE users SET tier = ? WHERE id = ?').run(tier, payment.user_id);
        db.prepare('INSERT INTO subscriptions (user_id, stripe_subscription_id, tier, status) VALUES (?, ?, ?, ?)')
          .run(payment.user_id, session.subscription, tier, 'active');
        db.prepare('UPDATE payments SET status = ? WHERE stripe_payment_intent_id = ?').run('succeeded', session.id);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      db.prepare('UPDATE subscriptions SET status = ? WHERE stripe_subscription_id = ?').run('canceled', subscription.id);
    } else if (event.type === 'customer.subscription.updated') {
      const subscription = event.data.object;
      db.prepare('UPDATE subscriptions SET status = ? WHERE stripe_subscription_id = ?')
        .run(subscription.status, subscription.id);
    }
  } catch (error) {
    console.error('Webhook processing error:', error);
  }

  res.json({ received: true });
});

// Get payment status
app.get('/api/payment/status/:sessionId', requireAuth, (req, res) => {
  try {
    const session = stripe.checkout.sessions.retrieve(req.params.sessionId);
    res.json({ status: session.payment_status, sessionId: session.id });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get user subscription
app.get('/api/subscriptions', requireAuth, (req, res) => {
  const subscription = db.prepare(
    'SELECT * FROM subscriptions WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1'
  ).get(req.session.userId, 'active');

  res.json({ subscription: subscription || null });
});

// Cancel subscription
app.post('/api/subscriptions/cancel', requireAuth, (req, res) => {
  const subscription = db.prepare(
    'SELECT * FROM subscriptions WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1'
  ).get(req.session.userId, 'active');

  if (!subscription) {
    return res.status(404).json({ error: 'No active subscription found.' });
  }

  try {
    stripe.subscriptions.update(subscription.stripe_subscription_id, {
      cancel_at_period_end: true
    });

    db.prepare('UPDATE subscriptions SET cancel_at_period_end = 1 WHERE id = ?').run(subscription.id);
    res.json({ success: true, message: 'Subscription will be canceled at period end.' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Admin: view all payments
app.get('/api/admin/payments', requireAdmin, (req, res) => {
  const payments = db.prepare(`
    SELECT p.*, u.name, u.email, u.tier,
           s.stripe_subscription_id, s.status as subscription_status
    FROM payments p
    JOIN users u ON p.user_id = u.id
    LEFT JOIN subscriptions s ON u.id = s.user_id
    ORDER BY p.created_at DESC
  `).all();

  res.json({ payments });
});

// Get saved payment methods for user
app.get('/api/payment/methods', requireAuth, (req, res) => {
  const methods = db.prepare('SELECT * FROM payment_methods WHERE user_id = ? ORDER BY is_default DESC').all(req.session.userId);
  res.json({ methods });
});

// ─── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Eroare la încărcare: ${err.message}` });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`EvalPrep server running at http://localhost:${PORT}`);
  console.log(`Admin login: admin@evalprep.ro / admin123`);
});
