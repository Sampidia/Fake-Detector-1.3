// Generate a secure CRON_SECRET_KEY for Vercel
// Run with: node generate-secret.js

const crypto = require('crypto');

// Generate a 32-byte random key and convert to hex
const secretKey = crypto.randomBytes(32).toString('hex');

console.log('\n🗝️  CRON_SECRET_KEY Generated:');
console.log('======================================');
console.log(secretKey);
console.log('======================================\n');

console.log('📝 Usage:');
console.log('1. Copy the key above');
console.log('2. Add to your .env.local file:');
console.log('   CRON_SECRET_KEY=' + secretKey);
console.log('3. Add to Vercel environment variables');
console.log('4. Delete this file for security\n');

console.log('✅ This key is cryptographically secure and unique.');
