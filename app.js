// app.js - DICE-DUEL

import {
  ethers
} from "./ethers-5.6.esm.min.js";
import {
  abi,
  contractAddress
} from "./constants.js";

let authStatus = null;
let userWallet = null;
let provider, signer;

// Initialize Web3Modal
const web3Modal = new Web3Modal({
  cacheProvider: true,
  providerOptions: {},
});

// Helper: Initialize Ethers.js
async function initEthers() {
  provider = new ethers.providers.Web3Provider(window.ethereum);
  signer = provider.getSigner();
  const contract = new ethers.Contract(contractAddress, abi, signer);
  return contract;
}

// --- LOGIN/AUTH LOGIC ---

// Function to check login status
async function checkAuthStatus() {
  // Mock check for now; in real Dapp, verify with backend or signed message
  return localStorage.getItem("authStatus") === "loggedIn";
}

// Function to update UI based on login status
async function updateAuthUI() {
  const loginBtn = document.getElementById("login-btn");
  const connectWalletBtn = document.getElementById("connect-wallet-btn");
  const displayUsername = document.getElementById("display-username");
  const withdrawBtn = document.getElementById("withdraw-btn");
  const adminNavBtn = document.getElementById("admin-history-nav-btn");
  const balanceNum = document.getElementById("balance-num");
  const wldBalanceNum = document.getElementById("wld-balance-num");

  const isLoggedIn = await checkAuthStatus();

  if (isLoggedIn) {
    loginBtn.textContent = "Logout";
    loginBtn.onclick = handleLogout;
    connectWalletBtn.style.display = "block";
    displayUsername.textContent = localStorage.getItem("username") || "User";
    
    // Load balances (mock data for now)
    const tnvBal = localStorage.getItem("tnvBalance") || "0";
    const wldBal = localStorage.getItem("wldBalance") || "100.00";
    balanceNum.textContent = parseFloat(tnvBal).toFixed(2);
    wldBalanceNum.textContent = parseFloat(wldBal).toFixed(2);

    // Show buttons if wallet connected
    if (window.ethereum.selectedAddress) {
      connectWalletBtn.textContent = "Wallet Connected";
      connectWalletBtn.classList.add("connected");
      connectWalletBtn.disabled = true;
      withdrawBtn.disabled = false;
      if(localStorage.getItem("isAdmin") === "true") {
          adminNavBtn.style.display = "block";
      }
    } else {
        connectWalletBtn.textContent = "Connect World ID Wallet";
        connectWalletBtn.classList.remove("connected");
        connectWalletBtn.disabled = false;
        withdrawBtn.disabled = true;
        adminNavBtn.style.display = "none";
    }

  } else {
    loginBtn.textContent = "Login with World ID";
    loginBtn.onclick = handleLogin;
    connectWalletBtn.style.display = "none";
    displayUsername.textContent = "Tap Play Now to Connect";
    balanceNum.textContent = "0.00";
    wldBalanceNum.textContent = "100.00";
    withdrawBtn.disabled = true;
    adminNavBtn.style.display = "none";
  }
}

// Handle Login
function handleLogin() {
  // Simulate World ID verification
  localStorage.setItem("authStatus", "loggedIn");
  localStorage.setItem("username", "WLD_User_" + Math.floor(Math.random() * 1000));
  updateAuthUI();
  checkAndFetchAllBalances();
}

// Handle Logout
function handleLogout() {
  localStorage.removeItem("authStatus");
  localStorage.removeItem("username");
  localStorage.removeItem("tnvBalance");
  localStorage.removeItem("wldBalance");
  localStorage.removeItem("isAdmin");
  localStorage.removeItem("walletAddress");
  updateAuthUI();
  // Optional: Disconnect from web3modal
  web3Modal.clearCachedProvider();
}

// --- WEB3 WALLET LOGIC ---

// Function to connect wallet
async function connectWallet() {
  try {
    const provider = await web3Modal.connect();
    const ethersProvider = new ethers.providers.Web3Provider(provider);
    const signer = ethersProvider.getSigner();
    const address = await signer.getAddress();
    
    localStorage.setItem("walletAddress", address);
    localStorage.setItem("wldBalance", "150.00"); // Mock update on connect

    updateAuthUI();
    fetchLeaderboard();

  } catch (error) {
    console.error("Wallet Connection Error:", error);
    alert("Could not connect wallet. Ensure you are using a Web3 enabled browser/extension.");
  }
}

// --- BALANCE & GAME LOGIC ---

// Mock function to simulate fetching balances from contract/backend
async function checkAndFetchAllBalances() {
    // Replace with real contract calls using initEthers()
    // Here we just update TNV based on stored data
    const currentTNV = localStorage.getItem("tnvBalance") || "0";
    // For test purposes, if user is logged in, we ensure they have a start balance
    if(localStorage.getItem("authStatus") === "loggedIn" && localStorage.getItem("tnvBalance") === null) {
         localStorage.setItem("tnvBalance", "0");
    }
    updateAuthUI();
}

// --- INITIALIZATION ---

// On Page Load
document.addEventListener('DOMContentLoaded', async () => {
    
    // Update UI based on current auth status
    await updateAuthUI();
    
    // Setup Listeners
    document.getElementById("login-btn").addEventListener("click", handleLogin);
    document.getElementById("connect-wallet-btn").addEventListener("click", connectWallet);
    document.getElementById("withdraw-btn").addEventListener("click", openWithdrawModal);
    document.getElementById("start-btn").addEventListener("click", startMatchmaking);
    
    // Refresh balances periodically
    setInterval(checkAndFetchAllBalances, 30000);
});

// --- MOCK DATA FETCHING FUNCTIONS (Placeholders) ---

function fetchLeaderboard() {
  const lbContainer = document.getElementById("lb-container");
  lbContainer.innerHTML = "";
  const leaders = [
    { name: "ElitePlayer1", score: 850 },
    { name: "DiceMaster", score: 720 },
    { name: "PhotonUser", score: 650 },
  ];
  leaders.forEach((leader, index) => {
    const item = document.createElement("div");
    item.className = `lb-item top-${index + 1}`;
    item.innerHTML = `<span class="lb-rank">#${index + 1}</span><span class="lb-user">${leader.name}</span><span class="lb-score">${leader.score} TNV</span>`;
    lbContainer.appendChild(item);
  });
}

function openWithdrawModal() {
    const modal = document.getElementById("withdraw-modal");
    const balSpan = document.getElementById("modal-bal");
    balSpan.textContent = localStorage.getItem("tnvBalance") || "0";
    modal.style.display = "flex";
}

function closeWithdrawModal() {
    document.getElementById("withdraw-modal").style.display = "none";
}

function submitWithdrawRequest() {
    const amount = document.getElementById("withdraw-amount-input").value;
    const minWithdraw = 5000;
    if (amount < minWithdraw) {
        alert("Minimum withdrawal is 5,000 TNV.");
        return;
    }
    // Mock request logic
    alert(`Withdrawal request for ${amount} TNV submitted to Admin.`);
    closeWithdrawModal();
}

function startMatchmaking() {
    const isLoggedIn = localStorage.getItem("authStatus") === "loggedIn";
    const isWalletConnected = localStorage.getItem("walletAddress") !== null;
    
    if (!isLoggedIn || !isWalletConnected) {
        alert("Please login with World ID and connect your wallet to play.");
        return;
    }
    
    matchmaking(); // Function from app.js
}

// --- MATCHMAKING AND GAMEPLAY (Pre-existing functions in app.js) ---
// ... The rest of your original app.js code (matchmaking, gameplay, chat, history, admin, etc.) should be below this line ...