require('dotenv').config();
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { 
    Connection, 
    Keypair, 
    PublicKey, 
    Transaction,
    VersionedTransaction 
} = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Define HELIUS_API_KEY before using it in CONFIG
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || 'db7b00c4-31e1-4ee9-91c9-116f0667cf4a';

// ====== CONFIGURATION ======
const CONFIG = {
    // Helius API configuration
    HELIUS_API_KEY: HELIUS_API_KEY,
    HELIUS_RPC_URL: 'https://mainnet.helius-rpc.com',
    HELIUS_WS_URL: `wss://rpc.helius.xyz/?api-key=${HELIUS_API_KEY}`,
    
    // Telegram configuration
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '7888155934:AAG29LYnSYxDBKGsKYAYYnLaGB1hrY4wCfs',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '5782411264',
    
    // Trading wallet configuration
    TRADING_WALLET_PRIVATE_KEY: process.env.TRADING_WALLET_PRIVATE_KEY || '',
    SLIPPAGE_BPS: 300, // 3% slippage
    
    // Jupiter API for swaps
    JUPITER_API_URL: 'https://quote-api.jup.ag/v6',
    
    // Wallets to monitor - MAKE SURE THESE ARE EXACT
    WALLETS_TO_MONITOR: [
        '4CqecFud362LKgALvChyhj6276he3Sy8yKim1uvFNV1m',
        'j1oxqtEHFn7rUkdABJLmtVtz5fFmHFs4tCG3fWJnkHX',
        '8pzBGC9KkyssMFuckrcZTN52rhMng5ikpqkmQNoKn45V',
        '7qbNi8QFrREPfz6iBzTQ483dPzTDeZj4bDpknvNvNs7x',
        'TonyuYKmxUzETE6QDAmsBFwb3C4qr1nD38G52UGTjta',
        'FSvK6sxyLje1A8V7pbXWyroqyFmN41j5oseDCBHjTXL4',
        'D8BuboNjz2m6ioCrrKuXVBAdAYkbLSKdeRvjdd5UhfvM',
        'sksdV4teo31iiivKrmggtP8EhW1DJonFg1uuPKL1Fi9'
    ],
    
    // Monitoring settings
    POLLING_INTERVAL_MS: 30000, // Check every 30 seconds
    MIN_TOKEN_VALUE_USD: 0.001,
    
    // Known token addresses
    WSOL_ADDRESS: 'So11111111111111111111111111111111111111112',
    USDC_ADDRESS: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    Jupiter_ADDRESS: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    
    // Copytrade settings
    COPYTRADE_ENABLED: true,
    COPYTRADE_AMOUNT_SOL: 0.001, // Always buy 0.001 SOL worth
};

// Trading limits for safety
const TRADING_LIMITS = {
    MAX_BUY_AMOUNT_SOL: 5,
    MIN_BUY_AMOUNT_SOL: 0.001,
    DAILY_LIMIT_SOL: 20,
    APPROVED_USERS: [CONFIG.TELEGRAM_CHAT_ID],
};

// ====== ADVANCED TRADING SETTINGS ======
const PROFIT_TARGETS = {
    10: { sell: 25, trailing: false },   // Sell 25% at 10% profit
    25: { sell: 25, trailing: true },    // Sell 25% at 25% profit, activate trailing
    50: { sell: 30, trailing: true },    // Sell 30% at 50% profit
    100: { sell: 20, trailing: true },   // Sell 20% at 100% profit (keep moonbag)
};

const RISK_MANAGEMENT = {
    maxPositionSize: 0.1,          // Max 10% of portfolio in one token
    maxDailyLoss: 0.2,            // Stop trading after 20% daily loss
    maxOpenPositions: 10,          // Maximum concurrent positions
    cooldownAfterLoss: 3600000,    // 1hr cooldown after big loss
    emergencyStopLoss: 0.5,        // Emergency sell at 50% loss
    trailingStopLossPercent: 10,   // Trail by 10%
};

const COPYTRADE_FILTERS = {
    enableFilters: true,            // Toggle smart filtering
    minLiquidity: 5000,            // $5k minimum liquidity (lower for testing)
    minHolders: 50,                // 50+ holders minimum
    maxWalletConcentration: 25,    // No wallet holds >25%
    minMarketCap: 10000,           // $10k minimum market cap
    maxSlippage: 10,               // Max 10% slippage allowed
    checkHoneypot: true,           // Check if token can be sold
    blacklistEnabled: true,        // Enable token blacklist
};

// ====== STATE MANAGEMENT ======
const walletTokenHoldings = {}; // Track tokens each wallet has held
const processedSignatures = new Set();
const walletNames = {
    '4CqecFud362LKgALvChyhj6276he3Sy8yKim1uvFNV1m': '4Cq Wallet',
    'j1oxqtEHFn7rUkdABJLmtVtz5fFmHFs4tCG3fWJnkHX': 'j1o Wallet',
    '8pzBGC9KkyssMFuckrcZTN52rhMng5ikpqkmQNoKn45V': '8pz Wallet',
    '7qbNi8QFrREPfz6iBzTQ483dPzTDeZj4bDpknvNvNs7x': '7qb Wallet',
    'TonyuYKmxUzETE6QDAmsBFwb3C4qr1nD38G52UGTjta': 'Tony Wallet',
    'FSvK6sxyLje1A8V7pbXWyroqyFmN41j5oseDCBHjTXL4': 'Fsv Wallet',
    'D8BuboNjz2m6ioCrrKuXVBAdAYkbLSKdeRvjdd5UhfvM': 'D8B Wallet',
    'sksdV4teo31iiivKrmggtP8EhW1DJonFg1uuPKL1Fi9': 'sks Wallet'
};
const dailyUsage = {};
let isMonitoring = false;
let botStartTime = null; // Track when bot started

// Price alerts management
const priceAlerts = {};
let priceCheckInterval = null;
let solPriceUSD = null; // Cache SOL price

// Trade tracking for P/L
const tradeHistory = {}; // { tokenMint: { trades: [], totalBought: 0, totalSold: 0, averageBuyPrice: 0 } }
const TRADES_FILE = path.join(__dirname, 'trades.json');

// Copytrade tracking
const copytradeEnabled = {}; // { walletAddress: boolean }
const processedCopytrades = new Set(); // Track already copied trades

// Advanced features state
const trailingStopLoss = {}; // { tokenMint: { enabled: true, highestPrice: X, stopPrice: Y } }
const blacklistedTokens = new Set(); // Tokens to never buy
const tokenAnalytics = {}; // { tokenMint: { volume24h, priceChange24h, holders, liquidity } }
let emergencyMode = false; // Emergency sell all positions
let tradingPaused = false; // Pause all automated trading
const dailyStats = { trades: 0, profit: 0, loss: 0, startBalance: 0 };

// Files for persistence
const BLACKLIST_FILE = path.join(__dirname, 'blacklist.json');
const ANALYTICS_FILE = path.join(__dirname, 'analytics.json');
const TRAILING_FILE = path.join(__dirname, 'trailing.json');

// Position tracking for smart features
let positionMonitorInterval = null;

// ====== INITIALIZE BOT AND CONNECTION ======
const bot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: true });
let connection;
let wallet;

// Initialize connection and wallet
function initializeTrading() {
    try {
        const rpcUrl = `${CONFIG.HELIUS_RPC_URL}/?api-key=${CONFIG.HELIUS_API_KEY}`;
        connection = new Connection(rpcUrl, {
            commitment: 'confirmed',
            confirmTransactionInitialTimeout: 60000
        });
        
        if (!CONFIG.TRADING_WALLET_PRIVATE_KEY || CONFIG.TRADING_WALLET_PRIVATE_KEY === '') {
            console.error('❌ TRADING_WALLET_PRIVATE_KEY not set!');
            return false;
        }
        
        try {
            const privateKeyBytes = bs58.decode(CONFIG.TRADING_WALLET_PRIVATE_KEY);
            wallet = Keypair.fromSecretKey(privateKeyBytes);
            console.log(`💰 Trading wallet loaded: ${wallet.publicKey.toString()}`);
            return true;
        } catch (decodeError) {
            console.error('❌ Failed to decode private key:', decodeError.message);
            return false;
        }
    } catch (error) {
        console.error('❌ Failed to initialize trading:', error);
        return false;
    }
}

