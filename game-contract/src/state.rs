// 三国卡牌游戏合约 - 状态存储

use cosmwasm_std::{Addr, Uint128};
use cw_storage_plus::{Item, Map};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::msg::CardInfo;

// ============================================================
// 存储项：合约配置 / 经济参数 / 卡牌模板列表
// ============================================================
pub const GAME_PARAMS: Item<GameParams> = Item::new("game_params");

// ============================================================
// 常量（需求五）
// ============================================================
pub const MAX_CARDS: u64 = 100;
pub const PROPOSAL_DEPOSIT: u128 = 50_000_000_000;     // 5 万 TKCC（最小单位）
pub const VOTING_PERIOD: u64 = 604_800;                // 7 天（秒）
pub const DAILY_AI_LIMIT: u64 = 20;                    // 每日 AI 对战上限
pub const UPGRADE_BURN_PCT: u128 = 50;                 // 升星 50% 销毁，50% 金库

// ============================================================
// 碎片系统常量
// ============================================================
/// 重复卡转化碎片数量
pub const FRAGMENT_FROM_DUPLICATE: [(u64, u64); 4] = [
    // (rarity_index, fragments)  index: 0=common 1=rare 2=epic 3=legend
    (0, 5), (1, 10), (2, 20), (3, 50),
];
/// 合成卡牌消耗碎片
pub const CRAFT_COST: [u64; 4] = [30, 60, 150, 400];
/// 升星碎片替代：TKCC / 100（向上取整）

// ============================================================
// 合约配置（完全无管理员）
// ============================================================
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct Config {
    pub token_contract: Addr,
    pub burn_address: Addr,
    pub tap_addresses: Vec<Addr>,
    // admin 已移除：合约完全无管理员，部署后即去中心化
}

pub const CONFIG: Item<Config> = Item::new("config");

// ============================================================
// 卡牌存储
// ============================================================
/// 卡牌ID -> 卡牌信息
pub const CARDS: Map<&str, CardInfo> = Map::new("cards");
/// 玩家地址 -> 卡牌ID 列表
pub const PLAYER_CARDS: Map<&Addr, Vec<String>> = Map::new("player_cards");

// ============================================================
// 碎片系统
// ============================================================
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema, Default)]
pub struct Fragments {
    pub common: u64,
    pub rare: u64,
    pub epic: u64,
    pub legend: u64,
}

impl Fragments {
    /// 按稀有度字符串获取字段值
    pub fn get(&self, rarity: &str) -> u64 {
        match rarity {
            "common" => self.common,
            "rare" => self.rare,
            "epic" => self.epic,
            "legend" => self.legend,
            _ => 0,
        }
    }
    /// 按稀有度字符串设置字段值
    pub fn set(&mut self, rarity: &str, val: u64) {
        match rarity {
            "common" => self.common = val,
            "rare" => self.rare = val,
            "epic" => self.epic = val,
            "legend" => self.legend = val,
            _ => {}
        }
    }
    /// 稀有度字符串 -> 索引 (0~3)
    pub fn rarity_index(rarity: &str) -> Option<usize> {
        match rarity {
            "common" => Some(0),
            "rare" => Some(1),
            "epic" => Some(2),
            "legend" => Some(3),
            _ => None,
        }
    }
}

pub const FRAGMENTS: Map<&Addr, Fragments> = Map::new("fragments");
/// 稀有度计数（用于提案校验）
pub const RARITY_COUNT: Map<&str, u64> = Map::new("rarity_count");
/// 已启用的卡牌模板总数（校验 MAX_CARDS）
pub const CARD_TEMPLATE_COUNT: Item<u64> = Item::new("card_template_count");

// ============================================================
// 对战记录（奖励领取）
// ============================================================
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct BattleRecord {
    pub battle_id: String,
    pub player: Addr,
    pub difficulty: u8,
    pub result: String,
    pub reward: String,
    pub claimed: bool,
    pub timestamp: u64,
}

pub const BATTLES: Map<&str, BattleRecord> = Map::new("battles");
pub const PENDING_REWARDS: Map<&Addr, Vec<String>> = Map::new("pending_rewards");

