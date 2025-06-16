const axios = require('axios');
require('dotenv').config();

// Configuration
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || 'db7b00c4-31e1-4ee9-91c9-116f0667cf4a';
const HELIUS_RPC_URL = 'https://rpc.helius.xyz';

// The wallet that's not showing transactions
const PROBLEM_WALLET = 'BGC9KkyssMFuckrcZTN52rhMng5ikpqkmQNoKn458pzV';

async function debugWallet() {
    console.log(`\n🔍 Debugging wallet: ${PROBLEM_WALLET}\n`);
    
    try {
        // 1. Test if we can fetch transactions
        console.log('1️⃣ Testing transaction fetch...');
        const response = await axios.post(
            `${HELIUS_RPC_URL}/?api-key=${HELIUS_API_KEY}`,
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'getSignaturesForAddress',
                params: [
                    PROBLEM_WALLET,
                    {
                        limit: 10,
                        commitment: 'confirmed'
                    }
                ]
            }
        );
        
        const signatures = response.data.result || [];
        console.log(`✅ Found ${signatures.length} recent transactions`);
        
        if (signatures.length === 0) {
            console.log('❌ No transactions found - wallet might be inactive');
            return;
        }
        
        // 2. Show recent transactions
        console.log('\n2️⃣ Recent transactions:');
        for (let i = 0; i < Math.min(5, signatures.length); i++) {
            const sig = signatures[i];
            const time = new Date(sig.blockTime * 1000).toLocaleString();
            console.log(`   ${i+1}. ${sig.signature.substring(0, 20)}... at ${time}`);
            console.log(`      Error: ${sig.err ? 'Yes' : 'No'}`);
        }
        
        // 3. Get details of the most recent transaction
        console.log('\n3️⃣ Analyzing most recent transaction...');
        const latestSig = signatures[0].signature;
        
        const txResponse = await axios.post(
            `${HELIUS_RPC_URL}/?api-key=${HELIUS_API_KEY}`,
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'getTransaction',
                params: [
                    latestSig,
                    {
                        encoding: 'jsonParsed',
                        commitment: 'confirmed',
                        maxSupportedTransactionVersion: 0
                    }
                ]
            }
        );
        
        const transaction = txResponse.data.result;
        if (!transaction) {
            console.log('❌ Could not fetch transaction details');
            return;
        }
        
        // 4. Check token balances
        const { preTokenBalances = [], postTokenBalances = [] } = transaction.meta;
        console.log(`   Pre-token balances: ${preTokenBalances.length}`);
        console.log(`   Post-token balances: ${postTokenBalances.length}`);
        
        // 5. Find token transfers for this wallet
        console.log('\n4️⃣ Token transfers involving this wallet:');
        let foundTransfers = false;
        
        // Check all token balance changes
        const allMints = new Set();
        [...preTokenBalances, ...postTokenBalances].forEach(b => {
            if (b.mint && b.owner === PROBLEM_WALLET) allMints.add(b.mint);
        });
        
        for (const mint of allMints) {
            const pre = preTokenBalances.find(b => b.mint === mint && b.owner === PROBLEM_WALLET);
            const post = postTokenBalances.find(b => b.mint === mint && b.owner === PROBLEM_WALLET);
            
            const preBal = pre?.uiTokenAmount?.uiAmount || 0;
            const postBal = post?.uiTokenAmount?.uiAmount || 0;
            const change = postBal - preBal;
            
            if (Math.abs(change) > 0.000001) {
                foundTransfers = true;
                console.log(`   Token ${mint.substring(0, 10)}...`);
                console.log(`   Balance: ${preBal} → ${postBal} (${change > 0 ? '+' : ''}${change})`);
            }
        }
        
        if (!foundTransfers) {
            console.log('   No token transfers found in this transaction');
        }
        
        // 6. Check if it's a SOL-only transaction
        console.log('\n5️⃣ Checking SOL transfers...');
        const accountKeys = transaction.transaction.message.accountKeys || [];
        const walletIndex = accountKeys.findIndex(key => 
            key.pubkey === PROBLEM_WALLET || key === PROBLEM_WALLET
        );
        
        if (walletIndex >= 0) {
            const preBalance = transaction.meta.preBalances[walletIndex] / 1e9;
            const postBalance = transaction.meta.postBalances[walletIndex] / 1e9;
            const solChange = postBalance - preBalance;
            
            console.log(`   SOL balance: ${preBalance.toFixed(4)} → ${postBalance.toFixed(4)} (${solChange > 0 ? '+' : ''}${solChange.toFixed(4)})`);
        }
        
        // 7. Common issues
        console.log('\n6️⃣ Possible reasons transactions aren\'t showing:');
        console.log('   - Wallet only transfers SOL (bot tracks tokens)');
        console.log('   - Transactions are failing (check for errors)');
        console.log('   - Token amounts are too small (below threshold)');
        console.log('   - Bot started after last transaction (check lastProcessedSignatures)');
        console.log('   - Rate limiting from too many API calls');
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.response) {
            console.error('API Error:', error.response.data);
        }
    }
}