// ====== MAIN MONITORING FUNCTION ======
async function monitorAllWallets() {
    if (!isMonitoring) return;
    
    console.log(`\n🔄 Checking all wallets at ${new Date().toLocaleTimeString()}...`);
    
    // Check daily loss limit
    if (dailyStats.loss > 0 && dailyStats.profit > 0) {
        const dailyPL = dailyStats.profit - dailyStats.loss;
        const dailyPLPercent = (dailyPL / dailyStats.startBalance) * 100;
        
        if (dailyPLPercent < -RISK_MANAGEMENT.maxDailyLoss * 100) {
            console.log(`🛑 Daily loss limit reached: ${dailyPLPercent.toFixed(2)}%`);
            tradingPaused = true;
            await sendTelegramMessage(
                `🛑 <b>TRADING PAUSED - DAILY LOSS LIMIT</b>\n\n` +
                `Daily P/L: ${dailyPL.toFixed(4)} SOL (${dailyPLPercent.toFixed(2)}%)\n` +
                `Limit: -${RISK_MANAGEMENT.maxDailyLoss * 100}%\n\n` +
                `Trading will resume tomorrow.`
            );
            return;
        }
    }
    
    for (const walletAddress of CONFIG.WALLETS_TO_MONITOR) {
        const walletName = walletNames[walletAddress] || shortenAddress(walletAddress);
        console.log(`👀 Checking ${walletName}: ${walletAddress}`);
        
        try {
            // Get recent signatures for this wallet
            const signatures = await connection.getSignaturesForAddress(
                new PublicKey(walletAddress),
                { limit: 30 }
            );
            
            console.log(`📝 Found ${signatures.length} recent transactions for ${walletName}`);
            
            // Process each signature
            let processedCount = 0;
            let receivedCount = 0;
            let sentCount = 0;
            
            for (const sigInfo of signatures) {
                if (processedSignatures.has(sigInfo.signature)) continue;
                
                // Skip transactions from before bot started
                if (botStartTime && sigInfo.blockTime && sigInfo.blockTime * 1000 < botStartTime) {
                    processedSignatures.add(sigInfo.signature);
                    continue;
                }
                
                try {
                    // Get parsed transaction
                    const tx = await connection.getParsedTransaction(sigInfo.signature, {
                        maxSupportedTransactionVersion: 0
                    });
                    
                    if (!tx || !tx.meta || tx.meta.err) continue;
                    
                    // Count transaction types before processing
                    const result = await analyzeTransaction(walletAddress, tx, sigInfo.signature);
                    if (result && result.types) {
                        result.types.forEach(type => {
                            if (type === 'received') receivedCount++;
                            else if (type === 'sent') sentCount++;
                        });
                    }
                    processedCount++;
                    
                } catch (txError) {
                    console.error(`Error processing tx ${sigInfo.signature.slice(0, 8)}...: ${txError.message}`);
                }
            }
            
            if (processedCount > 0) {
                console.log(`✅ Processed ${processedCount} transactions (${receivedCount} receives, ${sentCount} sends)`);
            }
            
        } catch (error) {
            console.error(`Error monitoring ${walletName}: ${error.message}`);
        }
        
        // Add a small delay between wallets to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Clean up old signatures
    if (processedSignatures.size > 10000) {
        const sigArray = Array.from(processedSignatures);
        sigArray.slice(0, 5000).forEach(sig => processedSignatures.delete(sig));
        console.log(`🧹 Cleaned up old signatures, kept ${processedSignatures.size}`);
    }
    
    console.log(`✅ Check complete. Next check in ${CONFIG.POLLING_INTERVAL_MS / 1000} seconds.\n`);
    
    // Schedule next check
    setTimeout(() => monitorAllWallets(), CONFIG.POLLING_INTERVAL_MS);
}

// Analyze transaction for token movements
async function analyzeTransaction(walletAddress, tx, signature) {
    if (processedSignatures.has(signature)) return null;
    
    const preBalances = tx.meta.preTokenBalances || [];
    const postBalances = tx.meta.postTokenBalances || [];
    
    // Debug log
    console.log(`\n🔍 Analyzing tx ${signature.slice(0, 8)}... for ${shortenAddress(walletAddress)}`);
    console.log(`   Pre-balances: ${preBalances.length}, Post-balances: ${postBalances.length}`);
    
    // Create a complete map of all balance changes in this transaction
    const allTokens = new Map();
    
    // First, add all tokens from pre-balances
    preBalances.forEach(balance => {
        if (balance.owner === walletAddress) {
            allTokens.set(balance.mint, {
                mint: balance.mint,
                pre: balance.uiTokenAmount.uiAmount || 0,
                post: 0,
                decimals: balance.uiTokenAmount.decimals
            });
        }
    });
    
    // Then update/add from post-balances
    postBalances.forEach(balance => {
        if (balance.owner === walletAddress) {
            if (allTokens.has(balance.mint)) {
                allTokens.get(balance.mint).post = balance.uiTokenAmount.uiAmount || 0;
            } else {
                allTokens.set(balance.mint, {
                    mint: balance.mint,
                    pre: 0,
                    post: balance.uiTokenAmount.uiAmount || 0,
                    decimals: balance.uiTokenAmount.decimals
                });
            }
        }
    });
    
    console.log(`   Found ${allTokens.size} tokens with balance changes`);
    
    // Now process each token that had any balance change
    let foundTransfer = false;
    let transactionTypes = [];
    
    for (const [mint, balances] of allTokens) {
        const change = balances.post - balances.pre;
        
        // Skip if no change
        if (change === 0) continue;
        
        // Skip tiny dust amounts
        if (Math.abs(change) < 0.000001) continue;
        
        // For WSOL, show all changes above 0.0001 SOL (~$0.01)
        if (mint === CONFIG.WSOL_ADDRESS && Math.abs(change) < 0.0001) continue;
        
        // For USDC, show all changes above $0.01
        if (mint === CONFIG.USDC_ADDRESS && Math.abs(change) < 0.01) continue;
        
        foundTransfer = true;
        
        // Get token info
        const tokenInfo = await getTokenInfo(mint);
        console.log(`💱 ${change > 0 ? 'RECEIVED' : 'SENT'}: ${Math.abs(change)} ${tokenInfo.symbol || shortenAddress(mint)}`);
        
        if (change > 0) {
            // Token received
            await handleTokenReceived(walletAddress, mint, change, signature, balances.pre === 0);
            transactionTypes.push('received');
            
            // Check for copytrade
            await handleCopytrade(walletAddress, mint, true);
        } else if (change < 0) {
            // Token sent/sold
            await handleTokenSent(walletAddress, mint, Math.abs(change), signature, balances.post === 0);
            transactionTypes.push('sent');
        }
    }
    
    // Mark as processed
    processedSignatures.add(signature);
    
    return foundTransfer ? { types: transactionTypes } : null;
}

// ====== NOTIFICATION HANDLERS ======
async function handleTokenReceived(walletAddress, tokenMint, amount, signature, isNewToken) {
    const tokenInfo = await getTokenInfo(tokenMint);
    const walletName = walletNames[walletAddress] || shortenAddress(walletAddress);
    
    const emoji = isNewToken ? '🟢' : '🔵';
    const action = isNewToken ? 'NEW TOKEN RECEIVED' : 'TOKEN RECEIVED';
    
    // Get token analytics for display
    const analytics = await getTokenAnalytics(tokenMint);
    
    const message = `${emoji} <b>${action}</b>

👛 Wallet: <b>${walletName}</b>
<code>${walletAddress}</code>
🪙 Token: <b>${tokenInfo.symbol}</b> ${tokenInfo.name !== 'Unknown Token' ? `(${tokenInfo.name})` : ''}
📊 Amount: +${formatNumber(amount)}
💧 Liquidity: ${formatNumber(analytics.liquidity)}
👥 Holders: ${analytics.holders}
🆔 Token: <a href="https://dexscreener.com/solana/${tokenMint}">${tokenMint}</a>
🔗 <a href="https://solscan.io/tx/${signature}">View Transaction</a>`;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: '💰 Buy 0.01 SOL', callback_data: `buy_0.01_${tokenMint}` },
                { text: '💰 Buy 0.02 SOL', callback_data: `buy_0.02_${tokenMint}` },
                { text: '💰 Buy 0.03 SOL', callback_data: `buy_0.03_${tokenMint}` },
            ],
            [
                { text: '💰 Buy 0.04 SOL', callback_data: `buy_0.04_${tokenMint}` },
                { text: '💰 Buy 0.05 SOL', callback_data: `buy_0.05_${tokenMint}` },
                { text: '💰 Buy 1 SOL', callback_data: `buy_1_${tokenMint}` },
            ],
            [
                { text: '📊 Price', callback_data: `price_${tokenMint}` },
                { text: '💼 Balance', callback_data: `balance_${tokenMint}` },
                { text: '📈 Chart', url: `https://dexscreener.com/solana/${tokenMint}` },
            ],
            [
                { text: '🛑 Set Stop Loss', callback_data: `set_stoploss_${tokenMint}` },
                { text: '🎯 Set Take Profit', callback_data: `set_takeprofit_${tokenMint}` },
            ],
            [
                { text: '🔗 Solscan', url: `https://solscan.io/tx/${signature}` },
                { text: '🦅 Birdeye', url: `https://birdeye.so/token/${tokenMint}` },
            ],
            [
                { text: '📊 P/L Report', callback_data: `pl_${tokenMint}` },
                { text: '🔄 Toggle Copytrade', callback_data: `copytrade_${walletAddress}` },
            ],
            [
                { text: '🚫 Blacklist Token', callback_data: `blacklist_${tokenMint}` },
                { text: '📊 Token Analytics', callback_data: `analytics_${tokenMint}` },
            ]
        ]
    };
    
    await sendTelegramMessage(message, { reply_markup: keyboard });
    console.log(`${emoji} ${action} detected: ${tokenInfo.symbol} by ${walletName}`);
}

async function handleTokenSent(walletAddress, tokenMint, amount, signature, isFullSell) {
    const tokenInfo = await getTokenInfo(tokenMint);
    const walletName = walletNames[walletAddress] || shortenAddress(walletAddress);
    
    const emoji = isFullSell ? '🔴' : '🟠';
    const action = isFullSell ? 'FULL SELL' : 'TOKEN SOLD';
    
    const message = `${emoji} <b>${action}</b>

👛 Wallet: <b>${walletName}</b>
<code>${walletAddress}</code>
🪙 Token: <b>${tokenInfo.symbol}</b> ${tokenInfo.name !== 'Unknown Token' ? `(${tokenInfo.name})` : ''}
📊 Amount: -${formatNumber(amount)}
🆔 Token: <a href="https://dexscreener.com/solana/${tokenMint}">${tokenMint}</a>
🔗 <a href="https://solscan.io/tx/${signature}">View Transaction</a>`;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: '💰 Buy 0.01 SOL', callback_data: `buy_0.01_${tokenMint}` },
                { text: '💰 Buy 0.05 SOL', callback_data: `buy_0.05_${tokenMint}` },
                { text: '💰 Buy 0.1 SOL', callback_data: `buy_0.1_${tokenMint}` },
            ], 
            [
                { text: '💸 Sell 25%', callback_data: `sell_25_${tokenMint}` },
                { text: '💸 Sell 50%', callback_data: `sell_50_${tokenMint}` },
                { text: '💸 Sell 100%', callback_data: `sell_100_${tokenMint}` },
            ],
            [
                { text: '📊 Price', callback_data: `price_${tokenMint}` },
                { text: '📈 Chart', url: `https://dexscreener.com/solana/${tokenMint}` },
                { text: '📊 P/L Report', callback_data: `pl_${tokenMint}` },
            ],
            [
                { text: '🛑 Set Stop Loss', callback_data: `set_stoploss_${tokenMint}` },
                { text: '🎯 Set Take Profit', callback_data: `set_takeprofit_${tokenMint}` },
            ],
            [
                { text: '🔗 Solscan', url: `https://solscan.io/tx/${signature}` },
                { text: '🦅 Birdeye', url: `https://birdeye.so/token/${tokenMint}` },
            ]
        ]
    };
    
    await sendTelegramMessage(message, { reply_markup: keyboard });
    console.log(`${emoji} ${action} detected: ${tokenInfo.symbol} by ${walletName}`);
}

// ====== PRICE FUNCTIONS ======
async function getSolPriceUSD() {
    try {
        // Get SOL price in USDC
        const quote = await getJupiterQuote(
            CONFIG.WSOL_ADDRESS,
            CONFIG.USDC_ADDRESS,
            1000000000, // 1 SOL
            50 // Low slippage for price check
        );
        
        const usdcReceived = quote.outAmount / 1e6; // USDC has 6 decimals
        solPriceUSD = usdcReceived;
        return usdcReceived;
    } catch (error) {
        console.log('Using cached SOL price');
        return solPriceUSD || 100; // Default fallback
    }
}

async function getTokenPrice(tokenMint) {
    try {
        // Try to get price via Jupiter quote (1 SOL worth)
        const quote = await getJupiterQuote(
            CONFIG.WSOL_ADDRESS,
            tokenMint,
            1000000000, // 1 SOL in lamports
            CONFIG.SLIPPAGE_BPS
        );
        
        // Calculate price per token in SOL
        const tokenInfo = await getTokenInfo(tokenMint);
        const tokensPerSol = quote.outAmount / Math.pow(10, tokenInfo.decimals);
        const pricePerToken = 1 / tokensPerSol;
        
        return pricePerToken;
    } catch (error) {
        // If Jupiter fails, try reverse quote
        try {
            const tokenInfo = await getTokenInfo(tokenMint);
            const amount = Math.pow(10, tokenInfo.decimals); // 1 token
            
            const reverseQuote = await getJupiterQuote(
                tokenMint,
                CONFIG.WSOL_ADDRESS,
                amount,
                CONFIG.SLIPPAGE_BPS
            );
            
            const solReceived = reverseQuote.outAmount / 1e9;
            return solReceived;
        } catch (reverseError) {
            console.error('Error getting token price:', reverseError.message);
            return null;
        }
    }
}

