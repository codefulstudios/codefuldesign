import crypto from 'node:crypto';
const password=process.argv[2];
if(!password||password.length<12){console.error('Usage: node scripts/create-admin-hash.mjs "your-long-unique-password" (minimum 12 characters)');process.exit(1)}
const salt=crypto.randomBytes(32);
console.log(salt.toString('hex')+':'+crypto.scryptSync(password,salt,64).toString('hex'));
