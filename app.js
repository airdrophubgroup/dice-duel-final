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
  checkExpiredAds(); // Auto Expiry Check on boot
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

      // Check if logged in user is Admin
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

// ==========================================
// PROHIBITED / ILLEGAL WORDS CHECKER
// ==========================================
const forbiddenWords = ['weapon', 'drug', 'gun', 'hack', 'counterfeit', 'illegal', 'adult', 'bomb', 'firearm'];

function validateListingContent(title, description) {
  const content = (title + " " + description).toLowerCase();
  for (let word of forbiddenWords) {
    if (content.includes(word)) {
      return word;
    }
  }
  return null;
}

// ==========================================
// FEATURE 3: AUTO AD EXPIRY (30 Days Limit)
// ==========================================
async function checkExpiredAds() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: expiredAds } = await supabase.from('listings').select('id, title, image1, image2, image3, image4').lt('created_at', thirtyDaysAgo).eq('status', 'active');
  
  if (expiredAds && expiredAds.length > 0) {
    for (const ad of expiredAds) {
      const imagesList = [ad.image1, ad.image2, ad.image3, ad.image4];
      for (const imgUrl of imagesList) {
        if (imgUrl && imgUrl.includes('/listing/')) {
          const filePath = imgUrl.split('/listing/')[1];
          if (filePath) await supabase.storage.from('listing').remove([filePath]);
        }
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

window.prevImage = function() {
  if (currentImageIndex > 0) {
    currentImageIndex--;
    updateViewer();
  }
}

window.nextImage = function() {
  if (currentImageIndex < viewerImages.length - 1) {
    currentImageIndex++;
    updateViewer();
  }
}

function updateViewer() {
  document.getElementById('viewerImage').src = viewerImages[currentImageIndex];
  document.getElementById('imageCounter').innerText = `${currentImageIndex + 1} / ${viewerImages.length}`;
}

// ==========================================
// AUTOMATIC IMAGE COMPRESSION HELPER
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
        let width = img.width;
        let height = img.height;

        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob((blob) => {
          resolve(new File([blob], file.name, {
            type: 'image/jpeg',
            lastModified: Date.now()
          }));
        }, 'image/jpeg', quality);
      };
    };
  });
}