// ====== PRICE ALERT FUNCTIONS ======
async function checkPriceAlerts() {
    if (Object.keys(priceAlerts).length === 0) return;
    
    console.log(`\n💹 Checking price alerts at ${new Date().toLocaleTimeString()}...`);
    
    // Update SOL price first
    await getSolPriceUSD();
    
    for (const [tokenMint, alertData] of Object.entries(priceAlerts)) {
        try {
            const currentPrice = await getTokenPrice(tokenMint);
            
            if (currentPrice === null) {
                console.log(`⚠️ Could not get price for ${alertData.tokenInfo.symbol}`);
                continue;
            }
            
            const currentPriceUSD = currentPrice * solPriceUSD;
            
            console.log(`📊 ${alertData.tokenInfo.symbol}: ${currentPrice.toFixed(8)} SOL (${currentPriceUSD.toFixed(6)})`);
            
            // Check stop loss (for tokens we own)
            for (const alert of alertData.stopLoss) {
                if (!alert.triggered && currentPriceUSD <= alert.price) {
                    alert.triggered = true;
                    await sendStopLossAlert(tokenMint, alertData.tokenInfo, currentPrice, currentPriceUSD, alert.price);
                }
            }
            
            // Check take profit (for tokens we own)
            for (const alert of alertData.takeProfit) {
                if (!alert.triggered && currentPriceUSD >= alert.price) {
                    alert.triggered = true;
                    await sendTakeProfitAlert(tokenMint, alertData.tokenInfo, currentPrice, currentPriceUSD, alert.price);
                }
            }
            
            // Check above alerts
            for (const alert of alertData.above) {
                if (!alert.triggered && currentPriceUSD >= alert.price) {
                    alert.triggered = true;
                    await sendPriceAlert(tokenMint, alertData.tokenInfo, currentPrice, currentPriceUSD, alert.price, 'above');
                }
                // Reset trigger if price goes back down
                if (alert.triggered && currentPriceUSD < alert.price * 0.95) {
                    alert.triggered = false;
                }
            }
            
            // Check below alerts
            for (const alert of alertData.below) {
                if (!alert.triggered && currentPriceUSD <= alert.price) {
                    alert.triggered = true;
                    await sendPriceAlert(tokenMint, alertData.tokenInfo, currentPrice, currentPriceUSD, alert.price, 'below');
                }
                // Reset trigger if price goes back up
                if (alert.triggered && currentPriceUSD > alert.price * 1.05) {
                    alert.triggered = false;
                }
            }
            
            alertData.lastPrice = currentPrice;
            alertData.lastPriceUSD = currentPriceUSD;
            
        } catch (error) {
            console.error(`Error checking price for ${tokenMint}: ${error.message}`);
        }
    }
}

async function sendPriceAlert(tokenMint, tokenInfo, currentPrice, currentPriceUSD, targetPrice, direction) {
    const emoji = direction === 'above' ? '🚀' : '📉';
    const action = direction === 'above' ? 'ABOVE' : 'BELOW';
    
    const message = `${emoji} <b>PRICE ALERT - ${action} TARGET</b>

🪙 Token: <b>${tokenInfo.symbol}</b> ${tokenInfo.name !== 'Unknown Token' ? `(${tokenInfo.name})` : ''}

💰 <b>Current Price:</b>
• SOL: ${currentPrice.toFixed(8)}
• USD: ${currentPriceUSD.toFixed(6)}

🎯 <b>Target:</b> ${targetPrice.toFixed(6)}
📊 ${direction === 'above' ? 'Increased' : 'Decreased'} ${Math.abs(((currentPriceUSD - targetPrice) / targetPrice) * 100).toFixed(2)}%

🆔 Token: <a href="https://dexscreener.com/solana/${tokenMint}">${tokenMint}</a>`;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: '💰 Buy 0.1 SOL', callback_data: `buy_0.1_${tokenMint}` },
                { text: '💰 Buy 1 SOL', callback_data: `buy_1_${tokenMint}` },
            ],
            [
                { text: '💸 Sell 25%', callback_data: `sell_25_${tokenMint}` },
                { text: '💸 Sell 50%', callback_data: `sell_50_${tokenMint}` },
                { text: '💸 Sell 100%', callback_data: `sell_100_${tokenMint}` },
            ],
            [
                { text: '📊 Current Price', callback_data: `price_${tokenMint}` },
                { text: '📈 Chart', url: `https://dexscreener.com/solana/${tokenMint}` },
            ]
        ]
    };
    
    await sendTelegramMessage(message, { reply_markup: keyboard });
    console.log(`${emoji} Price alert triggered for ${tokenInfo.symbol}: ${action} ${targetPrice}`);
}

async function sendStopLossAlert(tokenMint, tokenInfo, currentPrice, currentPriceUSD, stopLossPrice) {
    const tokenBalance = await getTokenBalance(wallet.publicKey.toString(), tokenMint);
    
    const message = `🛑 <b>STOP LOSS TRIGGERED!</b>

🪙 Token: <b>${tokenInfo.symbol}</b>
💰 Current Price: ${currentPriceUSD.toFixed(6)} (${currentPrice.toFixed(8)} SOL)
🛑 Stop Loss: ${stopLossPrice.toFixed(6)}
📉 Loss: -${(((stopLossPrice - currentPriceUSD) / stopLossPrice) * 100).toFixed(2)}%
💼 Balance: ${formatNumber(tokenBalance)} ${tokenInfo.symbol}

⚠️ <b>Consider selling to minimize losses!</b>`;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: '🚨 SELL 50%', callback_data: `sell_50_${tokenMint}` },
                { text: '🚨 SELL 100%', callback_data: `sell_100_${tokenMint}` },
            ],
            [
                { text: '📊 Current Price', callback_data: `price_${tokenMint}` },
                { text: '📈 Chart', url: `https://dexscreener.com/solana/${tokenMint}` },
            ]
        ]
    };
    
    await sendTelegramMessage(message, { reply_markup: keyboard });
}

async function sendTakeProfitAlert(tokenMint, tokenInfo, currentPrice, currentPriceUSD, takeProfitPrice) {
    const tokenBalance = await getTokenBalance(wallet.publicKey.toString(), tokenMint);
    
    const message = `🎯 <b>TAKE PROFIT REACHED!</b>

🪙 Token: <b>${tokenInfo.symbol}</b>
💰 Current Price: ${currentPriceUSD.toFixed(6)} (${currentPrice.toFixed(8)} SOL)
🎯 Take Profit: ${takeProfitPrice.toFixed(6)}
📈 Profit: +${(((currentPriceUSD - takeProfitPrice) / takeProfitPrice) * 100).toFixed(2)}%
💼 Balance: ${formatNumber(tokenBalance)} ${tokenInfo.symbol}

💡 <b>Consider taking profits!</b>`;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: '💰 SELL 25%', callback_data: `sell_25_${tokenMint}` },
                { text: '💰 SELL 50%', callback_data: `sell_50_${tokenMint}` },
            ],
            [
                { text: '💰 SELL 75%', callback_data: `sell_75_${tokenMint}` },
                { text: '💰 SELL 100%', callback_data: `sell_100_${tokenMint}` },
            ],
            [
                { text: '📊 Current Price', callback_data: `price_${tokenMint}` },
                { text: '📈 Chart', url: `https://dexscreener.com/solana/${tokenMint}` },
            ]
        ]
    };
    
    await sendTelegramMessage(message, { reply_markup: keyboard });
}

async function addPriceAlert(tokenMint, targetPrice, direction) {
    // Initialize alert data if not exists
    if (!priceAlerts[tokenMint]) {
        const tokenInfo = await getTokenInfo(tokenMint);
        priceAlerts[tokenMint] = {
            above: [],
            below: [],
            stopLoss: [],
            takeProfit: [],
            lastPrice: null,
            lastPriceUSD: null,
            tokenInfo: tokenInfo
        };
    }
    
    // Add the alert
    const alert = {
        price: targetPrice,
        triggered: false,
        createdAt: Date.now()
    };
    
    if (direction === 'above') {
        priceAlerts[tokenMint].above.push(alert);
    } else if (direction === 'below') {
        priceAlerts[tokenMint].below.push(alert);
    } else if (direction === 'stoploss') {
        priceAlerts[tokenMint].stopLoss.push(alert);
    } else if (direction === 'takeprofit') {
        priceAlerts[tokenMint].takeProfit.push(alert);
    }
    
    // Start price checking if not already running
    if (!priceCheckInterval) {
        priceCheckInterval = setInterval(checkPriceAlerts, 60000); // Check every minute
    }
    
    return priceAlerts[tokenMint].tokenInfo;
}

function removePriceAlerts(tokenMint) {
    delete priceAlerts[tokenMint];
    
    // Stop price checking if no alerts left
    if (Object.keys(priceAlerts).length === 0 && priceCheckInterval) {
        clearInterval(priceCheckInterval);
        priceCheckInterval = null;
    }
}

// ====== TRADING FUNCTIONS ======
async function getTokenBalance(walletAddress, tokenMint) {
    try {
        const walletPubkey = new PublicKey(walletAddress);
        const mintPubkey = new PublicKey(tokenMint);
        
        if (tokenMint === CONFIG.WSOL_ADDRESS) {
            const balance = await connection.getBalance(walletPubkey);
            return balance / 1e9;
        }
        
        const response = await connection.getParsedTokenAccountsByOwner(
            walletPubkey,
            { mint: mintPubkey }
        );
        
        if (response.value.length === 0) return 0;
        
        const tokenAccount = response.value[0];
        return tokenAccount.account.data.parsed.info.tokenAmount.uiAmount;
    } catch (error) {
        console.error('Error getting token balance:', error);
        return 0;
    }
}

async function getJupiterQuote(inputMint, outputMint, amount, slippageBps = 300) {
    try {
        const params = new URLSearchParams({
            inputMint: inputMint,
            outputMint: outputMint,
            amount: amount.toString(),
            slippageBps: slippageBps.toString(),
            onlyDirectRoutes: 'false',
            asLegacyTransaction: 'false',
        });
        
        const response = await fetch(`${CONFIG.JUPITER_API_URL}/quote?${params}`);
        const quote = await response.json();
        
        if (!quote || quote.error) {
            throw new Error(quote?.error || 'Failed to get quote');
        }
        
        return quote;
    } catch (error) {
        console.error('Error getting Jupiter quote:', error);
        throw error;
    }
}

async function executeSwap(quoteResponse) {
    try {
        const swapResponse = await fetch(`${CONFIG.JUPITER_API_URL}/swap`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                quoteResponse,
                userPublicKey: wallet.publicKey.toString(),
                wrapAndUnwrapSol: true,
                asLegacyTransaction: false,
                priorityFee: 'auto'
            })
        });
        
        const swapData = await swapResponse.json();
        
        if (!swapData.swapTransaction) {
            throw new Error('Failed to get swap transaction');
        }
        
        const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        
        transaction.sign([wallet]);
        
        const rawTransaction = transaction.serialize();
        const txid = await connection.sendRawTransaction(rawTransaction, {
            skipPreflight: true,
            maxRetries: 3
        });
        
        const latestBlockHash = await connection.getLatestBlockhash();
        await connection.confirmTransaction({
            signature: txid,
            blockhash: latestBlockHash.blockhash,
            lastValidBlockHeight: latestBlockHash.lastValidBlockHeight
        }, 'confirmed');
        
        return txid;
    } catch (error) {
        console.error('Error executing swap:', error);
        throw error;
    }
}

