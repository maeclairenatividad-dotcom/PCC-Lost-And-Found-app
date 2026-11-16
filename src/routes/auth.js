const express = require('express');
const bcrypt = require('bcryptjs');
const { q, one, run, logActivity, nextRefCode } = require('../db');
const { notify } = require('../mailer');
const { requireLogin, requireStudent, redirectIfLoggedIn } = require('../middleware/auth');
const { upload, saveUpload } = require('../middleware/upload');
const badges = require('../badges');
const { PROGRAMS } = require('../helpers');

const router = express.Router();

// ---- Sign in ---------------------------------------------------------
// /login is a landing page that sends students and admins to their own portal.
router.get('/login', redirectIfLoggedIn, (req, res) => {
  res.render('auth/login', { title: 'Sign in' });
});

const loginError = (req, res, view, title, email) => {
  req.flash('error', 'That email and password do not match.');
  return res.status(401).render(view, { title, form: { email } });
};

// ---- Student sign in -------------------------------------------------
router.get('/student/login', redirectIfLoggedIn, (req, res) => {
  res.render('auth/login-student', { title: 'Student sign in', form: {} });
});

router.post('/student/login', redirectIfLoggedIn, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const view = 'auth/login-student';
    const title = 'Student sign in';

    const user = await one('SELECT * FROM users WHERE email = ?', [email]);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return loginError(req, res, view, title, email);
    }
    if (user.role !== 'student') {
      req.flash('error', 'That is an administrator account. Use the admin sign-in portal.');
      return res.status(403).render(view, { title, form: { email } });
    }
    if (!user.is_active) {
      req.flash('error', 'This account is disabled. Contact the property office.');
      return res.status(403).render(view, { title, form: { email } });
    }

    req.session.user = {
      id: user.id, name: user.full_name, email: user.email,
      role: user.role, studentNo: user.student_no,
      avatar: user.avatar_path, program: user.program, section: user.section
    };
    await logActivity(user.id, 'login', 'user', user.id, null);

    const dest = req.session.returnTo && !req.session.returnTo.startsWith('/admin')
      ? req.session.returnTo : '/dashboard';
    delete req.session.returnTo;
    res.redirect(dest);
  } catch (err) { next(err); }
});

// ---- Administrator sign in -------------------------------------------
router.get('/admin/login', redirectIfLoggedIn, (req, res) => {
  res.render('auth/login-admin', { title: 'Administrator sign in', form: {} });
});

router.post('/admin/login', redirectIfLoggedIn, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const view = 'auth/login-admin';
    const title = 'Administrator sign in';

    const user = await one('SELECT * FROM users WHERE email = ?', [email]);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return loginError(req, res, view, title, email);
    }
    if (user.role !== 'admin') {
      req.flash('error', 'That is a student account. Use the student sign-in portal.');
      return res.status(403).render(view, { title, form: { email } });
    }
    if (!user.is_active) {
      req.flash('error', 'This account is disabled. Contact the school IT office.');
      return res.status(403).render(view, { title, form: { email } });
    }

    req.session.user = {
      id: user.id, name: user.full_name, email: user.email,
      role: user.role, studentNo: user.student_no,
      avatar: user.avatar_path, program: user.program, section: user.section
    };
    await logActivity(user.id, 'login', 'user', user.id, null);

    const dest = req.session.returnTo || '/admin';
    delete req.session.returnTo;
    res.redirect(dest);
  } catch (err) { next(err); }
});

// ---- Register (students only) ----------------------------------------
router.get('/register', redirectIfLoggedIn, (req, res) => {
  res.render('auth/register', { title: 'Create an account', form: {} });
});

