// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract DiceDuelEscrow is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable wldToken;
    address public resolver;
    address public feeWallet;

    mapping(uint256 => uint256) public payoutForFee;

    enum MatchStatus { Empty, WaitingForPlayer2, Settled, Refunded }

    struct Match {
        address player1;
        address player2;
        uint256 fee;
        MatchStatus status;
        uint64 joinedAt;
        address lockedOpponent;
    }

    mapping(bytes32 => Match) public matches;
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

    function joinMatch(bytes32 matchId, uint256 fee, address expectedOpponent) external nonReentrant {
        require(payoutForFee[fee] > 0, "fee tier not allowed");
        Match storage m = matches[matchId];

        if (m.status == MatchStatus.Empty) {
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
            require(m.lockedOpponent == address(0) || m.lockedOpponent == msg.sender, "opponent mismatch");
            require(expectedOpponent == address(0) || expectedOpponent == m.player1, "opponent mismatch");
            m.player2 = msg.sender;
            wldToken.safeTransferFrom(msg.sender, address(this), fee);
            emit MatchJoined(matchId, msg.sender, fee, 2);
        } else {
            revert("match not joinable");
        }
    }

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
        require(_seconds >= 60, "too short");
        refundTimeout = _seconds;
        emit RefundTimeoutChanged(_seconds);
    }

    function setPayoutTier(uint256 fee, uint256 payout) external onlyOwner {
        _setTier(fee, payout);
    }

    function _setTier(uint256 fee, uint256 payout) internal {
        payoutForFee[fee] = payout;
        emit PayoutTierChanged(fee, payout);
    }

    function getMatch(bytes32 matchId) external view returns (Match memory) {
        return matches[matchId];
    }
}