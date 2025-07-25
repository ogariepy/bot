require('dotenv').config();
const fs = require('fs'); // ✅ Only declare once, here
const path = require('path');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const WebSocket = require('ws');
const bs58 = require('bs58');
const { v4: uuidv4 } = require('uuid');
const web3 = require('@solana/web3.js');
const {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    VersionedTransaction
} = require('@solana/web3.js');

const { TOKEN_PROGRAM_ID } = require('@solana/spl-token'); // ✅ Add this line


// Custom logic
const pendingCopytrades = new Map(); // uid -> { walletAddress, tokenMint }
const autotradeTargets = {};
const userState = {};
const GLOBAL_STOPLOSS = {
    enabled: false,
    percent: 30 // default stop loss at 30%
};

const profitTargets = {}; // Format: { tokenMint: { buyPrice, targetPct, autoSellPct } }










// Define HELIUS_API_KEY before using it in CONFIG
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '7ff13336-ad00-4ada-8eac-2e47c58a770f';

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
    OWNER_PUBLIC_KEY: process.env.OWNER_PUBLIC_KEY,
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
const notifiedTrades = new Set();
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

// ====== ENHANCED MONITORING FUNCTION ======
const processedSignaturesByWallet = new Map(); // walletAddress => Set of signatures

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function monitorAllWallets() {
    if (!isMonitoring) return;

    console.log(`\n🔄 Checking all wallets at ${new Date().toLocaleTimeString()}...`);

    for (const walletAddress of CONFIG.WALLETS_TO_MONITOR) {
        const walletName = walletNames[walletAddress] || shortenAddress(walletAddress);
        console.log(`👀 Checking ${walletName}: ${walletAddress}`);

        const alertedThisRound = new Set();
        if (!processedSignaturesByWallet.has(walletAddress)) {
            processedSignaturesByWallet.set(walletAddress, new Set());
        }

        const walletProcessed = processedSignaturesByWallet.get(walletAddress);

        try {
            const signatures = await connection.getSignaturesForAddress(
                new PublicKey(walletAddress),
                { limit: 100 }
            );

            if (!signatures.length) {
                console.log(`🚫 No transactions found for ${walletName}`);
                continue;
            }

            let processedCount = 0;

            for (const sigInfo of signatures) {
                const signature = sigInfo.signature;

                if (walletProcessed.has(signature)) continue;

                if (botStartTime && sigInfo.blockTime && sigInfo.blockTime * 1000 < botStartTime) {
                    walletProcessed.add(signature);
                    continue;
                }

                try {
                    const tx = await connection.getParsedTransaction(signature, {
                        maxSupportedTransactionVersion: 0
                    });

                    if (!tx || tx.meta?.err) {
                        walletProcessed.add(signature);
                        continue;
                    }

                    const tokenTransfers = analyzeTokenTransfers(tx, walletAddress);
                    const hasNewToken = tokenTransfers.some(
                        t => t.direction === 'in' && !alertedThisRound.has(t.mint)
                    );

                    if (hasNewToken || tx.transaction.message.instructions.length > 0) {
                        await analyzeAllTransactionTypes(walletAddress, tx, sigInfo);
                        tokenTransfers.forEach(t => alertedThisRound.add(t.mint));
                        processedCount++;
                    }

                    walletProcessed.add(signature);
                    await delay(200); // delay between transactions to reduce API load

                } catch (txError) {
                    console.error(`❌ Error parsing tx ${signature.slice(0, 8)}...: ${txError.message}`);
                    continue;
                }
            }

            if (processedCount > 0) {
                console.log(`✅ Processed ${processedCount} new tx(s) for ${walletName}`);
            }

        } catch (error) {
            console.error(`❌ Failed to check wallet ${walletName}: ${error.message}`);
        }

        await delay(1000); // delay between wallets
    }

    // Cleanup old signatures per wallet
    for (const [wallet, sigSet] of processedSignaturesByWallet.entries()) {
        if (sigSet.size > 10000) {
            const sigArray = Array.from(sigSet);
            sigArray.slice(0, 5000).forEach(sig => sigSet.delete(sig));
        }
    }

    console.log(`✅ Wallet check complete. Next check in ${CONFIG.POLLING_INTERVAL_MS / 1000} seconds.\n`);

    setTimeout(monitorAllWallets, CONFIG.POLLING_INTERVAL_MS);
}






// Enhanced transaction analyzer that captures ALL transaction types
function createAutocopytradeCallback(walletAddress, tokenMint) {
    const uid = uuidv4().slice(0, 8); // Short uid (8 chars)
    pendingCopytrades.set(uid, { walletAddress, tokenMint });
    return `autocopytrade_${uid}`;
}

function safeCallbackData(prefix, value) {
    return `${prefix}_${value}`;
}

async function analyzeAllTransactionTypes(walletAddress, tx, sigInfo) {
    if (processedSignatures.has(sigInfo.signature)) return;
    processedSignatures.add(sigInfo.signature);

    const walletName = walletNames[walletAddress] || shortenAddress(walletAddress);
    const txTime = sigInfo.blockTime ? new Date(sigInfo.blockTime * 1000).toLocaleString() : 'Unknown time';
    const success = !tx.meta?.err;
    const fee = (tx.meta?.fee || 0) / 1e9;

    const solTransfers = analyzeSolTransfers(tx, walletAddress);
    const tokenTransfers = analyzeTokenTransfers(tx, walletAddress);
    const programInteractions = analyzeProgramInteractions(tx, walletAddress);

    if (solTransfers.length === 0 && tokenTransfers.length === 0) {
        console.log(`⚠️ Ignored tx ${sigInfo.signature} — no relevant activity`);
        return;
    }

    let message =
        `📋 TRANSACTION DETECTED\n\n` +
        `👛 Wallet: ${walletName}\n` +
        `${walletAddress}\n` +
        `⏰ Time: ${txTime}\n` +
        `✅ Status: ${success ? 'Success' : 'Failed'}\n` +
        `💸 Fee: ${fee.toFixed(6)} SOL\n\n`;

    if (solTransfers.length > 0) {
        message += `💰 SOL Transfers:\n`;
        for (const sol of solTransfers) {
            const sEmoji = sol.direction === 'in' ? '📥' : '📤';
            message += `${sEmoji} ${sol.direction === 'in' ? 'Received' : 'Sent'} ${sol.amount.toFixed(6)} SOL ${sol.direction === 'in' ? 'from' : 'to'} ${shortenAddress(sol.counterparty)}\n`;
        }
        message += `\n`;
    }

    await sendTelegramMessage(message);

    const seenMints = new Set();

    for (const transfer of tokenTransfers) {
        const tokenMint = transfer.mint;

        if (
            tokenMint === 'So11111111111111111111111111111111111111112' ||
            tokenMint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' ||
            tokenMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
        ) continue;

        if (seenMints.has(tokenMint)) continue;
        seenMints.add(tokenMint);

        const tokenInfo = await getTokenInfo(tokenMint);
        const analytics = await getTokenAnalytics(tokenMint);
        const shortMint = shortenAddress(tokenMint);
        const direction = transfer.direction === 'in' ? '+' : '-';
        const emoji = transfer.direction === 'in' ? '📥' : '📤';

        const tokenMessage =
            `📋 <b>TOKEN ${transfer.direction === 'in' ? 'RECEIVED' : 'SENT'}</b>\n\n` +
            `👛 Wallet: <b>${walletName}</b>\n` +
            `<code>${walletAddress}</code>\n\n` +
            `${emoji} <b>Token:</b> ${shortMint} (${tokenInfo.name || 'Unknown Token'})\n` +
            `📊 <b>Amount:</b> ${direction}${formatNumber(transfer.amount)}\n` +
            `💧 <b>Liquidity:</b> ${formatNumber(analytics.liquidity)}\n` +
            `📈 <b>24h Volume:</b> ${formatNumber(analytics.volume24h)}\n` +
            `👥 <b>Holders:</b> ${analytics.holders}\n` +
            `🆔 <b>Token:</b> <a href="https://dexscreener.com/solana/${tokenMint}">${tokenMint}</a>`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: "💰 Buy 0.001", callback_data: `buy_0.001_${tokenMint}` },
                    { text: "💰 Buy 0.01", callback_data: `buy_0.01_${tokenMint}` }
                ],
                [
                    { text: "💰 Buy 0.05", callback_data: `buy_0.05_${tokenMint}` },
                    { text: "💰 Buy 0.1", callback_data: `buy_0.1_${tokenMint}` }
                ],
                [
                    { text: '🧪 RugCheck', url: `https://rugcheck.xyz/tokens/${tokenMint}` }
                ],
                [
                    { text: "📊 Dexscreener", url: `https://dexscreener.com/solana/${tokenMint}` },
                    { text: "🦉 Birdeye", url: `https://birdeye.so/token/${tokenMint}?chain=solana` }
                ],
                [
                    { text: "🤖 Autocopytrade", callback_data: createAutocopytradeCallback(walletAddress, tokenMint) },
                    { text: "🚫 Blacklist", callback_data: `blacklist_${tokenMint}` }
                ],
                [
                    { text: "🛠 Autotrade", callback_data: `auto_trade_token_${tokenMint}` },
                    { text: "🌐 Multi-DEX Support", callback_data: `multi_dex_${tokenMint}` }
                ]
            ]
        };

        await sendTelegramMessage(tokenMessage, { parse_mode: 'HTML', reply_markup: keyboard });

        // 🔁 COPYTRADE BUY
        if (transfer.direction === 'in' && copytradeEnabled[walletAddress]?.enabled) {
            console.log(`🚀 [analyze] onWalletBuy → ${walletAddress} ${tokenMint}`);
            await onWalletBuy(walletAddress, tokenMint);
        }

        // 💸 COPYTRADE SELL — FIXED LOGIC HERE
        if (
            transfer.direction === 'out' &&
            copytradeEnabled?.[walletAddress]?.[tokenMint]?.enabled
        ) {
            console.log(`🔎 [analyze] Wallet is watched, triggering auto-sell for ${walletAddress}, ${tokenMint}`);
            await onWalletSell(walletAddress, tokenMint, wallet);
        }
    }

    if (programInteractions.length > 0) {
        const programs = [...new Set(programInteractions.map(p => p.name))];
        const interactionMessage = `🛠 Program Interactions:\n` + programs.map(p => `• ${p}`).join('\n');
        await sendTelegramMessage(interactionMessage);
    }

    console.log(`✅ TX summary sent for ${walletName} (${sigInfo.signature.slice(0, 8)}...)`);
}





















// Analyze SOL transfers in transaction
function analyzeSolTransfers(tx, walletAddress) {
    const transfers = [];
    
    if (!tx.meta) return transfers;
    
    // Get account keys
    const accountKeys = tx.transaction.message.accountKeys || tx.transaction.message.staticAccountKeys || [];
    
    // Find wallet index
    let walletIndex = -1;
    for (let i = 0; i < accountKeys.length; i++) {
        const key = accountKeys[i].pubkey || accountKeys[i];
        if (key.toString() === walletAddress) {
            walletIndex = i;
            break;
        }
    }
    
    if (walletIndex === -1) return transfers;
    
    // Calculate SOL balance change
    const preBalance = tx.meta.preBalances[walletIndex] || 0;
    const postBalance = tx.meta.postBalances[walletIndex] || 0;
    const balanceChange = (postBalance - preBalance) / 1e9; // Convert to SOL
    
    // Skip if no significant change (accounting for fees)
    if (Math.abs(balanceChange) < 0.000001) return transfers;
    
    // Try to identify counterparty
    for (let i = 0; i < accountKeys.length; i++) {
        if (i === walletIndex) continue;
        
        const otherPreBalance = tx.meta.preBalances[i] || 0;
        const otherPostBalance = tx.meta.postBalances[i] || 0;
        const otherChange = (otherPostBalance - otherPreBalance) / 1e9;
        
        // If this account had opposite change, it's likely the counterparty
        if (Math.abs(otherChange + balanceChange) < 0.001) {
            const counterparty = (accountKeys[i].pubkey || accountKeys[i]).toString();
            transfers.push({
                direction: balanceChange > 0 ? 'in' : 'out',
                amount: Math.abs(balanceChange),
                counterparty: counterparty,
                type: 'SOL'
            });
            break;
        }
    }
    
    // If no counterparty found but balance changed, record as unknown
    if (transfers.length === 0 && Math.abs(balanceChange) > 0.001) {
        transfers.push({
            direction: balanceChange > 0 ? 'in' : 'out',
            amount: Math.abs(balanceChange),
            counterparty: 'Unknown',
            type: 'SOL'
        });
    }
    
    return transfers;
}


