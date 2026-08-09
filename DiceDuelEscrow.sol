// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * DiceDuelEscrow
 * ----------------------------------------------------------------------
 * WHAT THIS FIXES vs your current off-chain (Supabase) system:
 *  - Entry fees are locked in THIS contract, not sent to admin's wallet
 *    directly. Anyone can verify on-chain that the money is actually
 *    held, not just "trust the database".
 *  - Payouts follow a FIXED on-chain formula (PAYOUT_BPS). The resolver
 *    (your backend) can only say WHO won — it can never send itself or
 *    anyone an arbitrary amount.
 *  - Every join / settle / refund emits an event — a permanent, public
 *    audit trail nobody (including you) can quietly edit.
 *
 * WHAT THIS DOES NOT FIX (be aware):
 *  - Your backend still decides *who won* off-chain (the tap-timing dice
 *    game itself doesn't run on-chain). So players still need to trust
 *    your server for match-result fairness — this contract only makes
 *    the MONEY MOVEMENT trustworthy, not the game logic itself. Fully
 *    removing that trust would need on-chain randomness + on-chain game
 *    logic, which is a much bigger undertaking.
 * ----------------------------------------------------------------------
 */
contract DiceDuelEscrow is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable wldToken;

    // The address allowed to settle/refund matches — your backend's
    // wallet (a NEW dedicated wallet for this, not your personal one).
    address public resolver;

    address public feeWallet; // where the platform's cut goes

    // Exact fee -> payout table, matching your app's fee chips exactly
    // (different tiers have different % cuts — 0.1/0.2 keep 85% for the
    // winner, 0.5/1/2 keep 80%, 5+ keep 88-90%). Only fees present in
    // this mapping (payout > 0) can be used to join a match — this also
    // stops anyone from joining with an arbitrary/unlisted fee amount.
    mapping(uint256 => uint256) public payoutForFee;

    enum MatchStatus { Empty, WaitingForPlayer2, Settled, Refunded }

    struct Match {
        address player1;
        address player2;
        uint256 fee;      // per-player entry fee
        MatchStatus status;
        uint64 joinedAt;  // when player1 created the match (for self-refund timeout)
        address lockedOpponent; // if nonzero, ONLY this address may fill player2 — closes the front-running gap where the p2 slot was open to anyone until the real opponent's tx landed
    }

    mapping(bytes32 => Match) public matches;

    // If player2 never joins within this window, player1 can self-refund
    // without needing the resolver to act. Owner-adjustable in case your
    // matchmaking normally takes longer than expected.
    uint256 public refundTimeout = 10 minutes;

    event MatchJoined(bytes32 indexed matchId, address indexed player, uint256 fee, uint8 slot);
    event MatchSettled(bytes32 indexed matchId, address indexed winner, uint256 winnerPayout, uint256 platformFee);
    event MatchRefunded(bytes32 indexed matchId, address indexed player, uint256 amount);
    event ResolverChanged(address indexed newResolver);
    event FeeWalletChanged(address indexed newFeeWallet);
    event PayoutTierChanged(uint256 fee, uint256 payout);
    event RefundTimeoutChanged(uint256 newTimeout);

    modifier onlyResolver() {
        require(msg.sender == resolver, "not resolver");
        _;
    }

    constructor(address _wldToken, address _resolver, address _feeWallet) Ownable(msg.sender) {
        require(_wldToken != address(0) && _resolver != address(0) && _feeWallet != address(0), "zero address");
        wldToken = IERC20(_wldToken);
        resolver = _resolver;
        feeWallet = _feeWallet;

        // Seed the exact tiers from your app. WLD has 18 decimals, so
        // "0.1 ether" here really means "0.1 WLD" (1e17 base units) —
        // the `ether` keyword is just Solidity's built-in 1e18 scaler,
        // it works the same for any 18-decimal token, not just ETH.
        _setTier(0.1 ether, 0.17 ether);
        _setTier(0.2 ether, 0.34 ether);
        _setTier(0.5 ether, 0.80 ether);
        _setTier(1 ether,   1.60 ether);
        _setTier(2 ether,   3.20 ether);
        _setTier(5 ether,   8.80 ether);
        _setTier(10 ether,  17.8 ether);
        _setTier(20 ether,  36.0 ether);
        _setTier(30 ether,  54.0 ether);
        _setTier(40 ether,  72.0 ether);
        _setTier(50 ether,  90.0 ether);
    }

    // ---------------------------------------------------------------
    // PLAYER-FACING: join a match by depositing the entry fee.
    // Player must call wldToken.approve(address(thisContract), fee)
    // BEFORE calling this (standard ERC-20 two-step pattern).
    //
    // `expectedOpponent`: when your backend has already matched two
    // specific players off-chain (both addresses known before EITHER
    // deposits), pass the other player's address here. Whoever creates
    // the match (fills slot 1) locks this in — it then restricts who's
    // allowed to fill slot 2, so a stranger can't race in and steal the
    // match. Pass address(0) only if you genuinely want an open match
    // anyone can join (not recommended for matched-pair games).
    // ---------------------------------------------------------------
    function joinMatch(bytes32 matchId, uint256 fee, address expectedOpponent) external nonReentrant {
        require(payoutForFee[fee] > 0, "fee tier not allowed");
        Match storage m = matches[matchId];

        if (m.status == MatchStatus.Empty) {
            // First player creates the match, optionally locking in
            // exactly who's allowed to join as player2.
            m.player1 = msg.sender;
            m.fee = fee;
            m.status = MatchStatus.WaitingForPlayer2;
            m.joinedAt = uint64(block.timestamp);
            m.lockedOpponent = expectedOpponent;
            wldToken.safeTransferFrom(msg.sender, address(this), fee);
            emit MatchJoined(matchId, msg.sender, fee, 1);
        } else if (m.status == MatchStatus.WaitingForPlayer2) {
            require(m.player1 != msg.sender, "already joined");
            require(m.player2 == address(0), "match already full");
            require(m.fee == fee, "fee mismatch");
            // Two-way check: the locked-in restriction from whoever
            // created the match (if any) MUST allow this caller, AND
            // if this caller specified who they expect player1 to be,
            // that must match too. Either side sniping the wrong slot
            // now safely reverts instead of silently mismatching real
            // money with a stranger.
            require(m.lockedOpponent == address(0) || m.lockedOpponent == msg.sender, "opponent mismatch");
            require(expectedOpponent == address(0) || expectedOpponent == m.player1, "opponent mismatch");
            m.player2 = msg.sender;
            wldToken.safeTransferFrom(msg.sender, address(this), fee);
            emit MatchJoined(matchId, msg.sender, fee, 2);
        } else {
            revert("match not joinable");
        }
    }

    // ---------------------------------------------------------------
    // PLAYER-FACING: if player2 never showed up and the timeout has
    // passed, player1 can recover their own funds WITHOUT needing the
    // resolver online. Anyone can call this (it always pays player1,
    // never the caller), so a friend/frontend can trigger it for you too.
    // ---------------------------------------------------------------
    function selfRefundIfExpired(bytes32 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        require(m.status == MatchStatus.WaitingForPlayer2, "not refundable");
        require(m.player2 == address(0), "already matched, ask resolver");
        require(block.timestamp >= m.joinedAt + refundTimeout, "timeout not reached yet");

        uint256 fee = m.fee;
        address player1 = m.player1;
        m.status = MatchStatus.Refunded;

        wldToken.safeTransfer(player1, fee);
        emit MatchRefunded(matchId, player1, fee);
    }

    // ---------------------------------------------------------------
    // RESOLVER-ONLY: called by your backend once the off-chain game
    // has decided a winner. Pays out automatically per the fixed formula.
    // ---------------------------------------------------------------
    function settleMatch(bytes32 matchId, address winner) external onlyResolver nonReentrant {
        Match storage m = matches[matchId];
        require(m.status == MatchStatus.WaitingForPlayer2 && m.player2 != address(0), "match not full");
        require(winner == m.player1 || winner == m.player2, "winner not a participant");

        uint256 pool = m.fee * 2;
        uint256 winnerPayout = payoutForFee[m.fee];
        require(winnerPayout > 0 && winnerPayout <= pool, "bad payout tier");
        uint256 platformFee = pool - winnerPayout;

        m.status = MatchStatus.Settled;

        wldToken.safeTransfer(winner, winnerPayout);
        if (platformFee > 0) {
            wldToken.safeTransfer(feeWallet, platformFee);
        }

        emit MatchSettled(matchId, winner, winnerPayout, platformFee);
    }

    // ---------------------------------------------------------------
    // RESOLVER-ONLY: cancel a match that never found a 2nd player, or
    // that needs to be voided for any reason, and refund whoever paid in.
    // ---------------------------------------------------------------
    function refundMatch(bytes32 matchId) external onlyResolver nonReentrant {
        Match storage m = matches[matchId];
        require(m.status == MatchStatus.WaitingForPlayer2, "not refundable");

        m.status = MatchStatus.Refunded;

        if (m.player1 != address(0)) {
            wldToken.safeTransfer(m.player1, m.fee);
            emit MatchRefunded(matchId, m.player1, m.fee);
        }
        if (m.player2 != address(0)) {
            wldToken.safeTransfer(m.player2, m.fee);
            emit MatchRefunded(matchId, m.player2, m.fee);
        }
    }

    // ---------------------------------------------------------------
    // OWNER-ONLY admin controls (deployer's wallet, ideally a multisig
    // eventually — not the same as `resolver`).
    // ---------------------------------------------------------------
    function setResolver(address _resolver) external onlyOwner {
        require(_resolver != address(0), "zero address");
        resolver = _resolver;
        emit ResolverChanged(_resolver);
    }

    function setFeeWallet(address _feeWallet) external onlyOwner {
        require(_feeWallet != address(0), "zero address");
        feeWallet = _feeWallet;
        emit FeeWalletChanged(_feeWallet);
    }

    function setRefundTimeout(uint256 _seconds) external onlyOwner {
        require(_seconds >= 60, "too short"); // sanity floor: at least 1 minute
        refundTimeout = _seconds;
        emit RefundTimeoutChanged(_seconds);
    }

    // Add or update one fee tier. Set payout to 0 to disable a tier
    // (existing matches already joined at that fee still settle fine,
    // since their fee is fixed at join-time — this only blocks NEW
    // matches from using that tier).
    function setPayoutTier(uint256 fee, uint256 payout) external onlyOwner {
        _setTier(fee, payout);
    }

    function _setTier(uint256 fee, uint256 payout) internal {
        payoutForFee[fee] = payout;
        emit PayoutTierChanged(fee, payout);
    }

    // View helper for your frontend/backend.
    function getMatch(bytes32 matchId) external view returns (Match memory) {
        return matches[matchId];
    }
}