async function handlePostAd(e) {
  e.preventDefault();
  
  if (!userWallet || !currentUsername) {
    await showNeonPopup('Hold On', 'Please connect your wallet first!', '🔗');
    return;
  }

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

  // Illegal Content Validation Check
  const restrictedWord = validateListingContent(title, description);
  if (restrictedWord) {
    await showNeonPopup('Prohibited Item', `Your listing contains a restricted or illegal keyword ("${restrictedWord}"). Please follow marketplace safety guidelines.`, '🛡️');
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
      tokens: [{ symbol: Tokens.WLD, token_amount: tokenToDecimals(1, Tokens.WLD).toString() }],
      description: 'Listing Fee: 1 WLD',
    };

    const { finalPayload } = await MiniKit.commandsAsync.pay(payPayload);
    paymentSuccessful = (finalPayload?.status === 'success');
  } catch (err) {}

  if (!paymentSuccessful) {
    await showNeonPopup('Payment Cancelled', 'Payment failed or was cancelled by you.', '💸');
    return;
  }

  let imageUrls = ['', '', '', ''];
  for (let i = 0; i < files.length; i++) {
    const compressedFile = await compressImage(files[i]);
    const fileExt = 'jpg';
    const fileName = `${Date.now()}_${Math.random()}.${fileExt}`;
    
    const { error: uploadError } = await supabase.storage.from('listing').upload(fileName, compressedFile);
    if (uploadError) {
      await showNeonPopup('Upload Error', 'Image upload failed: ' + uploadError.message, '❌');
      return;
    }

    const { data: publicURLData } = supabase.storage.from('listing').getPublicUrl(fileName);
    imageUrls[i] = publicURLData.publicUrl;
  }

  const { error: insertError } = await supabase.from('listings').insert([{
    seller_address: userWallet,
    seller_name: currentUsername,
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
    const displaySellerName = item.seller_name || 'User';
    
    return `
      <div class="listing-card" onclick="window.openAdDetails('${item.id}')" style="cursor:pointer; display:flex; gap:12px; background:#fff; padding:12px; border-radius:14px; border:1px solid #e2e8f0; margin-bottom:10px; align-items:center;">
        <img src="${thumbImg}" style="width: 90px; height: 90px; object-fit: cover; border-radius: 10px;">
        <div style="flex:1;">
          <span style="font-size:11px; color:#4f46e5; font-weight:bold;">🌍 ${item.country} (~${item.calculatedDistance} km)</span>
          <h3 style="font-size:1.05rem; margin:4px 0; color:#1e293b;">${item.title}</h3>
          <p style="font-size:1rem; font-weight:bold; color:#10b981; margin:0;">${item.price} WLD</p>
          <p style="font-size:0.8rem; color:#64748b; margin:4px 0 0 0;">👤 ${displaySellerName}</p>
        </div>
        <button onclick="event.stopPropagation(); window.openChat('${item.seller_address}', '${item.title}', '${displaySellerName}')" style="background:#4f46e5; color:#fff; padding:8px 14px; font-size:12px; border-radius:8px; border:none; cursor:pointer; font-weight:bold;">Chat</button>
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
  const imagesUrlsJoined = allImages.join('|');

  const imagesHtml = allImages.map((img, index) => `
    <img src="${img}" onclick="window.openImageViewer('${imagesUrlsJoined}', ${index})" style="width:100%; height:240px; object-fit:contain; background:#0f172a; border-radius:10px; margin-bottom:8px; border:1px solid #e2e8f0; cursor:zoom-in;">
  `).join('');

  const displaySellerName = data.seller_name || 'User';

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

      <div style="background:#f1f5f9; padding:8px 12px; border-radius:8px; font-size:12px; color:#475569; margin-bottom:14px; display:flex; justify-content:space-between; align-items:center;">
        <div>
          👤 <b>Seller:</b> <span style="color:#38bdf8; font-weight:bold;">${displaySellerName}</span><br>
          <span onclick="window.copyAddress('${data.seller_address}')" style="font-family:monospace; color:#94a3b8; font-size:10px; cursor:pointer;">
            ${data.seller_address.substring(0,18)}... 📋
          </span>
        </div>
        <button onclick="window.openReviews('${data.seller_address}', '${displaySellerName}')" style="background:#f59e0b; color:#fff; border:none; padding:6px 10px; border-radius:8px; font-size:11px; font-weight:bold; cursor:pointer;">⭐ Reviews</button>
      </div>

      <hr style="border:0; border-top:1px solid #e2e8f0; margin-bottom:14px;">
      
      <h4 style="font-size:0.95rem; color:#475569; margin-bottom:6px;">Uploaded Photos (${allImages.length}) - Tap to Zoom</h4>
      <div style="max-height:280px; overflow-y:auto; margin-bottom:14px; padding-right:4px;">
        ${imagesHtml}
      </div>

      <h4 style="font-size:0.95rem; color:#475569; margin-bottom:6px;">Product Description</h4>
      <p style="font-size:0.95rem; color:#334155; background:#f8fafc; padding:12px; border-radius:8px; border:1px solid #e2e8f0; margin-bottom:16px; white-space:pre-wrap; line-height:1.4;">${data.description}</p>

      <div style="display: flex; gap: 8px; margin-top: 16px;">
        <button onclick="document.getElementById('adDetailsModal').style.display='none';" style="background: #e2e8f0; color: #475569; flex: 1; padding: 12px; border: none; border-radius: 10px; font-size: 1rem; font-weight: bold; cursor: pointer;">⬅️ Back</button>
        <button onclick="event.stopPropagation(); window.openChat('${data.seller_address}', '${data.title}', '${displaySellerName}'); document.getElementById('adDetailsModal').style.display='none';" style="background: #4f46e5; color: #fff; flex: 1.5; padding: 12px; border: none; border-radius: 10px; font-size: 1rem; font-weight: bold; cursor: pointer;">💬 Chat</button>
      </div>
    </div>
  `;
  document.getElementById('adDetailsModal').style.display = 'flex';
}

// ==========================================
// FEATURE 1: PUSH NOTIFICATIONS & LIVE CHAT
// ==========================================
window.openChat = async function(sellerWallet, adTitle, sellerName) {
  if (!userWallet || !currentUsername) {
    await showNeonPopup('Hold On', 'Please connect your wallet first to chat!', '💬');
    return;
  }
  currentChatSeller = sellerWallet;
  currentChatSellerName = sellerName;
  window.currentChatAdTitle = adTitle; 
  
  document.getElementById('chatTitle').innerText = `Chat with ${sellerName || 'Seller'}`;
  const chatBox = document.getElementById('chatMessages');
  chatBox.innerHTML = `<p class="loading-text" style="text-align:center;">Loading chat history...</p>`;
  document.getElementById('chatModal').style.display = 'flex';

  const { data, error } = await supabase.from('chats')
    .select('*')
    .eq('ad_title', adTitle)
    .order('created_at', { ascending: true });

  let chatHtml = `<div style="background:#e2e8f0; padding:8px 12px; border-radius:8px; font-size:12px; align-self:flex-start; color:#334155; margin-bottom:4px;">Hello! I am interested in your ad: ${adTitle}</div>`;
  
  if (data && data.length > 0) {
    const filteredChats = data.filter(m => 
      (m.sender === userWallet && m.receiver === sellerWallet) || 
      (m.sender === sellerWallet && m.receiver === userWallet)
    );

    filteredChats.forEach(msg => {
      if (msg.sender === userWallet) {
        chatHtml += `<div style="background:#4f46e5; color:#fff; padding:8px 12px; border-radius:8px; font-size:12px; align-self:flex-end; max-width:80%; margin-bottom:4px;">${msg.message}</div>`;
      } else {
        chatHtml += `<div style="background:#e2e8f0; color:#fff; padding:8px 12px; border-radius:8px; font-size:12px; align-self:flex-start; color:#334155; max-width:80%; margin-bottom:4px;">${msg.message}</div>`;
      }
    });
  }

  chatBox.innerHTML = chatHtml;
  chatBox.scrollTop = chatBox.scrollHeight;
}

window.sendMessage = async function() {
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg || !currentChatSeller || !window.currentChatAdTitle) return;

  const chatBox = document.getElementById('chatMessages');
  chatBox.innerHTML += `<div style="background:#4f46e5; color:#fff; padding:8px 12px; border-radius:8px; font-size:12px; align-self:flex-end; max-width:80%; margin-bottom:4px;">${msg}</div>`;
  input.value = '';
  chatBox.scrollTop = chatBox.scrollHeight;

  await supabase.from('chats').insert([{
    sender: userWallet,
    receiver: currentChatSeller,
    ad_title: window.currentChatAdTitle,
    message: msg
  }]);
}

// ==========================================
// FEATURE 2: RATINGS & REVIEWS SYSTEM
// ==========================================
window.openReviews = async function(sellerAddress, sellerName) {
  document.getElementById('reviewsModalTitle').innerText = `${sellerName}'s Ratings & Reviews`;
  document.getElementById('reviewsModal').style.display = 'flex';
  window.targetSellerAddress = sellerAddress;

  const container = document.getElementById('reviewsListContainer');
  container.innerHTML = `<p class="loading-text" style="text-align:center;">Loading reviews...</p>`;

  const { data: reviews, error } = await supabase.from('reviews').select('*').eq('seller_address', sellerAddress).order('created_at', { ascending: false });

  if (error || !reviews || reviews.length === 0) {
    container.innerHTML = `<p style="text-align:center; color:#64748b; font-size:0.9px;">No reviews yet. Be the first to review!</p>`;
    return;
  }

  container.innerHTML = reviews.map(r => `
    <div style="background:#f8fafc; border:1px solid #e2e8f0; padding:8px 10px; border-radius:8px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
        <span style="font-weight:bold; font-size:0.85rem; color:#1e293b;">${r.buyer_name}</span>
        <span style="color:#f59e0b; font-size:0.85rem;">${'⭐'.repeat(r.rating)}</span>
      </div>
      <p style="margin:0; font-size:0.85rem; color:#475569;">${r.comment || 'No comment provided.'}</p>
    </div>
  `).join('');
}

window.submitReview = async function() {
  if (!userWallet || !currentUsername) {
    await showNeonPopup('Hold On', 'Please connect your wallet first to leave a review!', '⭐');
    return;
  }
  const rating = parseInt(document.getElementById('reviewRating').value);
  const comment = document.getElementById('reviewComment').value.trim();

  const { error } = await supabase.from('reviews').insert([{
    seller_address: window.targetSellerAddress,
    buyer_address: userWallet,
    buyer_name: currentUsername,
    rating,
    comment
  }]);

  if (!error) {
    document.getElementById('reviewComment').value = '';
    await showNeonPopup('Success', 'Review submitted successfully!', '🎉');
    window.openReviews(window.targetSellerAddress, 'Seller');
  } else {
    await showNeonPopup('Error', 'Could not submit review: ' + error.message, '⚠️');
  }
}

// ==========================================
// FEATURE 4: ADMIN PANEL DASHBOARD
// ==========================================
window.openAdminPanel = async function() {
  if (!userWallet || userWallet.toLowerCase() !== ADMIN_WALLET.toLowerCase()) {
    await showNeonPopup('Unauthorized', 'Access denied. Admin only.', '🚫');
    return;
  }

  document.getElementById('adminModal').style.display = 'flex';
  const statsContainer = document.getElementById('adminStatsContainer');
  const listingsContainer = document.getElementById('adminListingsContainer');

  statsContainer.innerHTML = `<p class="loading-text">Loading stats...</p>`;
  listingsContainer.innerHTML = `<p class="loading-text">Loading all listings...</p>`;

  const { count: totalListings } = await supabase.from('listings').select('*', { count: 'exact', head: true });
  const { count: totalUsers } = await supabase.from('users').select('*', { count: 'exact', head: true });
  const { count: totalChats } = await supabase.from('chats').select('*', { count: 'exact', head: true });

  statsContainer.innerHTML = `
    <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:8px; text-align:center;">
      <div style="background:#e0e7ff; padding:10px; border-radius:8px;"><b style="color:#4f46e5; font-size:1.1rem; display:block;">${totalListings || 0}</b> Active Ads</div>
      <div style="background:#d1fae5; padding:10px; border-radius:8px;"><b style="color:#10b981; font-size:1.1rem; display:block;">${totalUsers || 0}</b> Users</div>
      <div style="background:#fef3c7; padding:10px; border-radius:8px;"><b style="color:#d97706; font-size:1.1rem; display:block;">${totalChats || 0}</b> Messages</div>
    </div>
  `;

  const { data: listings } = await supabase.from('listings').select('*').order('created_at', { ascending: false });

  if (!listings || listings.length === 0) {
    listingsContainer.innerHTML = `<p style="text-align:center; color:#64748b;">No listings found.</p>`;
    return;
  }

  listingsContainer.innerHTML = listings.map(item => `
    <div style="background:#f8fafc; border:1px solid #e2e8f0; padding:8px 10px; border-radius:8px; display:flex; justify-content:space-between; align-items:center;">
      <div>
        <h4 style="margin:0; font-size:0.9rem; color:#1e293b;">${item.title}</h4>
        <p style="margin:2px 0 0 0; font-size:0.75rem; color:#64748b;">By: ${item.seller_name} | ${item.price} WLD</p>
      </div>
      <button onclick="window.adminDeleteAd('${item.id}')" style="background:#ef4444; color:#fff; border:none; padding:6px 10px; border-radius:6px; font-size:11px; font-weight:bold; cursor:pointer;">Force Delete</button>
    </div>
  `).join('');
}

window.adminDeleteAd = async function(id) {
  const confirmDel = await window.showNeonPopup('Admin Action', 'Are you sure you want to force delete this ad?', '🛡️', 'confirm');
  if (confirmDel) {
    const { data: adData } = await supabase.from('listings').select('title, image1, image2, image3, image4').eq('id', id).single();
    if (adData) {
      const imagesList = [adData.image1, adData.image2, adData.image3, adData.image4];
      for (const imgUrl of imagesList) {
        if (imgUrl && imgUrl.includes('/listing/')) {
          const filePath = imgUrl.split('/listing/')[1];
          if (filePath) await supabase.storage.from('listing').remove([filePath]);
        }
      }
      await supabase.from('chats').delete().eq('ad_title', adData.title);
    }
    await supabase.from('listings').delete().match({ id });
    await showNeonPopup('Success', 'Ad force deleted by admin.', '✅');
    window.openAdminPanel();
    fetchListings();
  }
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
  const isConfirmed = await showNeonPopup('Delete Ad?', 'Are you sure this item is Sold Out? This will permanently delete the ad, its images, and chat history.', '🗑️', 'confirm');
  
  if (isConfirmed) {
    const { data: adData } = await supabase.from('listings').select('title, image1, image2, image3, image4').eq('id', id).single();

    if (adData) {
      const imagesList = [adData.image1, adData.image2, adData.image3, adData.image4];
      for (const imgUrl of imagesList) {
        if (imgUrl && imgUrl.includes('/listing/')) {
          const filePath = imgUrl.split('/listing/')[1];
          if (filePath) await supabase.storage.from('listing').remove([filePath]);
        }
      }
      await supabase.from('chats').delete().eq('ad_title', adData.title);
    }

    const { error } = await supabase.from('listings').delete().match({ id });
    if (!error) {
      await showNeonPopup('Deleted', 'Ad, storage images, and related chat history deleted successfully!', '✅');
      openMyAdsModal();
      fetchListings();
    } else {
      await showNeonPopup('Error', 'Could not delete: ' + error.message, '⚠️');
    }
  }
}

window.openLeaderboard = async function() {
  document.getElementById('leaderboardModal').style.display = 'flex';
  const container = document.getElementById('leaderboardContainer');
  container.innerHTML = `<p class="loading-text">Fetching top earners...</p>`;

  const { data: balances, error: balError } = await supabase.from('sow_balances').select('*').order('balance', { ascending: false }).limit(50);
  if (balError || !balances || balances.length === 0) {
    container.innerHTML = `<p style="text-align:center; color:#64748b; padding:20px;">No data yet. Be the first to earn SOW! 🚀</p>`;
    return;
  }

  const wallets = balances.map(b => b.wallet_address);
  const { data: usersData } = await supabase.from('users').select('*').in('wallet_address', wallets);
  const userMap = {};
  if (usersData) { usersData.forEach(u => { userMap[u.wallet_address] = u.username; }); }

  container.innerHTML = balances.map((item, index) => {
    let rankMedal = `#${index + 1}`;
    if(index === 0) rankMedal = '🥇 1st';
    if(index === 1) rankMedal = '🥈 2nd';
    if(index === 2) rankMedal = '🥉 3rd';
    
    const username = userMap[item.wallet_address] || 'Unknown User';
    const shortWallet = item.wallet_address.substring(0, 6) + '...';

    let specialStyle = index < 3 
      ? 'border: 2px solid #38bdf8; background: linear-gradient(135deg, #0f172a, #1e293b); color: #fff; box-shadow: 0 4px 10px rgba(56, 189, 248, 0.2);' 
      : 'background: rgba(0,0,0,0.03); border: 1px solid #e2e8f0;';
    let nameStyle = index < 3 ? 'color: #38bdf8;' : 'color: #1e293b;';
    let rankStyle = index < 3 ? 'color: #f59e0b; font-size: 1.1rem;' : 'color: #64748b; font-size: 0.95rem;';

    return `
      <div style="padding:10px 14px; border-radius:12px; display:flex; justify-content:space-between; align-items:center; ${specialStyle}">
        <div style="display:flex; align-items:center; gap: 12px;">
          <span style="font-weight: 800; min-width: 45px; ${rankStyle}">${rankMedal}</span>
          <div>
            <h4 style="margin: 0; font-size: 0.95rem; ${nameStyle}">${username}</h4>
            <p style="margin: 2px 0 0 0; font-size: 0.7rem; color: #94a3b8; font-family: monospace;">${shortWallet}</p>
          </div>
        </div>
        <div style="font-weight: bold; font-size: 1rem; color: #10b981; text-align:right;">
          ${item.balance} <br><span style="font-size:0.7rem; color:#94a3b8;">SOW</span>
        </div>
      </div>
    `;
  }).join('');
}