// Analyze token transfers in transaction
function analyzeTokenTransfers(tx, walletAddress) {
    const transfers = [];
    const ownerKey = walletAddress;

    if (!tx.meta) return transfers;

    const preBalances = tx.meta.preTokenBalances || [];
    const postBalances = tx.meta.postTokenBalances || [];

    const tokenChanges = {};

    for (const balance of preBalances) {
        const mint = balance.mint;
        const owner = balance.owner;
        const key = `${mint}:${owner}`;

        if (!tokenChanges[key]) tokenChanges[key] = { pre: 0, post: 0, mint, owner };
        tokenChanges[key].pre = parseFloat(balance.uiTokenAmount.uiAmountString || '0');
    }

    for (const balance of postBalances) {
        const mint = balance.mint;
        const owner = balance.owner;
        const key = `${mint}:${owner}`;

        if (!tokenChanges[key]) tokenChanges[key] = { pre: 0, post: 0, mint, owner };
        tokenChanges[key].post = parseFloat(balance.uiTokenAmount.uiAmountString || '0');
    }

    for (const [key, { pre, post, mint, owner }] of Object.entries(tokenChanges)) {
    if (!ownerKey) continue;

    const delta = post - pre;
    if (Math.abs(delta) < 0.000001) continue;

    if (
        owner === ownerKey ||
        tx.transaction.message.accountKeys.some(
            k => (k.pubkey || k).toString?.() === ownerKey
        )
    ) {
        if (mint === 'So11111111111111111111') continue; // Skip WSOL

        transfers.push({
            mint,
            direction: delta > 0 ? 'in' : 'out',
            amount: Math.abs(delta),
            isNewToken: pre === 0 && post > 0,
            isFullSell: pre > 0 && post === 0,
            type: 'TOKEN'
        });
    }
}


    return transfers;
}




// Analyze program interactions
function analyzeProgramInteractions(tx, walletAddress) {
    const interactions = [];
    const knownPrograms = {
        '11111111111111111111111111111111': 'System Program',
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': 'Token Program',
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL': 'Associated Token Program',
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter v6',
        'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpool',
        '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium V4',
        'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium CLMM',
        'MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky': 'Mercurial',
        'SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ': 'Saber',
        'EewxydAPCCVuNEyrVN68PuSYdQ7wKn27V9Gjeoi8dy3S': 'Lifinity',
        'CURVGoZn8zycx6FXwwevgBTB2gVvdbGTEpvMJDbgs2t4': 'Curve',
        '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP': 'Orca V2',
        'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1': 'Orca V1',
        '9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT': 'Serum DEX V3',
        'EUqojwWA2rd19FZrzeBncJsm38Jm1hEhE3zsmX3bRc2o': 'Serum DEX V2',
        '22Y43yTVxuUkoRKdm9thyRhQ3SdgQS7c7kB6UNCiaczD': 'Serum DEX V1'
    };
    
    if (!tx.transaction?.message?.instructions) return interactions;
    
    const instructions = tx.transaction.message.instructions;
    
    for (const instruction of instructions) {
        const programId = instruction.programId?.toString() || instruction.program;
        if (programId) {
            const programName = knownPrograms[programId] || `Unknown (${shortenAddress(programId)})`;
            interactions.push({
                programId: programId,
                name: programName
            });
        }
    }
    
    return interactions;
}

// ====== NOTIFICATION HANDLERS ======
async function handleTokenReceived(walletAddress, tokenMint, amount, signature, isNewToken) {
    const tokenInfo = await getTokenInfo(tokenMint);
    const analytics = await getTokenAnalytics(tokenMint);
    const walletName = walletNames[walletAddress] || shortenAddress(walletAddress);
    const shortMint = shortenAddress(tokenMint);

    const message =
        `🟢 TOKEN RECEIVED\n\n` +
        `👛 Wallet: ${walletName}\n` +
        `${walletAddress}\n` +
        `🪙 Token: ${shortMint} (${tokenInfo.name || 'Unknown Token'})\n` +
        `📊 Amount: +${formatNumber(amount)}\n` +
        `💧 Liquidity: ${formatNumber(analytics.liquidity)}\n` +
        `👥 Holders: ${analytics.holders}\n` +
        `🆔 Token: ${tokenMint} (https://dexscreener.com/solana/${tokenMint})`;

    const keyboard = {
        inline_keyboard: [
            [
                { text: '💰 Buy 0.01 SOL', callback_data: `buy_0.01_${tokenMint}` },
                { text: '💰 Buy 0.05 SOL', callback_data: `buy_0.05_${tokenMint}` },
                { text: '💰 Buy 0.1 SOL', callback_data: `buy_0.1_${tokenMint}` }
            ],
            [
                { text: '📊 Price', callback_data: `price_${tokenMint}` },
                { text: '📈 Chart', url: `https://dexscreener.com/solana/${tokenMint}` },
                { text: '💼 Balance', callback_data: `balance_${tokenMint}` }
            ],
            [
                { text: '🛑 Set Stop Loss', callback_data: `set_stoploss_${tokenMint}` },
                { text: '🎯 Set Take Profit', callback_data: `set_takeprofit_${tokenMint}` }
            ],
            [
                { text: '🦅 Birdeye', url: `https://birdeye.so/token/${tokenMint}` },
                { text: '🔄 Copytrade', callback_data: `copytrade_${walletAddress}` }
            ],
            [
                { text: '🚫 Blacklist Token', callback_data: `blacklist_${tokenMint}` },
                { text: '📊 Token Analytics', callback_data: `analytics_${tokenMint}` }
            ]
        ]
    };

    await sendTelegramMessage(message, { reply_markup: keyboard });
    console.log(`🟢 Token received: ${tokenInfo.symbol} (${tokenMint}) by ${walletName}`);
}

async function handleTokenSent(walletAddress, tokenMint, amount, signature, isFullSell) {
    const tokenInfo = await getTokenInfo(tokenMint);
    const analytics = await getTokenAnalytics(tokenMint);
    const walletName = walletNames[walletAddress] || shortenAddress(walletAddress);
    const shortMint = shortenAddress(tokenMint);

    const emoji = isFullSell ? '🔴' : '🟠';
    const statusText = isFullSell ? 'FULL SELL' : 'TOKEN SOLD';

    const message =
        `${emoji} ${statusText}\n\n` +
        `👛 Wallet: ${walletName}\n` +
        `${walletAddress}\n` +
        `🪙 Token: ${shortMint}\n` +
        `📉 Amount: -${formatNumber(amount)}\n` +
        `💧 Liquidity: ${formatNumber(analytics.liquidity)}\n` +
        `👥 Holders: ${analytics.holders}\n` +
        `🆔 Token: ${tokenMint} (https://dexscreener.com/solana/${tokenMint})`;

    const keyboard = {
        inline_keyboard: [
            [
                { text: '💰 Buy 0.01 SOL', callback_data: `buy_0.01_${tokenMint}` },
                { text: '💰 Buy 0.05 SOL', callback_data: `buy_0.05_${tokenMint}` },
                { text: '💰 Buy 0.1 SOL', callback_data: `buy_0.1_${tokenMint}` }
            ],
            [
                { text: '💸 Sell 25%', callback_data: `sell_25_${tokenMint}` },
                { text: '💸 Sell 50%', callback_data: `sell_50_${tokenMint}` },
                { text: '💸 Sell 100%', callback_data: `sell_100_${tokenMint}` }
            ],
            [
                { text: '📊 Price', callback_data: `price_${tokenMint}` },
                { text: '📈 Chart', url: `https://dexscreener.com/solana/${tokenMint}` },
                { text: '💼 Balance', callback_data: `balance_${tokenMint}` }
            ],
            [
                { text: '🛑 Set Stop Loss', callback_data: `set_stoploss_${tokenMint}` },
                { text: '🎯 Set Take Profit', callback_data: `set_takeprofit_${tokenMint}` }
            ],
            [
                { text: '🦅 Birdeye', url: `https://birdeye.so/token/${tokenMint}` },
                { text: '🤖 Autocopytrade', callback_data: `autocopytrade_${walletAddress}_${tokenMint}` }
            ],
            [
                { text: '🚫 Blacklist Token', callback_data: `blacklist_${tokenMint}` },
                { text: '📊 Token Analytics', callback_data: `analytics_${tokenMint}` }
            ]
        ]
    };

    await sendTelegramMessage(message, { reply_markup: keyboard });
    console.log(`${emoji} ${statusText}: ${tokenInfo.symbol} (${tokenMint}) by ${walletName}`);

    // ✅ Autocopytrade SELL detection
    if (copytradeEnabled[walletAddress] && copytradeEnabled[walletAddress][tokenMint]) {
        console.log(`📉 Selling due to autocopytrade for ${tokenMint}`);
        const userBalance = await getTokenBalance(wallet.publicKey.toString(), tokenMint);
        if (userBalance > 0) {
            await sellToken(walletAddress, tokenMint, userBalance);
            delete copytradeEnabled[walletAddress][tokenMint];
        }
    }
}

