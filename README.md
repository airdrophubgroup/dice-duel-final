TNV Duel Arena 🎲
TNV Duel Arena is a fast-paced, real-time competitive WLD duel and reward mini-app built strictly for the World App ecosystem. Players battle head-to-head in a high-stakes 32-second dice rolling challenge to win WLD prize pools and earn TNV ecosystem tokens.  
JS
+ 1

🚀 Key Features
Strict World App Integration: Fully protected environment checks ensure the application runs exclusively inside official World App with native MiniKit authentication and wallet signatures.  
JS

Real-Time Multiplayer Duels: Powered by Supabase Realtime broadcast channels for live matchmaking, live betting alerts, and synchronized opponent score updates.  
JS

Anti-Cheat & Timing Mechanics: Features a strict 2-second alternating cooldown per tap and a 15-tap limit per user to completely block auto-clickers and automated scripts.  
JS

On-Chain & Database Security: Integrated with Worldchain mainnet RPC for live WLD balance checks and atomic database-level RPC functions (secure_join_match, settle_match_result) to prevent balance manipulation and fake payouts.  
JS

Community Global Chat: Built-in 24-hour persistent community chat room with secure HTML escaping and live connection counts.  
JS

Leaderboards & Rewards: Automated TNV coin distribution for both victories and consolation defeats, alongside an elite top-10 leaderboard system.  
JS

🛠️ Tech Stack
Frontend: Vanilla JavaScript (ES Modules), HTML5, CSS3 (Glassmorphism & Neon UI)

Web3 / Integration: @worldcoin/minikit-js, Worldchain RPC (Alchemy)  
JS

Backend / Database: Supabase (PostgreSQL, RLS Security Policies, and Stored Procedures / RPCs)  
JS

Hosting: Vercel  
JS

📖 Game Rules & Mechanics
Entry & Betting: Select an entry fee ranging from 0.1 WLD to 50 WLD to enter the matchmaking pool.  
JS

Gameplay: Once an opponent connects, a 32-second match timer starts (30s gameplay + 2s result display). Tap the 3D dice cube to roll, keeping the 2-second cooldown rule in mind.  
JS
+ 1

Victory & Rewards: The player with the higher score takes home the payout WLD and win-tier TNV coins. Defeated players still receive consolation TNV coins so nobody leaves empty-handed.  
JS
+ 1

🛡️ Security Architecture
Row Level Security (RLS) enabled across all database tables (matches, user_rewards, match_history) to prevent unauthorized tampering.  
JS

Server-Side RPC Verification ensures that fund deductions, matchmaking, and match settlements happen securely on the database layer rather than client-side execution.  
JS