// ============================================================
// 需求三：AI 防刷
// ============================================================
/// 每日对战计数：玩家 -> 当日次数
pub const AI_BATTLE_COUNT: Map<&Addr, u64> = Map::new("ai_battle_count");
/// 玩家 -> 最近一次对战的日期（UTC 当天 0 点时间戳）
pub const AI_BATTLE_DATE: Map<&Addr, u64> = Map::new("ai_battle_date");

/// 玩家 AI 对战累计统计（用于动态难度）
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema, Default)]
pub struct AiStats {
    pub total: u64,
    pub wins: u64,
}
pub const AI_BATTLE_STATS: Map<&Addr, AiStats> = Map::new("ai_battle_stats");

// ============================================================
// 需求四：玩家自定义出卡顺序
// ============================================================
/// 玩家地址 -> 卡牌 card_id 顺序列表（String 与 CardInfo.card_id 一致）
pub const PLAYER_BATTLE_ORDER: Map<&Addr, Vec<String>> = Map::new("player_battle_order");

// ============================================================
// 玩家存款系统（修复：一人付款全链共享漏洞）
// 每个地址维护独立的 TKCC 存款，所有消耗 TKCC 的操作从此扣除
// ============================================================
/// 玩家地址 -> 当前可用 TKCC 存款（最小单位，1 TKCC = 1e6）
pub const DEPOSITS: Map<&Addr, u128> = Map::new("deposits");
/// 玩家地址 -> 提案中锁定的 TKCC（简化版直接记总额）
pub const PROPOSAL_DEPOSITS: Map<&Addr, u128> = Map::new("proposal_deposits");