async function buyToken(tokenMint, solAmount) {
    try {
        console.log(`🛒 Attempting to buy token ${tokenMint} with ${solAmount} SOL`);
        
        const amountInLamports = Math.floor(solAmount * 1e9);
        
        const quote = await getJupiterQuote(
            CONFIG.WSOL_ADDRESS,
            tokenMint,
            amountInLamports,
            CONFIG.SLIPPAGE_BPS
        );
        
        console.log(`💰 Quote received: ${quote.outAmount} tokens for ${solAmount} SOL`);
        
        const txid = await executeSwap(quote);
        
        console.log(`✅ Buy transaction successful: ${txid}`);
        
        // Record the trade
        const tokenInfo = await getTokenInfo(tokenMint);
        const tokenAmount = quote.outAmount / Math.pow(10, tokenInfo.decimals);
        recordTrade(tokenMint, 'buy', tokenAmount, solAmount, txid, tokenInfo);
        
        return { success: true, txid, amount: quote.outAmount };
        
    } catch (error) {
        console.error('❌ Buy transaction failed:', error);
        return { success: false, error: error.message };
    }
}

async function sellToken(tokenMint, amount = null, percentage = 100) {
    try {
        const tokenBalance = await getTokenBalance(wallet.publicKey.toString(), tokenMint);
        
        if (tokenBalance === 0) {
            return { success: false, error: 'No tokens to sell' };
        }
        
        const amountToSell = amount || (tokenBalance * percentage / 100);
        const tokenInfo = await getTokenInfo(tokenMint);
        const amountInSmallestUnit = Math.floor(amountToSell * Math.pow(10, tokenInfo.decimals));
        
        console.log(`🛒 Attempting to sell ${amountToSell} ${tokenInfo.symbol} (${percentage}%)`);
        
        const quote = await getJupiterQuote(
            tokenMint,
            CONFIG.WSOL_ADDRESS,
            amountInSmallestUnit,
            CONFIG.SLIPPAGE_BPS
        );
        
        const solReceived = quote.outAmount / 1e9;
        console.log(`💰 Quote received: ${solReceived} SOL for ${amountToSell} tokens`);
        
        const txid = await executeSwap(quote);
        
        console.log(`✅ Sell transaction successful: ${txid}`);
        
        // Record the trade
        recordTrade(tokenMint, 'sell', amountToSell, solReceived, txid);
        
        return { success: true, txid, tokensSold: amountToSell, solReceived };
        
    } catch (error) {
        console.error('❌ Sell transaction failed:', error);
        return { success: false, error: error.message };
    }
}

function canTrade(userId, amount) {
    if (!TRADING_LIMITS.APPROVED_USERS.includes(userId.toString())) {
        return { allowed: false, reason: 'Unauthorized user' };
    }
    
    if (amount > TRADING_LIMITS.MAX_BUY_AMOUNT_SOL) {
        return { allowed: false, reason: `Maximum trade size is ${TRADING_LIMITS.MAX_BUY_AMOUNT_SOL} SOL` };
    }
    
    if (amount < TRADING_LIMITS.MIN_BUY_AMOUNT_SOL) {
        return { allowed: false, reason: `Minimum trade size is ${TRADING_LIMITS.MIN_BUY_AMOUNT_SOL} SOL` };
    }
    
    const today = new Date().toDateString();
    if (!dailyUsage[today]) dailyUsage[today] = {};
    if (!dailyUsage[today][userId]) dailyUsage[today][userId] = 0;
    
    if (dailyUsage[today][userId] + amount > TRADING_LIMITS.DAILY_LIMIT_SOL) {
        return { allowed: false, reason: `Daily limit exceeded. Used: ${dailyUsage[today][userId]} SOL` };
    }
    
    return { allowed: true };
}

// ====== TELEGRAM BOT HANDLERS ======
bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id;
    
    try {
        // Handle blacklist token
        if (data.startsWith('blacklist_')) {
            const tokenMint = data.replace('blacklist_', '');
            const tokenInfo = await getTokenInfo(tokenMint);
            
            blacklistedTokens.add(tokenMint);
            saveBlacklist();
            
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: `${tokenInfo.symbol} blacklisted!`
            });
            
            await bot.sendMessage(chatId, 
                `🚫 <b>Token Blacklisted</b>\n\n` +
                `Token: ${tokenInfo.symbol}\n` +
                `This token will be ignored in all future copytrades.`,
                { parse_mode: 'HTML' }
            );
            return;
        }
        
        // Handle token analytics
        if (data.startsWith('analytics_')) {
            const tokenMint = data.replace('analytics_', '');
            const analytics = await getTokenAnalytics(tokenMint);
            const tokenInfo = await getTokenInfo(tokenMint);
            
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: 'Loading analytics...'
            });
            
            const message = `📊 <b>Token Analytics - ${tokenInfo.symbol}</b>\n\n` +
                `💧 Liquidity: ${formatNumber(analytics.liquidity)}\n` +
                `📈 Market Cap: ${formatNumber(analytics.marketCap)}\n` +
                `👥 Holders: ${analytics.holders}\n` +
                `📊 24h Volume: ${formatNumber(analytics.volume24h)}\n` +
                `📉 24h Change: ${analytics.priceChange24h}%\n\n` +
                `<i>Note: These are estimated values</i>`;
            
            await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
            return;
        }
        
        // Handle emergency stop
        if (data === 'emergency_stop') {
            emergencyMode = true;
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: 'EMERGENCY STOP ACTIVATED!'
            });
            
            await bot.sendMessage(chatId,
                `🚨 <b>EMERGENCY MODE ACTIVATED</b>\n\n` +
                `All automated trading is now STOPPED.\n` +
                `Selling all positions...\n\n` +
                `Please wait...`,
                { parse_mode: 'HTML' }
            );
            
            // Sell all positions
            for (const tokenMint of Object.keys(tradeHistory)) {
                const position = tradeHistory[tokenMint];
                if (position.totalBought > position.totalSold) {
                    const balance = await getTokenBalance(wallet.publicKey.toString(), tokenMint);
                    if (balance > 0) {
                        await sellToken(tokenMint, null, 100);
                    }
                }
            }
            
            emergencyMode = false;
            await bot.sendMessage(chatId, `✅ All positions closed. Bot is now in safe mode.`);
            return;
        }
        
        // Handle pause/resume trading
        if (data === 'pause_trading') {
            tradingPaused = !tradingPaused;
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: tradingPaused ? 'Trading paused' : 'Trading resumed'
            });
            
            await bot.sendMessage(chatId,
                tradingPaused ? 
                `⏸️ <b>Trading Paused</b>\n\nAutomated trading and copytrading disabled.` :
                `▶️ <b>Trading Resumed</b>\n\nAutomated trading and copytrading enabled.`,
                { parse_mode: 'HTML' }
            );
            return;
        }
        
        // Handle P/L report
        if (data.startsWith('pl_')) {
            const tokenMint = data.replace('pl_', '');
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: 'Calculating P/L...'
            });
            
            const pl = await calculateProfitLoss(tokenMint);
            const tokenInfo = await getTokenInfo(tokenMint);
            
            if (!pl) {
                await bot.sendMessage(chatId, `❌ No trading history found for ${tokenInfo.symbol}`);
                return;
            }
            
            const plEmoji = pl.totalPL >= 0 ? '📈' : '📉';
            const plPercentage = pl.totalInvested > 0 ? 
                ((pl.totalPL / pl.totalInvested) * 100).toFixed(2) : 0;
            
            const message = `${plEmoji} <b>P/L Report - ${tokenInfo.symbol}</b>\n\n` +
                `<b>📊 Summary:</b>\n` +
                `• Total P/L: ${pl.totalPL >= 0 ? '+' : ''}${pl.totalPL.toFixed(4)} SOL (${plPercentage}%)\n` +
                `• Realized P/L: ${pl.realizedPL >= 0 ? '+' : ''}${pl.realizedPL.toFixed(4)} SOL\n` +
                `• Unrealized P/L: ${pl.unrealizedPL >= 0 ? '+' : ''}${pl.unrealizedPL.toFixed(4)} SOL\n\n` +
                `<b>💰 Investment:</b>\n` +
                `• Total Invested: ${pl.totalInvested.toFixed(4)} SOL\n` +
                `• Total Realized: ${pl.totalRealized.toFixed(4)} SOL\n` +
                `• Current Value: ${pl.unrealizedValue.toFixed(4)} SOL\n\n` +
                `<b>📈 Trading Stats:</b>\n` +
                `• Avg Buy Price: ${pl.averageBuyPrice.toFixed(8)} SOL\n` +
                `• Current Price: ${pl.currentPrice.toFixed(8)} SOL\n` +
                `• Total Bought: ${formatNumber(pl.totalBought)} tokens\n` +
                `• Total Sold: ${formatNumber(pl.totalSold)} tokens\n` +
                `• Current Balance: ${formatNumber(pl.currentBalance)} tokens`;
            
            await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
            return;
        }
        
        // Handle copytrade toggle
        if (data.startsWith('copytrade_')) {
            const walletAddress = data.replace('copytrade_', '');
            copytradeEnabled[walletAddress] = !copytradeEnabled[walletAddress];
            
            const walletName = walletNames[walletAddress] || shortenAddress(walletAddress);
            const status = copytradeEnabled[walletAddress] ? 'ENABLED' : 'DISABLED';
            const emoji = copytradeEnabled[walletAddress] ? '✅' : '❌';
            
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: `Copytrade ${status} for ${walletName}`
            });
            
            await bot.sendMessage(chatId, 
                `${emoji} <b>Copytrade ${status}</b>\n\n` +
                `Wallet: <b>${walletName}</b>\n` +
                `Amount per trade: ${CONFIG.COPYTRADE_AMOUNT_SOL} SOL\n` +
                `Filters: ${COPYTRADE_FILTERS.enableFilters ? 'Enabled' : 'Disabled'}\n\n` +
                `${copytradeEnabled[walletAddress] ? 
                    '✅ You will now copy buy trades from this wallet' : 
                    '❌ You will no longer copy trades from this wallet'}`,
                { parse_mode: 'HTML' }
            );
            return;
        }
        
        // Handle set stop loss
        if (data.startsWith('set_stoploss_')) {
            const tokenMint = data.replace('set_stoploss_', '');
            
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: 'Send stop loss price in USD. Example: 0.0025'
            });
            
            // Get current price for reference
            await getSolPriceUSD();
            const currentPrice = await getTokenPrice(tokenMint);
            const currentPriceUSD = currentPrice ? currentPrice * solPriceUSD : 0;
            const tokenInfo = await getTokenInfo(tokenMint);
            
            await bot.sendMessage(chatId,
                `🛑 <b>Set Stop Loss for ${tokenInfo.symbol}</b>\n\n` +
                `Current Price: ${currentPriceUSD.toFixed(6)}\n` +
                `Suggested Stop Loss: ${(currentPriceUSD * 0.8).toFixed(6)} (-20%)\n\n` +
                `Reply with your stop loss price in USD.\n` +
                `Example: <code>0.0025</code>`,
                { parse_mode: 'HTML' }
            );
            
            // Store context for next message
            bot.once('message', async (msg) => {
                if (msg.chat.id === chatId) {
                    const price = parseFloat(msg.text);
                    if (!isNaN(price) && price > 0) {
                        await addPriceAlert(tokenMint, price, 'stoploss');
                        await bot.sendMessage(chatId, `✅ Stop loss set at ${price.toFixed(6)}`);
                        checkPriceAlerts();
                    } else {
                        await bot.sendMessage(chatId, '❌ Invalid price. Please use a positive number.');
                    }
                }
            });
            return;
        }
        
        // Handle set take profit
        if (data.startsWith('set_takeprofit_')) {
            const tokenMint = data.replace('set_takeprofit_', '');
            
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: 'Send take profit price in USD. Example: 0.01'
            });
            
            // Get current price for reference
            await getSolPriceUSD();
            const currentPrice = await getTokenPrice(tokenMint);
            const currentPriceUSD = currentPrice ? currentPrice * solPriceUSD : 0;
            const tokenInfo = await getTokenInfo(tokenMint);
            
            await bot.sendMessage(chatId,
                `🎯 <b>Set Take Profit for ${tokenInfo.symbol}</b>\n\n` +
                `Current Price: ${currentPriceUSD.toFixed(6)}\n` +
                `Suggested Take Profit: ${(currentPriceUSD * 1.5).toFixed(6)} (+50%)\n\n` +
                `Reply with your take profit price in USD.\n` +
                `Example: <code>0.01</code>`,
                { parse_mode: 'HTML' }
            );
            
            // Store context for next message
            bot.once('message', async (msg) => {
                if (msg.chat.id === chatId) {
                    const price = parseFloat(msg.text);
                    if (!isNaN(price) && price > 0) {
                        await addPriceAlert(tokenMint, price, 'takeprofit');
                        await bot.sendMessage(chatId, `✅ Take profit set at ${price.toFixed(6)}`);
                        checkPriceAlerts();
                    } else {
                        await bot.sendMessage(chatId, '❌ Invalid price. Please use a positive number.');
                    }
                }
            });
            return;
        }
        
        const parts = data.split('_');
        const action = parts[0];
        
        if (action === 'buy') {
            const amount = parseFloat(parts[1]);
            const tokenMint = parts.slice(2).join('_');
            
            const tradeCheck = canTrade(userId, amount);
            if (!tradeCheck.allowed) {
                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: tradeCheck.reason,
                    show_alert: true
                });
                return;
            }
            
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: `Processing buy order for ${amount} SOL...`
            });
            
            const walletBalance = await getTokenBalance(wallet.publicKey.toString(), CONFIG.WSOL_ADDRESS);
            
            if (walletBalance < amount + 0.01) {
                await bot.sendMessage(chatId, 
                    `❌ Insufficient balance!\n\nWallet has ${walletBalance.toFixed(4)} SOL\nNeeded: ${(amount + 0.01).toFixed(4)} SOL (including fees)`,
                    { parse_mode: 'HTML' }
                );
                return;
            }
            
            const result = await buyToken(tokenMint, amount);
            
            if (result.success) {
                const today = new Date().toDateString();
                if (!dailyUsage[today]) dailyUsage[today] = {};
                if (!dailyUsage[today][userId]) dailyUsage[today][userId] = 0;
                dailyUsage[today][userId] += amount;
                
                await bot.sendMessage(chatId, 
                    `✅ <b>Buy Successful!</b>\n\n` +
                    `💰 Spent: ${amount} SOL\n` +
                    `🪙 Received: ${formatNumber(result.amount)} tokens\n` +
                    `🎯 Auto profit targets set: 10%, 25%, 50%, 100%\n` +
                    `🔗 <a href="https://solscan.io/tx/${result.txid}">View Transaction</a>`,
                    { parse_mode: 'HTML', disable_web_page_preview: true }
                );
            } else {
                await bot.sendMessage(chatId, 
                    `❌ <b>Buy Failed!</b>\n\nError: ${result.error}`,
                    { parse_mode: 'HTML' }
                );
            }
            
        } else if (action === 'sell') {
            const percentage = parseInt(parts[1]);
            const tokenMint = parts.slice(2).join('_');
            
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: `Processing sell order...`
            });
            
            const result = await sellToken(tokenMint, null, percentage);
            
            if (result.success) {
                const tokenInfo = await getTokenInfo(tokenMint);
                await bot.sendMessage(chatId, 
                    `✅ <b>Sell Successful!</b>\n\n` +
                    `🪙 Sold: ${formatNumber(result.tokensSold)} ${tokenInfo.symbol}\n` +
                    `💰 Received: ${result.solReceived.toFixed(4)} SOL\n` +
                    `🔗 <a href="https://solscan.io/tx/${result.txid}">View Transaction</a>`,
                    { parse_mode: 'HTML', disable_web_page_preview: true }
                );
            } else {
                await bot.sendMessage(chatId, 
                    `❌ <b>Sell Failed!</b>\n\nError: ${result.error}`,
                    { parse_mode: 'HTML' }
                );
            }
            
        } else if (action === 'balance') {
            const tokenMint = parts.slice(1).join('_');
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'Checking balance...' });
            
            const tokenBalance = await getTokenBalance(wallet.publicKey.toString(), tokenMint);
            const solBalance = await getTokenBalance(wallet.publicKey.toString(), CONFIG.WSOL_ADDRESS);
            const tokenInfo = await getTokenInfo(tokenMint);
            
            await bot.sendMessage(chatId,
                `💼 <b>Wallet Balance</b>\n\n` +
                `🪙 ${tokenInfo.symbol}: ${formatNumber(tokenBalance)}\n` +
                `💰 SOL: ${solBalance.toFixed(4)}\n` +
                `👛 Wallet: <code>${wallet.publicKey.toString()}</code>`,
                { parse_mode: 'HTML' }
            );
            
        } else if (action === 'price') {
            const tokenMint = parts.slice(1).join('_');
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'Fetching price...' });
            
            try {
                await getSolPriceUSD();
                const currentPrice = await getTokenPrice(tokenMint);
                
                if (currentPrice) {
                    const currentPriceUSD = currentPrice * solPriceUSD;
                    const tokenInfo = await getTokenInfo(tokenMint);
                    
                    // Check if user has this token
                    const tokenBalance = await getTokenBalance(wallet.publicKey.toString(), tokenMint);
                    
                    let message = `📊 <b>Token Price</b>\n\n` +
                        `🪙 Token: ${tokenInfo.symbol}\n` +
                        `💰 <b>Price:</b>\n` +
                        `• SOL: ${currentPrice.toFixed(8)}\n` +
                        `• USD: ${currentPriceUSD.toFixed(6)}\n\n` +
                        `📈 SOL/USD: ${solPriceUSD.toFixed(2)}`;
                    
                    if (tokenBalance > 0) {
                        const valueInSOL = tokenBalance * currentPrice;
                        const valueInUSD = valueInSOL * solPriceUSD;
                        message += `\n\n💼 <b>Your Holdings:</b>\n` +
                            `• Amount: ${formatNumber(tokenBalance)} ${tokenInfo.symbol}\n` +
                            `• Value: ${valueInSOL.toFixed(4)} SOL (${valueInUSD.toFixed(2)})`;
                    }
                    
                    const keyboard = {
                        inline_keyboard: [
                            [
                                { text: '🛑 Set Stop Loss', callback_data: `set_stoploss_${tokenMint}` },
                                { text: '🎯 Set Take Profit', callback_data: `set_takeprofit_${tokenMint}` },
                            ],
                            [
                                { text: '📈 Chart', url: `https://dexscreener.com/solana/${tokenMint}` },
                                { text: '🔄 Refresh', callback_data: `price_${tokenMint}` }
                            ]
                        ]
                    };
                    
                    await bot.sendMessage(chatId, message, { 
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    });
                } else {
                    await bot.sendMessage(chatId, '❌ Could not fetch price. Token might have low liquidity.');
                }
            } catch (error) {
                await bot.sendMessage(chatId, '❌ Error fetching price.');
            }
        }
        
    } catch (error) {
        console.error('Error handling callback:', error);
        await bot.answerCallbackQuery(callbackQuery.id, {
            text: 'Error processing request',
            show_alert: true
        });
    }
});

