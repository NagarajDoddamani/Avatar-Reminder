const fs = require('node:fs');
const http = require('node:http');
const { URL } = require('node:url');
const { google } = require('googleapis');
const crypto = require('node:crypto');

/*
Google OAuth setup:
1. Create a Google Cloud project and enable Google Calendar API.
2. Configure OAuth consent screen / Google Auth Platform.
3. Create an OAuth Client ID with application type "Desktop app".
4. Save the downloaded JSON to the app's userData directory as google-credentials.json.
   It must contain { installed: { client_id, client_secret, redirect_uris } }.
5. For production, review Google's current OAuth policies and use a verified app where required.
*/
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events'
];

function createCalendarService({ app, db, safeStorage, credentialsPath }) {
  let oauthClient = null;
  let credentials = null;

  function loadClient() {
    if (!fs.existsSync(credentialsPath)) {
      throw new Error(`Google credentials not found. Add google-credentials.json at: ${credentialsPath}`);
    }
    const raw = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    credentials = raw.installed || raw.web;
    if (!credentials?.client_id || !credentials?.client_secret) {
      throw new Error('Credentials JSON is missing client_id or client_secret.');
    }
    oauthClient = new google.auth.OAuth2(
      credentials.client_id,
      credentials.client_secret,
      'http://127.0.0.1:43827/oauth2callback'
    );

    const tokenRow = db.prepare("SELECT value FROM app_settings WHERE key = 'google_tokens'").get();
    if (tokenRow) {
      try {
        const encrypted = Buffer.from(tokenRow.value, 'base64');
        const tokenJson = safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(encrypted)
          : encrypted.toString('utf8');
        oauthClient.setCredentials(JSON.parse(tokenJson));
      } catch (error) {
        console.error('Could not read stored Google token:', error.message);
      }
    }
    return oauthClient;
  }

  function saveTokens(tokens) {
    const current = oauthClient.credentials || {};
    const merged = { ...current, ...tokens };
    oauthClient.setCredentials(merged);
    const json = JSON.stringify(merged);
    const encrypted = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json)
      : Buffer.from(json, 'utf8');
    db.prepare(`
      INSERT INTO app_settings(key, value, updated_at) VALUES ('google_tokens', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(encrypted.toString('base64'), new Date().toISOString());
  }

  async function connect() {
    const client = loadClient();
    const state = crypto.randomBytes(18).toString('hex');
    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
      state
    });

    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          const callbackUrl = new URL(req.url, 'http://127.0.0.1:43827');
          if (callbackUrl.pathname !== '/oauth2callback') return;
          if (callbackUrl.searchParams.get('state') !== state) {
            res.writeHead(400); res.end('Invalid OAuth state.'); server.close();
            return reject(new Error('OAuth state validation failed.'));
          }
          const code = callbackUrl.searchParams.get('code');
          if (!code) {
            res.writeHead(400); res.end('Authorization code missing.'); server.close();
            return reject(new Error('Google authorization code was not returned.'));
          }
          const { tokens } = await client.getToken(code);
          saveTokens(tokens);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h2>Google Calendar connected.</h2><p>You can close this tab and return to Avatar Reminder.</p>');
          server.close(() => resolve({ connected: true }));
        } catch (error) {
          res.writeHead(500); res.end('Authorization failed. Return to the app and try again.');
          server.close();
          reject(error);
        }
      });

      server.on('error', reject);
      server.listen(43827, '127.0.0.1', async () => {
        await app.whenReady();
        const { shell } = require('electron');
        await shell.openExternal(authUrl);
      });
      setTimeout(() => server.close(), 180000).unref();
    });
  }

  function getAuthorizedClient() {
    if (!oauthClient) loadClient();
    if (!oauthClient.credentials?.refresh_token && !oauthClient.credentials?.access_token) {
      throw new Error('Google Calendar is not connected yet.');
    }
    return oauthClient;
  }

  async function listUpcoming() {
    const auth = getAuthorizedClient();
    const api = google.calendar({ version: 'v3', auth });
    const response = await api.events.list({
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      maxResults: 20,
      singleEvents: true,
      orderBy: 'startTime'
    });
    return (response.data.items || []).map(event => ({
      id: event.id,
      title: event.summary || '(Untitled event)',
      start: event.start?.dateTime || event.start?.date,
      end: event.end?.dateTime || event.end?.date
    }));
  }

  async function createEvent(task) {
    const auth = getAuthorizedClient();
    const api = google.calendar({ version: 'v3', auth });
    const start = new Date(task.due_at);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    const response = await api.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: task.title,
        description: task.message || 'Created from Avatar Reminder',
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() }
      }
    });
    return response.data;
  }

  function status() {
    try {
      if (!oauthClient) loadClient();
      return {
        credentialsConfigured: fs.existsSync(credentialsPath),
        connected: Boolean(oauthClient.credentials?.refresh_token || oauthClient.credentials?.access_token)
      };
    } catch {
      return { credentialsConfigured: false, connected: false };
    }
  }

  return { connect, listUpcoming, createEvent, status };
}

module.exports = { createCalendarService };
