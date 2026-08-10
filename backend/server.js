// SECURE PAYOUT & MATCH SETTLEMENT ENDPOINT
app.post('/api/settle-match', async (expressReq, res) => {
  try {
    const { matchId, winnerAddress, loserAddress, fee } = expressReq.body;
    if (!matchId || !winnerAddress || !fee) {
      return res.status(400).json({ success: false, error: 'Missing parameters' });
    }

    // Payout calculation (jaise aapne database mein set kiya hai)
    const payoutMap = { 0.1: 0.17, 0.2: 0.34, 0.5: 0.80, 1: 1.60, 2: 3.20, 5: 8.80, 10: 17.8, 20: 36.0, 30: 54.0, 40: 72.0, 50: 90.0 };
    const payoutAmount = payoutMap[fee] || Number((fee * 1.6).toFixed(2));

    const payoutWei = ethers.parseUnits(payoutAmount.toString(), 18);

    // 1. Winner ko blockchain par WLD transfer karein
    console.log(`Sending payout of ${payoutAmount} WLD to winner: ${winnerAddress}`);
    const tx = await wldContract.transfer(winnerAddress, payoutWei);
    await tx.wait();
    console.log(`Payout success! Tx: ${tx.hash}`);

    // 2. Database mein match status 'completed' update kar dein
    await supabase.from('matches').update({
      status: 'completed',
      winner_address: winnerAddress,
      payout_amount: payoutAmount
    }).eq('id', matchId);

    // 3. History log add karein
    await supabase.from('match_history').insert([
      { wallet_address: winnerAddress.toLowerCase(), action_type: 'VICTORY', amount: payoutAmount, description: `Won duel match (${fee} WLD)`, created_at: new Date().toISOString() },
      { wallet_address: loserAddress ? loserAddress.toLowerCase() : 'system', action_type: 'DEFEAT', amount: -fee, description: `Lost duel match (${fee} WLD)`, created_at: new Date().toISOString() }
    ]);

    return res.json({ success: true, txHash: tx.hash });
  } catch (err) {
    console.error("Payout error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});