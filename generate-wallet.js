const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

const keypair = Keypair.generate();
const privateKey = bs58.encode(keypair.secretKey);

console.log('\n🔑 YOUR NEW WALLET:\n');
console.log('Public Key:', keypair.publicKey.toString());
console.log('Private Key:', privateKey);
console.log('\n⚠️  This is YOUR wallet - keep the private key SECRET!');