// ====== BOT COMMANDS ======
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    // Get summary data
    const tokenCount = Object.keys(tradeHistory).length;
    const alertCount = Object.keys(priceAlerts).length;
    const solBalance = wallet ? await getTokenBalance(wallet.publicKey.toString(), CONFIG.WSOL_ADDRESS) : 0;
    
    // Calculate total P/L
    let totalPL = 0;
    for (const tokenMint of Object.keys(tradeHistory)) {
        const pl = await calculateProfitLoss(tokenMint);
        if (pl) totalPL += pl.totalPL;
    }
    
    // Get copytrade status
    const copytradeCount = Object.values(copytradeEnabled).filter(v => v).length;
    
    const message = `🚀 <b>Advanced Crypto Trading Bot</b>\n\n` +
        `📊 <b>Portfolio Summary:</b>\n` +
        `• Wallet Balance: ${solBalance.toFixed(4)} SOL\n` +
        `• Active Positions: ${tokenCount}\n` +
        `• Total P/L: ${totalPL >= 0 ? '+' : ''}${totalPL.toFixed(4)} SOL\n` +
        `• Price Alerts: ${alertCount}\n` +
        `• Copytrade Active: ${copytradeCount} wallets\n` +
        `• Smart Filters: ${COPYTRADE_FILTERS.enableFilters ? '✅' : '❌'}\n` +
        `• Auto Profit Targets: ✅\n` +
        `• Trailing Stop Loss: ✅\n\n` +
        `🔧 <b>Bot Status:</b>\n` +
        `• Monitoring: ${isMonitoring ? '✅ Active' : '❌ Stopped'}\n` +
        `• Trading: ${tradingPaused ? '⏸️ Paused' : '✅ Active'}\n` +
        `• Wallets Tracked: ${CONFIG.WALLETS_TO_MONITOR.length}\n\n` +
        `📚 <b>Commands:</b>\n` +
        `/portfolio - View all your tokens\n` +
        `/pl - View P/L for all positions\n` +
        `/alerts - View active price alerts\n` +
        `/copytrade - Manage copytrade settings\n` +
        `/filters - Configure safety filters\n` +
        `/blacklist - Manage blacklisted tokens\n` +
        `/stats - View trading statistics\n` +
        `/wallet - Show trading wallet\n` +
        `/help - Show all commands`;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: '💼 Portfolio', callback_data: 'cmd_portfolio' },
                { text: '📊 P/L Report', callback_data: 'cmd_pl' },
            ],
            [
                { text: '💹 Price Alerts', callback_data: 'cmd_alerts' },
                { text: '🔄 Copytrade', callback_data: 'cmd_copytrade' },
            ],
            [
                { text: tradingPaused ? '▶️ Resume Trading' : '⏸️ Pause Trading', callback_data: 'pause_trading' },
                { text: '🚨 Emergency Stop', callback_data: 'emergency_stop' },
            ],
            [
                { text: '🔄 Refresh', callback_data: 'cmd_start' }
            ]
        ]
    };
    
    await bot.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

bot.onText(/\/help/, async (msg) => {
    const message = `📚 <b>Bot Commands & Features</b>\n\n` +
        `<b>🎯 Smart Features:</b>\n` +
        `• Auto Profit Targets: 10%, 25%, 50%, 100%\n` +
        `• Trailing Stop Loss: Follows price up\n` +
        `• Smart Copytrade Filters: Min liquidity/holders\n` +
        `• Emergency Stop Loss: -50% protection\n` +
        `• Daily Loss Limit: -20% max\n\n` +
        `<b>📱 Commands:</b>\n` +
        `/start - Main dashboard\n` +
        `/portfolio - View all tokens & balances\n` +
        `/pl - Profit/Loss report\n` +
        `/copytrade - Enable/disable wallet copying\n` +
        `/filters - Configure trade filters\n` +
        `/blacklist - View/manage blacklist\n` +
        `/stats - Trading statistics\n` +
        `/alert [token] [above/below] [price] - Set alerts\n` +
        `/alerts - View all price alerts\n` +
        `/wallet - Trading wallet info\n\n` +
        `<b>🛡️ Risk Management:</b>\n` +
        `• Max positions: ${RISK_MANAGEMENT.maxOpenPositions}\n` +
        `• Max daily loss: ${RISK_MANAGEMENT.maxDailyLoss * 100}%\n` +
        `• Copytrade amount: ${CONFIG.COPYTRADE_AMOUNT_SOL} SOL\n` +
        `• Min liquidity: ${COPYTRADE_FILTERS.minLiquidity}`;
    
    await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
});