// ====== PRICE FUNCTIONS ======
async function getSolPriceUSD() {
    try {
        // Get SOL price in USDC
        const quote = await getCachedJupiterQuote(
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
        const quote = await getCachedJupiterQuote(
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
            
            const reverseQuote = await getCachedJupiterQuote(
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

    const message =
        `${emoji} PRICE ALERT - ${action} TARGET\n\n` +
        `🪙 Token: ${tokenInfo.symbol} (${tokenInfo.name})\n` +
        `💰 Current Price:\n` +
        `• SOL: ${currentPrice.toFixed(8)}\n` +
        `• USD: ${currentPriceUSD.toFixed(6)}\n\n` +
        `🎯 Target: ${targetPrice.toFixed(6)}\n` +
        `🆔 Token: ${tokenMint} (https://dexscreener.com/solana/${tokenMint})`;

    const keyboard = {
        inline_keyboard: [
            [
                { text: '💰 Buy 0.1 SOL', callback_data: `buy_0.1_${tokenMint}` },
                { text: '💸 Sell 100%', callback_data: `sell_100_${tokenMint}` }
            ],
            [
                { text: '📈 Chart', url: `https://dexscreener.com/solana/${tokenMint}` },
                { text: '📊 Price', callback_data: `price_${tokenMint}` }
            ]
        ]
    };

    await sendTelegramMessage(message, { reply_markup: keyboard });
}

async function sendStopLossAlert(tokenMint, tokenInfo, currentPrice, currentPriceUSD, stopLossPrice) {
    const tokenBalance = await getTokenBalance(wallet.publicKey.toString(), tokenMint);

    const message =
        `🛑 STOP LOSS TRIGGERED\n\n` +
        `🪙 Token: ${tokenInfo.symbol}\n` +
        `💰 Current Price: ${currentPriceUSD.toFixed(6)} (${currentPrice.toFixed(8)} SOL)\n` +
        `🛑 Stop Loss: ${stopLossPrice.toFixed(6)}\n` +
        `📉 Balance: ${formatNumber(tokenBalance)} ${tokenInfo.symbol}\n` +
        `🆔 Token: ${tokenMint} (https://dexscreener.com/solana/${tokenMint})`;

    const keyboard = {
        inline_keyboard: [
            [
                { text: '🚨 SELL 50%', callback_data: `sell_50_${tokenMint}` },
                { text: '🚨 SELL 100%', callback_data: `sell_100_${tokenMint}` }
            ],
            [
                { text: '📈 Chart', url: `https://dexscreener.com/solana/${tokenMint}` },
                { text: '📊 Price', callback_data: `price_${tokenMint}` }
            ]
        ]
    };

    await sendTelegramMessage(message, { reply_markup: keyboard });
}

async function sendTakeProfitAlert(tokenMint, tokenInfo, currentPrice, currentPriceUSD, takeProfitPrice) {
    const tokenBalance = await getTokenBalance(wallet.publicKey.toString(), tokenMint);

    const message =
        `🎯 TAKE PROFIT REACHED\n\n` +
        `🪙 Token: ${tokenInfo.symbol}\n` +
        `💰 Current Price: ${currentPriceUSD.toFixed(6)} (${currentPrice.toFixed(8)} SOL)\n` +
        `🎯 Target: ${takeProfitPrice.toFixed(6)}\n` +
        `📈 Balance: ${formatNumber(tokenBalance)} ${tokenInfo.symbol}\n` +
        `🆔 Token: ${tokenMint} (https://dexscreener.com/solana/${tokenMint})`;

    const keyboard = {
        inline_keyboard: [
            [
                { text: '💰 SELL 25%', callback_data: `sell_25_${tokenMint}` },
                { text: '💰 SELL 50%', callback_data: `sell_50_${tokenMint}` },
                { text: '💰 SELL 100%', callback_data: `sell_100_${tokenMint}` }
            ],
            [
                { text: '📈 Chart', url: `https://dexscreener.com/solana/${tokenMint}` },
                { text: '📊 Price', callback_data: `price_${tokenMint}` }
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




async function getRaydiumQuote(inputMint, outputMint, amount) {
    const url = `https://api.raydium.io/v2/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}`;

    const response = await fetch(url);
    const data = await response.json();

    if (!data || !data.outputAmount || data.outputAmount <= 0) {
        throw new Error('Raydium quote returned no valid output');
    }

    return {
        inputMint,
        outputMint,
        inputAmount: amount,
        outputAmount: data.outputAmount,
        route: data, // for logging
    };
}


async function getOrcaQuote(inputMint, outputMint, amount) {
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&onlyDirectRoutes=true&dexes=Orca`;

    const response = await fetch(url);
    const data = await response.json();

    if (!data || !data.data || data.data.length === 0) {
        throw new Error('Orca quote not available via Jupiter fallback');
    }

    return {
        inputMint,
        outputMint,
        inputAmount: amount,
        outputAmount: data.data[0].outAmount,
        route: data.data[0],
    };
}


// Global quote request queue
let jupiterQueue = Promise.resolve();

function queueJupiterRequest(delay = 800) {
    const nextCall = new Promise(resolve => {
        setTimeout(resolve, delay);
    });

    const queued = jupiterQueue.then(() => nextCall);
    jupiterQueue = queued.catch(() => {}); // Prevent unhandled rejections
    return queued;
}



async function getJupiterQuote(inputMint, outputMint, amount, slippageBps = 300, retries = 3) {
    const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: amount.toString(),
        slippageBps: slippageBps.toString(),
        onlyDirectRoutes: 'false',
        asLegacyTransaction: 'false',
    });

    const url = `${CONFIG.JUPITER_API_URL}/quote?${params}`;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await queueJupiterRequest(); // 🧠 Enforced queue before each fetch

            const response = await fetch(url);

            if (response.status === 429) {
                const delay = attempt * 1000;
                console.warn(`⚠️ Rate limited by Jupiter API. Retrying in ${delay}ms (attempt ${attempt}/${retries})...`);
                await new Promise(res => setTimeout(res, delay));
                continue;
            }

            const quote = await response.json();

            if (!quote || quote.error) {
                throw new Error(quote?.error || 'Failed to get quote');
            }

            return quote;
        } catch (err) {
            if (attempt === retries) {
                console.error(`❌ Jupiter quote failed after ${retries} attempts:`, err.message);
                throw err;
            }
        }
    }
}



// 🧠 Keep this as-is
const quoteCache = new Map();

// ✅ Correct implementation
async function getCachedJupiterQuote(inputMint, outputMint, amount, slippageBps = 300, ttl = 30_000) {
    const key = `${inputMint}_${outputMint}_${amount}_${slippageBps}`;
    const now = Date.now();

    if (quoteCache.has(key)) {
        const { timestamp, data } = quoteCache.get(key);
        if (now - timestamp < ttl) {
            return data; // ✅ Use cached quote
        }
    }

    // ⚠️ THIS must be the *original* function!
    const quote = await getJupiterQuote(inputMint, outputMint, amount, slippageBps);

    quoteCache.set(key, { timestamp: now, data: quote });
    return quote;
}

async function getBestQuote(inputMint, outputMint, amount, slippageBps) {
    try {
        const jupiter = await getCachedJupiterQuote(inputMint, outputMint, amount, slippageBps);
        console.log(`✅ Jupiter quote succeeded`);
        return { quote: jupiter.route, source: 'Jupiter' };
    } catch (err) {
        console.warn(`⚠️ Jupiter quote failed: ${err.message}`);
    }

    try {
        const raydium = await getRaydiumQuote(inputMint, outputMint, amount);
        console.log(`✅ Raydium quote succeeded`);
        return { quote: raydium.route, source: 'Raydium' };
    } catch (err) {
        console.warn(`⚠️ Raydium quote failed: ${err.message}`);
    }

    try {
        const orca = await getOrcaQuote(inputMint, outputMint, amount);
        console.log(`✅ Orca quote succeeded`);
        return { quote: orca.route, source: 'Orca' };
    } catch (err) {
        console.warn(`⚠️ Orca quote failed: ${err.message}`);
    }

    throw new Error('❌ No working quote found from Jupiter, Raydium, or Orca');
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
        const quote = await getCachedJupiterQuote(
            CONFIG.WSOL_ADDRESS,
            tokenMint,
            Math.floor(solAmount * 1e9),
            CONFIG.SLIPPAGE_BPS
        );

        const txid = await executeSwap(quote);

        const tokenInfo = await getTokenInfo(tokenMint);
        const decimals = tokenInfo.decimals || 9;
        const tokenAmount = quote.outAmount / Math.pow(10, decimals);

        recordTrade(tokenMint, 'buy', tokenAmount, solAmount, txid, tokenInfo);

        return {
            success: true,
            txid,
            amount: tokenAmount,
            tokenInfo
        };

    } catch (error) {
        console.error(`❌ buyToken() failed for ${tokenMint}:`, error.message);
        return { success: false, error: error.message };
    }
}



async function sellToken(walletAddress, tokenMint, tokenAmount) {
    const tokenInfo = await getTokenInfo(tokenMint);
    const analytics = await getTokenAnalytics(tokenMint);
    const walletName = walletNames[walletAddress] || shortenAddress(walletAddress);
    const shortMint = shortenAddress(tokenMint);

    const message =
        `🚨 SELL ORDER EXECUTED\n\n` +
        `👛 Wallet: ${walletName}\n` +
        `${walletAddress}\n` +
        `📉 Sold: ${formatNumber(tokenAmount)} ${tokenInfo.symbol}\n` +
        `🪙 Token: ${shortMint} (${tokenInfo.name || 'Unknown Token'})\n` +
        `💧 Liquidity: ${formatNumber(analytics.liquidity)}\n` +
        `👥 Holders: ${analytics.holders}\n` +
        `🆔 Token: ${tokenMint} (https://dexscreener.com/solana/${tokenMint})`;

    const keyboard = {
        inline_keyboard: [
            [
                { text: '💰 Buy 0.01 SOL', callback_data: `buy_0.01_${tokenMint}` },
                { text: '📊 Price', callback_data: `price_${tokenMint}` },
                { text: '📈 Chart', url: `https://dexscreener.com/solana/${tokenMint}` }
            ],
            [
                { text: '💼 Balance', callback_data: `balance_${tokenMint}` },
                { text: '🔄 Copytrade', callback_data: `copytrade_${walletAddress}` }
            ]
        ]
    };

    await sendTelegramMessage(message, { reply_markup: keyboard });
    console.log(`🚨 Sold ${tokenAmount} ${tokenInfo.symbol} from ${walletName}`);
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
        if (data.startsWith('remove_copy_')) {
    const uid = data.split('_')[2];
    const stored = pendingCopytrades.get(uid);

    if (stored) {
        const { walletAddress, tokenMint } = stored;

        try {
            // ✅ FIX: Get *bot wallet's* balance, not source wallet
            const amount = await getTokenBalance(wallet.publicKey.toString(), tokenMint);

            if (amount > 0) {
                const quote = await getCachedJupiterQuote(
                    tokenMint,
                    CONFIG.WSOL_ADDRESS,
                    Math.floor(amount * 1e6), // assuming 6 decimals
                    CONFIG.SLIPPAGE_BPS
                );

                await executeSwap(quote);
                console.log(`✅ Swapped back ${amount} of ${tokenMint} to SOL`);
            } else {
                console.log(`ℹ️ No balance of ${tokenMint} found in bot wallet`);
            }

            // ✅ Clean up tracking
            if (copytradeEnabled[walletAddress]) {
                delete copytradeEnabled[walletAddress][tokenMint];
                if (Object.keys(copytradeEnabled[walletAddress]).length === 0) {
                    delete copytradeEnabled[walletAddress];
                }
            }

            await bot.answerCallbackQuery(callbackQuery.id, { text: 'Autotrade removed.' });

            await bot.sendMessage(chatId,
                `❌ <b>Autotrade Removed</b>\n\n` +
                `👛 Wallet: <code>${walletAddress}</code>\n` +
                `🪙 Token: <code>${tokenMint}</code>\n` +
                `🔄 Swapped back to SOL.`,
                { parse_mode: 'HTML' }
            );

        } catch (err) {
            console.error(`❌ Error during token reversal:`, err);
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: '❌ Error removing autotrade',
                show_alert: true
            });
        }
    } else {
        await bot.answerCallbackQuery(callbackQuery.id, {
            text: '❌ Invalid remove request',
            show_alert: true
        });
    }

    return;
}


 // Toggle Auto Copy
    if (data.startsWith('copywallet_toggle_')) {
        const shortId = data.replace('copywallet_toggle_', '');
        const walletAddress = walletShortMap.get(shortId);
        if (!walletAddress) return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Wallet not found.' });

        if (!copytradeEnabled[walletAddress]) {
            copytradeEnabled[walletAddress] = {
                enabled: true,
                amount: CONFIG.COPYTRADE_AMOUNT_SOL || 0.0005
            };
        } else {
            copytradeEnabled[walletAddress].enabled = !copytradeEnabled[walletAddress].enabled;
        }

        const isEnabled = copytradeEnabled[walletAddress].enabled;
        const amount = copytradeEnabled[walletAddress].amount || CONFIG.COPYTRADE_AMOUNT_SOL || 0.0005;
        const walletName = walletNames[walletAddress] || walletAddress;

        await bot.answerCallbackQuery(callbackQuery.id, {
            text: `Auto-copy ${isEnabled ? 'ENABLED ✅' : 'DISABLED ❌'}`
        });

        await bot.sendMessage(chatId, `🔁 Auto-copy for <b>${walletName}</b> is now <b>${isEnabled ? 'ENABLED ✅' : 'DISABLED ❌'}</b>\nTrade amount: <code>${amount} SOL</code>`, {
            parse_mode: 'HTML'
        });

        return bot.emit('text', { ...callbackQuery.message, text: '/copywallet' });
    }

    // Set specific amount per wallet
    if (data.startsWith('copywallet_setamount_')) {
        const shortId = data.replace('copywallet_setamount_', '');
        const walletAddress = walletShortMap.get(shortId);
        if (!walletAddress) return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Wallet not found.' });

        await bot.answerCallbackQuery(callbackQuery.id);
        await bot.sendMessage(chatId, `💰 Enter SOL amount to use per trade for:\n<code>${walletNames[walletAddress] || walletAddress}</code>`, {
            parse_mode: 'HTML'
        });

        bot.once('message', async (msg) => {
            const input = parseFloat(msg.text.trim());

            if (!isNaN(input) && input > 0) {
                if (!copytradeEnabled[walletAddress]) {
                    copytradeEnabled[walletAddress] = { enabled: false };
                }

                copytradeEnabled[walletAddress].amount = parseFloat(input.toFixed(6));

                await bot.sendMessage(chatId, `✅ Amount set to <code>${input}</code> SOL for <b>${walletNames[walletAddress] || walletAddress}</b>`, {
                    parse_mode: 'HTML'
                });

                return bot.emit('text', { ...msg, text: '/copywallet' });
            } else {
                await bot.sendMessage(chatId, `❌ Invalid amount. Please enter a number greater than 0.`);
            }
        });

        return;
    }











if (data.startsWith('buy')) {
    const parts = data.split('_');
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
        text: `Buying ${amount} SOL of token...`
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
            `✅ <b>Token bought successfully</b>\n\n` +
            `🪙 Token: ${result.tokenInfo.symbol || tokenMint}\n` +
            `💰 Spent: ${amount} SOL\n` +
            `📦 Received: ${formatNumber(result.amount)} tokens\n` +
            `🔗 <a href="https://solscan.io/tx/${result.txid}">View Transaction</a>`,
            { parse_mode: 'HTML', disable_web_page_preview: true }
        );
    } else {
        await bot.sendMessage(chatId,
            `❌ <b>Buy failed</b>\n\nError: ${result.error}`,
            { parse_mode: 'HTML' }
        );
    }

    return;
}

if (data.startsWith('sell_')) {
    const parts = data.split('_');
    const percentage = parseInt(parts[1]); // 25, 50, 100
    const tokenMint = parts.slice(2).join('_'); // in case tokenMint has underscores

    await bot.answerCallbackQuery(callbackQuery.id, {
        text: `Selling ${percentage}% of your ${tokenMint} tokens...`
    });

    try {
        const balance = await getTokenBalance(wallet.publicKey.toString(), tokenMint);

        if (balance <= 0) {
            await bot.sendMessage(chatId, `❌ You have 0 ${tokenMint} to sell.`);
            return;
        }

        const amountToSell = balance * (percentage / 100);

        const quote = await getCachedJupiterQuote(
            tokenMint,
            CONFIG.WSOL_ADDRESS,
            Math.floor(amountToSell * Math.pow(10, 6)), // 6 = assume USDC or SOL decimals; adjust if needed
            CONFIG.SLIPPAGE_BPS
        );

        const txid = await executeSwap(quote);

        await bot.sendMessage(chatId,
            `✅ <b>Sell Executed</b>\n\n` +
            `🪙 Token: ${tokenMint}\n` +
            `📉 Sold: ${formatNumber(amountToSell)} tokens\n` +
            `🔗 <a href="https://solscan.io/tx/${txid}">View Transaction</a>`,
            { parse_mode: 'HTML', disable_web_page_preview: true }
        );

    } catch (err) {
        console.error(`❌ Sell failed: ${err.message}`);
        await bot.sendMessage(chatId,
            `❌ <b>Sell Failed</b>\n\n<code>${err.message}</code>`,
            { parse_mode: 'HTML' }
        );
    }

    return;
}



if (data.startsWith('multi_dex_')) {
    const tokenMint = data.replace('multi_dex_', '');
    const keyboard = {
        inline_keyboard: [
            [
                { text: "🔁 Raydium", url: `https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${tokenMint}` },
                { text: "🐳 Orca", url: `https://www.orca.so/token/${tokenMint}` }
            ],
            [
                { text: "🌊 Meteora", url: `https://app.meteora.ag/swap?outputMint=${tokenMint}` },
                { text: "⚛️ Photon", url: `https://photon.art/swap/${tokenMint}` }
            ]
        ]
    };

    await bot.sendMessage(chatId,
        `🌐 <b>Multi-DEX Links</b>\n\nToken Mint:\n<code>${tokenMint}</code>`,
        { parse_mode: 'HTML', reply_markup: keyboard }
    );

    await bot.answerCallbackQuery(callbackQuery.id);
    return;
}



// STEP 1: Show trading mode options
if (data.startsWith("auto_trade_token_")) {
    const tokenAddress = data.replace("auto_trade_token_", "");

    const keyboard = {
        inline_keyboard: [
            [
                { text: "⚙️ Manual Trade", callback_data: `auto_trade_manual_${tokenAddress}` },
                { text: "⚡ Quick Trade (0.0001)", callback_data: `auto_trade_preset_${tokenAddress}` }
            ]
        ]
    };

    await bot.sendMessage(chatId, `🛠 Choose trading mode for token:\n<code>${tokenAddress}</code>`, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
    return;
}

// STEP 2: Handle trade mode selection
if (data.startsWith("auto_trade_manual_") || data.startsWith("auto_trade_preset_")) {
    const isManual = data.startsWith("auto_trade_manual_");
    const tokenAddress = data.split("_").pop();
    const mode = isManual ? "manual" : "preset";

    await bot.answerCallbackQuery(callbackQuery.id, { text: `Starting ${mode} trade...` });
    await auto_trade(chatId, mode, tokenAddress);
    return;
}

if (data.startsWith('autocopytrade_')) {
    const uid = data.split('_')[1];
    const stored = pendingCopytrades.get(uid);

    if (!stored || !stored.walletAddress || !stored.tokenMint) {
        await bot.answerCallbackQuery(callbackQuery.id, {
            text: '❌ Invalid or expired autocopytrade data',
            show_alert: true
        });
        return;
    }

    const { walletAddress, tokenMint } = stored;
    const chatId = callbackQuery.message.chat.id;

    const ask = async (text) => {
        await bot.sendMessage(chatId, text);
        return new Promise((resolve) => {
            bot.once('message', (msg) => resolve(msg.text.trim()));
        });
    };

    try {
        // Ask user for SOL amount
        let solAmount = 0;
        while (true) {
            const input = await ask("💰 Enter SOL amount to copy trade:");
            const value = parseFloat(input);
            if (!isNaN(value) && value > 0) {
                solAmount = parseFloat(value.toFixed(6));
                break;
            } else {
                await bot.sendMessage(chatId, "❌ Invalid amount. Please enter a number > 0.");
            }
        }

        const quote = await getCachedJupiterQuote(
            CONFIG.WSOL_ADDRESS,
            tokenMint,
            Math.floor(solAmount * 1e9),
            CONFIG.SLIPPAGE_BPS
        );

        const txid = await executeSwap(quote);
        if (!txid) throw new Error('Swap transaction failed');

        const allTrades = loadTradeMemory();
        allTrades.push({
            timestamp: Date.now(),
            type: 'copy',
            wallet: walletAddress,
            token: tokenMint,
            txid
        });
        saveTradeMemory(allTrades);

        // Enable copytrade tracking
        if (!copytradeEnabled[walletAddress]) copytradeEnabled[walletAddress] = {};
        copytradeEnabled[walletAddress][tokenMint] = {
            enabled: true,
            chatId: chatId
        };

        const tokenInfo = await getTokenInfo(tokenMint);
        const analytics = await getTokenAnalytics(tokenMint);
        const tokenName = tokenInfo?.symbol || tokenMint;

        const removeId = uuidv4().slice(0, 8);
        pendingCopytrades.set(removeId, { walletAddress, tokenMint });

        const message =
            `✅ <b>Autocopytrade Successful</b>\n\n` +
            `👛 <b>Wallet:</b> <a href="https://solscan.io/account/${walletAddress}">${shortenAddress(walletAddress)}</a>\n` +
            `🪙 <b>Token:</b> <a href="https://dexscreener.com/solana/${tokenMint}">${tokenName}</a>\n` +
            `💰 <b>Amount Bought:</b> ${solAmount} SOL\n\n` +
            `📊 <b>Liquidity:</b> ${formatNumber(analytics.liquidity)}\n` +
            `📈 <b>24h Volume:</b> ${formatNumber(analytics.volume24h)}\n` +
            `👥 <b>Holders:</b> ${analytics.holders}`;

        const keyboard = {
            inline_keyboard: [
                [
                    {
                        text: '❌ Remove Autocopytrade',
                        callback_data: `remove_copy_${removeId}`
                    }
                ],
                [
                    { text: '📊 Dexscreener', url: `https://dexscreener.com/solana/${tokenMint}` },
                    { text: '🦉 Birdeye', url: `https://birdeye.so/token/${tokenMint}?chain=solana` }
                ],
                [
                    { text: '🔍 View Wallet', url: `https://solscan.io/account/${walletAddress}` }
                ]
            ]
        };

        await bot.sendMessage(chatId, message, {
            parse_mode: 'HTML',
            disable_web_page_preview: false,
            reply_markup: keyboard
        });

        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Autocopytrade successful!' });
        console.log(`✅ Copied trade: ${walletAddress} → ${tokenMint}`);

        // 👀 Start monitoring for auto-sell when original wallet sells
        monitorOriginalTraderSell(walletAddress, tokenMint);

    } catch (err) {
        console.error(`❌ Autocopytrade failed: ${err.message}`);
        await bot.sendMessage(chatId,
            `❌ <b>Autocopytrade Failed</b>\n\n<code>${err.message}</code>`,
            { parse_mode: 'HTML' }
        );
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Autocopytrade failed.' });
    }

    return;
}

if (data === 'copywallet') {
    let message = `🔄 <b>Wallet-Wide Copytrade</b>\n\n`;
    message += `Default amount per trade: ${CONFIG.COPYTRADE_AMOUNT_SOL} SOL\n`;
    message += `Smart Filters: ${COPYTRADE_FILTERS.enableFilters ? '✅ Enabled' : '❌ Disabled'}\n\n`;

    const keyboard = { inline_keyboard: [] };
    walletShortMap.clear();

    let index = 0;

    for (const [walletAddress, walletName] of Object.entries(walletNames)) {
        const shortId = `w${index++}`;
        walletShortMap.set(shortId, walletAddress);

        const isEnabled = copytradeEnabled[walletAddress]?.enabled || false;
        const amount = copytradeEnabled[walletAddress]?.amount || CONFIG.COPYTRADE_AMOUNT_SOL || 0.0005;
        const status = isEnabled ? '✅' : '❌';

        keyboard.inline_keyboard.push([
            {
                text: `${status} ${walletName} (${amount} SOL)`,
                callback_data: `copywallet_toggle_${shortId}`
            },
            {
                text: '⚙️ Set Amount',
                callback_data: `copywallet_setamount_${shortId}`
            }
        ]);
    }

    message += `Click a wallet to toggle copy mode or change amount:\n`;
    message += `✅ = Enabled, ❌ = Disabled\n\n`;
    message += `<i>The bot will auto-buy tokens that wallet buys (if filters pass).</i>`;

    await bot.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });

    await bot.answerCallbackQuery(callbackQuery.id);
    return;
}






if (data === 'show_recent_trades') {
    const now = Date.now();
    const history = loadTradeMemory();

    const recent = history
        .filter(t =>
            (t.type === 'copy' || t.type === 'auto') &&
            now - t.timestamp < 3 * 60 * 60 * 1000
        )
        .slice(-10);

    if (!recent.length) {
        await bot.sendMessage(chatId, '📭 No trades in the last 3h.');
    } else {
        let msg = `<b>📜 Recent Trades (last 3h)</b>\n\n`;
        for (const trade of recent) {
            const ageMin = Math.floor((now - trade.timestamp) / 60000);
            const tokenLink = `https://dexscreener.com/solana/${trade.token}`;
            const typeLabel = trade.type === 'auto' ? 'Autotrade' : 'Copytrade';

            msg += `🔁 <b>${typeLabel}</b> - <a href="${tokenLink}">${trade.token.slice(0, 6)}...</a>\n`;
            msg += `👛 ${shortenAddress(trade.wallet)} | ${ageMin} min ago\n\n`;
        }

        await bot.sendMessage(chatId, msg, {
            parse_mode: 'HTML',
            disable_web_page_preview: false
        });
    }

    await bot.answerCallbackQuery(callbackQuery.id);
    return;
}




if (data === 'scan_memes') {
  try {
    const res = await fetch('https://api.dexscreener.com/token-boosts/latest/v1');
    const tokens = await res.json();

    const memes = tokens
      .filter(t => t.chainId === 'solana')
      .filter(t => t.header?.toLowerCase().match(/doge|bonk|pepe|cat|elon|meme|floki|inu/))
      .slice(0, 5);

    if (memes.length === 0) {
      await bot.sendMessage(chatId, "🧪 No boosted meme tokens found.");
    } else {
      let msg = `🚀 <b>Boosted Meme Tokens</b>\n\n`;
      for (const t of memes) {
        msg += `🪙 <a href="${t.url}">${t.header}</a>\n`;
        msg += `🌐 ${t.chainId}\n\n`;
      }
      await bot.sendMessage(chatId, msg, { parse_mode: 'HTML', disable_web_page_preview: false });
    }

  } catch (err) {
    console.error("❌ Meme scanner failed:", err.message);
    await bot.sendMessage(chatId, "❌ Failed to scan trending meme tokens.");
  }

  await bot.answerCallbackQuery(callbackQuery.id);
  return;
}




if (data === 'show_trending') {
    try {
        const trackedTokens = [
            "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E", // USDT
            "Es9vMFrzdRgK7U8qF8efFt3fVsAeGz8CC2fBafnXzC5E", // USDC
            "4k3Dyjzvzp8eGZzU7nNyqGHTrp44xh6tjkTv3SzcHkMF", // RAY
            "DUw3ECw1U2QknAQ7GE22tmdPX93YXg2ZYwAfWHmXYDKa", // Bonk
            "7MBjK7NVy3ZyzEZ5j5Tc6KPK1ZEXW3c9dLw3bcCcuVyd"  // Random meme
        ];

        const results = [];

        for (const token of trackedTokens) {
            const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${token}`);
            const json = await res.json();
            const pair = json.pairs?.[0];
            if (!pair) continue;

            results.push({
                symbol: pair.baseToken.symbol,
                change: pair.priceChange?.h24 || 0,
                liquidity: pair.liquidity?.usd || 0,
                volume: pair.volume?.h24 || 0,
                url: `https://dexscreener.com/solana/${pair.pairAddress}`
            });
        }

        results.sort((a, b) => b.change - a.change);
        const top = results.slice(0, 5);

        let msg = `📈 <b>Top Gainers (24h)</b>\n\n`;
        for (const token of top) {
            msg += `🪙 <a href="${token.url}">${token.symbol}</a>\n`;
            msg += `📈 +${token.change.toFixed(2)}%\n`;
            msg += `💧 $${Math.floor(token.liquidity)} | Vol: $${Math.floor(token.volume)}\n\n`;
        }

        await bot.sendMessage(chatId, msg, {
            parse_mode: 'HTML',
            disable_web_page_preview: false
        });

    } catch (err) {
        console.error('Trending fetch failed:', err.message);
        await bot.sendMessage(chatId, '❌ Failed to load trending tokens.');
    }

    await bot.answerCallbackQuery(callbackQuery.id);
    return;
}



if (data === 'show_risk') {
    const filters = COPYTRADE_FILTERS;
    const msg =
        `🧠 <b>Risk Filter Settings</b>\n\n` +
        `• 💧 Min Liquidity: <b>$${filters.minLiquidity}</b>\n` +
        `• 👥 Min Holders: <b>${filters.minHolders}</b>\n` +
        `• 📈 Min 24h Volume: <b>$${filters.minVolume}</b>\n\n` +
        `Use /setfilter to modify these.`;

    await bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
    await bot.answerCallbackQuery(callbackQuery.id);
    return;
}

if (data === 'stoploss_menu') {
    const status = GLOBAL_STOPLOSS.enabled ? '✅ Enabled' : '❌ Disabled';
    const msg =
        `🛡️ <b>Global Stop Loss</b>\n\n` +
        `• Status: ${status}\n` +
        `• Threshold: <b>${GLOBAL_STOPLOSS.percent}%</b>\n\n` +
        `Use /stoploss [on/off] [percent]`;

    await bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
    await bot.answerCallbackQuery(callbackQuery.id);
    return;
}


if (data === 'show_copytrades') {
    const active = [];

    for (const [walletAddr, tokens] of Object.entries(copytradeEnabled)) {
        for (const [tokenMint, enabled] of Object.entries(tokens)) {
            if (!enabled) continue;

            const tokenInfo = await getTokenInfo(tokenMint);
            const walletName = walletNames[walletAddr] || shortenAddress(walletAddr);
            const tokenSymbol = tokenInfo?.symbol || tokenMint;

            const message =
                `👛 <b>${walletName}</b>\n` +
                `🪙 <a href="https://dexscreener.com/solana/${tokenMint}">${tokenSymbol}</a>\n` +
                `🔁 Autocopytrade active`;

            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '💰 Buy 0.01', callback_data: `buy_0.01_${tokenMint}` },
                        { text: '💰 Buy 0.05', callback_data: `buy_0.05_${tokenMint}` },
                        { text: '💰 Buy 0.1', callback_data: `buy_0.1_${tokenMint}` }
                    ],
                    [
                        { text: '💸 Sell 25%', callback_data: `sell_25_${tokenMint}` },
                        { text: '💸 Sell 50%', callback_data: `sell_50_${tokenMint}` },
                        { text: '💸 Sell 100%', callback_data: `sell_100_${tokenMint}` }
                    ],
                    [
                        { text: '📊 Price', callback_data: `price_${tokenMint}` },
                        { text: '📈 Chart', url: `https://dexscreener.com/solana/${tokenMint}` }
                    ]
                ]
            };

            await bot.sendMessage(chatId, message, {
                parse_mode: 'HTML',
                reply_markup: keyboard
            });
        }
    }

    if (Object.keys(copytradeEnabled).length === 0) {
        await bot.sendMessage(chatId, `ℹ️ No active copytrades.`);
    }

    await bot.answerCallbackQuery(callbackQuery.id);
    return;
}



