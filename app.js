import { MiniKit, Tokens, tokenToDecimals } from "https://cdn.jsdelivr.net/npm/@worldcoin/minikit-js@1.9.6/+esm";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = 'https://adicdkrfinbudpaqqjai.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkaWNka3JmaW5idWRwYXFxamFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxNzM4MzMsImV4cCI6MjEwMTc0OTgzM30.ksv1zdQVimQTNWnrHaRqEXcLw7-3G6_zjAyEOZZkr0s';
const ADMIN_WALLET = '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1';
const APP_ID = 'app_06db98c492a19f80177b8d633f056982';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
let userWallet = null;
let currentChatSeller = null;

function checkWorldAppEnvironment() {
  const isWorldApp = (typeof MiniKit !== 'undefined' && MiniKit.isInstalled());
  if (!isWorldApp) {
    alert('⚠️ Yeh app sirf World App ke andar kaam karta hai.');
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
  try { MiniKit.install(APP_ID); } catch (e) { console.error(e); }
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

  const rangeInput = document.getElementById('distanceRange');
  rangeInput.addEventListener('input', (e) => {
    document.getElementById('rangeValue').innerText = e.target.value + ' km';
  });
  rangeInput.addEventListener('change', fetchListings);

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
    alert('❌ Wallet connect error.');
  }
}

