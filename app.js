import { MiniKit } from '@worldcoin/minikit-js';
import { createClient } from '@supabase/supabase-js';

// --- CONFIGURATION & CREDENTIALS ---
const SUPABASE_URL = 'https://adicdkrfinbudpaqqjai.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkaWNka3JmaW5idWRwYXFxamFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxNzM4MzMsImV4cCI6MjEwMTc0OTgzM30.ksv1zdQVimQTNWnrHaRqEXcLw7-3G6_zjAyEOZZkr0s';
const ADMIN_WALLET = '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
let userWallet = null;

document.addEventListener('DOMContentLoaded', () => {
  if (typeof MiniKit !== 'undefined' && MiniKit.isInstalled()) {
    MiniKit.install();
  }
  setupUI();
  fetchListings();
});

function setupUI() {
  document.getElementById('loginBtn').addEventListener('click', handleLogin);
  document.getElementById('openModalBtn').addEventListener('click', () => toggleModal(true));
  document.getElementById('closeModalBtn').addEventListener('click', () => toggleModal(false));
  document.getElementById('adForm').addEventListener('submit', handlePostAd);
}

function toggleModal(show) {
  document.getElementById('adModal').style.display = show ? 'flex' : 'none';
}

async function handleLogin() {
  const res = await MiniKit.commandsAsync.walletAuth({
    nonce: '12345678',
    requestId: '0',
    expirationTime: new Date(new Date().getTime() + 7 * 24 * 60 * 60 * 1000),
    statement: 'Sign in to Want Sell On World',
  });

  if (res.finalPayload?.status === 'success') {
    userWallet = res.finalPayload.address;
    document.getElementById('loginBtn').innerText = `Connected: ${userWallet.substring(0, 6)}...`;
    document.getElementById('openModalBtn').style.display = 'block';
  }
}

async function handlePostAd(e) {
  e.preventDefault();
  if (!userWallet) return alert("Connect wallet first!");

  const paymentResponse = await MiniKit.commandsAsync.pay({
    reference: 'listing_fee_' + Date.now(),
    to: ADMIN_WALLET,
    tokens: [{ symbol: 'WLD', token_amount: '1000000000000000000' }],
    description: 'Listing Fee: 1 WLD',
  });

  if (paymentResponse.finalPayload?.status === 'success') {
    await supabase.from('listings').insert([{
      seller_address: userWallet,
      title: document.getElementById('title').value,
      description: document.getElementById('description').value,
      price: document.getElementById('price').value,
      category: document.getElementById('category').value,
      image_url: document.getElementById('imageUrl').value,
      status: 'active'
    }]);
    alert('Ad posted!');
    toggleModal(false);
    document.getElementById('adForm').reset();
    fetchListings();
  }
}

async function fetchListings() {
  const container = document.getElementById('listingsContainer');
  const { data } = await supabase.from('listings').select('*').eq('status', 'active');
  container.innerHTML = data?.map(item => `
    <div class="listing-card">
      <img src="${item.image_url}" style="width: 90px; height: 90px; object-fit: cover; border-radius: 12px;">
      <div>
        <h3>${item.title}</h3>
        <p>${item.price} WLD</p>
      </div>
    </div>
  `).join('') || '<p>No listings.</p>';
}