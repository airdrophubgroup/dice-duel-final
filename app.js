import { MiniKit } from '@worldcoin/minikit-js';
import { createClient } from '@supabase/supabase-js';

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
  document.getElementById('openModalBtn').addEventListener('click', () => toggleModal('adModal', true));
  document.getElementById('closeModalBtn').addEventListener('click', () => toggleModal('adModal', false));
  
  document.getElementById('viewMyAdsBtn').addEventListener('click', openMyAdsModal);
  document.getElementById('closeMyAdsModal').addEventListener('click', () => toggleModal('myAdsModal', false));
  
  document.getElementById('adForm').addEventListener('submit', handlePostAd);
  document.getElementById('countryFilter').addEventListener('change', () => fetchListings());

  const rangeInput = document.getElementById('distanceRange');
  rangeInput.addEventListener('input', (e) => {
    document.getElementById('rangeValue').innerText = e.target.value + ' km';
  });
  rangeInput.addEventListener('change', () => {
    fetchListings();
  });
}

function toggleModal(modalId, show) {
  document.getElementById(modalId).style.display = show ? 'flex' : 'none';
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
    document.getElementById('viewMyAdsBtn').style.display = 'block';
  }
}

async function handlePostAd(e) {
  e.preventDefault();
  if (!userWallet) return alert("Connect wallet first!");

  const title = document.getElementById('title').value;
  const description = document.getElementById('description').value;
  const price = document.getElementById('price').value;
  const category = document.getElementById('category').value;
  const country = document.getElementById('adCountry').value;
  const imageUrl = document.getElementById('imageUrl').value;

  const paymentResponse = await MiniKit.commandsAsync.pay({
    reference: 'listing_fee_' + Date.now(),
    to: ADMIN_WALLET,
    tokens: [{ symbol: 'WLD', token_amount: '1000000000000000000' }],
    description: 'Listing Fee: 1 WLD',
  });

  if (paymentResponse.finalPayload?.status === 'success') {
    await supabase.from('listings').insert([{
      seller_address: userWallet,
      title,
      description,
      price,
      category,
      country,
      image_url: imageUrl,
      status: 'active'
    }]);
    alert('Ad posted successfully! Note: Ads cannot be edited, only deleted.');
    toggleModal('adModal', false);
    document.getElementById('adForm').reset();
    fetchListings();
  }
}

async function fetchListings() {
  const container = document.getElementById('listingsContainer');
  const selectedCountry = document.getElementById('countryFilter').value;
  const maxDistance = parseInt(document.getElementById('distanceRange').value);
  
  let query = supabase.from('listings').select('*').eq('status', 'active');
  if (selectedCountry !== 'ALL') {
    query = query.eq('country', selectedCountry);
  }

  const { data } = await query;
  
  if (!data || data.length === 0) {
    container.innerHTML = `<p class="loading-text">No active listings found.</p>`;
    return;
  }

  const filteredData = data.filter((item, index) => {
    const itemDistance = (index * 15 + 10) % 500; 
    return itemDistance <= maxDistance;
  });

  if (filteredData.length === 0) {
    container.innerHTML = `<p class="loading-text">No listings found within ${maxDistance} km range.</p>`;
    return;
  }

  container.innerHTML = filteredData.map((item, index) => {
    const simulatedDist = (index * 15 + 10) % 500;
    return `
      <div class="listing-card">
        <img src="${item.image_url}" style="width: 90px; height: 90px; object-fit: cover; border-radius: 12px;">
        <div style="flex:1;">
          <span style="font-size:10px; color:#a855f7; font-weight:bold;">🌍 ${item.country} (~${simulatedDist} km away) | ${item.category}</span>
          <h3 style="font-size:1rem; margin:2px 0;">${item.title}</h3>
          <p style="font-weight:bold; color:#10b981;">${item.price} WLD</p>
        </div>
        <button onclick="contactSeller('${item.seller_address}', '${item.title}')" style="background:#6366f1; color:#fff; padding:6px 12px; font-size:12px; border-radius:8px; align-self:center;">Chat</button>
      </div>
    `;
  }).join('');
}

window.contactSeller = function(sellerWallet, adTitle) {
  prompt("Seller Wallet Address (Copy to connect/chat):", sellerWallet);
}

async function openMyAdsModal() {
  if (!userWallet) return alert("Please connect wallet first!");
  toggleModal('myAdsModal', true);
  
  const container = document.getElementById('myAdsContainer');
  container.innerHTML = `<p class="loading-text">Loading your ads...</p>`;

  const { data } = await supabase.from('listings').select('*').eq('seller_address', userWallet).eq('status', 'active');

  if (!data || data.length === 0) {
    container.innerHTML = `<p style="text-align:center; color:#94a3b8; padding:20px;">You haven't posted any ads yet.</p>`;
    return;
  }

    container.innerHTML = data.map(item => `
    <div style="background:rgba(255,255,255,0.05); padding:10px; border-radius:10px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center;">
      <div>
        <h4 style="font-size:0.9rem; color:#fff;">${item.title}</h4>
        <p style="font-size:0.8rem; color:#10b981;">${item.price} WLD (${item.country}) - [${item.category}]</p>
      </div>
      <button onclick="deleteMyAd('${item.id}')" style="background:#ef4444; color:#fff; padding:6px 10px; font-size:11px; border-radius:6px;">Delete</button>
    </div>
  `).join('');
}

window.deleteMyAd = async function(id) {
  if (confirm("Are you sure? Once deleted, it cannot be recovered and you must pay 1 WLD to repost.")) {
    const { error } = await supabase.from('listings').delete().match({ id });
    if (!error) {
      alert("Ad deleted successfully.");
      openMyAdsModal();
      fetchListings();
    } else {
      alert("Error deleting ad.");
    }
  }
}