bot.onText(/\/filters/, async (msg) => {
    const message = `🛡️ <b>Copytrade Safety Filters</b>\n\n` +
        `Status: ${COPYTRADE_FILTERS.enableFilters ? '✅ Enabled' : '❌ Disabled'}\n\n` +
        `<b>Current Settings:</b>\n` +
        `• Min Liquidity: ${COPYTRADE_FILTERS.minLiquidity}\n` +
        `• Min Holders: ${COPYTRADE_FILTERS.minHolders}\n` +
        `• Min Market Cap: ${COPYTRADE_FILTERS.minMarketCap}\n` +
        `• Max Slippage: ${COPYTRADE_FILTERS.maxSlippage}%\n` +
        `• Max Wallet Concentration: ${COPYTRADE_FILTERS.maxWalletConcentration}%\n` +
        `• Blacklist Check: ${COPYTRADE_FILTERS.blacklistEnabled ? '✅' : '❌'}\n\n` +
        `<i>These filters help protect against rugpulls and scams</i>`;
    
    await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
});

bot.onText(/\/blacklist/, async (msg) => {
    const count = blacklistedTokens.size;
    
    if (count === 0) {
        await bot.sendMessage(msg.chat.id, 
            `🚫 <b>Token Blacklist</b>\n\n` +
            `No tokens blacklisted yet.\n\n` +
            `Blacklisted tokens are automatically ignored in copytrades.`,
            { parse_mode: 'HTML' }
        );
        return;
    }
    
    let message = `🚫 <b>Token Blacklist (${count} tokens)</b>\n\n`;
    
    let index = 1;
    for (const tokenMint of blacklistedTokens) {
        const tokenInfo = await getTokenInfo(tokenMint);
        message += `${index}. ${tokenInfo.symbol} - ${shortenAddress(tokenMint)}\n`;
        index++;
        if (index > 20) {
            message += `\n... and ${count - 20} more`;
            break;
        }
    }
    
    await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
});

bot.onText(/\/stats/, async (msg) => {
    const totalTrades = dailyStats.trades;
    const winRate = dailyStats.trades > 0 ? 
        ((dailyStats.profit / (dailyStats.profit + dailyStats.loss)) * 100).toFixed(2) : 0;
    
    const activePositions = Object.keys(tradeHistory).filter(
        mint => tradeHistory[mint].totalBought > tradeHistory[mint].totalSold
    ).length;
    
    const message = `📊 <b>Trading Statistics</b>\n\n` +
        `<b>Today's Performance:</b>\n` +
        `• Trades: ${totalTrades}\n` +
        `• Profit: ${dailyStats.profit.toFixed(4)} SOL\n` +
        `• Loss: ${dailyStats.loss.toFixed(4)} SOL\n` +
        `• Net P/L: ${(dailyStats.profit - dailyStats.loss).toFixed(4)} SOL\n` +
        `• Win Rate: ${winRate}%\n\n` +
        `<b>Overall Stats:</b>\n` +
        `• Active Positions: ${activePositions}\n` +
        `• Total Positions: ${Object.keys(tradeHistory).length}\n` +
        `• Blacklisted Tokens: ${blacklistedTokens.size}\n` +
        `• Price Alerts: ${Object.keys(priceAlerts).length}`;
    
    await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
});

bot.onText(/\/pl/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (Object.keys(tradeHistory).length === 0) {
        await bot.sendMessage(chatId, 
            `📊 <b>No Trading History</b>\n\n` +
            `Start trading to see your profit/loss report!`,
            { parse_mode: 'HTML' }
        );
        return;
    }
    
    let totalPL = 0;
    let totalInvested = 0;
    let totalRealized = 0;
    let message = `📊 <b>Overall P/L Report</b>\n\n`;
    
    for (const [tokenMint, history] of Object.entries(tradeHistory)) {
        const tokenInfo = await getTokenInfo(tokenMint);
        const pl = await calculateProfitLoss(tokenMint);
        
        if (pl) {
            totalPL += pl.totalPL;
            totalInvested += pl.totalInvested;
            totalRealized += pl.totalRealized;
            
            const plEmoji = pl.totalPL >= 0 ? '📈' : '📉';
            const plPercentage = pl.totalInvested > 0 ? 
                ((pl.totalPL / pl.totalInvested) * 100).toFixed(2) : 0;
            
            message += `${plEmoji} <b>${tokenInfo.symbol || history.symbol}</b>\n`;
            message += `• P/L: ${pl.totalPL >= 0 ? '+' : ''}${pl.totalPL.toFixed(4)} SOL (${plPercentage}%)\n`;
            message += `• Balance: ${formatNumber(pl.currentBalance)} tokens\n\n`;
        }
    }
    
    const overallPercentage = totalInvested > 0 ? 
        ((totalPL / totalInvested) * 100).toFixed(2) : 0;
    
    message = `📊 <b>Overall P/L Summary</b>\n\n` +
        `💰 <b>Total P/L: ${totalPL >= 0 ? '+' : ''}${totalPL.toFixed(4)} SOL (${overallPercentage}%)</b>\n` +
        `• Total Invested: ${totalInvested.toFixed(4)} SOL\n` +
        `• Total Realized: ${totalRealized.toFixed(4)} SOL\n\n` +
        message;
    
    await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
});

bot.onText(/\/copytrade/, async (msg) => {
    const chatId = msg.chat.id;
    
    let message = `🔄 <b>Copytrade Settings</b>\n\n`;
    message += `Amount per trade: ${CONFIG.COPYTRADE_AMOUNT_SOL} SOL\n`;
    message += `Smart Filters: ${COPYTRADE_FILTERS.enableFilters ? '✅ Enabled' : '❌ Disabled'}\n\n`;
    
    const keyboard = {
        inline_keyboard: []
    };
    
    for (const [walletAddress, walletName] of Object.entries(walletNames)) {
        const isEnabled = copytradeEnabled[walletAddress] || false;
        const status = isEnabled ? '✅' : '❌';
        
        keyboard.inline_keyboard.push([{
            text: `${status} ${walletName}`,
            callback_data: `copytrade_${walletAddress}`
        }]);
    }
    
    message += `Click on a wallet to toggle copytrade:\n`;
    message += `✅ = Copytrade enabled\n`;
    message += `❌ = Copytrade disabled\n\n`;
    message += `<i>When enabled, the bot will automatically buy ${CONFIG.COPYTRADE_AMOUNT_SOL} SOL worth of any token the wallet buys (if it passes safety filters).</i>`;
    
    await bot.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

bot.onText(/\/portfolio/, async (msg) => {
    if (!wallet) {
        await bot.sendMessage(msg.chat.id, '❌ No trading wallet configured');
        return;
    }
    
    await bot.sendMessage(msg.chat.id, '🔄 Loading portfolio...');
    
    try {
        // Get all token accounts
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
            wallet.publicKey,
            { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
        );
        
        if (tokenAccounts.value.length === 0) {
            await bot.sendMessage(msg.chat.id, 
                `📊 <b>Your Portfolio</b>\n\n` +
                `No tokens found in wallet.\n` +
                `Start trading to build your portfolio!`,
                { parse_mode: 'HTML' }
            );
            return;
        }
        
        // Get SOL balance
        const solBalance = await getTokenBalance(wallet.publicKey.toString(), CONFIG.WSOL_ADDRESS);
        
        // Process each token
        const tokens = [];
        for (const account of tokenAccounts.value) {
            const mint = account.account.data.parsed.info.mint;
            const balance = account.account.data.parsed.info.tokenAmount.uiAmount;
            
            if (balance > 0) {
                const tokenInfo = await getTokenInfo(mint);
                
                // Try to get value in SOL
                let valueInSol = 0;
                try {
                    const quote = await getJupiterQuote(
                        mint,
                        CONFIG.WSOL_ADDRESS,
                        Math.floor(balance * Math.pow(10, tokenInfo.decimals)),
                        CONFIG.SLIPPAGE_BPS
                    );
                    valueInSol = quote.outAmount / 1e9;
                } catch (e) {
                    // If quote fails, token might have no liquidity
                }
                
                // Get P/L data if available
                const pl = await calculateProfitLoss(mint);
                
                tokens.push({
                    mint,
                    symbol: tokenInfo.symbol,
                    name: tokenInfo.name,
                    balance,
                    valueInSol,
                    pl: pl
                });
            }
        }
        
        // Sort by value
        tokens.sort((a, b) => b.valueInSol - a.valueInSol);
        
        // Build message
        let totalValue = solBalance;
        let message = `📊 <b>Your Portfolio</b>\n\n`;
        message += `💰 <b>SOL:</b> ${solBalance.toFixed(4)}\n\n`;
        
        if (tokens.length > 0) {
            message += `<b>🪙 Tokens:</b>\n`;
            tokens.forEach((token, index) => {
                totalValue += token.valueInSol;
                const value = token.valueInSol > 0 ? ` (~${token.valueInSol.toFixed(4)} SOL)` : '';
                const plText = token.pl ? 
                    ` ${token.pl.totalPL >= 0 ? '📈' : '📉'} ${token.pl.totalPL >= 0 ? '+' : ''}${token.pl.totalPL.toFixed(4)} SOL` : '';
                message += `${index + 1}. <b>${token.symbol}</b>: ${formatNumber(token.balance)}${value}${plText}\n`;
                
                // Check if trailing stop is active
                if (trailingStopLoss[token.mint]?.enabled) {
                    message += `   🛡️ Trailing stop active at ${trailingStopLoss[token.mint].stopPrice.toFixed(8)} SOL\n`;
                }
            });
            
            message += `\n💼 <b>Total Portfolio Value:</b> ${totalValue.toFixed(4)} SOL`;
        }
        
        await bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
        
    } catch (error) {
        console.error('Error getting portfolio:', error);
        await bot.sendMessage(msg.chat.id, '❌ Error loading portfolio. Please try again.');
    }
});

bot.onText(/\/wallet/, async (msg) => {
    if (!wallet) {
        await bot.sendMessage(msg.chat.id, '❌ No trading wallet configured');
        return;
    }
    
    const solBalance = await getTokenBalance(wallet.publicKey.toString(), CONFIG.WSOL_ADDRESS);
    
    await bot.sendMessage(msg.chat.id,
        `👛 <b>Trading Wallet</b>\n\n` +
        `Address: <code>${wallet.publicKey.toString()}</code>\n` +
        `Balance: ${solBalance.toFixed(4)} SOL\n\n` +
        `<i>Send SOL to this address to fund your trading wallet</i>`,
        { parse_mode: 'HTML' }
    );
});

// ====== MAIN FUNCTION ======
async function main() {
    console.log('🚀 Advanced Crypto Trading Bot Started');
    console.log(`📍 Monitoring ${CONFIG.WALLETS_TO_MONITOR.length} wallets`);
    console.log(`⏱️  Check interval: ${CONFIG.POLLING_INTERVAL_MS / 1000} seconds`);
    console.log(`🛡️  Smart Filters: ${COPYTRADE_FILTERS.enableFilters ? 'Enabled' : 'Disabled'}`);
    console.log(`🎯 Auto Profit Targets: Enabled`);
    console.log(`📊 Trailing Stop Loss: Enabled`);
    
    // Set bot start time
    botStartTime = Date.now();
    
    // Load saved data
    loadTradeHistory();
    loadBlacklist();
    loadTrailingStops();
    
    // Initialize trading and connection first
    if (!initializeTrading()) {
        console.log('⚠️  Trading functionality disabled - no private key set');
    } else {
        const balance = await getTokenBalance(wallet.publicKey.toString(), CONFIG.WSOL_ADDRESS);
        console.log(`💵 Trading wallet balance: ${balance.toFixed(4)} SOL`);
        dailyStats.startBalance = balance;
    }
    
    await sendTelegramMessage(
        `🚀 <b>Advanced Bot Started</b>\n\n` +
        `Monitoring ${CONFIG.WALLETS_TO_MONITOR.length} wallets\n` +
        `Check interval: Every ${CONFIG.POLLING_INTERVAL_MS / 1000} seconds\n` +
        `Trading: ${wallet ? 'Enabled' : 'Disabled'}\n` +
        `Smart Filters: ${COPYTRADE_FILTERS.enableFilters ? 'Enabled' : 'Disabled'}\n` +
        `Auto Profit Targets: ✅\n` +
        `Trailing Stop Loss: ✅\n\n` +
        `Type /start to see your dashboard!`
    );
    
    // Start monitoring
    isMonitoring = true;
    monitorAllWallets();
    
    // Start position monitoring (every 2 minutes)
    positionMonitorInterval = setInterval(monitorPositions, 120000);
    
    // Start price alert checking
    if (Object.keys(priceAlerts).length > 0) {
        priceCheckInterval = setInterval(checkPriceAlerts, 60000); // Check every minute
    }
}

// ====== ERROR HANDLING ======
process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error);
    // Don't exit, just log the error
});

