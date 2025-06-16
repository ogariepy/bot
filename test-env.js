require('dotenv').config();

console.log('Testing environment variables:');
console.log('HELIUS_API_KEY:', process.env.HELIUS_API_KEY ? '✅ Set' : '❌ Not set');
console.log('TELEGRAM_BOT_TOKEN:', process.env.TELEGRAM_BOT_TOKEN ? '✅ Set' : '❌ Not set');
console.log('TELEGRAM_CHAT_ID:', process.env.TELEGRAM_CHAT_ID ? '✅ Set' : '❌ Not set');
console.log('TRADING_WALLET_PRIVATE_KEY:', process.env.TRADING_WALLET_PRIVATE_KEY ? '✅ Set' : '❌ Not set');