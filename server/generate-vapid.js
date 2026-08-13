/**
 * Print a fresh VAPID key pair.
 *
 * Run once, then put the two values into Render's environment variables. The
 * public key is handed to phones so they can subscribe; the private key signs
 * every push and must never reach the browser.
 *
 * Changing the pair later invalidates every existing subscription — phones
 * would silently stop receiving reminders until each one reopened the app and
 * re-subscribed. Generate once and keep them.
 *
 *   npm run keys
 */
const webpush = require('web-push');

const keys = webpush.generateVAPIDKeys();

console.log('\nAdd these to your Render service as environment variables:\n');
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
console.log('VAPID_SUBJECT=mailto:you@example.com   <- change to your address\n');