router.post('/register', redirectIfLoggedIn, upload.single('photo'), async (req, res, next) => {
  const form = {
    fullName: String(req.body.fullName || '').trim(),
    studentNo: String(req.body.studentNo || '').trim(),
    email: String(req.body.email || '').trim().toLowerCase(),
    program: String(req.body.program || '').trim(),
    section: String(req.body.section || '').trim(),
    phone: String(req.body.phone || '').trim()
  };
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirmPassword || '');

  const fail = (msg) => {
    req.flash('error', msg);
    return res.status(400).render('auth/register', { title: 'Create an account', form });
  };

  try {
    if (!form.fullName || !form.studentNo || !form.email) {
      return fail('Fill in your name, student number and school email.');
    }
    if (!PROGRAMS.includes(form.program)) return fail('Pick a valid program.');
    if (!form.section) return fail('Enter your section (for example 1-A).');
    if (password.length < 8) return fail('Use a password of at least 8 characters.');
    if (password !== confirm) return fail('The two passwords do not match.');

    const clash = await one(
      'SELECT id FROM users WHERE email = ? OR student_no = ?',
      [form.email, form.studentNo]
    );
    if (clash) return fail('An account already exists for that email or student number.');

    const hash = await bcrypt.hash(password, 10);
    const avatarPath = await saveUpload(req.file);
    const result = await run(
      `INSERT INTO users (student_no, full_name, email, phone, program, section, avatar_path, password_hash, role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'student')`,
      [form.studentNo, form.fullName, form.email, form.phone || null,
       form.program, form.section, avatarPath, hash]
    );

    await logActivity(result.insertId, 'register', 'user', result.insertId, form.email);
    await notify(form.email, 'welcome', { name: form.fullName });

    req.session.user = {
      id: result.insertId, name: form.fullName, email: form.email,
      role: 'student', studentNo: form.studentNo,
      avatar: avatarPath, program: form.program, section: form.section
    };
    req.flash('success', 'Account created. Welcome.');
    res.redirect('/dashboard');
  } catch (err) { next(err); }
});

// ---- Sign out --------------------------------------------------------
router.post('/logout', requireLogin, async (req, res) => {
  await logActivity(req.session.user.id, 'logout', 'user', req.session.user.id, null);
  req.session.destroy(() => res.redirect('/login'));
});

// ---- Profile ---------------------------------------------------------
router.get('/profile', requireLogin, async (req, res, next) => {
  try {
    const user = await one('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
    const badgeData = user.role === 'student'
      ? badges.evaluate(await badges.statsFor(user.id))
      : null;
    res.render('profile', { title: 'Your profile', user, badges: badgeData });
  } catch (err) { next(err); }
});

router.post('/profile', requireLogin, upload.single('avatar'), async (req, res, next) => {
  try {
    const fullName = String(req.body.fullName || '').trim();
    const phone = String(req.body.phone || '').trim();
    const program = String(req.body.program || '').trim();
    const section = String(req.body.section || '').trim();

    if (!fullName) {
      req.flash('error', 'Your name cannot be empty.');
      return res.redirect('/profile');
    }
    if (req.session.user.role === 'student') {
      if (!PROGRAMS.includes(program)) {
        req.flash('error', 'Pick a valid program.');
        return res.redirect('/profile');
      }
      if (!section) {
        req.flash('error', 'Enter your section (for example 1-A).');
        return res.redirect('/profile');
      }
    }

    const avatar = req.file ? await saveUpload(req.file) : undefined;
    await run(
      `UPDATE users SET full_name = ?, phone = ?, program = ?, section = ?,
        avatar_path = COALESCE(?, avatar_path) WHERE id = ?`,
      [fullName, phone || null, program || null, section || null, avatar ?? null,
       req.session.user.id]
    );

    req.session.user.name = fullName;
    req.session.user.program = program || null;
    req.session.user.section = section || null;
    if (avatar) req.session.user.avatar = avatar;
    req.flash('success', 'Profile updated.');
    res.redirect('/profile');
  } catch (err) { next(err); }
});

router.post('/profile/password', requireLogin, async (req, res, next) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const user = await one('SELECT * FROM users WHERE id = ?', [req.session.user.id]);

    if (!(await bcrypt.compare(String(currentPassword), user.password_hash))) {
      req.flash('error', 'Your current password is wrong.');
      return res.redirect('/profile');
    }
    if (String(newPassword).length < 8) {
      req.flash('error', 'Use a new password of at least 8 characters.');
      return res.redirect('/profile');
    }
    if (newPassword !== confirmPassword) {
      req.flash('error', 'The two new passwords do not match.');
      return res.redirect('/profile');
    }

    await run('UPDATE users SET password_hash = ? WHERE id = ?',
      [await bcrypt.hash(String(newPassword), 10), user.id]);
    await logActivity(user.id, 'password_change', 'user', user.id, null);
    req.flash('success', 'Password changed.');
    res.redirect('/profile');
  } catch (err) { next(err); }
});

module.exports = router;
