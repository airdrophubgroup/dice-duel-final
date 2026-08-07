'use client';

import { useState } from 'react';
import { MiniKit } from '@worldcoin/minikit-js';

export default function Home() {
  const [walletAddress, setWalletAddress] = useState('');
  const [status, setStatus] = useState('Not Connected');

  const handleLogin = async () => {
    if (!MiniKit.isInstalled()) {
      alert("Please open inside World App!");
      return;
    }

    try {
      setStatus("Authenticating...");
      const res = await MiniKit.walletAuth({
        nonce: Math.random().toString(36).substring(2),
        statement: 'Sign in to Dice Duel.',
        expirationTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        notBefore: new Date(Date.now() - 60 * 1000),
      });

      if (res && res.data && res.data.address) {
        setWalletAddress(res.data.address);
        setStatus("Connected Successfully!");
      }
    } catch (err: any) {
      setStatus("Error: " + err.message);
    }
  };

  return (
    <main style={{ padding: '20px', textAlign: 'center', color: '#fff', background: '#0a0a0a', minHeight: '100vh' }}>
      <h1>Dice Duel TNV Arena</h1>
      <p>Status: {status}</p>
      {walletAddress ? (
        <p>Wallet: {walletAddress}</p>
      ) : (
        <button 
          onClick={handleLogin}
          style={{ padding: '12px 24px', background: '#29d9c2', color: '#000', fontWeight: 'bold', border: 'none', borderRadius: '8px', cursor: 'pointer' }}
        >
          Connect Wallet / Play Now
        </button>
      )}
    </main>
  );
}