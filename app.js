import { MiniKit, Tokens, tokenToDecimals } from "https://cdn.jsdelivr.net/npm/@worldcoin/minikit-js@1.9.6/+esm";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = 'https://adicdkrfinbudpaqqjai.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkaWNka3JmaW5idWRwYXFxamFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxNzM4MzMsImV4cCI6MjEwMTc0OTgzM30.ksv1zdQVimQTNWnrHaRqEXcLw7-3G6_zjAyEOZZkr0s';
const ADMIN_WALLET = '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1';
const APP_ID = 'app_06db98c492a19f80177b8d633f056982';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
let userWallet = null;
let currentUsername = null; 
let currentChatSeller = null;
let currentChatSellerName = null;
let currentLat = 28.6139; 
let currentLng = 77.2090;

// ==========================================
// UNIVERSAL NEON POPUP SYSTEM
// ==========================================
let popupResolve = null;
window.showNeonPopup = function(title, text, icon = '🔔', type = 'alert') {
  return new Promise((resolve) => {
    document.getElementById('neonPopupIcon').innerText = icon;
    document.getElementById('neonPopupTitle').innerText = title;
    document.getElementById('neonPopupText').innerHTML = text;

    const inputContainer = document.getElementById('neonPopupInputContainer');
    const alertBtns = document.getElementById('neonPopupAlertBtnContainer');
    const confirmBtns = document.getElementById('neonPopupConfirmBtnContainer');
    const popupBox = document.getElementById('neonPopupBox');
    
    inputContainer.style.display = 'none';
    alertBtns.style.display = 'none';
    confirmBtns.style.display = 'none';

    if (type === 'confirm') {
      confirmBtns.style.display = 'flex';
      popupBox.style.borderColor = '#ef4444';
      popupBox.style.boxShadow = '0 0 30px rgba(239, 68, 68, 0.4)';
      document.getElementById('neonPopupTitle').style.color = '#ef4444';
    } else if (type === 'prompt') {
      inputContainer.style.display = 'block';
      document.getElementById('neonPopupInput').value = '';
      alertBtns.style.display = 'block';
      document.getElementById('neonPopupAlertBtn').innerText = 'Submit';
      popupBox.style.borderColor = '#10b981';
      popupBox.style.boxShadow = '0 0 30px rgba(16, 185, 129, 0.4)';
      document.getElementById('neonPopupTitle').style.color = '#10b981';
    } else {
      alertBtns.style.display = 'block';
      document.getElementById('neonPopupAlertBtn').innerText = 'OK';
      popupBox.style.borderColor = '#38bdf8';
      popupBox.style.boxShadow = '0 0 30px rgba(56, 189, 248, 0.4)';
      document.getElementById('neonPopupTitle').style.color = '#38bdf8';
    }

    document.getElementById('neonPopup').style.display = 'flex';
    popupResolve = resolve;

    document.getElementById('neonPopupAlertBtn').onclick = function() {
      if (type === 'prompt') {
        const val = document.getElementById('neonPopupInput').value.trim();
        if(!val) closeNeonPopup("User_" + Math.floor(Math.random()*10000));
        else closeNeonPopup(val);
      } else {
        closeNeonPopup(true);
      }
    };
    
    document.getElementById('neonPopupConfirmYesBtn').onclick = () => closeNeonPopup(true);
    document.getElementById('neonPopupConfirmNoBtn').onclick = () => closeNeonPopup(false);
  });
};

window.closeNeonPopup = function(result) {
  document.getElementById('neonPopup').style.display = 'none';
  if (popupResolve) {
    popupResolve(result);
    popupResolve = null;
  }
};

window.copyAddress = async function(address) {
  try {
    await navigator.clipboard.writeText(address);
    await showNeonPopup('Copied!', 'Wallet Address copied to clipboard.', '📋');
  } catch (err) {
    const textArea = document.createElement("textarea");
    textArea.value = address;
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand('copy');
      await showNeonPopup('Copied!', 'Wallet Address copied to clipboard.', '📋');
    } catch (ex) {}
    document.body.removeChild(textArea);
  }
}