if (data === 'auto_trade_menu') {
    const tradeKeyboard = {
        inline_keyboard: [
            [
                { text: '⚙️ Manual Trade', callback_data: 'auto_trade_manual' },
                { text: '⚡ Quick Trade (0.0001)', callback_data: 'auto_trade_preset' }
            ]
        ]
    };

    await bot.sendMessage(chatId, "🛠 Choose your trading mode:", {
        reply_markup: tradeKeyboard
    });
    return;
}

if (data === 'auto_trade_manual' || data === 'auto_trade_preset') {
    const mode = data === 'auto_trade_manual' ? 'manual' : 'preset';
    await bot.answerCallbackQuery(callbackQuery.id, { text: `Starting ${mode} trade...` });
    await auto_trade(chatId, mode);
    return;
}


if (data === 'cmd_portfolio') {
    await bot.answerCallbackQuery(callbackQuery.id);
    await handlePortfolioCommand(chatId);
    return;
}






if (data === 'cmd_pl') {
    await bot.answerCallbackQuery(callbackQuery.id);
    await handlePLCommand(chatId);
    return;
}


if (data === 'cmd_alerts') {
    await bot.answerCallbackQuery(callbackQuery.id);
    await handleAlertsCommand(chatId);
    return;
}


if (data === 'multi_dex_global') {
    const defaultToken = 'So11111111111111111111111111111111111111112'; // WSOL or placeholder
    await sendMultiDexLinks(chatId, defaultToken);
    await bot.answerCallbackQuery(callbackQuery.id);
    return;
}