// ====== START THE BOT ======
main().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});

// ====== ADVANCED FEATURES FUNCTIONS ======
function loadBlacklist() {
    try {
        if (fs.existsSync(BLACKLIST_FILE)) {
            const data = fs.readFileSync(BLACKLIST_FILE, 'utf8');
            const blacklist = JSON.parse(data);
            blacklist.forEach(token => blacklistedTokens.add(token));
            console.log(`🚫 Loaded ${blacklistedTokens.size} blacklisted tokens`);
        }
    } catch (error) {
        console.error('Error loading blacklist:', error);
    }
}

function saveBlacklist() {
    try {
        fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(Array.from(blacklistedTokens), null, 2));
    } catch (error) {
        console.error('Error saving blacklist:', error);
    }
}

function loadTrailingStops() {
    try {
        if (fs.existsSync(TRAILING_FILE)) {
            const data = fs.readFileSync(TRAILING_FILE, 'utf8');
            Object.assign(trailingStopLoss, JSON.parse(data));
            console.log(`📊 Loaded trailing stops for ${Object.keys(trailingStopLoss).length} tokens`);
        }
    } catch (error) {
        console.error('Error loading trailing stops:', error);
    }
}

function saveTrailingStops() {
    try {
        fs.writeFileSync(TRAILING_FILE, JSON.stringify(trailingStopLoss, null, 2));
    } catch (error) {
        console.error('Error saving trailing stops:', error);
    }
}

// Check if token passes safety filters
async function passesTradeFilters(tokenMint, amount = CONFIG.COPYTRADE_AMOUNT_SOL) {
    if (!COPYTRADE_FILTERS.enableFilters) return true;
    
    // Check blacklist
    if (COPYTRADE_FILTERS.blacklistEnabled && blacklistedTokens.has(tokenMint)) {
        console.log(`🚫 Token ${tokenMint} is blacklisted`);
        return false;
    }
    
    try {
        // Get token analytics
        const analytics = await getTokenAnalytics(tokenMint);
        
        // Check liquidity
        if (analytics.liquidity < COPYTRADE_FILTERS.minLiquidity) {
            console.log(`❌ Low liquidity: $${analytics.liquidity} < $${COPYTRADE_FILTERS.minLiquidity}`);
            return false;
        }
        
        // Check market cap
        if (analytics.marketCap < COPYTRADE_FILTERS.minMarketCap) {
            console.log(`❌ Low market cap: $${analytics.marketCap} < $${COPYTRADE_FILTERS.minMarketCap}`);
            return false;
        }
        
        // Check holders
        if (analytics.holders < COPYTRADE_FILTERS.minHolders) {
            console.log(`❌ Too few holders: ${analytics.holders} < ${COPYTRADE_FILTERS.minHolders}`);
            return false;
        }
        
        // Check slippage
        const quote = await getJupiterQuote(
            CONFIG.WSOL_ADDRESS,
            tokenMint,
            Math.floor(amount * 1e9),
            1000 // 10% max slippage for check
        );
        
        if (!quote || quote.priceImpactPct > COPYTRADE_FILTERS.maxSlippage) {
            console.log(`❌ High slippage: ${quote?.priceImpactPct || 'N/A'}% > ${COPYTRADE_FILTERS.maxSlippage}%`);
            return false;
        }
        
        console.log(`✅ Token passed all filters`);
        return true;
        
    } catch (error) {
        console.error('Error checking trade filters:', error);
        return false; // Fail safe - don't trade if we can't verify
    }
}

// Get token analytics (liquidity, holders, etc)
async function getTokenAnalytics(tokenMint) {
    // Check cache first
    if (tokenAnalytics[tokenMint] && 
        tokenAnalytics[tokenMint].timestamp > Date.now() - 300000) { // 5 min cache
        return tokenAnalytics[tokenMint];
    }
    
    try {
        // This is a simplified version - in production you'd use DEX APIs
        // For now, we'll estimate based on available data
        const tokenInfo = await getTokenInfo(tokenMint);
        
        // Try to get some basic metrics
        let liquidity = 10000; // Default $10k
        let marketCap = 50000; // Default $50k
        let holders = 100; // Default 100 holders
        
        // You can enhance this with real API calls to:
        // - DexScreener API
        // - Birdeye API
        // - HelloMoon API
        
        const analytics = {
            tokenMint,
            symbol: tokenInfo.symbol,
            liquidity,
            marketCap,
            holders,
            volume24h: 0,
            priceChange24h: 0,
            timestamp: Date.now()
        };
        
        tokenAnalytics[tokenMint] = analytics;
        return analytics;
        
    } catch (error) {
        console.error('Error getting token analytics:', error);
        return {
            liquidity: 0,
            marketCap: 0,
            holders: 0,
            volume24h: 0,
            priceChange24h: 0
        };
    }
}

// Update trailing stop loss
async function updateTrailingStopLoss(tokenMint) {
    const position = tradeHistory[tokenMint];
    if (!position || position.totalBought <= position.totalSold) return;
    
    const currentPrice = await getTokenPrice(tokenMint);
    if (!currentPrice) return;
    
    const trailing = trailingStopLoss[tokenMint];
    if (!trailing || !trailing.enabled) return;
    
    // Update highest price
    if (currentPrice > trailing.highestPrice) {
        trailing.highestPrice = currentPrice;
        trailing.stopPrice = currentPrice * (1 - RISK_MANAGEMENT.trailingStopLossPercent / 100);
        saveTrailingStops();
        
        console.log(`📈 Updated trailing stop for ${tokenMint}: Stop at ${trailing.stopPrice.toFixed(8)} SOL`);
    }
    
    // Check if we should sell
    if (currentPrice <= trailing.stopPrice) {
        console.log(`🛑 Trailing stop triggered for ${tokenMint}!`);
        
        const tokenInfo = await getTokenInfo(tokenMint);
        await sendTelegramMessage(
            `🛑 <b>TRAILING STOP TRIGGERED!</b>\n\n` +
            `Token: ${tokenInfo.symbol}\n` +
            `Current Price: ${currentPrice.toFixed(8)} SOL\n` +
            `Stop Price: ${trailing.stopPrice.toFixed(8)} SOL\n\n` +
            `Selling position...`,
            { parse_mode: 'HTML' }
        );
        
        // Execute sell
        const balance = await getTokenBalance(wallet.publicKey.toString(), tokenMint);
        if (balance > 0) {
            await sellToken(tokenMint, null, 100);
        }
        
        // Remove trailing stop
        delete trailingStopLoss[tokenMint];
        saveTrailingStops();
    }
}

// Check and execute profit targets
async function checkProfitTargets(tokenMint) {
    const position = tradeHistory[tokenMint];
    if (!position || position.totalBought <= position.totalSold) return;
    
    const currentPrice = await getTokenPrice(tokenMint);
    if (!currentPrice || !position.averageBuyPrice) return;
    
    const profitPercent = ((currentPrice - position.averageBuyPrice) / position.averageBuyPrice) * 100;
    
    // Check each profit target
    for (const [target, config] of Object.entries(PROFIT_TARGETS)) {
        const targetPercent = parseFloat(target);
        
        // Check if we've hit this target and haven't executed it yet
        if (profitPercent >= targetPercent && !position[`target${target}Hit`]) {
            position[`target${target}Hit`] = true;
            
            const balance = await getTokenBalance(wallet.publicKey.toString(), tokenMint);
            const sellAmount = balance * (config.sell / 100);
            
            if (sellAmount > 0) {
                console.log(`🎯 Profit target ${target}% hit for ${tokenMint}! Selling ${config.sell}%`);
                
                const tokenInfo = await getTokenInfo(tokenMint);
                await sendTelegramMessage(
                    `🎯 <b>PROFIT TARGET HIT!</b>\n\n` +
                    `Token: ${tokenInfo.symbol}\n` +
                    `Profit: +${profitPercent.toFixed(2)}%\n` +
                    `Target: ${target}%\n` +
                    `Action: Selling ${config.sell}% of position\n\n` +
                    `Executing trade...`,
                    { parse_mode: 'HTML' }
                );
                
                // Execute partial sell
                await sellToken(tokenMint, sellAmount);
                
                // Enable trailing stop if configured
                if (config.trailing && !trailingStopLoss[tokenMint]) {
                    trailingStopLoss[tokenMint] = {
                        enabled: true,
                        highestPrice: currentPrice,
                        stopPrice: currentPrice * (1 - RISK_MANAGEMENT.trailingStopLossPercent / 100),
                        activatedAt: Date.now()
                    };
                    saveTrailingStops();
                    console.log(`📊 Activated trailing stop loss for ${tokenMint}`);
                }
            }
            
            saveTradeHistory();
        }
    }
}