// ==========================================
// STRICT WORLD APP ENVIRONMENT CHECK
// ==========================================
async function enforceWorldAppEnvironment() {
  const isWorldApp = (typeof MiniKit !== 'undefined' && MiniKit.isInstalled());
  if (!isWorldApp) {
    document.body.innerHTML = `
      <div style="background: linear-gradient(135deg, #0f172a, #1e293b); color: #fff; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 20px; font-family: sans-serif;">
        <div style="font-size: 80px; margin-bottom: 20px; animation: iconBounce 2s infinite;">⚠️</div>
        <h1 style="color: #ef4444; font-size: 2rem; margin-bottom: 10px; font-weight: 900; text-shadow: 0 0 20px rgba(239, 68, 68, 0.5);">STRICT WARNING</h1>
        <p style="color: #cbd5e1; font-size: 1.1rem; max-width: 400px; line-height: 1.6; margin-bottom: 30px;">
          This application is secure and can <b>ONLY</b> be opened inside the official <b>World App</b>. Please open this mini-app through World App to continue.
        </p>
        <div style="background: rgba(239, 68, 68, 0.1); border: 2px solid #ef4444; padding: 12px 24px; border-radius: 14px; color: #ef4444; font-weight: bold; font-size: 0.95rem; box-shadow: 0 0 15px rgba(239, 68, 68, 0.3);">
          🚫 Access Denied Outside World App
        </div>
      </div>
    `;
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
  
  const isAllowed = await enforceWorldAppEnvironment();
  if (!isAllowed) return;

  setupUI();
  detectUserCurrentPosition();
  fetchListings();
  checkExpiredAds();
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
      
      const { data: userData } = await supabase.from('users').select('username').eq('wallet_address', userWallet).single();
      
      if (userData && userData.username) {
        currentUsername = userData.username;
      } else {
        currentUsername = await showNeonPopup('Welcome! 👋', 'Choose a stylish Username for your marketplace profile:', '👤', 'prompt');
        await supabase.from('users').upsert([{ wallet_address: userWallet, username: currentUsername }]);
      }

      document.getElementById('loginBtn').innerText = `👤 ${currentUsername}`;
      document.getElementById('viewMyAdsBtn').style.display = 'block';

      if (userWallet.toLowerCase() === ADMIN_WALLET.toLowerCase()) {
        document.getElementById('adminPanelBtn').style.display = 'block';
      }
    } else {
      await showNeonPopup('Connection Failed', 'Wallet connect nahi ho paaya.', '🔌');
    }
  } catch (err) {
    await showNeonPopup('Error', 'Wallet connect error.', '❌');
  }
}

function detectUserCurrentPosition() {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition((position) => {
      currentLat = position.coords.latitude;
      currentLng = position.coords.longitude;
    }, (err) => console.log("GPS default used"), { enableHighAccuracy: true, timeout: 10000 });
  }
}