if (data === 'social_global') {
    await sendGlobalNewsLinks(chatId);
    await bot.answerCallbackQuery(callbackQuery.id);
    return;
}



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

bot.on('message', async msg => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (userState[userId]?.action === 'awaiting_manual_rebuy_pct') {
        const { tokenMint, amount, sellPct } = userState[userId];
        const rebuyPct = parseFloat(msg.text);

        const currentPrice = await getTokenPrice(tokenMint);
        if (!currentPrice) {
            await bot.sendMessage(chatId, `❌ Could not fetch current price for token.`);
            delete userState[userId];
            return;
        }

        autotradeTargets[tokenMint] = {
            tokenMint,
            chatId,
            userId,
            amount,
            basePrice: currentPrice,
            sellAt: currentPrice * (1 + sellPct / 100),
            rebuyAt: currentPrice * (1 - rebuyPct / 100),
            sold: false,
            originalSellPct: sellPct,
            originalRebuyPct: rebuyPct
        };

        await bot.sendMessage(chatId,
            `✅ Trade activated:\n` +
            `• Token: <code>${tokenMint}</code>\n` +
            `• Amount: ${amount} SOL\n` +
            `• Sell Target: +${sellPct}%\n` +
            `• Rebuy Dip: -${rebuyPct}%`,
            { parse_mode: 'HTML' }
        );

        delete userState[userId];
        return;
    }
});



// ====== BOT COMMANDS ======
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;

    await bot.sendMessage(chatId, '🔄 Initializing bot...');

    try {
        const [solBalance, tokenMints] = await Promise.all([
            wallet ? getTokenBalance(wallet.publicKey.toString(), CONFIG.WSOL_ADDRESS) : 0,
            Promise.resolve(Object.keys(tradeHistory))
        ]);

        const alertCount = Object.keys(priceAlerts).length;
        const copytradeCount = Object.values(copytradeEnabled).flatMap(t => Object.values(t)).filter(Boolean).length;

        const plResults = await Promise.all(tokenMints.map(calculateProfitLoss));
        const totalPL = plResults.reduce((sum, pl) => sum + (pl?.totalPL || 0), 0);

        const message = `🚀 <b>Advanced Crypto Trading Bot</b>\n\n` +
            `📊 <b>Portfolio Summary:</b>\n` +
            `• Wallet Balance: ${solBalance.toFixed(4)} SOL\n` +
            `• Active Positions: ${tokenMints.length}\n` +
            `• Total P/L: ${totalPL >= 0 ? '+' : ''}${totalPL.toFixed(4)} SOL\n` +
            `• Price Alerts: ${alertCount}\n` +
            `• Copytrade Active: ${copytradeCount} tokens\n` +
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
            `/copywallet - copywallet toggle\n` +
            `/showOngoingCopyTrades - Ongoing copytrades\n` +
            `/filters - Configure filters\n` +
            `/blacklist - Manage blacklisted tokens\n` +
            `/stats - View statistics\n` +
            `/wallet - Show trading wallet\n` +
            `/help - Show all commands`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: "📊 Portfolio", callback_data: "cmd_portfolio" },
                    { text: "📈 P/L Report", callback_data: "cmd_pl" },
                ],
                [{ text: '📜 Recent Trades (3h)', callback_data: 'show_recent_trades' }],
                [
                    { text: "🔔 Price Alerts", callback_data: "cmd_alerts" },
                    { text: '🔄 Copy Wallet', callback_data: 'copywallet' },
                ],
                [
                    { text: tradingPaused ? '▶️ Resume Trading' : '⏸️ Pause Trading', callback_data: 'pause_trading' },
                    { text: '📢 Social Monitor', callback_data: 'social_global' }
                ],
                [
                    { text: "📈 Trending", callback_data: "show_trending" },
                    { text: "🧠 Risk Filters", callback_data: "show_risk" }
                ],
                [
                    { text: "🛡️ Stop Loss", callback_data: "stoploss_menu" },
                    { text: '📋 Ongoing Copytrades', callback_data: 'show_copytrades' }
                ],
                [
                    { text: "🚀 Trending Meme Boosts", callback_data: "scan_memes" },
                    { text: '🔄 Refresh', callback_data: 'cmd_start' }
                ]
            ]
        };

        await bot.sendMessage(chatId, message, {
            parse_mode: 'HTML',
            reply_markup: keyboard
        });

    } catch (err) {
        console.error('/start error:', err);
        await bot.sendMessage(chatId, '❌ Failed to load bot info.');
    }
});



