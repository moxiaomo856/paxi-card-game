// 三国卡牌游戏合约 - 消息定义

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::state::CardTemplate;

// ============================================================
// 实例化消息
// ============================================================
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct InstantiateMsg {
    pub token_contract: String,
    pub burn_address: String,
    pub tap_addresses: Vec<String>,
    pub admin: String,
    // 可选项：初始化时的卡牌模板（建议 30 张首发卡）
    pub initial_templates: Option<Vec<CardTemplate>>,
}

// ============================================================
// 执行消息
// ============================================================
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecuteMsg {
    // ---- 抽卡（需求二）----
    /// 单抽：10 PAXI + 20 万 TKCC
    DrawPack { tap_index: u8 },
    /// 三连抽：30 PAXI + 50 万 TKCC
    DrawPack3 { tap_index: u8 },

    // ---- AI 对战（需求三：防刷 + 动态难度）----
    AiBattle {
        difficulty: u8,
        result: BattleResult,
        battle_hash: String,
    },
    ClaimReward { battle_id: String },

    // ---- 升星（50% 销毁 + 50% 金库）----
    StarUp { card_id: String },

    // ---- 需求四：玩家自定义出卡顺序 ----
    SetBattleOrder { order: Vec<String> },

    // ---- 需求五：卡牌提案系统 ----
    /// 提交新卡牌提案：质押 5 万 TKCC
    ProposeCard { template: CardTemplate },
    /// 投票：1 TKCC = 1 票（使用玩家持有的 TKCC 余额）
    VoteCard { proposal_id: u64, approve: bool, amount: String },
    /// 提案到期后执行（赞成票 > 50%）
    ExecuteProposal { proposal_id: u64 },
    /// 提案者提前取消未到期的未通过提案
    CancelProposal { proposal_id: u64 },

    // ---- PVP（需求二动态奖励）----
    /// 挑战方调用，支付 6 万 TKCC
    RequestPvpMatch { opponent: String },
    /// 完成 PVP 对战
    FinishPvpMatch { match_id: String, winner: String },

    // ---- 混战（需求二）----
    /// 报名混战（支持 4-6 人）
    JoinRoyale { royale_id: String },
    /// 结束混战，分配奖金
    FinishRoyale { royale_id: String, winner: String, size: u8 },

    // ---- 管理员功能 ----
    WithdrawVault { recipient: String, amount: String },
    UpdateConfig {
        token_contract: Option<String>,
        burn_address: Option<String>,
        tap_addresses: Option<Vec<String>>,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BattleResult {
    Win,
    Lose,
}

// ============================================================
// 查询消息
// ============================================================
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum QueryMsg {
    Config {},
    GameParams {},
    PlayerCards { address: String },
    PendingRewards { address: String },
    VaultBalance {},
    Card { card_id: String },

    // ---- 需求三：AI 统计 ----
    AiStats { address: String },

    // ---- 需求四：出卡顺序 ----
    GetBattleOrder { player: String },

    // ---- 需求五：卡牌提案 ----
    ListProposals {
        start_after: Option<u64>,
        limit: Option<u32>,
    },
    GetProposal { proposal_id: u64 },
    GetProposalVotes { proposal_id: u64 },
    CardTemplates {
        start_after: Option<u32>,
        limit: Option<u32>,
    },
    RarityCount {},
}

// ============================================================
// 查询响应
// ============================================================
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct ConfigResponse {
    pub token_contract: String,
    pub burn_address: String,
    pub tap_addresses: Vec<String>,
    pub admin: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct CardInfo {
    pub card_id: String,
    pub owner: String,
    pub name: String,
    pub rarity: String,
    pub attack: u32,
    pub defense: u32,
    pub star: u8,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct PlayerCardsResponse {
    pub cards: Vec<CardInfo>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct PendingRewardsResponse {
    pub total_rewards: String,
    pub battle_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct VaultBalanceResponse {
    pub balance: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct AiStatsResponse {
    pub total: u64,
    pub wins: u64,
    pub win_rate: String,
    pub recommended_difficulty: u8,
    pub today_count: u64,
    pub daily_limit: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct BattleOrderResponse {
    pub order: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct ProposalResponse {
    pub id: u64,
    pub template: CardTemplate,
    pub proposer: String,
    pub deposit: String,
    pub yes_votes: String,
    pub no_votes: String,
    pub deadline: u64,
    pub executed: bool,
    pub approved: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct ProposalListResponse {
    pub proposals: Vec<ProposalResponse>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct ProposalVotesResponse {
    pub proposal_id: u64,
    pub yes_votes: String,
    pub no_votes: String,
    pub passed: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct RarityCountResponse {
    pub common: u64,
    pub rare: u64,
    pub epic: u64,
    pub legend: u64,
    pub total: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct GameParamsResponse {
    pub single_paxi_fee: String,
    pub pack3_paxi_fee: String,
    pub ai_fee: [String; 4],
    pub ai_reward: [String; 4],
    pub upgrade_fees: [String; 4],
}