// ============================================================
// 需求五：卡牌提案系统
// ============================================================
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct CardTemplate {
    pub id: String,
    pub name: String,
    pub title: Option<String>,
    pub rarity: String,      // common / rare / epic / legend
    pub attack: u32,
    pub defense: u32,
    pub cost: Option<u32>,
    pub weight: u32,         // 抽卡权重
    pub description: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct CardProposal {
    pub id: u64,
    pub template: CardTemplate,
    pub proposer: Addr,
    pub deposit: Uint128,    // 5 万 TKCC
    pub yes_votes: Uint128,  // 累计赞成票 (TKCC 总量，1 TKCC = 1 票)
    pub no_votes: Uint128,   // 累计反对票
    pub deadline: u64,       // 截止时间戳 (seconds)
    pub executed: bool,
    pub approved: bool,
}

pub const CARD_TEMPLATES: Item<Vec<CardTemplate>> = Item::new("card_templates");
pub const PROPOSALS: Map<u64, CardProposal> = Map::new("proposals");
pub const PROPOSAL_COUNTER: Item<u64> = Item::new("proposal_counter");

// 记录某地址对某提案的投票（防止重复投票）
pub const VOTES: Map<(u64, &Addr), bool> = Map::new("votes"); // (proposal_id, voter) -> true(yes) / false(no)

// ============================================================
// 经济模型参数（需求二）
// ============================================================
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct GameParams {
    // ---- 单抽 ----
    pub single_paxi_fee: u128,   // 10 PAXI (upaxi)
    pub single_prc_total: u128,  // 20 万 TKCC (最小单位)
    pub single_prc_vault: u128,  // 14 万（70%）
    pub single_prc_burn: u128,   // 4 万（20%）
    pub single_prc_eco: u128,    // 2 万（10%）
    // ---- 三连抽 ----
    pub pack3_paxi_fee: u128,    // 30 PAXI
    pub pack3_prc_total: u128,   // 50 万 TKCC
    pub pack3_prc_vault: u128,   // 35 万（70%）
    pub pack3_prc_burn: u128,    // 10 万（20%）
    pub pack3_prc_eco: u128,     // 5 万（10%）
    // ---- AI 对战 ----
    pub ai_fee: [u128; 4],       // [1万, 1.5万, 2万, 2.5万]
    pub ai_reward: [u128; 4],    // [4万, 5万, 7万, 8万]
    pub ai_legend_boost_pct: u32, // 传说 AI 卡牌属性加成百分比（25）
    // ---- PVP ----
    pub pvp_fee: u128,           // 挑战方 6 万
    pub pvp_reward_tiers: [(u128, u128); 4], // [(888万下限, 10万奖励), (3888万下限, 15万), (6888万下限, 20万), (Infinity上限, 25万)]
    // ---- 混战 ----
    pub royale_entry_fee: u128,  // 6 万/人
    pub royale_reward_pct_bp: u128, // 7000 基点 (70%)
    pub royale_burn_pct_bp: u128,   // 1500
    pub royale_vault_pct_bp: u128,  // 1500
    // ---- 升星（50% 销毁 + 50% 金库）----
    pub upgrade_fees: [u128; 4],     // [5万, 15万, 40万, 100万]
    pub upgrade_atk_boost: [u32; 4], // [8, 12, 18, 25]
    pub upgrade_def_boost: [u32; 4], // [5, 8, 12, 18]
    // ---- AI 防刷 ----
    pub daily_ai_limit: u64,         // 20 局/日
    pub ai_burn_pct_bp: u128,        // 5000（50% 销毁）
}

impl Default for GameParams {
    fn default() -> Self {
        // TKCC 最小单位：按 Paxid CLI 指令的格式为 * 1e6
        // 即 1 TKCC = 1_000_000 最小单位（与 PAXI 类似）
        let tkcc = |n: u128| n * 1_000_000;
        let paxi = |n: u128| n * 1_000_000; // upaxi
        Self {
            single_paxi_fee:  paxi(10),
            single_prc_total: tkcc(200_000),
            single_prc_vault: tkcc(140_000),
            single_prc_burn:  tkcc(40_000),
            single_prc_eco:   tkcc(20_000),

            pack3_paxi_fee:  paxi(30),
            pack3_prc_total: tkcc(500_000),
            pack3_prc_vault: tkcc(350_000),
            pack3_prc_burn:  tkcc(100_000),
            pack3_prc_eco:   tkcc(50_000),

            ai_fee:   [tkcc(10_000), tkcc(15_000), tkcc(20_000), tkcc(25_000)],
            ai_reward:[tkcc(40_000), tkcc(50_000), tkcc(70_000), tkcc(80_000)],
            ai_legend_boost_pct: 25,

            pvp_fee: tkcc(60_000),
            pvp_reward_tiers: [
                (tkcc(0),        tkcc(100_000)),   // < 888万 → 10万
                (tkcc(8_880_000),  tkcc(150_000)), // 888万~ → 15万
                (tkcc(38_880_000), tkcc(200_000)), // 3888万~ → 20万
                (tkcc(68_880_000), tkcc(250_000)), // >6888万 → 25万
            ],

            royale_entry_fee:     tkcc(60_000),
            royale_reward_pct_bp: 7000,
            royale_burn_pct_bp:   1500,
            royale_vault_pct_bp:  1500,

            upgrade_fees:    [tkcc(50_000), tkcc(150_000), tkcc(400_000), tkcc(1_000_000)],
            upgrade_atk_boost: [8, 12, 18, 25],
            upgrade_def_boost: [5, 8, 12, 18],

            daily_ai_limit:  20,
            ai_burn_pct_bp:  5000,
        }
    }
}

impl GameParams {
    // 根据金库余额计算 PVP 赢家奖励（四档递进：< 888万 → 10万，以此类推）
    pub fn pvp_reward(&self, vault_balance: u128) -> u128 {
        // tiers 4 个：[(0,10万),(888万,15万),(3888万,20万),(6888万,25万)]
        // 取值规则：如果 vault_balance < 下一阶阈值 → 返回当前阶 reward
        for i in 0..self.pvp_reward_tiers.len() {
            let (_, reward) = self.pvp_reward_tiers[i];
            let next_threshold = self.pvp_reward_tiers.get(i + 1).map(|(t, _)| *t).unwrap_or(u128::MAX);
            if vault_balance < next_threshold {
                return reward;
            }
        }
        self.pvp_reward_tiers.last().map(|(_, r)| *r).unwrap_or(self.pvp_reward_tiers[0].1)
    }

    // 根据胜率计算 AI 难度调整（返回目标难度 1~4）
    pub fn difficulty_from_win_rate(&self, wins: u64, total: u64) -> u8 {
        if total == 0 { return 1; }
        let rate = (wins as f64) / (total as f64);
        if rate < 0.40 { 1 }
        else if rate < 0.60 { 2 }
        else if rate < 0.80 { 3 }
        else { 4 }
    }
}
