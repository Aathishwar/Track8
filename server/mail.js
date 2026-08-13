/**
 * Track8 - sending the sign-in code
 *
 * Brevo's HTTP API rather than SMTP, and that is not a preference: Render
 * blocks outbound connections on ports 25, 465 and 587, so anything speaking
 * SMTP from inside the service hangs and times out. This is ordinary HTTPS on
 * 443, which is not blocked.
 *
 * Deliverability is the weakest link in the whole sign-in flow - a code that
 * lands in spam is a broken login. Hence the plain text part, the boring
 * subject line, and a consistent verified sender.
 */
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

const API_KEY = process.env.BREVO_API_KEY || '';
const FROM_EMAIL = process.env.MAIL_FROM_EMAIL || '';
const FROM_NAME = process.env.MAIL_FROM_NAME || 'Track8';

function configured() {
  return Boolean(API_KEY && FROM_EMAIL);
}

function body(code) {
  return {
    text:
      'Your Track8 sign-in code is ' + code + '\n\n' +
      'It expires in 10 minutes. If you did not ask for it, ignore this email.\n',
    html:
      '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#111">' +
      '<p>Your Track8 sign-in code is</p>' +
      '<p style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:30px;' +
      'font-weight:700;letter-spacing:5px;margin:18px 0">' + code + '</p>' +
      '<p style="color:#555">It expires in 10 minutes. If you did not ask for it, ignore this email.</p>' +
      '</div>'
  };
}

/**
 * Send one code. Resolves to a result rather than throwing, because a mail
 * failure must not take down the request - the caller reports it and the user
 * can ask for another.
 */
async function sendLoginCode(to, code) {
  if (!configured()) {
    // In local development without a key, printing the code is far more useful
    // than failing. Never reachable in production, where the key is required
    // before the endpoint is exposed at all.
    console.log(`[mail] not configured - sign-in code for ${to} is ${code}`);
    return { ok: true, simulated: true };
  }

  const parts = body(code);

  try {
    const response = await fetch(BREVO_URL, {
      method: 'POST',
      headers: {
        'api-key': API_KEY,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({
        sender: { email: FROM_EMAIL, name: FROM_NAME },
        to: [{ email: to }],
        subject: 'Track8 sign-in code: ' + code,
        textContent: parts.text,
        htmlContent: parts.html
      })
    });

    if (response.ok) return { ok: true };

    // Brevo explains refusals in the body, and the usual one is worth naming:
    // an unverified sender address.
    const detail = await response.text();
    console.error('[mail] brevo refused:', response.status, detail.slice(0, 300));
    return { ok: false, status: response.status };
  } catch (e) {
    console.error('[mail] send failed:', e.message);
    return { ok: false, status: 0 };
  }
}

module.exports = { sendLoginCode, configured };
