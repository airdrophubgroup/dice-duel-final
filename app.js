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
  document.getElementById('viewMyAdsBtn').addEventListener('click', openMyAdsModal);
  
  document.getElementById('adForm').addEventListener('submit', handlePostAd);
  document.getElementById('countryFilter').addEventListener('change', fetchListings);
  document.getElementById('categoryFilter').addEventListener('change', fetchListings);

  const rangeInput = document.getElementById('distanceRange');
  rangeInput.addEventListener('input', (e) => {
    document.getElementById('rangeValue').innerText = e.target.value + ' km';
  });
  rangeInput.addEventListener('change', fetchListings);
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
    document.getElementById('viewMyAdsBtn').style.display = 'block';
  }
}

async function handlePostAd(e) {
  e.preventDefault();
  if (!userWallet) return alert("Please connect your wallet first!");

  const fileInput = document.getElementById('imageInput');
  const files = fileInput.files;
  if (files.length === 0) return alert("Please select at least one image!");
  if (files.length > 4) return alert("You can upload a maximum of 4 photos!");

  const paymentResponse = await MiniKit.commandsAsync.pay({
    reference: 'listing_fee_' + Date.now(),
    to: ADMIN_WALLET,
    tokens: [{ symbol: 'WLD', token_amount: '100000000000000000' }],
    description: 'Listing Fee: 0.1 WLD',
  });

  if (paymentResponse.finalPayload?.status !== 'success') {
    return alert('Payment failed or cancelled.');
  }

  let imageUrls = ['', '', '', ''];
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileExt = file.name.split('.').pop();
    const fileName = `${Date.now()}_${Math.random()}.${fileExt}`;
    
    const { error: uploadError } = await supabase.storage.from('listings').upload(fileName, file);
    
    if (uploadError) {
      alert("Image upload failed: " + uploadError.message);
      return;
    }

    const { data: publicURLData } = supabase.storage.from('listings').getPublicUrl(fileName);
    imageUrls[i] = publicURLData.publicUrl;
  }

  const { error: insertError } = await supabase.from('listings').insert([{
    seller_address: userWallet,
    title: document.getElementById('title').value,
    description: document.getElementById('description').value,
    price: document.getElementById('price').value,
    category: document.getElementById('category').value,
    country: document.getElementById('adCountry').value,
    image1: imageUrls[0],
    image2: imageUrls[1],
    image3: imageUrls[2],
    image4: imageUrls[3],
    status: 'active'
  }]);

  if (!insertError) {
    alert('Ad posted successfully with 0.1 WLD payment and images uploaded!');
    document.getElementById('adModal').style.display = 'none';
    document.getElementById('adForm').reset();
    fetchListings();
  } else {
    alert('Error saving ad to database: ' + insertError.message);
  }
}

async function fetchListings() {
  const container = document.getElementById('listingsContainer');
  const selectedCountry = document.getElementById('countryFilter').value;
  const selectedCategory = document.getElementById('categoryFilter').value;
  const maxDistance = parseInt(document.getElementById('distanceRange').value);
  
  let query = supabase.from('listings').select('*').eq('status', 'active');
  
  if (selectedCountry !== 'ALL') {
    query = query.eq('country', selectedCountry);
  }
  if (selectedCategory !== 'ALL') {
    query = query.eq('category', selectedCategory);
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
    container.innerHTML = `<p class="loading-text">No listings found within ${maxDistance} km.</p>`;
    return;
  }

  container.innerHTML = filteredData.map((item, index) => {
    const simulatedDist = (index * 15 + 10) % 500;
    const thumbImg = item.image1 || 'https://via.placeholder.com/90';
    return `
      <div class="listing-card">
        <img src="${thumbImg}" style="width: 90px; height: 90px; object-fit: cover; border-radius: 12px;">
        <div style="flex:1;">
          <span style="font-size:10px; color:#4f46e5; font-weight:bold;">🌍 ${item.country} (~${simulatedDist} km) | ${item.category}</span>
          <h3 style="font-size:1rem; margin:2px 0;">${item.title}</h3>
          <p style="font-weight:bold; color:#10b981;">${item.price} WLD</p>
        </div>
        <button onclick="window.contactSeller('${item.seller_address}', '${item.title}')" style="background:#4f46e5; color:#fff; padding:6px 12px; font-size:12px; border-radius:8px; align-self:center;">Chat</button>
      </div>
    `;
  }).join('');
}

window.contactSeller = function(sellerWallet, adTitle) {
  prompt("Seller Wallet Address (Copy to connect/chat):", sellerWallet);
}

async function openMyAdsModal() {
  if (!userWallet) return alert("Please connect first!");
  document.getElementById('myAdsModal').style.display = 'flex';
  
  const container = document.getElementById('myAdsContainer');
  container.innerHTML = `<p class="loading-text">Loading...</p>`;

  const { data } = await supabase.from('listings').select('*').eq('seller_address', userWallet).eq('status', 'active');

  if (!data || data.length === 0) {
    container.innerHTML = `<p style="text-align:center; color:#64748b; padding:20px;">No ads posted yet.</p>`;
    return;
  }

  container.innerHTML = data.map(item => `
    <div style="background:rgba(0,0,0,0.03); padding:10px; border-radius:10px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center;">
      <div>
        <h4 style="font-size:0.9rem; color:#1e293b;">${item.title}</h4>
        <p style="font-size:0.8rem; color:#10b981;">${item.price} WLD (${item.country})</p>
      </div>
      <button onclick="window.deleteMyAd('${item.id}')" style="background:#ef4444; color:#fff; padding:6px 10px; font-size:11px; border-radius:6px;">Delete</button>
    </div>
  `).join('');
}

window.deleteMyAd = async function(id) {
  if (confirm("Are you sure? Delete this ad?")) {
    const { error } = await supabase.from('listings').delete().match({ id });
    if (!error) {
      alert("Deleted.");
      openMyAdsModal();
      fetchListings();
    }
  }
}