import { MiniKit, Tokens, tokenToDecimals } from "https://cdn.jsdelivr.net/npm/@worldcoin/minikit-js@1.9.6/+esm";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = 'https://adicdkrfinbudpaqqjai.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFkaWNka3JmaW5idWRwYXFxamFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxNzM4MzMsImV4cCI6MjEwMTc0OTgzM30.ksv1zdQVimQTNWnrHaRqEXcLw7-3G6_zjAyEOZZkr0s';
const ADMIN_WALLET = '0x8c5b20653abcb87f6b3a7cb469d8623e94bfb6a1';
const APP_ID = 'app_06db98c492a19f80177b8d633f056982';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
let userWallet = null;
let currentChatSeller = null;
let currentLat = 28.6139; 
let currentLng = 77.2090;

// ==========================================
// UNIVERSAL NEON POPUP SYSTEM
// ==========================================
let popupResolve = null;

window.showNeonPopup = function(title, text, icon = '🔔', isConfirm = false) {
  return new Promise((resolve) => {
    document.getElementById('neonPopupIcon').innerText = icon;
    document.getElementById('neonPopupTitle').innerText = title;
    document.getElementById('neonPopupText').innerHTML = text;

    if (isConfirm) {
      document.getElementById('neonPopupAlertBtnContainer').style.display = 'none';
      document.getElementById('neonPopupConfirmBtnContainer').style.display = 'flex';
      document.getElementById('neonPopupBox').style.borderColor = '#ef4444';
      document.getElementById('neonPopupBox').style.boxShadow = '0 0 30px rgba(239, 68, 68, 0.4)';
      document.getElementById('neonPopupTitle').style.color = '#ef4444';
    } else {
      document.getElementById('neonPopupAlertBtnContainer').style.display = 'block';
      document.getElementById('neonPopupConfirmBtnContainer').style.display = 'none';
      document.getElementById('neonPopupBox').style.borderColor = '#38bdf8';
      document.getElementById('neonPopupBox').style.boxShadow = '0 0 30px rgba(56, 189, 248, 0.4)';
      document.getElementById('neonPopupTitle').style.color = '#38bdf8';
    }

    document.getElementById('neonPopup').style.display = 'flex';
    popupResolve = resolve;
  });
};

window.closeNeonPopup = function(result) {
  document.getElementById('neonPopup').style.display = 'none';
  if (popupResolve) {
    popupResolve(result);
    popupResolve = null;
  }
};

// Clipboard function that uses Neon Popup instead of native prompt!
window.copyAddress = async function(address) {
  try {
    await navigator.clipboard.writeText(address);
    await showNeonPopup('Copied!', 'Seller Wallet Address copied to clipboard.', '📋');
  } catch (err) {
    // Fallback for Mini-App limits
    const textArea = document.createElement("textarea");
    textArea.value = address;
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand('copy');
      await showNeonPopup('Copied!', 'Seller Wallet Address copied to clipboard.', '📋');
    } catch (ex) {
      await showNeonPopup('Error', 'Could not copy address directly.', '⚠️');
    }
    document.body.removeChild(textArea);
  }
}
// ==========================================

async function checkWorldAppEnvironment() {
  const isWorldApp = (typeof MiniKit !== 'undefined' && MiniKit.isInstalled());
  if (!isWorldApp) {
    await showNeonPopup('Warning', 'Yeh app sirf World App ke andar kaam karta hai.', '⚠️');
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
  detectUserCurrentPosition();
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
  const isEnvOk = await checkWorldAppEnvironment();
  if (!isEnvOk) return;

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
    }, (err) => {
      console.log("GPS position default used");
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
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
        if (data && data.display_name) {
          addressField.value = data.display_name;
        } else {
          addressField.value = `Lat: ${currentLat.toFixed(4)}, Lng: ${currentLng.toFixed(4)}`;
        }
      } catch (e) {
        addressField.value = `Lat: ${currentLat.toFixed(4)}, Lng: ${currentLng.toFixed(4)}`;
      }
    }, async (error) => {
      try {
        const res = await fetch('https://ipapi.co/json/');
        const locData = await res.json();
        if (locData && locData.city) {
          currentLat = locData.latitude;
          currentLng = locData.longitude;
          addressField.value = `${locData.city}, ${locData.region}, ${locData.country_name}`;
        } else {
          addressField.value = "";
          await showNeonPopup('Notice', 'Could not auto-detect. Please type manually.', '📍');
        }
      } catch (err) {
        addressField.value = "";
        await showNeonPopup('Error', 'Location permissions denied and fallback failed. Please type manually.', '🌍');
      }
    }, { enableHighAccuracy: true, timeout: 7000, maximumAge: 0 });
  } else {
    addressField.value = "";
    await showNeonPopup('Error', 'Geolocation not supported. Please type manually.', '🚫');
  }
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return 0;
  const R = 6371; 
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return Math.round(R * c); 
}