bot.onText(/\/help/, async (msg) => {
    const message = `📚 <b>Bot Commands & Features</b>\n\n` +
        `<b>🎯 Smart Features:</b>\n` +
        `• Auto Profit Targets: 10%, 25%, 50%, 100%\n` +
        `• Trailing Stop Loss: Follows price up\n` +
        `• Smart Copytrade Filters: Min liquidity/holders\n` +
        `• Daily Loss Limit: -20% max\n\n` +
        `<b>📱 Commands:</b>\n` +
        `/start - Main dashboard\n` +
        `/portfolio - View all tokens & balances\n` +
        `/pl - Profit/Loss report\n` +
        `/copywallet - Enable/disable wallet copying\n` +
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

bot.onText(/\/pl/, async (msg) => {
    await handlePLCommand(msg.chat.id);
});

bot.onText(/\/alerts/, async (msg) => {
    await handleAlertsCommand(msg.chat.id);
});

bot.onText(/\/stoploss (on|off) ?([\d.]*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const enabled = match[1] === 'on';
    const percent = parseFloat(match[2]) || GLOBAL_STOPLOSS.percent;

    GLOBAL_STOPLOSS.enabled = enabled;
    GLOBAL_STOPLOSS.percent = percent;

    await bot.sendMessage(chatId, `🛡️ Global Stop Loss ${enabled ? 'enabled' : 'disabled'} at ${percent}%`);
});

bot.onText(/\/setfilter (\w+) (\d+)/, async (msg, match) => {
    const [_, key, value] = match;
    const chatId = msg.chat.id;

    if (!['minLiquidity', 'minHolders', 'minVolume'].includes(key)) {
        return bot.sendMessage(chatId, `❌ Invalid filter key. Use minLiquidity, minHolders, or minVolume.`);
    }

    COPYTRADE_FILTERS[key] = Number(value);
    await bot.sendMessage(chatId, `✅ Updated ${key} to ${value}`);
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

 

// Global mapping to resolve short IDs back to full wallet addresses
const walletShortMap = new Map();

bot.onText(/\/copywallet/, async (msg) => {
    const chatId = msg.chat.id;

    let message = `🔄 <b>Auto Copy Wallet Settings</b>\n\n`;
    message += `<i>Select a wallet to toggle Auto Copy and set trade amount.</i>\n\n`;

    const keyboard = { inline_keyboard: [] };
    walletShortMap.clear();

    let index = 0;

    for (const [walletAddress, walletName] of Object.entries(walletNames)) {
        const isEnabled = copytradeEnabled[walletAddress]?.enabled || false;
        const amount = copytradeEnabled[walletAddress]?.amount || CONFIG.COPYTRADE_AMOUNT_SOL || 0.0005;
        const status = isEnabled ? '✅' : '❌';

        const shortId = `w${index++}`;
        walletShortMap.set(shortId, walletAddress);

        keyboard.inline_keyboard.push([
            {
                text: `${status} ${walletName} (${amount} SOL)`,
                callback_data: `copywallet_toggle_${shortId}`
            },
            {
                text: '⚙️ Set Amount',
                callback_data: `copywallet_setamount_${shortId}`
            }
        ]);
    }

    await bot.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});





bot.onText(/\/portfolio/, async (msg) => {
    await handlePortfolioCommand(msg.chat.id);
});





bot.onText(/\/autotrade/, async (msg) => {
    const chatId = msg.chat.id;

    const keyboard = {
        inline_keyboard: [
            [
                { text: '⚙️ Manual Trade', callback_data: 'auto_trade_manual' },
                { text: '⚡ Quick Trade (0.0001)', callback_data: 'auto_trade_preset' }
            ]
        ]
    };

    await bot.sendMessage(chatId, "🛠 Choose your trading mode:", {
        reply_markup: keyboard
    });
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
            console.log(`❌ Low liquidity: ${analytics.liquidity} < ${COPYTRADE_FILTERS.minLiquidity}`);
            return false;
        }
        
        // Check market cap
        if (analytics.marketCap < COPYTRADE_FILTERS.minMarketCap) {
            console.log(`❌ Low market cap: ${analytics.marketCap} < ${COPYTRADE_FILTERS.minMarketCap}`);
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
    // Cache for 5 minutes
    if (tokenAnalytics[tokenMint] && 
        tokenAnalytics[tokenMint].timestamp > Date.now() - 300000) {
        return tokenAnalytics[tokenMint];
    }

    try {
        // Use search API instead of exact mint API
        const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${tokenMint}`);
        if (!res.ok) throw new Error(`Dexscreener search failed: ${res.status}`);

        const result = await res.json();
        const pair = result.pairs?.[0];

        if (!pair) throw new Error('No token match found on Dexscreener');

        const analytics = {
            tokenMint,
            symbol: pair.baseToken?.symbol || '',
            liquidity: Number(pair.liquidity?.usd) || 0,
            volume24h: Number(pair.volume?.h24) || 0,
            holders: 0, // still not available here
            priceChange24h: parseFloat(pair.priceChange?.h24 || 0),
            timestamp: Date.now()
        };

        tokenAnalytics[tokenMint] = analytics;
        return analytics;

    } catch (err) {
        console.error(`❌ Dexscreener fetch failed for ${tokenMint}: ${err.message}`);
        return {
            tokenMint,
            symbol: '',
            liquidity: 0,
            volume24h: 0,
            holders: 0,
            priceChange24h: 0,
            timestamp: Date.now()
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
async function checkProfitTargets(chatId) {
    for (const tokenMint of Object.keys(profitTargets)) {
        const target = profitTargets[tokenMint];
        const basePrice = target.buyPrice;
        const sellPct = target.targetPct;
        const autoSellPortion = target.autoSellPct || 50;

        const currentPrice = await getTokenPrice(tokenMint);
        if (!currentPrice || !basePrice) continue;

        const profitPct = ((currentPrice - basePrice) / basePrice) * 100;
        console.log(`[DEBUG] ${tokenMint} | Base: ${basePrice}, Current: ${currentPrice}, Profit: ${profitPct.toFixed(2)}%, Target: ${sellPct}%`);

        if (profitPct >= sellPct) {
            console.log(`[DEBUG] Profit target HIT for ${tokenMint}`);

            const balance = await getTokenBalance(wallet.publicKey.toString(), tokenMint);
            if (balance <= 0) {
                console.log(`[DEBUG] Skipping ${tokenMint} — No token balance`);
                continue;
            }

            const sellAmount = Math.floor(balance * autoSellPortion / 100 * 1e6); // assuming 6 decimals
            console.log(`[DEBUG] Calculated sell amount for ${tokenMint}: ${sellAmount}`);
            if (sellAmount <= 0) continue;

            try {
                const quote = await getCachedJupiterQuote(
                    tokenMint,
                    CONFIG.WSOL_ADDRESS,
                    sellAmount,
                    CONFIG.SLIPPAGE_BPS
                );

                if (!quote) {
                    console.warn(`⚠️ No Jupiter quote found for ${tokenMint}`);
                    await bot.sendMessage(chatId,
                        `⚠️ <b>Auto-sell failed</b>\n\n` +
                        `🪙 Token: <code>${shortenAddress(tokenMint)}</code>\n` +
                        `📈 Profit: +${profitPct.toFixed(2)}%\n` +
                        `🚫 No Jupiter route found for this token.\n\n` +
                        `Try manually selling on a DEX.`,
                        { parse_mode: 'HTML' }
                    );
                    continue;
                }

                const txid = await executeSwap(quote);
                console.log(`✅ Swapped ${tokenMint} for SOL | txid: ${txid}`);

                await bot.sendMessage(chatId,
                    `🚀 <b>PROFIT TARGET HIT!</b>\n\n` +
                    `🪙 Token: <code>${shortenAddress(tokenMint)}</code>\n` +
                    `📈 Profit: +${profitPct.toFixed(2)}%\n` +
                    `💸 Auto-sold ${autoSellPortion}% of your position\n\n` +
                    `<a href="https://solscan.io/tx/${txid}">🔗 View on Solscan</a>`,
                    { parse_mode: 'HTML' }
                );

            } catch (err) {
                console.error(`❌ Failed to auto-sell ${tokenMint}:`, err.message);
                await bot.sendMessage(chatId,
                    `❌ <b>Auto-sell failed</b>\n\n` +
                    `🪙 Token: <code>${shortenAddress(tokenMint)}</code>\n` +
                    `💥 Error: ${err.message}`,
                    { parse_mode: 'HTML' }
                );
            }

            delete profitTargets[tokenMint];
            console.log(`[DEBUG] Removed ${tokenMint} from profitTargets`);
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
// Monitor open positions for profit targets and trailing stops
async function monitorPositions() {
    if (tradingPaused) return;

    console.log(`\n📊 Monitoring positions at ${new Date().toLocaleTimeString()}...`);

    // Update SOL price first
    await getSolPriceUSD();

    // Get all positions with open balances
    for (const [tokenMint, history] of Object.entries(tradeHistory)) {
        // Skip if no open position
        if (history.totalBought <= history.totalSold) continue;

        try {
            // Get current balance
            const balance = await getTokenBalance(wallet.publicKey.toString(), tokenMint);
            if (balance === 0) continue;

            // Get current price
            const currentPrice = await getTokenPrice(tokenMint);
            if (!currentPrice) continue;

            const tokenInfo = await getTokenInfo(tokenMint);
            const profitPercent = ((currentPrice - history.averageBuyPrice) / history.averageBuyPrice) * 100;

            console.log(`📊 ${tokenInfo.symbol}: ${profitPercent >= 0 ? '+' : ''}${profitPercent.toFixed(2)}% (${currentPrice.toFixed(8)} SOL)`);

            // ✅ Inline profit target check instead of calling checkProfitTargets()
            const trackedTarget = profitTargets[tokenMint];
            if (trackedTarget) {
                const sellPct = trackedTarget.targetPct;
                const autoSellPortion = trackedTarget.autoSellPct || 50;
                const chatId = trackedTarget.chatId;

                if (profitPercent >= sellPct) {
                    const sellAmount = Math.floor(balance * autoSellPortion / 100 * 1e6); // assuming 6 decimals
                    if (sellAmount > 0) {
                        try {
                            const quote = await getCachedJupiterQuote(
                                tokenMint,
                                CONFIG.WSOL_ADDRESS,
                                sellAmount,
                                CONFIG.SLIPPAGE_BPS
                            );

                            if (!quote) {
                                console.warn(`⚠️ No Jupiter quote for ${tokenMint}`);
                                await sendTelegramMessage(
                                    `⚠️ <b>Auto-sell failed</b>\n\n` +
                                    `🪙 Token: <code>${shortenAddress(tokenMint)}</code>\n` +
                                    `📈 Profit: +${profitPercent.toFixed(2)}%\n` +
                                    `🚫 No Jupiter route found.`,
                                    { parse_mode: 'HTML' }
                                );
                            } else {
                                const txid = await executeSwap(quote);
                                await sendTelegramMessage(
                                    `🚀 <b>PROFIT TARGET HIT!</b>\n\n` +
                                    `🪙 Token: <code>${shortenAddress(tokenMint)}</code>\n` +
                                    `📈 Profit: +${profitPercent.toFixed(2)}%\n` +
                                    `💸 Auto-sold ${autoSellPortion}% of your position\n\n` +
                                    `<a href="https://solscan.io/tx/${txid}">🔗 View on Solscan</a>`,
                                    { parse_mode: 'HTML' }
                                );
                                delete profitTargets[tokenMint];
                                console.log(`[DEBUG] Removed ${tokenMint} from profitTargets`);
                            }
                        } catch (err) {
                            console.error(`❌ Failed to auto-sell ${tokenMint}:`, err.message);
                        }
                    }
                }
            }

            // Update trailing stop loss
            await updateTrailingStopLoss(tokenMint);

            // Check if position is at risk
            if (profitPercent < -20 && !history.riskWarningsSent) {
                history.riskWarningsSent = true;
                await sendTelegramMessage(
                    `⚠️ <b>POSITION AT RISK</b>\n\n` +
                    `Token: ${tokenInfo.symbol}\n` +
                    `Loss: ${profitPercent.toFixed(2)}%\n` +
                    `Current Price: ${currentPrice.toFixed(8)} SOL\n` +
                    `Avg Buy Price: ${history.averageBuyPrice.toFixed(8)} SOL\n\n` +
                    `Consider setting a stop loss or reducing position size.`,
                    { parse_mode: 'HTML' }
                );
            }

        } catch (error) {
            console.error(`Error monitoring position ${tokenMint}: ${error.message}`);
        }

        // Small delay between tokens
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`✅ Position monitoring complete\n`);
}

// ====== HELPER FUNCTIONS ======
function shortenAddress(address) {
    const str = typeof address === 'string' ? address : address.toString();
    return str.slice(0, 4) + '...' + str.slice(-4);
}

function formatNumber(num) {
    if (num >= 1000000) return `${(num / 1000000).toFixed(2)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(2)}K`;
    return num.toFixed(6);
}

async function sendTelegramMessage(message, options = {}) {
    await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...options
    });
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

async function autoCopyTrade(walletAddress, tokenMint) {
    try {
        const amountSOL = 0.0001;
        const walletName = walletNames[walletAddress] || shortenAddress(walletAddress);

        const quote = await getCachedJupiterQuote(
            CONFIG.WSOL_ADDRESS,
            tokenMint,
            Math.floor(amountSOL * 1e9),
            CONFIG.SLIPPAGE_BPS
        );

        const txid = await executeSwap(quote);
        const allTrades = loadTradeMemory();
        allTrades.push({
            timestamp: Date.now(),
            type: 'copy',
            wallet: walletAddress,
            token: tokenMint,
            txid
        });
        saveTradeMemory(allTrades);


        // Enable copytrade flag for wallet+token
        if (!copytradeEnabled[walletAddress]) {
            copytradeEnabled[walletAddress] = {};
        }
        copytradeEnabled[walletAddress][tokenMint] = true;

        const tokenLink = `https://dexscreener.com/solana/${tokenMint}`;
        const txLink = `https://solscan.io/tx/${txid}`;

        const message =
            `✅ <b>Successful Auto Copy Trade</b>\n\n` +
            `👛 Wallet: ${walletName}\n` +
            `🪙 Token: <code>${tokenMint}</code>\n` +
            `💰 Amount: ${amountSOL} SOL\n` +
            `🔗 <a href="${tokenLink}">View Token</a>\n` +
            `🧾 <a href="${txLink}">Transaction</a>`;

        const keyboard = {
            inline_keyboard: [
                [
                    {
                        text: '❌ Remove Autotrade',
                        callback_data: `remove_copytrade_${walletAddress}_${tokenMint}`
                    }
                ]
            ]
        };

        await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, {
            parse_mode: 'HTML',
            reply_markup: keyboard
        });

        console.log(`✅ Auto copytrade successful for ${walletName}: ${tokenMint}`);
    } catch (err) {
        console.error(`❌ Auto copytrade failed for ${tokenMint}: ${err.message}`);
        await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, `❌ Auto copytrade failed: ${err.message}`);
    }
}


async function auto_trade(chatId, mode = 'preset', tokenAddress = null) {
    const ask = async (text) => {
        await bot.sendMessage(chatId, text);
        return new Promise((resolve) => {
            bot.once('message', (msg) => resolve(msg.text.trim()));
        });
    };

    if (!tokenAddress || tokenAddress.length !== 44) {
        await bot.sendMessage(chatId, "❌ Invalid token address.");
        return;
    }

    let solAmount = 0.0001;
    if (mode === 'manual') {
        while (true) {
            const input = await ask("💰 Enter SOL amount to trade:");
            const value = parseFloat(input);
            if (!isNaN(value) && value > 0) {
                solAmount = parseFloat(value.toFixed(6));
                break;
            } else {
                await bot.sendMessage(chatId, "❌ Amount must be > 0 SOL. Try again.");
            }
        }
    }

    let sellPct = 0;
    while (true) {
        const input = await ask("📈 Enter profit percentage to sell (e.g., 10 for 10%):");
        const value = parseFloat(input);
        if (!isNaN(value) && value > 0) {
            sellPct = value;
            break;
        } else {
            await bot.sendMessage(chatId, "❌ Invalid profit percentage. Try again.");
        }
    }

    let rebuyPct = 0;
    while (true) {
        const input = await ask("🔁 Enter price drop percentage to rebuy (e.g., 5 for 5%):");
        const value = parseFloat(input);
        if (!isNaN(value) && value > 0 && value < 100) {
            rebuyPct = value;
            break;
        } else {
            await bot.sendMessage(chatId, "❌ Must be between 0–100%. Try again.");
        }
    }

    const result = await buyToken(tokenAddress, solAmount);
    if (!result.success) {
        await bot.sendMessage(chatId, `❌ Buy failed: ${result.error}`);
        return;
    }

    const currentPrice = await getTokenPrice(tokenAddress);
    if (!currentPrice) {
        await bot.sendMessage(chatId, "❌ Could not fetch current price for token.");
        return;
    }

    // ✅ Track profit target with chatId included
    profitTargets[tokenAddress] = {
        buyPrice: currentPrice,
        targetPct: sellPct,
        autoSellPct: 50,
        chatId
    };

    await bot.sendMessage(chatId,
        `✅ Trade activated:\n` +
        `• Token: <code>${tokenAddress}</code>\n` +
        `• Amount: ${solAmount} SOL\n` +
        `• Sell Target: +${sellPct}%\n` +
        `• Rebuy Dip: -${rebuyPct}%`,
        {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '💸 Sell 25%', callback_data: `sell_25_${tokenAddress}` },
                        { text: '💸 Sell 50%', callback_data: `sell_50_${tokenAddress}` },
                        { text: '💸 Sell 100%', callback_data: `sell_100_${tokenAddress}` }
                    ]
                ]
            }
        }
    );

    // ✅ Start monitoring this token every 20 seconds
    const interval = setInterval(async () => {
        try {
            console.log(`[AUTO_TRADE] Checking ${tokenAddress} for profit targets...`);
            await checkProfitTargets(); // uses chatId from profitTargets

            const balance = await getTokenBalance(wallet.publicKey.toString(), tokenAddress);
            console.log(`[AUTO_TRADE] Token balance: ${balance}`);

            if (balance <= 0) {
                clearInterval(interval);
                delete profitTargets[tokenAddress];

                await bot.sendMessage(chatId,
                    `✅ Position sold. Auto-trading ended for:\n<code>${tokenAddress}</code>`,
                    { parse_mode: 'HTML' }
                );
            }
        } catch (err) {
            console.error(`❌ Error in auto_trade monitor for ${tokenAddress}:`, err);
        }
    }, 20000); // Every 20 seconds
}

















