import { MiniKit } from '@worldcoin/minikit-js';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://adicdkrfinbudpaqqjai.supabase.co';
const SUPABASE_KEY = 'YOUR_SUPABASE_ANON_KEY'; // Yahan apna key rakhein
const ADMIN_WALLET = '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
let userWallet = null;

document.addEventListener('DOMContentLoaded', () => {
  if (typeof MiniKit !== 'undefined' && MiniKit.isInstalled()) MiniKit.install();
  setupUI();
  fetchListings();
});

function setupUI() {
  document.getElementById('loginBtn').addEventListener('click', handleLogin);
  document.getElementById('viewMyAdsBtn').addEventListener('click', openMyAdsModal);
  document.getElementById('adForm').addEventListener('submit', handlePostAd);
  document.getElementById('countryFilter').addEventListener('change', fetchListings);
  document.getElementById('categoryFilter').addEventListener('change', fetchListings);
}

async function handleLogin() {
  const res = await MiniKit.commandsAsync.walletAuth({ nonce: '1', requestId: '0', expirationTime: new Date(Date.now() + 600000), statement: 'Login' });
  if (res.finalPayload?.status === 'success') {
    userWallet = res.finalPayload.address;
    document.getElementById('loginBtn').innerText = `Connected`;
    document.getElementById('viewMyAdsBtn').style.display = 'block';
  }
}

async function handlePostAd(e) {
  e.preventDefault();
  const paymentResponse = await MiniKit.commandsAsync.pay({
    reference: 'listing_' + Date.now(),
    to: ADMIN_WALLET,
    tokens: [{ symbol: 'WLD', token_amount: '100000000000000000' }],
    description: '0.1 WLD Fee',
  });

  if (paymentResponse.finalPayload?.status === 'success') {
    await supabase.from('listings').insert([{
      seller_address: userWallet,
      title: document.getElementById('title').value,
      description: document.getElementById('description').value,
      price: document.getElementById('price').value,
      category: document.getElementById('category').value,
      country: document.getElementById('adCountry').value,
      image1: document.getElementById('img1').value,
      image2: document.getElementById('img2').value,
      image3: document.getElementById('img3').value,
      image4: document.getElementById('img4').value
    }]);
    alert('Posted!');
    document.getElementById('adModal').style.display = 'none';
    fetchListings();
  }
}

async function fetchListings() {
  const { data } = await supabase.from('listings').select('*').eq('status', 'active');
  const container = document.getElementById('listingsContainer');
  container.innerHTML = data.map(item => `
    <div class="listing-card">
      <img src="${item.image1}" style="width:80px; height:80px;">
      <div><h3>${item.title}</h3><p>${item.price} WLD</p></div>
      <button onclick="prompt('Contact:', '${item.seller_address}')">Chat</button>
    </div>
  `).join('');
}