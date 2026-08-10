import { MiniKit } from '@worldcoin/minikit-js';
import { createClient } from '@supabase/supabase-js';

// --- CONFIGURATION & CREDENTIALS ---
const SUPABASE_URL = 'YOUR_SUPABASE_URL_HERE';
const SUPABASE_KEY = 'YOUR_SUPABASE_KEY_HERE';
const ADMIN_WALLET = '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1';
const WLD_TOKEN = '0x2cFc85d8E48F8EAB294be644d9E25C3030863003'; // WLD Token Contract

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// State
let userWallet = null;

document.addEventListener('DOMContentLoaded', () => {
  // Initialize MiniKit
  if (typeof MiniKit !== 'undefined' && MiniKit.isInstalled()) {
    MiniKit.install();
  }

  setupUI();
  fetchListings();
});

// --- DYNAMIC UI & BRANDING GENERATOR ---
function setupUI() {
  // Dynamically inject app title and generated SVG branding/icons
  document.title = "Want Sell On World";
  
  const header = document.querySelector('.header h1');
  if (header) {
    header.innerHTML = `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="url(#grad)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 8px;">
        <defs>
          <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#6366f1" />
            <stop offset="100%" stop-color="#a855f7" />
          </linearGradient>
        </defs>
        <circle cx="9" cy="21" r="1"></circle>
        <circle cx="20" cy="21" r="1"></circle>
        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path>
      </svg>
      Want Sell On World
    `;
  }

  // Bind Events
  document.getElementById('loginBtn').addEventListener('click', handleLogin);
  document.getElementById('openModalBtn').addEventListener('click', () => toggleModal(true));
  document.getElementById('closeModalBtn').addEventListener('click', () => toggleModal(false));
  document.getElementById('adForm').addEventListener('submit', handlePostAd);
}

function toggleModal(show) {
  const modal = document.getElementById('adModal');
  if (modal) {
    modal.style.display = show ? 'flex' : 'none';
  }
}

// --- WORLD APP LOGIN (SIWE) ---
async function handleLogin() {
  try {
    if (!MiniKit.isInstalled()) {
      alert("Please open this app inside the World App.");
      return;
    }

    const res = await MiniKit.commandsAsync.walletAuth({
      nonce: '12345678',
      requestId: '0',
      expirationTime: new Date(new Date().getTime() + 7 * 24 * 60 * 60 * 1000),
      statement: 'Sign in to Want Sell On World Marketplace',
    });

    if (res.finalPayload && res.finalPayload.status === 'success') {
      userWallet = res.finalPayload.address;
      document.getElementById('loginBtn').innerText = `Connected: ${userWallet.substring(0, 6)}...`;
      document.getElementById('openModalBtn').style.display = 'block';
      
      // Save profile to Supabase
      await supabase.from('profiles').upsert({
        wallet_address: userWallet,
        username: `User_${userWallet.substring(4, 8)}`
      }, { onConflict: 'wallet_address' });
      
    } else {
      alert('Wallet authentication failed.');
    }
  } catch (error) {
    console.error('Login Error:', error);
  }
}

// --- POST AD WITH 1 WLD LISTING FEE (PAYMENT TO ADMIN WALLET) ---
async function handlePostAd(e) {
  e.preventDefault();

  if (!userWallet) {
    alert("Please connect your wallet first!");
    return;
  }

  const title = document.getElementById('title').value;
  const description = document.getElementById('description').value;
  const price = parseFloat(document.getElementById('price').value);
  const category = document.getElementById('category').value;
  const imageUrl = document.getElementById('imageUrl').value;

  try {
    // 1 WLD Payment to Admin Wallet
    const paymentResponse = await MiniKit.commandsAsync.pay({
      reference: 'listing_fee_' + Date.now(),
      to: ADMIN_WALLET,
      tokens: [
        {
          symbol: 'WLD',
          token_amount: '1000000000000000000', // Exactly 1 WLD (18 decimals)
        }
      ],
      description: 'Listing Fee: Want Sell On World',
    });

    const payload = paymentResponse.finalPayload;
    if (payload && payload.status === 'success') {
      // Save Listing to Supabase after successful payment
      const { error } = await supabase.from('listings').insert([
        {
          seller_address: userWallet,
          title,
          description,
          price,
          category,
          image_url: imageUrl,
          status: 'active'
        }
      ]);

      if (error) throw error;

      alert('Ad posted successfully!');
      toggleModal(false);
      document.getElementById('adForm').reset();
      fetchListings();
    } else {
      alert('Payment failed or cancelled.');
    }
  } catch (err) {
    console.error('Posting Error:', err);
    alert('An error occurred while publishing the ad.');
  }
}

// --- FETCH & RENDER MARKETPLACE LISTINGS ---
async function fetchListings() {
  const container = document.getElementById('listingsContainer');
  container.innerHTML = `<p class="loading-text">Loading marketplace items...</p>`;

  const { data, error } = await supabase
    .from('listings')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  if (error) {
    container.innerHTML = `<p class="loading-text">Failed to load listings.</p>';`;
    return;
  }

  if (!data || data.length === 0) {
    container.innerHTML = `<p class="loading-text">No active listings found. Be the first to post!</p>`;
    return;
  }

  container.innerHTML = data.map(item => `
    <div class="listing-card">
      <img src="${item.image_url}" alt="${item.title}" style="width: 90px; height: 90px; object-fit: cover; border-radius: 12px; background: #222;" onerror="this.src='https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?w=200'">
      <div style="flex: 1; display: flex; flex-direction: column; justify-content: space-between;">
        <div>
          <span style="font-size: 0.75rem; color: #a855f7; font-weight: 600; text-transform: uppercase;">${item.category}</span>
          <h3 style="font-size: 1rem; margin: 4px 0; color: #f8fafc;">${item.title}</h3>
          <p style="font-size: 0.85rem; color: #94a3b8; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${item.description}</p>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px;">
          <span style="font-size: 0.95rem; font-weight: 700; color: #10b981;">${item.price} WLD</span>
          <span style="font-size: 0.75rem; color: #64748b;">Seller: ${item.seller_address.substring(0, 6)}...</span>
        </div>
      </div>
    </div>
  `).join('');
}