async function handlePortfolioCommand(chatId) {
    if (!wallet) {
        await bot.sendMessage(chatId, '❌ No trading wallet configured');
        return;
    }

    await bot.sendMessage(chatId, '🔄 Loading portfolio...');

    try {
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
            wallet.publicKey,
            { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
        );

        if (!tokenAccounts.value.length) {
            await bot.sendMessage(chatId,
                `📊 <b>Your Portfolio</b>\n\n` +
                `No tokens found in wallet.\nStart trading to build your portfolio!`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        const solBalance = await getTokenBalance(wallet.publicKey.toString(), CONFIG.WSOL_ADDRESS);

        const tokens = await Promise.all(tokenAccounts.value.map(async (account) => {
            try {
                const mint = account.account.data.parsed.info.mint;
                const balance = account.account.data.parsed.info.tokenAmount.uiAmount;
                if (!balance || balance <= 0) return null;

                const tokenInfo = await getTokenInfo(mint);
                const pl = await calculateProfitLoss(mint);

                let valueInSol = 0;
                try {
                    const quote = await getBestQuote(mint, CONFIG.WSOL_ADDRESS, Math.floor(balance * 10 ** tokenInfo.decimals));
                    if (quote) valueInSol = quote.outAmount / 1e9;
                } catch (e) {
                    console.warn(`⚠️ Failed quote for ${mint}:`, e.message);
                }

                return {
                    mint,
                    symbol: tokenInfo.symbol,
                    name: tokenInfo.name,
                    balance,
                    valueInSol,
                    pl
                };
            } catch (e) {
                return null;
            }
        }));

        const validTokens = tokens.filter(Boolean).sort((a, b) => b.valueInSol - a.valueInSol);
        let totalValue = solBalance;

        let header = `📊 <b>Your Portfolio</b>\n\n💰 <b>SOL:</b> ${solBalance.toFixed(4)}\n\n`;
        await bot.sendMessage(chatId, header, { parse_mode: 'HTML' });

        for (const [i, token] of validTokens.entries()) {
            totalValue += token.valueInSol;
            const plText = token.pl ?
                ` ${token.pl.totalPL >= 0 ? '📈' : '📉'} ${token.pl.totalPL >= 0 ? '+' : ''}${token.pl.totalPL.toFixed(4)} SOL` : '';

            const tokenMsg = `${i + 1}. <b>${token.symbol}</b>\n` +
                `📦 Balance: ${formatNumber(token.balance)}\n` +
                `💰 Value: ~${token.valueInSol.toFixed(4)} SOL${plText}\n`;

            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '💸 Sell 25%', callback_data: `sell_25_${token.mint}` },
                        { text: '💸 Sell 50%', callback_data: `sell_50_${token.mint}` },
                        { text: '💸 Sell 100%', callback_data: `sell_100_${token.mint}` }
                    ],
                    [
                        { text: '💰 Buy 0.005', callback_data: `buy_0.005_${token.mint}` },
                        { text: '💰 Buy 0.01', callback_data: `buy_0.01_${token.mint}` }
                    ],
                    [
                        { text: '📊 Price', callback_data: `price_${token.mint}` },
                        { text: '📈 Chart', url: `https://dexscreener.com/solana/${token.mint}` }
                    ]
                ]
            };

            await bot.sendMessage(chatId, tokenMsg, {
                parse_mode: 'HTML',
                reply_markup: keyboard
            });
        }

    } catch (error) {
        console.error('handlePortfolioCommand error:', error);
        await bot.sendMessage(chatId, '❌ Error loading portfolio.');
    }
}





async function handlePLCommand(chatId) {
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
}


async function handleAlertsCommand(chatId) {
    const alerts = userAlerts[chatId];

    if (!alerts || alerts.length === 0) {
        await bot.sendMessage(chatId, "🔕 You have no active price alerts.");
        return;
    }

    let message = `🔔 <b>Your Price Alerts</b>\n\n`;

    alerts.forEach((alert, index) => {
        const createdAt = new Date(alert.createdAt);
        const dateStr = createdAt.toLocaleDateString("en-GB");
        message += `${index + 1}. <b>${alert.token}</b>\n`;
        message += `   📉 Target: $${alert.targetPrice.toFixed(2)}\n`;
        message += `   📅 Created: ${dateStr}\n\n`;
    });

    await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
}


async function sendGlobalNewsLinks(chatId) {
    const keyboard = {
        inline_keyboard: [
            [
                { text: "📰 CoinDesk", url: "https://www.coindesk.com/" },
                { text: "🌍 U.Today", url: "https://u.today/" }
            ],
            [
                { text: "🚀 CoinGape", url: "https://coingape.com/" },
                { text: "🧠 Decrypt", url: "https://decrypt.co/" }
            ],
            [
                { text: "📩 Bankless", url: "https://banklesshq.com/" },
                { text: "🌐 BeInCrypto", url: "https://beincrypto.com/" }
            ],
            [
                { text: "📊 The Block", url: "https://www.theblock.co/" },
                { text: "⚡ Bitcoin Mag", url: "https://bitcoinmagazine.com/" }
            ],
            [
                { text: "📚 Coin Bureau", url: "https://www.coinbureau.com/" },
                { text: "💧 The Defiant", url: "https://thedefiant.io/" }
            ],
            [
                { text: "👥 Reddit: r/Crypto", url: "https://www.reddit.com/r/CryptoCurrency/" },
                { text: "🐦 Twitter Crypto", url: "https://twitter.com/search?q=crypto&src=typed_query" }
            ]
        ]
    };

    const message = `📢 <b>Crypto News & Social Monitoring</b>\n\nStay ahead with real-time updates, analysis, and trends from trusted outlets and community hubs.`;

    await bot.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
}