// Fast & Safe Location Detection with IP Fallback (Won't freeze)
window.detectLocation = async function() {
  const addressField = document.getElementById('adAddress');
  addressField.value = "Detecting location...";

  try {
    // Fast IP-based location lookup (Works everywhere without hanging)
    const res = await fetch('https://ipapi.co/json/');
    const locData = await res.json();
    
    if (locData && locData.city) {
      addressField.value = `${locData.city}, ${locData.region}, ${locData.country_name}`;
      return;
    }
  } catch (err) {
    console.log("IP fallback error:", err);
  }

  // Fallback to browser geolocation with a strict timeout so it never hangs
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(async (position) => {
      try {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`);
        const data = await response.json();
        if (data && data.display_name) {
          addressField.value = data.display_name;
          return;
        }
      } catch (e) {
        console.error(e);
      }
      addressField.value = "";
      alert("Could not auto-detect. Please type your location manually.");
    }, (error) => {
      addressField.value = "";
      alert("Location permission denied or timeout. Please type manually.");
    }, { timeout: 5000 });
  } else {
    addressField.value = "";
    alert("Geolocation not supported. Please type manually.");
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
  const address = document.getElementById('adAddress').value;

  if (containsPhoneNumber(title) || containsPhoneNumber(description) || containsPhoneNumber(address)) {
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
    console.error(err);
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
    address: address,
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
    alert('Error saving ad: ' + insertError.message);
  }
}

async function fetchListings() {
  const container = document.getElementById('listingsContainer');
  const selectedCountry = document.getElementById('countryFilter').value;
  const selectedCategory = document.getElementById('categoryFilter').value;
  const maxDistance = parseInt(document.getElementById('distanceRange').value);
  const searchInput = document.getElementById('searchInput');
  const searchText = searchInput ? searchInput.value.trim().toLowerCase() : '';
  
  let query = supabase.from('listings').select('*').eq('status', 'active');
  
  if (selectedCountry !== 'ALL') query = query.eq('country', selectedCountry);
  if (selectedCategory !== 'ALL') query = query.eq('category', selectedCategory);

  const { data, error } = await query;
  
  if (error || !data || data.length === 0) {
    container.innerHTML = `<p class="loading-text">No active listings found.</p>`;
    return;
  }

  const filteredData = data.filter((item, index) => {
    const simulatedDist = (index * 12 + 8) % 300;
    if (simulatedDist > maxDistance) return false;
    if (searchText && !item.title.toLowerCase().includes(searchText)) return false;
    return true;
  });

  if (filteredData.length === 0) {
    container.innerHTML = `<p class="loading-text">No listings found within ${maxDistance} km.</p>`;
    return;
  }

  container.innerHTML = filteredData.map((item, index) => {
    const simulatedDist = (index * 12 + 8) % 300;
    const thumbImg = item.image1 || 'https://via.placeholder.com/90';
    return `
      <div class="listing-card" onclick="window.openAdDetails('${item.id}')" style="cursor:pointer; display:flex; gap:12px; background:#fff; padding:12px; border-radius:14px; border:1px solid #e2e8f0; margin-bottom:10px; align-items:center;">
        <img src="${thumbImg}" style="width: 90px; height: 90px; object-fit: cover; border-radius: 10px;">
        <div style="flex:1;">
          <span style="font-size:11px; color:#4f46e5; font-weight:bold;">🌍 ${item.country} (~${simulatedDist} km) | ${item.category}</span>
          <h3 style="font-size:1.05rem; margin:4px 0; color:#1e293b;">${item.title}</h3>
          <p style="font-size:1rem; font-weight:bold; color:#10b981;">${item.price} WLD</p>
        </div>
        <button onclick="event.stopPropagation(); window.openChat('${item.seller_address}', '${item.title}')" style="background:#4f46e5; color:#fff; padding:8px 14px; font-size:12px; border-radius:8px; border:none; cursor:pointer; font-weight:bold;">Chat</button>
      </div>
    `;
  }).join('');
}

window.openAdDetails = async function(id) {
  const { data, error } = await supabase.from('listings').select('*').eq('id', id).single();
  if (error || !data) return alert("Ad details not found.");

  const allImages = [data.image1, data.image2, data.image3, data.image4].filter(img => img && img.trim() !== "");
  const imagesHtml = allImages.map(img => `
    <img src="${img}" style="width:100%; height:240px; object-fit:cover; border-radius:10px; margin-bottom:8px; border:1px solid #e2e8f0;">
  `).join('');

  document.getElementById('adDetailsBody').innerHTML = `
    <div style="text-align:left;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
        <span style="background:#e0e7ff; color:#4f46e5; padding:4px 10px; border-radius:20px; font-size:11px; font-weight:bold;">📂 ${data.category}</span>
        <span style="font-size:12px; color:#64748b; font-weight:bold;">🌍 Country: ${data.country}</span>
      </div>

      <h2 style="font-size:1.4rem; margin:6px 0; color:#1e293b;">${data.title}</h2>
      <h3 style="font-size:1.45rem; color:#10b981; margin-bottom:12px;">${data.price} WLD</h3>
      
      <div style="background:#f1f5f9; padding:8px 12px; border-radius:8px; font-size:12px; color:#475569; margin-bottom:8px;">
        📍 <b>Address:</b> ${data.address || 'Not specified'}
      </div>

      <div style="background:#f1f5f9; padding:8px 12px; border-radius:8px; font-size:12px; color:#475569; margin-bottom:14px;">
        👤 <b>Seller Address:</b> <span style="font-family:monospace; color:#334155;">${data.seller_address}</span>
      </div>

      <hr style="border:0; border-top:1px solid #e2e8f0; margin-bottom:14px;">
      
      <h4 style="font-size:0.95rem; color:#475569; margin-bottom:6px;">Uploaded Photos (${allImages.length})</h4>
      <div style="max-height:280px; overflow-y:auto; margin-bottom:14px; padding-right:4px;">
        ${imagesHtml}
      </div>

      <h4 style="font-size:0.95rem; color:#475569; margin-bottom:6px;">Product Description</h4>
      <p style="font-size:0.95rem; color:#334155; background:#f8fafc; padding:12px; border-radius:8px; border:1px solid #e2e8f0; margin-bottom:16px; white-space:pre-wrap; line-height:1.4;">${data.description}</p>

      <button onclick="event.stopPropagation(); window.openChat('${data.seller_address}', '${data.title}'); document.getElementById('adDetailsModal').style.display='none';" style="background:#4f46e5; color:#fff; width:100%; padding:12px; border:none; border-radius:10px; font-size:1rem; font-weight:bold; cursor:pointer;">Chat with Seller</button>
    </div>
  `;
  document.getElementById('adDetailsModal').style.display = 'flex';
}

window.openChat = function(sellerWallet, adTitle) {
  if (!userWallet) return alert("Please connect your wallet first to chat!");
  currentChatSeller = sellerWallet;
  document.getElementById('chatTitle').innerText = `Chat about: ${adTitle}`;
  document.getElementById('chatMessages').innerHTML = `<div style="background:#e2e8f0; padding:8px 12px; border-radius:8px; font-size:12px; align-self:flex-start; color:#334155;">Hello! I am interested in your ad: ${adTitle}</div>`;
  document.getElementById('chatModal').style.display = 'flex';
}

window.sendMessage = function() {
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg) return;

  const chatBox = document.getElementById('chatMessages');
  chatBox.innerHTML += `<div style="background:#4f46e5; color:#fff; padding:8px 12px; border-radius:8px; font-size:12px; align-self:flex-end; max-width:80%;">${msg}</div>`;
  input.value = '';
  chatBox.scrollTop = chatBox.scrollHeight;
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
    <div onclick="document.getElementById('myAdsModal').style.display='none'; window.openAdDetails('${item.id}')" style="background:rgba(0,0,0,0.03); padding:10px; border-radius:10px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; cursor:pointer;">
      <div>
        <h4 style="font-size:0.9rem; color:#1e293b;">${item.title}</h4>
        <p style="font-size:0.8rem; color:#10b981;">${item.price} WLD (${item.country})</p>
      </div>
      <button onclick="event.stopPropagation(); window.markAsSoldOut('${item.id}')" style="background:#10b981; color:#fff; padding:6px 10px; font-size:11px; border-radius:6px; font-weight:bold; cursor:pointer;">Sold Out</button>
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