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
    
    inputContainer.style.display = type === 'prompt' ? 'block' : 'none';
    alertBtns.style.display = type === 'confirm' ? 'none' : 'block';
    confirmBtns.style.display = type === 'confirm' ? 'flex' : 'none';

    document.getElementById('neonPopup').style.display = 'flex';
    popupResolve = resolve;

    document.getElementById('neonPopupAlertBtn').onclick = () => closeNeonPopup(type === 'prompt' ? document.getElementById('neonPopupInput').value : true);
    document.getElementById('neonPopupConfirmYesBtn').onclick = () => closeNeonPopup(true);
    document.getElementById('neonPopupConfirmNoBtn').onclick = () => closeNeonPopup(false);
  });
};

window.closeNeonPopup = function(result) {
  document.getElementById('neonPopup').style.display = 'none';
  if (popupResolve) { popupResolve(result); popupResolve = null; }
};

window.copyAddress = async function(address) {
  await navigator.clipboard.writeText(address);
  await showNeonPopup('Copied!', 'Address copied!', '📋');
}

// ==========================================
// STRICT ENVIRONMENT & UI HELPERS
// ==========================================
async function enforceWorldAppEnvironment() {
  if (typeof MiniKit === 'undefined' || !MiniKit.isInstalled()) {
    document.body.innerHTML = `<h1 style="text-align:center; padding:50px; color:white; background:red;">Only accessible in World App ⚠️</h1>`;
    return false;
  }
  return true;
}

document.addEventListener('DOMContentLoaded', async () => {
  try { MiniKit.install(APP_ID); } catch (e) {}
  if (await enforceWorldAppEnvironment()) {
    setupUI();
    detectUserCurrentPosition();
    fetchListings();
    checkExpiredAds();
  }
});

function setupUI() {
  document.getElementById('loginBtn').addEventListener('click', handleLogin);
  document.getElementById('viewMyAdsBtn').addEventListener('click', openMyAdsModal);
  document.getElementById('adForm').addEventListener('submit', handlePostAd);
}

// ==========================================
// FEATURE: SOW COIN & AD POSTING (1 WLD)
// ==========================================
async function handlePostAd(e) {
  e.preventDefault();
  if (!userWallet) { await showNeonPopup('Hold On', 'Connect wallet first!', '🔗'); return; }

  // 1 WLD Payment Logic
  try {
    const { finalPayload } = await MiniKit.commandsAsync.pay({
      reference: randomAlphaNumeric(16),
      to: ADMIN_WALLET,
      tokens: [{ symbol: Tokens.WLD, token_amount: tokenToDecimals(1, Tokens.WLD).toString() }],
      description: 'Listing Fee: 1 WLD',
    });
    if (finalPayload?.status !== 'success') return;
  } catch (err) { return; }

  // Upload Logic
  const files = document.getElementById('imageInput').files;
  let imageUrls = [];
  for (let i = 0; i < files.length; i++) {
    const fileName = `${Date.now()}_${Math.random()}.jpg`;
    await supabase.storage.from('listing').upload(fileName, files[i]);
    imageUrls.push(supabase.storage.from('listing').getPublicUrl(fileName).data.publicUrl);
  }

  await supabase.from('listings').insert([{
    seller_address: userWallet, seller_name: currentUsername,
    title: document.getElementById('title').value,
    description: document.getElementById('description').value,
    price: document.getElementById('price').value,
    category: document.getElementById('category').value,
    country: document.getElementById('adCountry').value,
    image1: imageUrls[0], image2: imageUrls[1], image3: imageUrls[2], image4: imageUrls[3],
    lat: currentLat, lng: currentLng, status: 'active'
  }]);

  // Update Balance
  const { data: balData } = await supabase.from('sow_balances').select('balance').eq('wallet_address', userWallet).single();
  await supabase.from('sow_balances').upsert([{ wallet_address: userWallet, balance: (balData?.balance || 0) + 1 }]);
  
  await showNeonPopup('Success', 'Ad Posted! +1 SOW Earned', '🪙');
  fetchListings();
}

// ==========================================
// FEATURE: AUTO EXPIRY & OTHER HELPERS
// ==========================================
async function checkExpiredAds() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: expiredAds } = await supabase.from('listings').select('*').lt('created_at', thirtyDaysAgo);
  if (expiredAds) expiredAds.forEach(async (ad) => {
    await supabase.from('listings').delete().match({ id: ad.id });
    await supabase.from('chats').delete().eq('ad_title', ad.title);
  });
}

function randomAlphaNumeric(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// --- (Other existing window.functions like openChat, openAdDetails, openAdminPanel, fetchListings remain same) ---