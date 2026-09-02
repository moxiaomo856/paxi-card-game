// 三国卡牌游戏合约 - 错误类型

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ContractError {
    // ------ 通用 ------
    #[error("Unauthorized")]
    Unauthorized,
    #[error("Invalid input: {0}")]
    InvalidInput(String),
    #[error("Insufficient funds: expected {expected}, got {got}")]
    InsufficientFunds { expected: String, got: String },
    #[error("Card not found: {0}")]
    CardNotFound(String),
    #[error("Card already max star")]
    MaxStarReached,
    #[error("Invalid difficulty: {0}")]
    InvalidDifficulty(u8),
    #[error("Battle already claimed: {0}")]
    BattleAlreadyClaimed(String),
    #[error("No pending rewards")]
    NoPendingRewards,

    // ------ 需求三：AI 防刷 ------
    #[error("Daily AI battle limit reached: {limit} games / day")]
    DailyAILimitReached { limit: u64 },

    // ------ 需求五：卡牌提案 & 稀有度校验 ------
    #[error("Rarity limit reached: {rarity} max {max}")]
    RarityLimitReached { rarity: String, max: u64 },
    #[error("Invalid weight: expected {expected}, got {got}")]
    InvalidWeight { expected: String, got: u32 },
    #[error("Max cards reached: {max}")]
    MaxCardsReached { max: u64 },
    #[error("Proposal not found: {0}")]
    ProposalNotFound(u64),
    #[error("Proposal already executed: {0}")]
    ProposalAlreadyExecuted(u64),
    #[error("Proposal deadline passed: {0}")]
    ProposalDeadlineNotReached(u64),
    #[error("Proposal still open")]
    ProposalStillOpen,
    #[error("Proposal not approved")]
    ProposalNotApproved,
    #[error("Already voted on proposal: {0}")]
    AlreadyVoted(u64),
    #[error("Only proposer can cancel")]
    NotProposer,
    #[error("Voting period must be active")]
    VotingClosed,
    #[error("Invalid rarity: {0}")]
    InvalidRarity(String),

    #[error("Player has duplicate card: {0}")]
    DuplicateCard(String),

    #[error("Feature temporarily disabled (safety first): {0}")]
    FeatureDisabled(String),

    // ------ 碎片系统 ------
    #[error("Insufficient fragments: need {needed}, have {have}")]
    InsufficientFragments { needed: u64, have: u64 },
}