function containsPhoneNumber(text) {
  const phoneRegex = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\b\d{10}\b/;
  return phoneRegex.test(text);
}

async function handlePostAd(e) {
  e.preventDefault();
  
  if (!userWallet) {
    await showNeonPopup('Hold On', 'Please connect your wallet first!', '🔗');
    return;
  }
  
  const isEnvOk = await checkWorldAppEnvironment();
  if (!isEnvOk) return;

  const title = document.getElementById('title').value;
  const description = document.getElementById('description').value;
  const address = document.getElementById('adAddress').value;

  if (!address) {
    await showNeonPopup('Location Required', 'Please click \'📍 Detect GPS\' to capture your real location before posting!', '📍');
    return;
  }

  if (containsPhoneNumber(title) || containsPhoneNumber(description) || containsPhoneNumber(address)) {
    await showNeonPopup('Rule Violation', 'Phone numbers or contact details are strictly not allowed to prevent scams!', '🚫');
    return;
  }

  const fileInput = document.getElementById('imageInput');
  const files = fileInput.files;
  if (files.length === 0) {
    await showNeonPopup('Image Missing', 'Please select at least one product image!', '🖼️');
    return;
  }
  if (files.length > 4) {
    await showNeonPopup('Limit Reached', 'You can upload a maximum of 4 photos!', '📸');
    return;
  }

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
    await showNeonPopup('Payment Cancelled', 'Payment failed or was cancelled by you.', '💸');
    return;
  }

  let imageUrls = ['', '', '', ''];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileExt = file.name.split('.').pop();
    const fileName = `${Date.now()}_${Math.random()}.${fileExt}`;
    
    const { error: uploadError } = await supabase.storage.from('listing').upload(fileName, file);
    if (uploadError) {
      await showNeonPopup('Upload Error', 'Image upload failed: ' + uploadError.message, '❌');
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
    lat: currentLat,
    lng: currentLng,
    image1: imageUrls[0],
    image2: imageUrls[1],
    image3: imageUrls[2],
    image4: imageUrls[3],
    status: 'active'
  }]);

  if (!insertError) {
    const { data: balData } = await supabase.from('sow_balances').select('balance').eq('wallet_address', userWallet).single();
    let newBal = (balData && balData.balance) ? balData.balance + 1 : 1;
    await supabase.from('sow_balances').upsert([{ wallet_address: userWallet, balance: newBal }]);

    document.getElementById('adModal').style.display = 'none';
    document.getElementById('adForm').reset();
    fetchListings();

    await showNeonPopup('Awesome! 🎉', `Your ad was posted successfully!<br><span style="color: #10b981; font-weight: 800; font-size: 1.2rem; display: block; margin-top: 8px; text-shadow: 0 0 10px rgba(16, 185, 129, 0.4);">+1 SOW Coin Earned!</span>`, '🪙');
  } else {
    await showNeonPopup('Database Error', 'Error saving ad: ' + insertError.message, '⚠️');
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

  const filteredData = data.filter((item) => {
    const itemLat = item.lat || 28.6139;
    const itemLng = item.lng || 77.2090;
    const realDist = calculateDistance(currentLat, currentLng, itemLat, itemLng);

    item.calculatedDistance = realDist; 

    if (realDist > maxDistance) return false;
    if (searchText && !item.title.toLowerCase().includes(searchText)) return false;
    return true;
  });

  if (filteredData.length === 0) {
    container.innerHTML = `<p class="loading-text">No listings found within ${maxDistance} km of your location.</p>`;
    return;
  }

  container.innerHTML = filteredData.map((item) => {
    const thumbImg = item.image1 || 'https://via.placeholder.com/90';
    return `
      <div class="listing-card" onclick="window.openAdDetails('${item.id}')" style="cursor:pointer; display:flex; gap:12px; background:#fff; padding:12px; border-radius:14px; border:1px solid #e2e8f0; margin-bottom:10px; align-items:center;">
        <img src="${thumbImg}" style="width: 90px; height: 90px; object-fit: cover; border-radius: 10px;">
        <div style="flex:1;">
          <span style="font-size:11px; color:#4f46e5; font-weight:bold;">🌍 ${item.country} (~${item.calculatedDistance} km) | ${item.category}</span>
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
  if (error || !data) {
    await showNeonPopup('Not Found', 'Ad details not found or removed.', '🔍');
    return;
  }

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
        📍 <b>GPS Address:</b> ${data.address || 'Not specified'}
      </div>

      <div style="background:#f1f5f9; padding:8px 12px; border-radius:8px; font-size:12px; color:#475569; margin-bottom:14px;">
        <!-- Neon Copy feature added directly to the address text -->
        👤 <b>Seller Address:</b> <br>
        <span onclick="window.copyAddress('${data.seller_address}')" style="font-family:monospace; color:#38bdf8; font-weight:bold; cursor:pointer; text-decoration:underline;">
          ${data.seller_address.substring(0,18)}... 📋
        </span>
      </div>

      <hr style="border:0; border-top:1px solid #e2e8f0; margin-bottom:14px;">
      
      <h4 style="font-size:0.95rem; color:#475569; margin-bottom:6px;">Uploaded Photos (${allImages.length})</h4>
      <div style="max-height:280px; overflow-y:auto; margin-bottom:14px; padding-right:4px;">
        ${imagesHtml}
      </div>

      <h4 style="font-size:0.95rem; color:#475569; margin-bottom:6px;">Product Description</h4>
      <p style="font-size:0.95rem; color:#334155; background:#f8fafc; padding:12px; border-radius:8px; border:1px solid #e2e8f0; margin-bottom:16px; white-space:pre-wrap; line-height:1.4;">${data.description}</p>

      <div style="display: flex; gap: 8px; margin-top: 16px;">
        <button onclick="document.getElementById('adDetailsModal').style.display='none';" style="background: #e2e8f0; color: #475569; flex: 1; padding: 12px; border: none; border-radius: 10px; font-size: 1rem; font-weight: bold; cursor: pointer;">⬅️ Back</button>
        <button onclick="event.stopPropagation(); window.openChat('${data.seller_address}', '${data.title}'); document.getElementById('adDetailsModal').style.display='none';" style="background: #4f46e5; color: #fff; flex: 1.5; padding: 12px; border: none; border-radius: 10px; font-size: 1rem; font-weight: bold; cursor: pointer;">💬 Chat</button>
      </div>
    </div>
  `;
  document.getElementById('adDetailsModal').style.display = 'flex';
}

window.openChat = async function(sellerWallet, adTitle) {
  if (!userWallet) {
    await showNeonPopup('Hold On', 'Please connect your wallet first to chat!', '💬');
    return;
  }
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
  if (!userWallet) {
    await showNeonPopup('Hold On', 'Please connect your wallet first!', '🔗');
    return;
  }
  document.getElementById('myAdsModal').style.display = 'flex';
  
  const container = document.getElementById('myAdsContainer');
  container.innerHTML = `<p class="loading-text">Loading your ads & balance...</p>`;

  const { data: balData } = await supabase.from('sow_balances').select('balance').eq('wallet_address', userWallet).single();
  const earnedSow = balData ? balData.balance : 0;

  const balanceHtml = `
    <div style="background: linear-gradient(135deg, #0f172a, #1e293b); border: 1px solid #38bdf8; padding: 14px; border-radius: 12px; margin-bottom: 15px; color: #fff; text-align: center; box-shadow: 0 4px 10px rgba(56, 189, 248, 0.2);">
      <h3 style="margin: 0; font-size: 1.3rem; color: #38bdf8;">🪙 Your Balance: ${earnedSow} SOW</h3>
      <p style="margin: 4px 0 0 0; font-size: 0.8rem; color: #cbd5e1;">Tokens will be airdropped to your wallet on launch!</p>
    </div>
  `;

  const { data: activeAds } = await supabase.from('listings').select('*').eq('seller_address', userWallet).eq('status', 'active');

  if (!activeAds || activeAds.length === 0) {
    container.innerHTML = balanceHtml + `<p style="text-align:center; color:#64748b; padding:20px;">You have no active ads.</p>`;
    return;
  }

  container.innerHTML = balanceHtml + activeAds.map(item => `
    <div onclick="document.getElementById('myAdsModal').style.display='none'; window.openAdDetails('${item.id}')" style="background:rgba(0,0,0,0.03); padding:10px; border-radius:10px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; cursor:pointer;">
      <div>
        <h4 style="font-size:0.9rem; color:#1e293b;">${item.title}</h4>
        <p style="font-size:0.8rem; color:#10b981;">${item.price} WLD (${item.country})</p>
      </div>
      <button onclick="event.stopPropagation(); window.markAsSoldOut('${item.id}')" style="background:#ef4444; color:#fff; padding:6px 10px; font-size:11px; border-radius:6px; font-weight:bold; cursor:pointer;">Delete Ad</button>
    </div>
  `).join('');
}

window.markAsSoldOut = async function(id) {
  const isConfirmed = await showNeonPopup('Delete Ad?', 'Are you sure this item is Sold Out? This will permanently delete the ad.', '🗑️', true);
  
  if (isConfirmed) {
    const { error } = await supabase.from('listings').delete().match({ id });
    if (!error) {
      await showNeonPopup('Deleted', 'Ad deleted successfully! Your SOW balance is safe.', '✅');
      openMyAdsModal();
      fetchListings();
    } else {
      await showNeonPopup('Error', 'Could not delete: ' + error.message, '⚠️');
    }
  }
}