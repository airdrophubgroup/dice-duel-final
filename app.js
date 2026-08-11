import { MiniKit, Tokens, tokenToDecimals } from "https://cdn.jsdelivr.net/npm/@worldcoin/minikit-js@1.9.6/+esm";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = 'https://adicdkrfinbudpaqqjai.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkaWNka3JmaW5idWRwYXFxamFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxNzM4MzMsImV4cCI6MjEwMTc0OTgzM30.ksv1zdQVimQTNWnrHaRqEXcLw7-3G6_zjAyEOZZkr0s';
const ADMIN_WALLET = '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1';
const APP_ID = 'app_06db98c492a19f80177b8d633f056982';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
let userWallet = null;

function checkWorldAppEnvironment() {
  const isWorldApp = (typeof MiniKit !== 'undefined' && MiniKit.isInstalled());
  if (!isWorldApp) {
    alert('⚠️ Yeh app sirf World App ke andar kaam karta hai. Kripya World App mein open karein.');
    return false;
  }
  return true;
}

function waitForMiniKitReady(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const start = Date.now();
    (function check() {
      if (typeof MiniKit !== 'undefined' && MiniKit.isInstalled()) {
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        resolve(false);
      } else {
        setTimeout(check, 100);
      }
    })();
  });
}

function randomAlphaNumeric(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

document.addEventListener('DOMContentLoaded', async () => {
  try { MiniKit.install(APP_ID); } catch (e) { console.error('MiniKit install error:', e); }
  await waitForMiniKitReady();
  setupUI();
  fetchListings();
});

function setupUI() {
  document.getElementById('loginBtn').addEventListener('click', handleLogin);
  document.getElementById('viewMyAdsBtn').addEventListener('click', openMyAdsModal);
  document.getElementById('adForm').addEventListener('submit', handlePostAd);
  document.getElementById('countryFilter').addEventListener('change', fetchListings);
  document.getElementById('categoryFilter').addEventListener('change', fetchListings);

  let searchDebounceTimer;
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(fetchListings, 300);
    });
  }
}

async function handleLogin() {
  if (!checkWorldAppEnvironment()) return;

  try {
    const { finalPayload } = await MiniKit.commandsAsync.walletAuth({
      nonce: randomAlphaNumeric(24),
      requestId: 'req_login_' + Date.now(),
      expirationTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      notBefore: new Date(Date.now() - 60 * 1000),
      statement: 'Sign in to Want Sell On World',
    });

    if (finalPayload?.status === 'success' && finalPayload?.address) {
      userWallet = finalPayload.address;
      document.getElementById('loginBtn').innerText = `Connected: ${userWallet.substring(0, 6)}...`;
      document.getElementById('viewMyAdsBtn').style.display = 'block';
    } else {
      alert('❌ Wallet connect nahi ho paaya.');
    }
  } catch (err) {
    alert('❌ Wallet connect mein error aaya.');
  }
}

function containsPhoneNumber(text) {
  const phoneRegex = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\b\d{10}\b/;
  return phoneRegex.test(text);
}

