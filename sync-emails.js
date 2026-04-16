/**
 * sync-emails.js
 * Logs into Outlook Live, captures Graph API token,
 * reads inbox + sent items, updates Supabase contacts.
 *
 * Usage:
 *   node sync-emails.js          → full sync
 *   node sync-emails.js --reset  → clear saved session (re-login)
 */

require('dotenv').config();
const { chromium } = require('playwright');
const https = require('https');
const fs = require('fs');
const path = require('path');

const EMAIL    = process.env.OUTLOOK_EMAIL;
const PASSWORD = process.env.OUTLOOK_PASSWORD;
const SB_URL   = process.env.SUPABASE_URL;
const SB_KEY   = process.env.SUPABASE_SERVICE_KEY;
const SESSION  = path.join(__dirname, 'session');

if (!EMAIL || !PASSWORD) { console.error('Missing OUTLOOK_EMAIL or OUTLOOK_PASSWORD in .env'); process.exit(1); }

// ── SUPABASE HELPERS ──────────────────────────────────────────────────────────
function sbFetch(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(SB_URL + path);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method,
      headers: {
        'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=representation',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── GRAPH API HELPERS ─────────────────────────────────────────────────────────
function graphGet(token, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'graph.microsoft.com',
      path: '/v1.0' + path,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
    }, res => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  const reset = process.argv.includes('--reset');
  if (reset && fs.existsSync(SESSION)) {
    fs.rmSync(SESSION, { recursive: true });
    console.log('Session cleared.');
  }

  console.log('\n📬 Pinpoint CRM — Email Sync');
  console.log('Account:', EMAIL);
  console.log('─'.repeat(40));

  // Launch with persistent context to save cookies/session
  const context = await chromium.launchPersistentContext(SESSION, {
    headless: true,
    args: ['--no-sandbox'],
  });

  const page = await context.newPage();
  let accessToken = null;

  // Intercept all requests to catch Graph API Bearer tokens
  await context.route('**', async route => {
    const headers = route.request().headers();
    const url = route.request().url();
    if (url.includes('graph.microsoft.com') && headers['authorization']?.startsWith('Bearer ')) {
      accessToken = headers['authorization'].slice(7);
    }
    await route.continue();
  });

  // Navigate to Outlook
  console.log('Opening Outlook…');
  await page.goto('https://outlook.live.com/mail/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Check if we need to login
  const currentUrl = page.url();
  const needsLogin = currentUrl.includes('login') || currentUrl.includes('account.live') || currentUrl.includes('login.microsoftonline');

  if (needsLogin) {
    console.log('Logging in…');

    // Enter email
    try {
      await page.fill('input[type="email"], input[name="loginfmt"]', EMAIL, { timeout: 10000 });
      await page.click('input[type="submit"], button[type="submit"]');
      await page.waitForTimeout(2000);
    } catch (e) {
      console.error('Could not find email field:', e.message);
    }

    // Enter password
    try {
      await page.fill('input[type="password"], input[name="passwd"]', PASSWORD, { timeout: 10000 });
      await page.click('input[type="submit"], button[type="submit"]');
      await page.waitForTimeout(2000);
    } catch (e) {
      console.error('Could not find password field:', e.message);
    }

    // "Stay signed in?" — click Yes
    try {
      const stayBtn = page.locator('input[value="Yes"], button:has-text("Yes")');
      if (await stayBtn.count() > 0) await stayBtn.click();
    } catch {}

    await page.waitForURL('**/mail/**', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(5000);
  } else {
    console.log('Using saved session.');
    await page.waitForTimeout(5000);
  }

  // Trigger some navigation to ensure Graph tokens are captured
  if (!accessToken) {
    console.log('Waiting for Graph token…');
    await page.goto('https://outlook.live.com/mail/0/inbox', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(6000);
  }

  if (!accessToken) {
    console.error('❌ Could not capture Graph API token. Login may have failed or MFA is required.');
    console.log('Try running with --reset to clear session and re-login.');
    await context.close();
    process.exit(1);
  }

  console.log('✓ Graph token captured');

  // ── FETCH CONTACTS FROM SUPABASE ────────────────────────────────────────────
  console.log('Loading contacts from Supabase…');
  const contacts = await sbFetch('/rest/v1/contacts?select=id,email,first_contact_date,last_contact_date,nb_follow_ups,reply_status');
  if (!Array.isArray(contacts)) { console.error('Failed to load contacts'); await context.close(); process.exit(1); }
  console.log(`✓ ${contacts.length} contacts loaded`);

  // Build email → contact map (lowercase)
  const emailMap = {};
  contacts.forEach(c => { if (c.email) emailMap[c.email.toLowerCase()] = c; });

  // ── FETCH INBOX (last 200 emails) ───────────────────────────────────────────
  console.log('Reading inbox…');
  let inboxEmails = [];
  let inboxUrl = `/me/mailFolders/inbox/messages?$top=100&$select=from,receivedDateTime,subject&$orderby=receivedDateTime desc`;
  while (inboxUrl && inboxEmails.length < 200) {
    const res = await graphGet(accessToken, inboxUrl.replace('/v1.0',''));
    if (!res.value) break;
    inboxEmails = inboxEmails.concat(res.value);
    inboxUrl = res['@odata.nextLink'] ? res['@odata.nextLink'].replace('https://graph.microsoft.com/v1.0','') : null;
  }
  console.log(`✓ ${inboxEmails.length} inbox emails`);

  // ── FETCH SENT ITEMS (last 200 emails) ─────────────────────────────────────
  console.log('Reading sent items…');
  let sentEmails = [];
  let sentUrl = `/me/mailFolders/sentItems/messages?$top=100&$select=toRecipients,sentDateTime,subject&$orderby=sentDateTime desc`;
  while (sentUrl && sentEmails.length < 200) {
    const res = await graphGet(accessToken, sentUrl.replace('/v1.0',''));
    if (!res.value) break;
    sentEmails = sentEmails.concat(res.value);
    sentUrl = res['@odata.nextLink'] ? res['@odata.nextLink'].replace('https://graph.microsoft.com/v1.0','') : null;
  }
  console.log(`✓ ${sentEmails.length} sent emails`);

  await context.close();

  // ── PROCESS & UPDATE ────────────────────────────────────────────────────────
  const updates = {}; // id → patch object

  const getUpdate = (c) => {
    if (!updates[c.id]) updates[c.id] = { id: c.id, _current: c };
    return updates[c.id];
  };

  // Process inbox → detect replies
  for (const mail of inboxEmails) {
    const senderEmail = mail.from?.emailAddress?.address?.toLowerCase();
    if (!senderEmail || !emailMap[senderEmail]) continue;
    const c = emailMap[senderEmail];
    const u = getUpdate(c);

    // Mark as replied
    u.reply_status = 'Replied';

    // Update last_contact_date if this email is newer
    const mailDate = mail.receivedDateTime?.slice(0, 10);
    if (mailDate && (!c.last_contact_date || mailDate > c.last_contact_date)) {
      if (!u._lastContactDate || mailDate > u._lastContactDate) {
        u._lastContactDate = mailDate;
        u.last_contact_date = mailDate;
      }
    }
  }

  // Process sent items → detect outreach + count follow-ups
  const sentDates = {}; // contactId → Set of dates
  for (const mail of sentEmails) {
    const recipients = mail.toRecipients || [];
    for (const r of recipients) {
      const recipEmail = r.emailAddress?.address?.toLowerCase();
      if (!recipEmail || !emailMap[recipEmail]) continue;
      const c = emailMap[recipEmail];
      const u = getUpdate(c);

      const sentDate = mail.sentDateTime?.slice(0, 10);
      if (!sentDate) continue;

      // Track unique sent dates per contact
      if (!sentDates[c.id]) sentDates[c.id] = new Set();
      sentDates[c.id].add(sentDate);

      // Set first_contact_date to earliest sent date
      if (!u._firstDate || sentDate < u._firstDate) {
        u._firstDate = sentDate;
        if (!c.first_contact_date || sentDate < c.first_contact_date) {
          u.first_contact_date = sentDate;
        }
      }
    }
  }

  // Set nb_follow_ups = count of unique dates we emailed them
  for (const [cId, dates] of Object.entries(sentDates)) {
    const u = updates[cId];
    if (u) u.nb_follow_ups = dates.size;
  }

  // Remove internal tracking fields
  const patches = Object.values(updates).map(u => {
    const { id, _current, _lastContactDate, _firstDate, ...patch } = u;
    return { id, patch };
  }).filter(({ patch }) => Object.keys(patch).length > 0);

  console.log(`\n📊 Updates to apply: ${patches.length} contacts`);

  if (!patches.length) {
    console.log('Nothing to update. Everything is up to date.');
    process.exit(0);
  }

  // Apply updates
  let updated = 0, errors = 0;
  for (const { id, patch } of patches) {
    const res = await sbFetch(`/rest/v1/contacts?id=eq.${id}`, 'PATCH', patch);
    if (Array.isArray(res) || (typeof res === 'object' && !res.error)) {
      updated++;
      const c = contacts.find(x => x.id === id);
      const name = c ? c.email : id;
      const changes = Object.keys(patch).join(', ');
      console.log(`  ✓ ${name} → ${changes}`);
    } else {
      errors++;
      console.error(`  ✗ ${id}:`, res);
    }
  }

  console.log('\n─'.repeat(40));
  console.log(`✅ Sync complete: ${updated} updated, ${errors} errors`);
  console.log('─'.repeat(40) + '\n');

})().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