window.detectLocation = async function() {
  const addressField = document.getElementById('adAddress');
  addressField.value = "Detecting precise location...";

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(async (position) => {
      try {
        currentLat = position.coords.latitude;
        currentLng = position.coords.longitude;
        const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${currentLat}&lon=${currentLng}`);
        const data = await response.json();
        addressField.value = data.display_name || `Lat: ${currentLat.toFixed(4)}, Lng: ${currentLng.toFixed(4)}`;
      } catch (e) { addressField.value = `Lat: ${currentLat.toFixed(4)}, Lng: ${currentLng.toFixed(4)}`; }
    }, async () => {
      try {
        const res = await fetch('https://ipapi.co/json/');
        const locData = await res.json();
        addressField.value = `${locData.city}, ${locData.region}, ${locData.country_name}`;
      } catch (err) { addressField.value = ""; await showNeonPopup('Notice', 'Could not auto-detect. Please type manually.', '📍'); }
    }, { enableHighAccuracy: true, timeout: 7000 });
  }
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return 0;
  const R = 6371; 
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

function containsPhoneNumber(text) {
  const phoneRegex = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\b\d{10}\b/;
  return phoneRegex.test(text);
}

// ==========================================
// FEATURE 3: AUTO AD EXPIRY
// ==========================================
async function checkExpiredAds() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: expiredAds } = await supabase.from('listings').select('id, title, image1, image2, image3, image4').lt('created_at', thirtyDaysAgo).eq('status', 'active');
  
  if (expiredAds) {
    for (const ad of expiredAds) {
      const imagesList = [ad.image1, ad.image2, ad.image3, ad.image4];
      for (const imgUrl of imagesList) {
        if (imgUrl?.includes('/listing/')) await supabase.storage.from('listing').remove([imgUrl.split('/listing/')[1]]);
      }
      await supabase.from('chats').delete().eq('ad_title', ad.title);
      await supabase.from('listings').delete().match({ id: ad.id });
    }
  }
}

// ==========================================
// FULL-SCREEN IMAGE SLIDER SYSTEM
// ==========================================
let viewerImages = [];
let currentImageIndex = 0;

window.openImageViewer = function(imagesStr, index) {
  viewerImages = imagesStr.split('|');
  currentImageIndex = parseInt(index);
  updateViewer();
  document.getElementById('imageViewerModal').style.display = 'flex';
}

function updateViewer() {
  document.getElementById('viewerImage').src = viewerImages[currentImageIndex];
  document.getElementById('imageCounter').innerText = `${currentImageIndex + 1} / ${viewerImages.length}`;
}

window.prevImage = () => { if (currentImageIndex > 0) { currentImageIndex--; updateViewer(); } };
window.nextImage = () => { if (currentImageIndex < viewerImages.length - 1) { currentImageIndex++; updateViewer(); } };

// ==========================================
// COMPRESSION HELPER
// ==========================================
function compressImage(file, maxWidth = 1000, quality = 0.7) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width, height = img.height;
        if (width > maxWidth) { height = Math.round((height * maxWidth) / width); width = maxWidth; }
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => resolve(new File([blob], file.name, { type: 'image/jpeg' })), 'image/jpeg', quality);
      };
    };
  });
}

// ==========================================
// FEATURE: POST AD (1 WLD FEE)
// ==========================================
async function handlePostAd(e) {
  e.preventDefault();
  if (!userWallet || !currentUsername) { await showNeonPopup('Hold On', 'Please connect your wallet first!', '🔗'); return; }

  const title = document.getElementById('title').value;
  const description = document.getElementById('description').value;
  const address = document.getElementById('adAddress').value;

  if (containsPhoneNumber(title) || containsPhoneNumber(description) || containsPhoneNumber(address)) {
    await showNeonPopup('Rule Violation', 'Phone numbers not allowed!', '🚫'); return;
  }

  const fileInput = document.getElementById('imageInput');
  const files = fileInput.files;
  if (files.length === 0 || files.length > 4) { await showNeonPopup('Image Limit', 'Please upload 1-4 photos!', '📸'); return; }

  let paymentSuccessful = false;
  try {
    const { finalPayload } = await MiniKit.commandsAsync.pay({
      reference: randomAlphaNumeric(16),
      to: ADMIN_WALLET,
      tokens: [{ symbol: Tokens.WLD, token_amount: tokenToDecimals(1, Tokens.WLD).toString() }], // 1 WLD Fee
      description: 'Listing Fee: 1 WLD',
    });
    paymentSuccessful = (finalPayload?.status === 'success');
  } catch (err) {}

  if (!paymentSuccessful) { await showNeonPopup('Payment Cancelled', 'Payment failed or was cancelled.', '💸'); return; }

  let imageUrls = ['', '', '', ''];
  for (let i = 0; i < files.length; i++) {
    const compressedFile = await compressImage(files[i]);
    const fileName = `${Date.now()}_${Math.random()}.jpg`;
    await supabase.storage.from('listing').upload(fileName, compressedFile);
    imageUrls[i] = supabase.storage.from('listing').getPublicUrl(fileName).data.publicUrl;
  }

  const { error } = await supabase.from('listings').insert([{
    seller_address: userWallet, seller_name: currentUsername, title, description,
    price: document.getElementById('price').value, category: document.getElementById('category').value,
    country: document.getElementById('adCountry').value, address, lat: currentLat, lng: currentLng,
    image1: imageUrls[0], image2: imageUrls[1], image3: imageUrls[2], image4: imageUrls[3], status: 'active'
  }]);

  if (!error) {
    const { data: balData } = await supabase.from('sow_balances').select('balance').eq('wallet_address', userWallet).single();
    await supabase.from('sow_balances').upsert([{ wallet_address: userWallet, balance: (balData?.balance || 0) + 1 }]);
    document.getElementById('adModal').style.display = 'none';
    document.getElementById('adForm').reset();
    fetchListings();
    await showNeonPopup('Awesome! 🎉', `Ad posted successfully!<br>+1 SOW Coin Earned!`, '🪙');
  } else {
    await showNeonPopup('Error', 'Database error: ' + error.message, '⚠️');
  }
}

async function fetchListings() {
  const container = document.getElementById('listingsContainer');
  const selectedCountry = document.getElementById('countryFilter').value;
  const selectedCategory = document.getElementById('categoryFilter').value;
  const maxDistance = parseInt(document.getElementById('distanceRange').value);
  const searchText = document.getElementById('searchInput')?.value.trim().toLowerCase() || '';
  
  let query = supabase.from('listings').select('*').eq('status', 'active');
  if (selectedCountry !== 'ALL') query = query.eq('country', selectedCountry);
  if (selectedCategory !== 'ALL') query = query.eq('category', selectedCategory);

  const { data } = await query;
  if (!data || data.length === 0) { container.innerHTML = `<p class="loading-text">No active listings.</p>`; return; }

  const filteredData = data.filter((item) => {
    const dist = calculateDistance(currentLat, currentLng, item.lat, item.lng);
    item.calculatedDistance = dist;
    return dist <= maxDistance && (searchText === '' || item.title.toLowerCase().includes(searchText));
  });

  container.innerHTML = filteredData.map(item => `
    <div class="listing-card" onclick="window.openAdDetails('${item.id}')" style="cursor:pointer; display:flex; gap:12px; background:#fff; padding:12px; border-radius:14px; border:1px solid #e2e8f0; margin-bottom:10px; align-items:center;">
      <img src="${item.image1 || 'https://via.placeholder.com/90'}" style="width: 90px; height: 90px; object-fit: cover; border-radius: 10px;">
      <div style="flex:1;">
        <span style="font-size:11px; color:#4f46e5; font-weight:bold;">🌍 ${item.country} (~${item.calculatedDistance} km)</span>
        <h3 style="font-size:1.05rem; margin:4px 0; color:#1e293b;">${item.title}</h3>
        <p style="font-size:1rem; font-weight:bold; color:#10b981; margin:0;">${item.price} WLD</p>
        <p style="font-size:0.8rem; color:#64748b; margin:4px 0 0 0;">👤 ${item.seller_name || 'User'}</p>
      </div>
      <button onclick="event.stopPropagation(); window.openChat('${item.seller_address}', '${item.title}', '${item.seller_name}')" style="background:#4f46e5; color:#fff; padding:8px 14px; font-size:12px; border-radius:8px; border:none; cursor:pointer; font-weight:bold;">Chat</button>
    </div>
  `).join('');
}

window.openAdDetails = async function(id) {
  const { data } = await supabase.from('listings').select('*').eq('id', id).single();
  if (!data) return;
  const allImages = [data.image1, data.image2, data.image3, data.image4].filter(img => img);
  document.getElementById('adDetailsBody').innerHTML = `
    <h2 style="margin:6px 0; color:#1e293b;">${data.title}</h2>
    <h3 style="color:#10b981;">${data.price} WLD</h3>
    <div style="background:#f1f5f9; padding:10px; border-radius:8px; font-size:12px;">📍 ${data.address}</div>
    <div style="max-height:280px; overflow-y:auto; margin:14px 0;">${allImages.map((img, idx) => `<img src="${img}" onclick="window.openImageViewer('${allImages.join('|')}', ${idx})" style="width:100%; border-radius:10px; margin-bottom:8px;">`).join('')}</div>
    <p style="background:#f8fafc; padding:10px; border-radius:8px;">${data.description}</p>
    <div style="display:flex; gap:8px;">
      <button onclick="document.getElementById('adDetailsModal').style.display='none';" style="flex:1; padding:12px;">⬅️ Back</button>
      <button onclick="window.openChat('${data.seller_address}', '${data.title}', '${data.seller_name}'); document.getElementById('adDetailsModal').style.display='none';" style="flex:1.5; padding:12px; background:#4f46e5; color:#fff;">💬 Chat</button>
    </div>
  `;
  document.getElementById('adDetailsModal').style.display = 'flex';
}

window.openChat = async function(sellerWallet, adTitle, sellerName) {
  currentChatSeller = sellerWallet; currentChatSellerName = sellerName; window.currentChatAdTitle = adTitle;
  document.getElementById('chatTitle').innerText = `Chat with ${sellerName}`;
  document.getElementById('chatModal').style.display = 'flex';
  const { data } = await supabase.from('chats').select('*').eq('ad_title', adTitle).order('created_at', { ascending: true });
  document.getElementById('chatMessages').innerHTML = (data || []).map(m => `
    <div style="background:${m.sender === userWallet ? '#4f46e5' : '#e2e8f0'}; color:${m.sender === userWallet ? '#fff' : '#334155'}; padding:8px; border-radius:8px; font-size:12px; align-self:${m.sender === userWallet ? 'flex-end' : 'flex-start'}; max-width:80%;">${m.message}</div>
  `).join('');
}

window.sendMessage = async function() {
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg) return;
  await supabase.from('chats').insert([{ sender: userWallet, receiver: currentChatSeller, ad_title: window.currentChatAdTitle, message: msg }]);
  input.value = '';
  window.openChat(currentChatSeller, window.currentChatAdTitle, currentChatSellerName);
}

window.markAsSoldOut = async function(id) {
  const isConfirmed = await showNeonPopup('Delete Ad?', 'Are you sure?', '🗑️', 'confirm');
  if (isConfirmed) {
    const { data: adData } = await supabase.from('listings').select('*').eq('id', id).single();
    if (adData) {
      [adData.image1, adData.image2, adData.image3, adData.image4].forEach(img => {
        if (img?.includes('/listing/')) supabase.storage.from('listing').remove([img.split('/listing/')[1]]);
      });
      await supabase.from('chats').delete().eq('ad_title', adData.title);
    }
    await supabase.from('listings').delete().match({ id });
    await showNeonPopup('Deleted', 'Ad removed.', '✅');
    fetchListings();
  }
}

window.openReviews = async function(sellerAddress, sellerName) {
  window.targetSellerAddress = sellerAddress;
  document.getElementById('reviewsModalTitle').innerText = `${sellerName}'s Reviews`;
  document.getElementById('reviewsModal').style.display = 'flex';
  const { data } = await supabase.from('reviews').select('*').eq('seller_address', sellerAddress);
  document.getElementById('reviewsListContainer').innerHTML = (data || []).map(r => `
    <div style="padding:8px; background:#f8fafc; border-radius:8px;"><b>${r.buyer_name}</b>: ${r.comment} (${'⭐'.repeat(r.rating)})</div>
  `).join('');
}

window.submitReview = async function() {
  await supabase.from('reviews').insert([{ seller_address: window.targetSellerAddress, buyer_address: userWallet, buyer_name: currentUsername, rating: document.getElementById('reviewRating').value, comment: document.getElementById('reviewComment').value }]);
  await showNeonPopup('Success', 'Review Posted!', '🎉');
}

window.openAdminPanel = async function() {
  document.getElementById('adminModal').style.display = 'flex';
  const { data: listings } = await supabase.from('listings').select('*');
  document.getElementById('adminListingsContainer').innerHTML = (listings || []).map(item => `
    <div style="display:flex; justify-content:space-between; padding:8px;">${item.title} <button onclick="window.adminDeleteAd('${item.id}')">Delete</button></div>
  `).join('');
}

window.adminDeleteAd = async function(id) {
  await supabase.from('listings').delete().match({ id });
  window.openAdminPanel();
  fetchListings();
}