async function handlePostAd(e) {
  e.preventDefault();
  if (!userWallet) return alert("Please connect your wallet first!");
  if (!checkWorldAppEnvironment()) return;

  const title = document.getElementById('title').value;
  const description = document.getElementById('description').value;

  if (containsPhoneNumber(title) || containsPhoneNumber(description)) {
    return alert("❌ Error: Phone numbers or contact details are strictly not allowed!");
  }

  const fileInput = document.getElementById('imageInput');
  const files = fileInput.files;
  if (files.length === 0) return alert("Please select at least one image!");
  if (files.length > 4) return alert("You can upload a maximum of 4 photos!");

  let paymentSuccessful = false;
  try {
    const payPayload = {
      reference: randomAlphaNumeric(16),
      to: ADMIN_WALLET,
      tokens: [{ symbol: Tokens.WLD, token_amount: tokenToDecimals(0.1, Tokens.WLD).toString() }],
      description: 'Listing Fee: 0.1 WLD',
    };

    const { finalPayload } = await MiniKit.commandsAsync.pay(payPayload);
    paymentSuccessful = (finalPayload?.status === 'success');
  } catch (err) {
    console.error('pay exception:', err);
  }

  if (!paymentSuccessful) {
    return alert('❌ Payment failed ya cancel ho gaya.');
  }

  let imageUrls = ['', '', '', ''];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileExt = file.name.split('.').pop();
    const fileName = `${Date.now()}_${Math.random()}.${fileExt}`;
    
    const { error: uploadError } = await supabase.storage.from('listing').upload(fileName, file);
    if (uploadError) {
      alert("Image upload failed: " + uploadError.message);
      return;
    }

    const { data: publicURLData } = supabase.storage.from('listing').getPublicUrl(fileName);
    imageUrls[i] = publicURLData.publicUrl;
  }

  const { error: insertError } = await supabase.from('listings').insert([{
    seller_address: userWallet,
    title,
    description,
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
    alert('Ad posted successfully!');
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
  const searchInput = document.getElementById('searchInput');
  const searchText = searchInput ? searchInput.value.trim().toLowerCase() : '';
  
  let query = supabase.from('listings').select('*').eq('status', 'active');
  
  if (selectedCountry !== 'ALL') {
    query = query.eq('country', selectedCountry);
  }
  if (selectedCategory !== 'ALL') {
    query = query.eq('category', selectedCategory);
  }

  const { data, error } = await query;
  
  if (error || !data || data.length === 0) {
    container.innerHTML = `<p class="loading-text">No active listings found.</p>`;
    return;
  }

  const filteredData = data.filter((item) => {
    if (searchText && !item.title.toLowerCase().includes(searchText)) return false;
    return true;
  });

  if (filteredData.length === 0) {
    container.innerHTML = `<p class="loading-text">No listings found.</p>`;
    return;
  }

  container.innerHTML = filteredData.map((item) => {
    const thumbImg = item.image1 || 'https://via.placeholder.com/90';
    return `
      <div class="listing-card">
        <img src="${thumbImg}" style="width: 90px; height: 90px; object-fit: cover; border-radius: 12px;">
        <div style="flex:1;">
          <span style="font-size:10px; color:#4f46e5; font-weight:bold;">🌍 ${item.country} | ${item.category}</span>
          <h3 style="font-size:1rem; margin:2px 0;">${item.title}</h3>
          <p style="font-weight:bold; color:#10b981;">${item.price} WLD</p>
        </div>
        <button onclick="window.contactSeller('${item.seller_address}', '${item.title}')" style="background:#4f46e5; color:#fff; padding:6px 12px; font-size:12px; border-radius:8px; align-self:center;">Chat</button>
      </div>
    `;
  }).join('');
}

window.contactSeller = function(sellerWallet) {
  prompt("Seller Wallet Address:", sellerWallet);
}

async function openMyAdsModal() {
  if (!userWallet) return alert("Please connect first!");
  document.getElementById('myAdsModal').style.display = 'flex';
  
  const container = document.getElementById('myAdsContainer');
  container.innerHTML = `<p class="loading-text">Loading your ads...</p>`;

  const { data } = await supabase.from('listings').select('*').eq('seller_address', userWallet).eq('status', 'active');

  if (!data || data.length === 0) {
    container.innerHTML = `<p style="text-align:center; color:#64748b; padding:20px;">You haven't posted any active ads yet.</p>`;
    return;
  }

  container.innerHTML = data.map(item => `
    <div style="background:rgba(0,0,0,0.03); padding:10px; border-radius:10px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center;">
      <div>
        <h4 style="font-size:0.9rem; color:#1e293b;">${item.title}</h4>
        <p style="font-size:0.8rem; color:#10b981;">${item.price} WLD (${item.country})</p>
      </div>
      <button onclick="window.markAsSoldOut('${item.id}')" style="background:#10b981; color:#fff; padding:6px 10px; font-size:11px; border-radius:6px; font-weight:bold; cursor:pointer;">Sold Out</button>
    </div>
  `).join('');
}

window.markAsSoldOut = async function(id) {
  if (confirm("Are you sure this item is Sold Out?")) {
    const { error } = await supabase.from('listings').delete().match({ id });
    if (!error) {
      alert("Ad removed.");
      openMyAdsModal();
      fetchListings();
    }
  }
}