// 三国卡牌游戏合约 - 消息定义

use cosmwasm_std::Binary;
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
    // admin 已移除：合约完全无管理员，部署后即去中心化
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

    // ---- 升星（50% 销毁 + 50% 金库 / 碎片替代）----
    StarUp { card_id: String, use_fragments: Option<bool> },

    // ---- 需求四：玩家自定义出卡顺序 ----
    SetBattleOrder { order: Vec<String> },

    // ---- 需求五：卡牌提案系统 ----
    /// 提交新卡牌提案：质押 5 万 TKCC
    ProposeCard { template: CardTemplate },
    /// 投票：1 TKCC = 1 票（使用玩家「持有」的 TKCC 余额作为投票权重，无需转账）
    VoteCard { proposal_id: u64, approve: bool },
    /// 提案到期后执行（赞成票 > 50%）
    ExecuteProposal { proposal_id: u64 },
    /// 提案者提前取消未到期的未通过提案
    CancelProposal { proposal_id: u64 },

    // ---- PVP 1v1 对战 ----
    /// 挑战者创建对局：指定对手地址（或公开）+ 自己的 3 张卡牌顺序，从存款扣除 6 万 TKCC 入场费
    CreatePvpMatch { opponent: String, card_ids: Vec<String>, public: Option<bool> },
    /// 对手接受对局：填入自己 3 张卡牌顺序，从存款扣 6 万 TKCC，接受后立即触发链上结算
    AcceptPvpMatch { match_id: String, card_ids: Vec<String> },
    /// 挑战者取消未被接受的对局（费用不退）
    CancelPvpMatch { match_id: String },
    /// 赢家领取奖励（Check-Effects-Interaction：先标记后转账，防重入）
    ClaimPvpReward { match_id: String },

    // ---- 4-6 人混战 ----
    /// 创建混战房间，size=4/5/6，房主支付 6 万 TKCC 并提交 3 张卡
    CreateRoyale { size: u8, card_ids: Vec<String> },
    /// 加入混战房间，支付 6 万 TKCC 并提交 3 张卡；满人后状态变 Full
    JoinRoyaleRoom { royale_id: String, card_ids: Vec<String> },
    /// 发起结算（满人后任何参与者可调用）；赢家由合约自动计算，防作弊
    SettleRoyale { royale_id: String },
    /// 赢家领取奖励，防重入
    ClaimRoyaleReward { royale_id: String },

    // ---- 卡牌分解 & 升级 ----
    /// 分解卡牌为碎片（按稀有度：5/10/20/50）
    DecomposeCard { card_id: String },
    /// 升级卡牌：消耗碎片 +3 攻 +2 防，最多 Lv.10
    UpgradeCard { card_id: String },

    // ---- CW20 Send + Receive（官方标准存款模式，修复费用共享漏洞）----
    /// CW20 代币合约转账到本合约时自动回调（标准 Cw20ReceiveMsg）
    /// 用户调用 cw20::Cw20ExecuteMsg::Send { contract, amount, msg } 即可存入
    Receive(cw20::Cw20ReceiveMsg),

    // ---- 玩家存款系统 ----
    /// 从个人存款提取 TKCC（退回自己地址）
    WithdrawDeposit { amount: String },

    // ---- 碎片系统 ----
    /// 合成卡牌：消耗碎片，随机获得对应稀有度卡牌
    CraftCard { rarity: String },
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

    // ---- 碎片系统 ----
    GetFragments { address: String },

    // ---- 玩家存款系统 ----
    GetDeposit { address: String },

    // ---- PVP ----
    GetPvpMatch { match_id: String },
    ListPvpMatches {
        player: Option<String>,
        status: Option<String>,
        start_after: Option<String>,
        limit: Option<u32>,
    },

    // ---- 混战 ----
    GetRoyale { royale_id: String },
    ListRoyale {
        status: Option<String>,
        start_after: Option<String>,
        limit: Option<u32>,
    },
}

// ============================================================
// 查询响应
// ============================================================
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct ConfigResponse {
    pub token_contract: String,
    pub burn_address: String,
    pub tap_addresses: Vec<String>,
    // admin 已移除：合约完全无管理员
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
    pub level: u8,   // Lv.0-10，升星/升级独立成长；旧卡默认 0
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
    pub daily_ai_limit: u64,
    pub ai_legend_boost_pct: u32,
    pub pvp_fee: String,
    pub royale_entry_fee: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct FragmentsResponse {
    pub common: u64,
    pub rare: u64,
    pub epic: u64,
    pub legend: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct DepositResponse {
    pub available: String,   // 可用存款（未锁定）
    pub locked: String,      // 提案质押锁定金额
}

// ============================================================
// PVP / 混战响应
// ============================================================
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct PvpMatchResponse {
    pub match_id: String,
    pub challenger: String,
    pub opponent: String,
    pub is_public: bool,
    pub challenger_order: Vec<String>,
    pub opponent_order: Vec<String>,
    pub winner: Option<String>,
    pub status: String,   // waiting / pending / finished / cancelled
    pub created_at: u64,
    pub finished_at: Option<u64>,
    pub reward_claimed: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct PvpListResponse {
    pub matches: Vec<PvpMatchResponse>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct RoyaleResponse {
    pub royale_id: String,
    pub players: Vec<String>,
    pub player_orders: Vec<Vec<String>>,
    pub winner: Option<String>,
    pub status: String,   // waiting / full / finished / cancelled
    pub created_at: u64,
    pub finished_at: Option<u64>,
    pub size: u8,
    pub reward_claimed: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct RoyaleListResponse {
    pub royales: Vec<RoyaleResponse>,
}