// Monitor all positions for trailing stops and profit targets
async function monitorPositions() {
    if (tradingPaused || emergencyMode) return;
    
    console.log('📊 Monitoring positions for profit targets and trailing stops...');
    
    for (const tokenMint of Object.keys(tradeHistory)) {
        const position = tradeHistory[tokenMint];
        if (position.totalBought > position.totalSold) {
            await updateTrailingStopLoss(tokenMint);
            await checkProfitTargets(tokenMint);
            
            // Check emergency stop loss
            const currentPrice = await getTokenPrice(tokenMint);
            if (currentPrice && position.averageBuyPrice) {
                const lossPercent = ((position.averageBuyPrice - currentPrice) / position.averageBuyPrice) * 100;
                
                if (lossPercent > RISK_MANAGEMENT.emergencyStopLoss * 100) {
                    console.log(`🚨 Emergency stop loss triggered for ${tokenMint}!`);
                    const tokenInfo = await getTokenInfo(tokenMint);
                    await sendTelegramMessage(
                        `🚨 <b>EMERGENCY STOP LOSS!</b>\n\n` +
                        `Token: ${tokenInfo.symbol}\n` +
                        `Loss: -${lossPercent.toFixed(2)}%\n` +
                        `Selling entire position to prevent further losses...`,
                        { parse_mode: 'HTML' }
                    );
                    
                    const balance = await getTokenBalance(wallet.publicKey.toString(), tokenMint);
                    if (balance > 0) {
                        await sellToken(tokenMint, null, 100);
                    }
                }
            }
        }
    }
}

// ====== TRADE TRACKING FUNCTIONS ======
function loadTradeHistory() {
    try {
        if (fs.existsSync(TRADES_FILE)) {
            const data = fs.readFileSync(TRADES_FILE, 'utf8');
            Object.assign(tradeHistory, JSON.parse(data));
            console.log('📊 Trade history loaded');
        }
    } catch (error) {
        console.error('Error loading trade history:', error);
    }
}

function saveTradeHistory() {
    try {
        fs.writeFileSync(TRADES_FILE, JSON.stringify(tradeHistory, null, 2));
    } catch (error) {
        console.error('Error saving trade history:', error);
    }
}

function recordTrade(tokenMint, type, amount, priceInSol, txid, tokenInfo = null) {
    if (!tradeHistory[tokenMint]) {
        tradeHistory[tokenMint] = {
            trades: [],
            totalBought: 0,
            totalSold: 0,
            totalSpentSOL: 0,
            totalReceivedSOL: 0,
            averageBuyPrice: 0,
            symbol: tokenInfo?.symbol || 'Unknown',
            name: tokenInfo?.name || 'Unknown Token'
        };
    }
    
    const trade = {
        type,
        amount,
        priceInSol,
        timestamp: Date.now(),
        txid
    };
    
    tradeHistory[tokenMint].trades.push(trade);
    
    if (type === 'buy') {
        tradeHistory[tokenMint].totalBought += amount;
        tradeHistory[tokenMint].totalSpentSOL += priceInSol;
        // Recalculate average buy price
        if (tradeHistory[tokenMint].totalBought > 0) {
            tradeHistory[tokenMint].averageBuyPrice = 
                tradeHistory[tokenMint].totalSpentSOL / tradeHistory[tokenMint].totalBought;
        }
        dailyStats.trades++;
    } else if (type === 'sell') {
        tradeHistory[tokenMint].totalSold += amount;
        tradeHistory[tokenMint].totalReceivedSOL += priceInSol;
        
        // Calculate profit/loss for this sell
        const avgBuyPrice = tradeHistory[tokenMint].averageBuyPrice;
        const sellValue = priceInSol;
        const buyValue = amount * avgBuyPrice;
        const profit = sellValue - buyValue;
        
        if (profit > 0) {
            dailyStats.profit += profit;
        } else {
            dailyStats.loss += Math.abs(profit);
        }
        dailyStats.trades++;
    }
    
    saveTradeHistory();
}

async function calculateProfitLoss(tokenMint) {
    const history = tradeHistory[tokenMint];
    if (!history) return null;
    
    const currentBalance = await getTokenBalance(wallet.publicKey.toString(), tokenMint);
    const currentPrice = await getTokenPrice(tokenMint);
    
    if (!currentPrice) return null;
    
    const totalInvested = history.totalSpentSOL;
    const totalRealized = history.totalReceivedSOL;
    const unrealizedValue = currentBalance * currentPrice;
    
    const realizedPL = totalRealized - (history.totalSold * history.averageBuyPrice);
    const unrealizedPL = currentBalance > 0 ? 
        (currentPrice - history.averageBuyPrice) * currentBalance : 0;
    const totalPL = realizedPL + unrealizedPL;
    
    return {
        totalInvested,
        totalRealized,
        realizedPL,
        unrealizedPL,
        totalPL,
        unrealizedValue,
        currentBalance,
        currentPrice,
        averageBuyPrice: history.averageBuyPrice,
        totalBought: history.totalBought,
        totalSold: history.totalSold
    };
}

// ====== HELPER FUNCTIONS ======
function shortenAddress(address) {
    if (!address || address.length < 10) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatNumber(num) {
    if (num >= 1000000) return `${(num / 1000000).toFixed(2)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(2)}K`;
    return num.toFixed(6);
}

async function sendTelegramMessage(message, options = {}) {
    try {
        await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...options
        });
        console.log('✅ Telegram message sent');
    } catch (error) {
        console.error('❌ Failed to send Telegram message:', error.message);
    }
}

// ====== TOKEN INFO FUNCTIONS ======
async function getTokenInfo(tokenAddress) {
    try {
        const knownTokens = {
            'So11111111111111111111111111111111111111112': { symbol: 'WSOL', name: 'Wrapped SOL', decimals: 9 },
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
            'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': { symbol: 'JUP', name: 'Jupiter', decimals: 6 }
        };
        
        if (knownTokens[tokenAddress]) {
            return knownTokens[tokenAddress];
        }
        
        // Validate token address format before calling API
        try {
            new PublicKey(tokenAddress); // This will throw if invalid
        } catch (e) {
            console.log(`⚠️ Invalid token address format: ${tokenAddress}`);
            return {
                symbol: shortenAddress(tokenAddress),
                name: 'Unknown Token',
                decimals: 9
            };
        }
        
        // Try Helius metadata API
        try {
            const metadataResponse = await axios.get(
                `https://api.helius.xyz/v0/token-metadata`,
                {
                    params: {
                        'api-key': CONFIG.HELIUS_API_KEY,
                        mint_accounts: tokenAddress
                    },
                    timeout: 5000 // 5 second timeout
                }
            );
            
            if (metadataResponse.data && metadataResponse.data.length > 0) {
                const metadata = metadataResponse.data[0];
                return {
                    symbol: metadata.symbol || metadata.onChainMetadata?.symbol || 'Unknown',
                    name: metadata.name || metadata.onChainMetadata?.name || 'Unknown Token',
                    decimals: metadata.decimals || 9
                };
            }
        } catch (e) {
            // Don't log for common errors
            if (e.response?.status !== 400 && e.code !== 'ECONNABORTED') {
                console.log(`⚠️ Helius metadata API failed: ${e.message}`);
            }
        }
        
        return {
            symbol: shortenAddress(tokenAddress),
            name: 'Unknown Token',
            decimals: 9
        };
        
    } catch (error) {
        console.error(`❌ Error fetching token info: ${error.message}`);
        return {
            symbol: shortenAddress(tokenAddress),
            name: 'Unknown Token',
            decimals: 9
        };
    }
}

// ====== COPYTRADE FUNCTION WITH FILTERS ======
async function handleCopytrade(walletAddress, tokenMint, isBuying) {
    // Check if copytrade is enabled for this wallet
    if (!copytradeEnabled[walletAddress] || !CONFIG.COPYTRADE_ENABLED || tradingPaused) return;
    
    // Create unique identifier for this trade
    const tradeId = `${walletAddress}_${tokenMint}_${isBuying ? 'buy' : 'sell'}_${Date.now()}`;
    
    // Check if we've already processed this copytrade
    if (processedCopytrades.has(tradeId)) return;
    processedCopytrades.add(tradeId);
    
    // Clean up old copytrade IDs (keep last 1000)
    if (processedCopytrades.size > 1000) {
        const idsArray = Array.from(processedCopytrades);
        idsArray.slice(0, 500).forEach(id => processedCopytrades.delete(id));
    }
    
    const walletName = walletNames[walletAddress] || shortenAddress(walletAddress);
    const tokenInfo = await getTokenInfo(tokenMint);
    
    if (isBuying) {
        // Check filters before copying trade
        console.log(`🔍 Analyzing copytrade opportunity for ${tokenInfo.symbol}...`);
        
        const passesFilters = await passesTradeFilters(tokenMint, CONFIG.COPYTRADE_AMOUNT_SOL);
        
        if (!passesFilters) {
            console.log(`❌ Token ${tokenInfo.symbol} failed safety filters - skipping copytrade`);
            await sendTelegramMessage(
                `⚠️ <b>COPYTRADE SKIPPED - FAILED FILTERS</b>\n\n` +
                `👛 Wallet: <b>${walletName}</b> bought\n` +
                `🪙 Token: <b>${tokenInfo.symbol}</b>\n` +
                `❌ Reason: Failed safety checks\n\n` +
                `<i>Token didn't meet minimum requirements for liquidity, holders, or slippage.</i>`,
                { parse_mode: 'HTML' }
            );
            return;
        }
        
        // Check position sizing
        const currentPositions = Object.keys(tradeHistory).filter(
            mint => tradeHistory[mint].totalBought > tradeHistory[mint].totalSold
        ).length;
        
        if (currentPositions >= RISK_MANAGEMENT.maxOpenPositions) {
            console.log(`❌ Max positions (${RISK_MANAGEMENT.maxOpenPositions}) reached`);
            await sendTelegramMessage(
                `⚠️ <b>COPYTRADE SKIPPED - MAX POSITIONS</b>\n\n` +
                `Current positions: ${currentPositions}/${RISK_MANAGEMENT.maxOpenPositions}\n` +
                `Close some positions before opening new ones.`,
                { parse_mode: 'HTML' }
            );
            return;
        }
        
        // Execute copytrade buy
        console.log(`🔄 Executing filtered copytrade: Buying ${CONFIG.COPYTRADE_AMOUNT_SOL} SOL worth of ${tokenInfo.symbol}`);
        
        await sendTelegramMessage(
            `🔄 <b>SMART COPYTRADE TRIGGERED</b>\n\n` +
            `👛 Following: <b>${walletName}</b>\n` +
            `🪙 Token: <b>${tokenInfo.symbol}</b>\n` +
            `✅ Passed all safety filters\n` +
            `💰 Buying: ${CONFIG.COPYTRADE_AMOUNT_SOL} SOL worth\n\n` +
            `<i>Executing trade...</i>`,
            { parse_mode: 'HTML' }
        );
        
        const result = await buyToken(tokenMint, CONFIG.COPYTRADE_AMOUNT_SOL);
        
        if (result.success) {
            await sendTelegramMessage(
                `✅ <b>SMART COPYTRADE SUCCESSFUL!</b>\n\n` +
                `👛 Copied: <b>${walletName}</b>\n` +
                `🪙 Token: <b>${tokenInfo.symbol}</b>\n` +
                `💰 Spent: ${CONFIG.COPYTRADE_AMOUNT_SOL} SOL\n` +
                `📊 Received: ${formatNumber(result.amount)} tokens\n` +
                `🎯 Auto profit targets: 10%, 25%, 50%, 100%\n` +
                `🛡️ Protection: Trailing stop loss ready\n` +
                `🔗 <a href="https://solscan.io/tx/${result.txid}">View Transaction</a>`,
                { parse_mode: 'HTML', disable_web_page_preview: true }
            );
        } else {
            await sendTelegramMessage(
                `❌ <b>COPYTRADE FAILED</b>\n\n` +
                `Error: ${result.error}`,
                { parse_mode: 'HTML' }
            );
        }
    }
}