setInterval(async () => {
    for (const [tokenMint, config] of Object.entries(autotradeTargets)) {
        const currentPrice = await getTokenPrice(tokenMint);
        if (!currentPrice) continue;

        // SELL Logic
        if (!config.sold && currentPrice >= config.sellAt) {
            const balance = await getTokenBalance(wallet.publicKey.toString(), tokenMint);
            if (balance > 0) {
                const result = await sellToken(wallet.publicKey.toString(), tokenMint, balance);
                if (result.success) {
                    config.sold = true;
                    config.lastSellPrice = currentPrice;

                    await bot.sendMessage(config.chatId,
                        `✅ Sold <b>${tokenMint}</b> at ${currentPrice.toFixed(6)} SOL\n📦 Amount: ${balance}`,
                        { parse_mode: 'HTML' }
                    );
                }
            }
        }

        // REBUY Logic
        if (config.sold && currentPrice <= config.rebuyAt) {
            const result = await buyToken(tokenMint, config.amount);
            if (result.success) {
                config.sold = false;
                config.basePrice = currentPrice;
                config.sellAt = currentPrice * (1 + config.originalSellPct / 100);
                config.rebuyAt = currentPrice * (1 - config.originalRebuyPct / 100);

                await bot.sendMessage(config.chatId,
                    `🔁 Re-bought <b>${tokenMint}</b> at ${currentPrice.toFixed(6)} SOL\n💰 Amount: ${config.amount} SOL`,
                    { parse_mode: 'HTML' }
                );
            }
        }
    }
}, 10000); // Check every 10 seconds


const TRADE_CACHE_FILE = 'tradeMemory.json';

function loadTradeMemory() {
    try {
        const data = fs.readFileSync(TRADE_CACHE_FILE);
        return JSON.parse(data);
    } catch (e) {
        return [];
    }
}

function saveTradeMemory(trades) {
    fs.writeFileSync(TRADE_CACHE_FILE, JSON.stringify(trades, null, 2));
}

function wasTokenBoughtByBot(walletAddress, tokenMint) {
    const trades = loadTradeMemory();
    return trades.some(
        (t) =>
            t.wallet === walletAddress &&
            t.token === tokenMint &&
            t.type === 'autowallet'
    );
}


async function monitorOriginalTraderSell(traderWalletAddress, tokenMint) {
    try {
        let lastBalance = await getTokenBalance(traderWalletAddress, tokenMint);
        console.log(`[MONITOR] Watching ${traderWalletAddress} for sells of ${tokenMint}`);

        const interval = setInterval(async () => {
            try {
                const currentBalance = await getTokenBalance(traderWalletAddress, tokenMint);

                // Detect significant sell (e.g. 20%+ drop)
                if (currentBalance < lastBalance * 0.8) {
                    clearInterval(interval);

                    console.log(`📉 Trader ${traderWalletAddress} sold ${tokenMint}, triggering auto-sell`);

                    // ✅ Execute sell on our side (your wallet)
                    const sellTx = await executeSell(tokenMint);
                    if (!sellTx) {
                        console.error(`❌ Failed to auto-sell ${tokenMint}`);
                    }

                    // ✅ Send Telegram notification
                    await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID,
                        `🔁 <b>Auto-Sell Triggered</b>\n\n` +
                        `👤 Original Trader: <a href="https://solscan.io/account/${traderWalletAddress}">${shortenAddress(traderWalletAddress)}</a>\n` +
                        `🪙 Token: <a href="https://dexscreener.com/solana/${tokenMint}">${shortenAddress(tokenMint)}</a>\n` +
                        `📉 Detected 20%+ balance drop → Executed sell.`,
                        { parse_mode: 'HTML' }
                    );
                }

                lastBalance = currentBalance;
            } catch (err) {
                console.error(`❌ Error checking balance for ${traderWalletAddress}: ${err.message}`);
            }
        }, 20000); // Poll every 20 seconds

    } catch (err) {
        console.error(`❌ Failed to start monitoring for ${traderWalletAddress}: ${err.message}`);
    }
}




let lastJupiterCall = 0;

function getQuoteCacheKey(baseMint, targetMint, amount) {
    return `${baseMint}-${targetMint}-${amount}`;
}

async function throttleJupiter(minInterval = 800) {
    const now = Date.now();
    const timeDiff = now - lastJupiterCall;
    if (timeDiff < minInterval) {
        await new Promise(res => setTimeout(res, minInterval - timeDiff));
    }
    lastJupiterCall = Date.now();
}

async function onWalletBuy(walletAddress, tokenMint) {
    try {
        const chatId = CONFIG.TELEGRAM_CHAT_ID;
        const amountSOL = copytradeEnabled[walletAddress]?.amount || CONFIG.COPYTRADE_AMOUNT_SOL;
        const walletName = walletNames[walletAddress] || shortenAddress(walletAddress);

        console.log(`🚀 onWalletBuy triggered for ${walletAddress} | token: ${tokenMint} | amount: ${amountSOL} SOL`);

        const quote = await getCachedJupiterQuote(
            CONFIG.WSOL_ADDRESS,
            tokenMint,
            Math.floor(amountSOL * 1e9),
            CONFIG.SLIPPAGE_BPS
        );

        if (!quote || !quote.outAmount || !quote.routePlan?.length) {
            console.warn(`⚠️ No valid quote found for ${tokenMint} — skipping swap.`);
            return;
        }

        const txid = await executeSwap(quote);
        if (!txid) throw new Error('Swap execution returned no txid');

        // ✅ Save copytrade state for this (wallet, token) so onWalletSell can auto-sell later
        if (!copytradeEnabled[walletAddress]) copytradeEnabled[walletAddress] = {};
        copytradeEnabled[walletAddress][tokenMint] = {
            enabled: true,
            chatId: chatId
        };
        console.log(`✅ Copytrade tracking set: ${walletAddress} → ${tokenMint}`);

        const allTrades = loadTradeMemory();
        allTrades.push({
            timestamp: Date.now(),
            type: 'autowallet',
            wallet: walletAddress,
            token: tokenMint,
            txid,
            botWallet: CONFIG.OWNER_PUBLIC_KEY
        });
        saveTradeMemory(allTrades);

        await monitorOriginalTraderSell(walletAddress, tokenMint); // ✅ Begin monitoring for sells

        const tokenInfo = await getTokenInfo(tokenMint);
        const analytics = await getTokenAnalytics(tokenMint);
        const tokenName = tokenInfo?.symbol || tokenMint;

        const message =
            `✅ <b>Wallet Copytrade Executed</b>\n\n` +
            `👤 <b>Copied Wallet:</b> <a href="https://solscan.io/account/${walletAddress}">${shortenAddress(walletAddress)}</a>\n` +
            `🪙 <b>Token:</b> <a href="https://dexscreener.com/solana/${tokenMint}">${tokenName}</a>\n` +
            `💰 <b>Amount Bought:</b> ${amountSOL} SOL\n\n` +
            `📊 <b>Liquidity:</b> ${formatNumber(analytics.liquidity)}\n` +
            `📈 <b>24h Volume:</b> ${formatNumber(analytics.volume24h)}\n` +
            `👥 <b>Holders:</b> ${analytics.holders}\n` +
            `🔗 <b>Tx:</b> <a href="https://solscan.io/tx/${txid}">${txid.slice(0, 8)}...</a>`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: "📊 Dexscreener", url: `https://dexscreener.com/solana/${tokenMint}` },
                    { text: "🦉 Birdeye", url: `https://birdeye.so/token/${tokenMint}?chain=solana` }
                ],
                [
                    { text: "🔍 View Wallet", url: `https://solscan.io/account/${walletAddress}` }
                ]
            ]
        };

        await bot.sendMessage(chatId, message, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
            disable_web_page_preview: false
        });

        console.log(`✅ Wallet buy copied: ${walletAddress} → ${tokenMint}`);

    } catch (err) {
        console.error(`❌ onWalletBuy failed for ${tokenMint}: ${err.message}`);
        await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, `❌ Wallet copytrade failed: ${err.message}`);
    }
}





async function onWalletSell(walletAddress, tokenMint, wallet) {
    try {
        const botWallet = wallet.publicKey.toString(); // ✅ Real signer public key

        // ✅ Step 0: Check if this token is copytraded
        if (!copytradeEnabled?.[walletAddress]?.[tokenMint]?.enabled) {
            console.log(`ℹ️ Skipping ${tokenMint} — not marked as copytraded from ${walletAddress}`);
            return;
        }

        const botBalance = await getTokenBalance(botWallet, tokenMint);
        if (botBalance <= 0) {
            console.log(`⚠️ Bot has 0 balance of ${tokenMint}, skipping sell.`);
            return;
        }

        console.log(`🌀 Auto-selling ${tokenMint} copied from ${walletAddress}`);

        const chatId = CONFIG.TELEGRAM_CHAT_ID;
        const walletName = walletNames?.[walletAddress] || shortenAddress(walletAddress);

        const accounts = await connection.getParsedTokenAccountsByOwner(
            wallet.publicKey,
            { programId: TOKEN_PROGRAM_ID }
        );

        let tokenAccountInfo = null;
        for (const acc of accounts.value) {
            const info = acc.account.data.parsed.info;
            if (info.mint === tokenMint) {
                tokenAccountInfo = info;
                break;
            }
        }

        if (!tokenAccountInfo) {
            console.warn(`⚠️ No token account found in bot wallet for ${tokenMint}`);
            return;
        }

        const balance = parseFloat(tokenAccountInfo.tokenAmount.uiAmount);
        const decimals = tokenAccountInfo.tokenAmount.decimals;

        if (balance <= 0) {
            console.warn(`⚠️ No balance to sell for ${tokenMint}`);
            return;
        }

        const amountToSell = Math.floor(balance * Math.pow(10, decimals));

        // ✅ Use native SOL (not WSOL)
        const NATIVE_SOL = "So11111111111111111111111111111111111111112";

        const quote = await getCachedJupiterQuote(
            tokenMint,
            NATIVE_SOL,
            amountToSell,
            CONFIG.SLIPPAGE_BPS
        );

        if (!quote || !quote.outAmount || !quote.routePlan?.length) {
            console.warn(`⚠️ No valid Jupiter quote for ${tokenMint}`);
            return;
        }

        // ✅ Execute with signer
        const txid = await executeSwap(quote, wallet);
        if (!txid) throw new Error('Swap execution returned no txid');

        const allTrades = loadTradeMemory();
        allTrades.push({
            timestamp: Date.now(),
            type: 'autosell',
            wallet: walletAddress,
            token: tokenMint,
            txid,
            botWallet
        });
        saveTradeMemory(allTrades);

        const tokenInfo = await getTokenInfo(tokenMint);
        const tokenName = tokenInfo?.symbol || tokenMint;

        const message =
            `💸 <b>Auto-Sell Executed</b>\n\n` +
            `👤 <b>Wallet:</b> <a href="https://solscan.io/account/${botWallet}">${shortenAddress(botWallet)}</a>\n` +
            `🪙 <b>Token Sold:</b> <a href="https://dexscreener.com/solana/${tokenMint}">${tokenName}</a>\n` +
            `💰 <b>Amount:</b> ${formatNumber(balance)}\n` +
            `🔁 <b>Swapped to:</b> SOL\n` +
            `🔗 <a href="https://solscan.io/tx/${txid}">View Transaction</a>`;

        await bot.sendMessage(chatId, message, {
            parse_mode: 'HTML',
            disable_web_page_preview: false
        });

        console.log(`✅ Full sell complete for ${tokenMint}`);

        // ✅ Clean up copytrade tracking
        delete copytradeEnabled[walletAddress][tokenMint];

    } catch (err) {
        console.error(`❌ onWalletSell failed for ${tokenMint}: ${err.message}`);
        await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, `❌ Auto-sell failed: ${err.message}`);
    }
}






















