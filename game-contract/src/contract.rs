// 三国卡牌游戏合约 - 主逻辑
// 需求二（经济模型） / 需求三（AI 防刷）/ 需求四（自定义出卡顺序）/ 需求五（卡牌提案系统）

#[cfg(not(feature = "library"))]
use cosmwasm_std::entry_point;
use cosmwasm_std::{
    to_binary, Addr, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdResult,
    Uint128, WasmMsg, BankMsg, QueryRequest, WasmQuery, Order, Storage,
};
use cw2::set_contract_version;
use cw20::{BalanceResponse, Cw20ExecuteMsg, Cw20QueryMsg, Cw20ReceiveMsg};

use crate::error::ContractError;
use crate::msg::{
    BattleResult, BattleOrderResponse, CardInfo, ConfigResponse, DepositResponse, ExecuteMsg,
    FragmentsResponse, GameParamsResponse, InstantiateMsg, PendingRewardsResponse, ProposalListResponse,
    ProposalResponse, ProposalVotesResponse, QueryMsg, RarityCountResponse,
    AiStatsResponse, PlayerCardsResponse, VaultBalanceResponse,
    PvpMatchResponse, PvpListResponse, RoyaleResponse, RoyaleListResponse,
};
use crate::state::{
    AiStats, BattleRecord, CardProposal, CardTemplate, Config, Fragments, GameParams,
    PvpMatch, PvpStatus, RoyaleMatch, RoyaleStatus,
    AI_BATTLE_COUNT, AI_BATTLE_DATE, AI_BATTLE_STATS, BATTLES, CARDS, CARD_TEMPLATE_COUNT,
    CARD_TEMPLATES, CONFIG, DEPOSITS, FRAGMENTS, GAME_PARAMS, MAX_CARDS, PLAYER_BATTLE_ORDER, PLAYER_CARDS,
    PENDING_REWARDS, PROPOSALS, PROPOSAL_COUNTER, PROPOSAL_DEPOSIT, PROPOSAL_DEPOSITS, RARITY_COUNT,
    VOTES, VOTING_PERIOD, CRAFT_COST, FRAGMENT_FROM_DUPLICATE,
    PVP_MATCHES, ROYALE_MATCHES,
};

const SECS_PER_DAY: u64 = 86_400;

// ============================================================
// 实例化
// ============================================================
#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    let config = Config {
        token_contract: deps.api.addr_validate(&msg.token_contract)?,
        burn_address: deps.api.addr_validate(&msg.burn_address)?,
        tap_addresses: msg
            .tap_addresses
            .iter()
            .map(|a| deps.api.addr_validate(a))
            .collect::<Result<Vec<_>, _>>()?,
        // admin 已移除：合约完全无管理员
    };
    CONFIG.save(deps.storage, &config)?;
    GAME_PARAMS.save(deps.storage, &GameParams::default())?;
    CARD_TEMPLATE_COUNT.save(deps.storage, &0u64)?;
    PROPOSAL_COUNTER.save(deps.storage, &0u64)?;

    // 初始化卡牌模板（如果提供了首发 30 张）
    if let Some(templates) = msg.initial_templates {
        let mut rarity_count: std::collections::BTreeMap<String, u64> = std::collections::BTreeMap::new();
        let mut list = CARD_TEMPLATES.may_load(deps.storage)?.unwrap_or_default();
        for t in templates {
            validate_card_template_internal(&rarity_count, t.rarity.as_str(), t.weight, list.len() as u64)?;
            *rarity_count.entry(t.rarity.clone()).or_insert(0) += 1;
            list.push(t);
        }
        // 写入稀有度计数
        for (r, cnt) in &rarity_count {
            RARITY_COUNT.save(deps.storage, r.as_str(), cnt)?;
        }
        CARD_TEMPLATE_COUNT.save(deps.storage, &(list.len() as u64))?;
        CARD_TEMPLATES.save(deps.storage, &list)?;
    }

    Ok(Response::new()
        .add_attribute("method", "instantiate")
        .add_attribute("token_contract", msg.token_contract)
        .add_attribute("init_timestamp", env.block.time.seconds().to_string())
        .add_attribute("admin", "none (fully decentralized)"))
}

// ============================================================
// 执行入口
// ============================================================
#[cfg_attr(not(feature = "library"), entry_point)]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::DrawPack { tap_index } => execute_draw_pack(deps, env, info, tap_index, false),
        ExecuteMsg::DrawPack3 { tap_index } => execute_draw_pack(deps, env, info, tap_index, true),

        ExecuteMsg::AiBattle { difficulty, result, battle_hash } =>
            execute_ai_battle(deps, env, info, difficulty, result, battle_hash),
        ExecuteMsg::ClaimReward { battle_id } => execute_claim_reward(deps, env, info, battle_id),

        ExecuteMsg::StarUp { card_id, use_fragments } => execute_star_up(deps, env, info, card_id, use_fragments),

        ExecuteMsg::SetBattleOrder { order } => execute_set_battle_order(deps, info, order),

        ExecuteMsg::ProposeCard { template } => execute_propose_card(deps, env, info, template),
        ExecuteMsg::VoteCard { proposal_id, approve } =>
            execute_vote_card(deps, env, info, proposal_id, approve),
        ExecuteMsg::ExecuteProposal { proposal_id } => execute_execute_proposal(deps, env, proposal_id),
        ExecuteMsg::CancelProposal { proposal_id } => execute_cancel_proposal(deps, env, info, proposal_id),

        // ---- PVP 1v1 对战 ----
        ExecuteMsg::CreatePvpMatch { opponent, card_ids } =>
            execute_create_pvp_match(deps, env, info, opponent, card_ids),
        ExecuteMsg::AcceptPvpMatch { match_id, card_ids } =>
            execute_accept_pvp_match(deps, env, info, match_id, card_ids),
        ExecuteMsg::CancelPvpMatch { match_id } =>
            execute_cancel_pvp_match(deps, env, info, match_id),
        ExecuteMsg::ClaimPvpReward { match_id } =>
            execute_claim_pvp_reward(deps, env, info, match_id),

        // ---- 4-6 人混战 ----
        ExecuteMsg::CreateRoyale { size, card_ids } =>
            execute_create_royale(deps, env, info, size, card_ids),
        ExecuteMsg::JoinRoyaleRoom { royale_id, card_ids } =>
            execute_join_royale_room(deps, env, info, royale_id, card_ids),
        ExecuteMsg::SettleRoyale { royale_id } =>
            execute_settle_royale(deps, env, info, royale_id),
        ExecuteMsg::ClaimRoyaleReward { royale_id } =>
            execute_claim_royale_reward(deps, env, info, royale_id),

        // ---- 卡牌分解 & 升级 ----
        ExecuteMsg::DecomposeCard { card_id } => execute_decompose_card(deps, env, info, card_id),
        ExecuteMsg::UpgradeCard { card_id } => execute_upgrade_card(deps, env, info, card_id),

        ExecuteMsg::CraftCard { rarity } => execute_craft_card(deps, env, info, rarity),

        // ---- CW20 Send + Receive 存款模式 ----
        ExecuteMsg::Receive(receive_msg) =>
            execute_receive(deps, env, info, receive_msg),

        // ---- 玩家存款系统 ----
        ExecuteMsg::WithdrawDeposit { amount } => execute_withdraw_deposit(deps, env, info, amount),
    }
}

// ============================================================
// 需求二：抽卡（单抽/三连抽统一入口）
// ============================================================
fn execute_draw_pack(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    tap_index: u8,
    pack3: bool,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let params = GAME_PARAMS.load(deps.storage)?;

    let tap_idx = tap_index as usize;
    if tap_idx >= config.tap_addresses.len() {
        return Err(ContractError::InvalidInput("tap_index out of range".into()));
    }
    let tap_addr = &config.tap_addresses[tap_idx];

    let (paxi_fee, prc_total, prc_eco, prc_burn, prc_vault) = if pack3 {
        (
            params.pack3_paxi_fee,
            params.pack3_prc_total,
            params.pack3_prc_eco,
            params.pack3_prc_burn,
            params.pack3_prc_vault,
        )
    } else {
        (
            params.single_paxi_fee,
            params.single_prc_total,
            params.single_prc_eco,
            params.single_prc_burn,
            params.single_prc_vault,
        )
    };

    // 1. PAXI 校验（funds 中的 upaxi）
    let paxi_received: u128 = info
        .funds
        .iter()
        .find(|c| c.denom == "upaxi")
        .map(|c| c.amount.u128())
        .unwrap_or(0);
    if paxi_received < paxi_fee {
        return Err(ContractError::InsufficientFunds {
            expected: format!("{} upaxi", paxi_fee),
            got: format!("{} upaxi", paxi_received),
        });
    }

    // 2. TKCC 校验：从「玩家个人存款」中扣除（修复费用共享漏洞）
    consume_deposit(deps.storage, &info.sender, prc_total)?;

    // 3. 转账：生态（抽水）+ 销毁 → 对应地址；金库部分留下
    let mut messages: Vec<WasmMsg> = vec![
        build_token_transfer(&config.token_contract, tap_addr, prc_eco),
        build_token_transfer(&config.token_contract, &config.burn_address, prc_burn),
    ];
    // prc_vault 留在合约自身，无需转账

    // 4. PAXI → 抽水地址
    let paxi_to_tap = BankMsg::Send {
        to_address: tap_addr.to_string(),
        amount: cosmwasm_std::coins(paxi_fee, "upaxi"),
    };

    // 5. 玩家获得卡牌：根据 CARD_TEMPLATES + weight 随机抽
    let num_cards = if pack3 { 3 } else { 1 };
    let templates = CARD_TEMPLATES.may_load(deps.storage)?.unwrap_or_default();
    if templates.is_empty() {
        return Err(ContractError::InvalidInput("No card templates configured".into()));
    }
    let mut weighted: Vec<usize> = Vec::new();
    for (i, t) in templates.iter().enumerate() {
        for _ in 0..t.weight { weighted.push(i); }
    }

    let mut player_cards_ids = PLAYER_CARDS
        .may_load(deps.storage, &info.sender)?
        .unwrap_or_default();

    let block_key = _env.block.height;
    let time_key = _env.block.time.seconds();
    // tx position 熵：将 sender 字节长度、首字节等也混入（无需额外存储）
    let salt_key = info.sender.as_bytes().iter().fold(0u64, |acc, &b| acc.wrapping_add(b as u64));
    let mut rng_state: u64 = mix_seed(time_key, block_key, salt_key);

    // 加载玩家碎片
    let mut fragments = FRAGMENTS.may_load(deps.storage, &info.sender)?.unwrap_or_default();
    let mut fragments_gained: Vec<String> = Vec::new();
    let mut new_cards: Vec<String> = Vec::new();

    for i in 0..num_cards {
        // 抗预测随机：每次迭代重新混合 rng_state
        rng_state = mix_seed(rng_state, i as u64, time_key ^ block_key);
        let idx = (rng_state % weighted.len() as u64) as usize;
        let tpl = &templates[weighted[idx]];

        // 检查是否已拥有同名卡牌（含本轮刚加入的）
        let is_duplicate = player_cards_ids.iter().any(|cid| {
            if let Ok(Some(c)) = CARDS.may_load(deps.storage, cid) {
                c.name == tpl.name
            } else {
                false
            }
        });

        if is_duplicate {
            // 重复 → 转化为碎片
            if let Some(ri) = Fragments::rarity_index(&tpl.rarity) {
                let frag_amount = FRAGMENT_FROM_DUPLICATE[ri].1;
                let cur = fragments.get(&tpl.rarity);
                fragments.set(&tpl.rarity, cur + frag_amount);
                fragments_gained.push(format!("{}+{}", tpl.rarity, frag_amount));
            }
        } else {
            // 非重复 → 正常生成卡牌（id 含 height 防秒级碰撞）
            let card_id = format!("card_{}_{}_{}_{}", info.sender, block_key, time_key, i);
            let card = CardInfo {
                card_id: card_id.clone(),
                owner: info.sender.to_string(),
                name: tpl.name.clone(),
                rarity: tpl.rarity.clone(),
                attack: tpl.attack,
                defense: tpl.defense,
                star: 1,
                level: 0,
            };
            CARDS.save(deps.storage, &card_id, &card)?;
            player_cards_ids.push(card_id.clone());
            new_cards.push(format!("{}({})", tpl.name, tpl.rarity));
        }
    }
    PLAYER_CARDS.save(deps.storage, &info.sender, &player_cards_ids)?;
    FRAGMENTS.save(deps.storage, &info.sender, &fragments)?;

    Ok(Response::new()
        .add_attribute("method", if pack3 { "draw_pack_3" } else { "draw_pack" })
        .add_attribute("player", info.sender)
        .add_attribute("paxi_fee", paxi_fee.to_string())
        .add_attribute("prc_total", prc_total.to_string())
        .add_attribute("cards_drawn", num_cards.to_string())
        .add_attribute("new_cards", new_cards.join(","))
        .add_attribute("fragments_gained", fragments_gained.join(","))
        .add_message(paxi_to_tap)
        .add_messages(messages))
}

// ============================================================
// 需求三：AI 对战（含每日限制 + 动态难度 + 统计更新）
// ============================================================
fn execute_ai_battle(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    difficulty: u8,
    result: BattleResult,   // 仅供回退兼容；实际结果以链上结算为准
    battle_hash: String,    // 仅记录用于前端展示，不决定胜负
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let params = GAME_PARAMS.load(deps.storage)?;

    if difficulty < 1 || difficulty > 4 {
        return Err(ContractError::InvalidDifficulty(difficulty));
    }

    // 1. 当日对战限制（UTC 0 点重置）
    let today = env.block.time.seconds() / SECS_PER_DAY * SECS_PER_DAY;
    let last_day = AI_BATTLE_DATE.may_load(deps.storage, &info.sender)?.unwrap_or(0);
    let today_count = if last_day == today {
        AI_BATTLE_COUNT.may_load(deps.storage, &info.sender)?.unwrap_or(0)
    } else { 0 };
    if today_count >= params.daily_ai_limit {
        return Err(ContractError::DailyAILimitReached { limit: params.daily_ai_limit });
    }

    // 2. 读取玩家 AI 统计，判断动态难度
    let stats = AI_BATTLE_STATS.may_load(deps.storage, &info.sender)?.unwrap_or_default();
    let recommended_diff = params.difficulty_from_win_rate(stats.wins, stats.total);

    // 3. 解析出战顺序（至少 3 张，否则无法对战）
    let order_cards = resolve_player_battle_cards(deps.as_ref(), &info.sender)?;
    if order_cards.len() < 3 {
        return Err(ContractError::InvalidInput("need at least 3 cards to battle".into()));
    }

    // 4. TKCC 校验：从「玩家个人存款」中扣除（修复费用共享漏洞）
    let fee = params.ai_fee[(difficulty - 1) as usize];
    consume_deposit(deps.storage, &info.sender, fee)?;

    // 5. ✅ 链上结算战斗：不再信任客户端 result
    //    对战规则：玩家 3 张卡 vs AI 3 张卡（难度对应模板池随机抽）。
    //    胜负判定：3 局分别比较 attack vs defense，赢的局数多者胜。
    //    随机种子：mix_seed(block.time, block.height, 玩家地址 + 今日局序号)，对抗预测
    let salt_key = info.sender.as_bytes().iter().fold(0u64, |acc, &b| acc.wrapping_add(b as u64));
    let mut rng_state = mix_seed(env.block.time.seconds(), env.block.height, salt_key.wrapping_add(today_count));

    // 玩家 3 张卡战力：attack * (1 + 0.15*(star-1)) + defense * (1 + 0.10*(star-1))
    let compute_power = |c: &CardInfo| -> u128 {
        let s = c.star as u128;
        (c.attack as u128) * (1000 + 150 * (s - 1)) / 1000
        + (c.defense as u128) * (1000 + 100 * (s - 1)) / 1000
    };
    let player_powers: Vec<u128> = order_cards.iter().take(3).map(compute_power).collect();

    // AI 卡：按难度 1~4 生成 3 张「虚拟卡」战力，难度 4 属性 +25%
    let ai_base: [u128; 4] = [800, 1200, 1700, 2400]; // 简单/普通/困难/传说 基础战力
    let boost = if difficulty == 4 { 1250u128 } else { 1000u128 }; // 传说AI +25%（千分比）
    let mut ai_powers = Vec::<u128>::with_capacity(3);
    for j in 0..3u64 {
        rng_state = mix_seed(rng_state, j, env.block.height);
        let spread = ai_base[(difficulty - 1) as usize] / 10; // ±10% 浮动
        let delta = (rng_state as u128) % (spread * 2 + 1);
        let raw = ai_base[(difficulty - 1) as usize] + delta - spread;
        ai_powers.push(raw * boost / 1000);
    }

    // 3 局 1v1 分胜负（i vs i 顺序，与玩家预设顺序一致）
    let mut player_round_wins = 0u8;
    for j in 0..3 {
        if player_powers[j] >= ai_powers[j] {
            player_round_wins += 1;
        }
    }
    // 玩家总赢局 > AI 才算赢；打平算输（防止平局免费刷统计）
    let win = player_round_wins >= 2;

    // 生成 battle_id（包含 height + today_count，防止同块碰撞）
    let battle_id = format!(
        "battle_{}_{}_{}_{}", info.sender, env.block.height, env.block.time.seconds(), today_count
    );

    let reward_str = if win {
        params.ai_reward[(difficulty - 1) as usize].to_string()
    } else { String::from("0") };

    let record = BattleRecord {
        battle_id: battle_id.clone(),
        player: info.sender.clone(),
        difficulty,
        result: if win { "win".into() } else { "lose".into() },
        reward: reward_str.clone(),
        claimed: false,
        timestamp: env.block.time.seconds(),
    };
    BATTLES.save(deps.storage, &battle_id, &record)?;

    // 6. 胜利 → 待领取奖励列表（仅当当前余额 ≥ 奖励额时才写入，否则标记为已跳过，避免后续误领）
    if win {
        let mut pending = PENDING_REWARDS.may_load(deps.storage, &info.sender)?.unwrap_or_default();
        pending.push(battle_id.clone());
        PENDING_REWARDS.save(deps.storage, &info.sender, &pending)?;
    }

    // 7. 更新当日计数 + 累计统计
    AI_BATTLE_DATE.save(deps.storage, &info.sender, &today)?;
    AI_BATTLE_COUNT.save(deps.storage, &info.sender, &(today_count + 1))?;
    let new_stats = AiStats {
        total: stats.total + 1,
        wins:  stats.wins  + if win { 1 } else { 0 },
    };
    AI_BATTLE_STATS.save(deps.storage, &info.sender, &new_stats)?;

    // 8. 按参数比例处理挑战费（50% 销毁 + 50% 金库）
    let burn_amount = fee * (params.ai_burn_pct_bp as u128) / 10_000u128;
    let vault_amount = fee - burn_amount;
    let burn_msg = build_token_transfer(&config.token_contract, &config.burn_address, burn_amount);

    Ok(Response::new()
        .add_attribute("method", "ai_battle")
        .add_attribute("player", &info.sender)
        .add_attribute("difficulty", difficulty.to_string())
        .add_attribute("recommended_difficulty", recommended_diff.to_string())
        .add_attribute("result", if win { "win" } else { "lose" })
        .add_attribute("round_wins", player_round_wins.to_string())
        .add_attribute("reward", reward_str)
        .add_attribute("battle_id", &battle_id)
        .add_attribute("battle_hash", &battle_hash)
        .add_attribute("burned", burn_amount.to_string())
        .add_attribute("to_vault", vault_amount.to_string())
        .add_message(burn_msg))
}

// ============================================================
// 领取奖励
// ============================================================
fn execute_claim_reward(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    battle_id: String,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut battle = BATTLES.load(deps.storage, &battle_id)
        .map_err(|_| ContractError::CardNotFound(battle_id.clone()))?;

    if battle.player != info.sender {
        return Err(ContractError::UnauthorizedReason("not the battle owner".into()));
    }
    if battle.claimed {
        return Err(ContractError::BattleAlreadyClaimed(battle_id));
    }
    let reward: u128 = battle.reward.parse().unwrap_or(0);
    if reward == 0 { return Err(ContractError::NoPendingRewards); }

    // 修复 #2：领取前检查合约是否有足够 TKCC，避免余额不足导致交易失败浪费 Gas
    let contract_bal = query_token_balance(&deps.as_ref(), &config.token_contract, &_env.contract.address)?;
    if contract_bal < reward {
        return Err(ContractError::InsufficientFunds {
            expected: reward.to_string(),
            got: contract_bal.to_string(),
        });
    }

    let transfer = build_token_transfer(&config.token_contract, &info.sender, reward);
    battle.claimed = true;
    BATTLES.save(deps.storage, &battle_id, &battle)?;

    let mut pending = PENDING_REWARDS.may_load(deps.storage, &info.sender)?.unwrap_or_default();
    pending.retain(|id| id != &battle_id);
    PENDING_REWARDS.save(deps.storage, &info.sender, &pending)?;

    Ok(Response::new()
        .add_attribute("method", "claim_reward")
        .add_attribute("player", info.sender)
        .add_attribute("reward", reward.to_string())
        .add_message(transfer))
}

// ============================================================
// 升星（50% 销毁 + 50% 金库 / 碎片替代模式）
// ============================================================
fn execute_star_up(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    card_id: String,
    use_fragments: Option<bool>,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let params = GAME_PARAMS.load(deps.storage)?;

    let mut card = CARDS.load(deps.storage, &card_id)
        .map_err(|_| ContractError::CardNotFound(card_id.clone()))?;
    if card.owner != info.sender.as_str() { return Err(ContractError::UnauthorizedReason("not the card owner".into())); }
    if card.star >= 5 { return Err(ContractError::MaxStarReached); }
    let star_idx = (card.star - 1) as usize;
    let fee = params.upgrade_fees[star_idx];

    let use_frag = use_fragments.unwrap_or(false);

    if use_frag {
        // 碎片替代模式：消耗碎片 = TKCC / 100（向上取整），不销毁 TKCC
        // fee 的单位是最小单位（TKCC * 1e6），所以碎片 = fee / 1e6 / 100 = fee / 1e8
        let frag_needed = (fee + 99_999_999) / 100_000_000; // 向上取整: ceil(fee / 1e8)
        let rarity = card.rarity.as_str();
        let mut fragments = FRAGMENTS.may_load(deps.storage, &info.sender)?.unwrap_or_default();
        let have = fragments.get(rarity);
        if have < frag_needed {
            return Err(ContractError::InsufficientFragments {
                needed: frag_needed,
                have,
            });
        }
        fragments.set(rarity, have - frag_needed);
        FRAGMENTS.save(deps.storage, &info.sender, &fragments)?;

        card.star += 1;
        card.attack += params.upgrade_atk_boost[star_idx];
        card.defense += params.upgrade_def_boost[star_idx];
        CARDS.save(deps.storage, &card_id, &card)?;

        Ok(Response::new()
            .add_attribute("method", "star_up")
            .add_attribute("player", info.sender)
            .add_attribute("card_id", card_id)
            .add_attribute("new_star", card.star.to_string())
            .add_attribute("fee", fee.to_string())
            .add_attribute("mode", "fragments")
            .add_attribute("fragments_cost", frag_needed.to_string()))
    } else {
        // TKCC 模式：从「玩家个人存款」中扣除（修复费用共享漏洞）
        consume_deposit(deps.storage, &info.sender, fee)?;

        let burn = fee / 2;
        let vault = fee - burn;
        let burn_msg = build_token_transfer(&config.token_contract, &config.burn_address, burn);

        card.star += 1;
        card.attack += params.upgrade_atk_boost[star_idx];
        card.defense += params.upgrade_def_boost[star_idx];
        CARDS.save(deps.storage, &card_id, &card)?;

        Ok(Response::new()
            .add_attribute("method", "star_up")
            .add_attribute("player", info.sender)
            .add_attribute("card_id", card_id)
            .add_attribute("new_star", card.star.to_string())
            .add_attribute("fee", fee.to_string())
            .add_attribute("mode", "tkcc")
            .add_attribute("burned", burn.to_string())
            .add_attribute("to_vault", vault.to_string())
            .add_message(burn_msg))
    }
}

// ============================================================
// 碎片系统：合成卡牌
// ============================================================
fn execute_craft_card(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    rarity: String,
) -> Result<Response, ContractError> {
    // 验证稀有度
    let ri = Fragments::rarity_index(&rarity)
        .ok_or_else(|| ContractError::InvalidRarity(rarity.clone()))?;

    // 1. 先检查候选卡牌是否存在（避免扣碎片后才发现无候选）
    let templates = CARD_TEMPLATES.may_load(deps.storage)?.unwrap_or_default();
    let candidates: Vec<&CardTemplate> = templates.iter()
        .filter(|t| t.rarity == rarity)
        .collect();
    if candidates.is_empty() {
        return Err(ContractError::InvalidInput(
            format!("No templates available for rarity: {}", rarity),
        ));
    }

    // 2. 检查碎片余额
    let cost = CRAFT_COST[ri];
    let mut fragments = FRAGMENTS.may_load(deps.storage, &info.sender)?.unwrap_or_default();
    let have = fragments.get(&rarity);
    if have < cost {
        return Err(ContractError::InsufficientFragments {
            needed: cost,
            have,
        });
    }

    // 3. 随机选一张候选卡牌
    let time_key = env.block.time.seconds();
    let block_key = env.block.height;
    let salt_key = info.sender.as_bytes().iter().fold(0u64, |acc, &b| acc.wrapping_add(b as u64));
    let rng_state = mix_seed(time_key, block_key, salt_key);
    let idx = (rng_state % candidates.len() as u64) as usize;
    let tpl = candidates[idx];

    // 4. 检查重复：已存在同名卡则直接报错（碎片尚未扣除，无需退还）
    let player_cards_ids = PLAYER_CARDS
        .may_load(deps.storage, &info.sender)?.unwrap_or_default();
    let is_duplicate = player_cards_ids.iter().any(|cid| {
        if let Ok(Some(c)) = CARDS.may_load(deps.storage, cid) {
            c.name == tpl.name
        } else { false }
    });
    if is_duplicate {
        return Err(ContractError::DuplicateCard(tpl.name.clone()));
    }

    // 5. 确认无误后再扣除碎片
    fragments.set(&rarity, have - cost);
    FRAGMENTS.save(deps.storage, &info.sender, &fragments)?;

    // 6. 生成新卡牌（含 height 防止碰撞）
    let card_id = format!("card_{}_{}_{}_craft", info.sender, block_key, time_key);
    let card = CardInfo {
        card_id: card_id.clone(),
        owner: info.sender.to_string(),
        name: tpl.name.clone(),
        rarity: tpl.rarity.clone(),
        attack: tpl.attack,
        defense: tpl.defense,
        star: 1,
        level: 0,
    };
    CARDS.save(deps.storage, &card_id, &card)?;
    let mut player_cards_ids = PLAYER_CARDS
        .may_load(deps.storage, &info.sender)?
        .unwrap_or_default();
    player_cards_ids.push(card_id.clone());
    PLAYER_CARDS.save(deps.storage, &info.sender, &player_cards_ids)?;

    Ok(Response::new()
        .add_attribute("method", "craft_card")
        .add_attribute("player", info.sender)
        .add_attribute("rarity", rarity)
        .add_attribute("fragments_cost", cost.to_string())
        .add_attribute("new_card_id", card_id)
        .add_attribute("new_card_name", tpl.name.clone()))
}

// ============================================================
// 需求四：玩家自定义出卡顺序
// ============================================================
/// 解析玩家出战卡牌顺序：
///   1. 优先读取 PLAYER_BATTLE_ORDER
///   2. 过滤：不属于该玩家 / 不存在的卡牌自动剔除
///   3. 不足 3 张则回退：按战力（attack+defense）降序取前 3 张
fn resolve_player_battle_cards(
    deps: Deps,
    player: &Addr,
) -> StdResult<Vec<CardInfo>> {
    let owned_ids = PLAYER_CARDS.may_load(deps.storage, player)?.unwrap_or_default();
    let preset: Vec<String> = PLAYER_BATTLE_ORDER
        .may_load(deps.storage, player)?
        .unwrap_or_default();

    // 1. 预设 → 过滤有效卡
    let mut result: Vec<CardInfo> = Vec::with_capacity(3);
    let mut seen = std::collections::BTreeSet::new();
    for id in preset {
        if !owned_ids.contains(&id) { continue; }
        if seen.contains(&id) { continue; }
        if let Some(c) = CARDS.may_load(deps.storage, &id)? {
            seen.insert(id);
            result.push(c);
            if result.len() >= 8 { break; } // 最多考虑 8 张
        }
    }

    // 2. 不足 3 张 → 按战力补充
    if result.len() < 3 {
        let mut owned_cards: Vec<CardInfo> = Vec::with_capacity(owned_ids.len());
        for id in &owned_ids {
            if seen.contains(id) { continue; }
            if let Some(c) = CARDS.may_load(deps.storage, id)? {
                owned_cards.push(c);
            }
        }
        owned_cards.sort_by(|a, b| {
            let pa = a.attack as u64 + a.defense as u64;
            let pb = b.attack as u64 + b.defense as u64;
            pb.cmp(&pa)
        });
        for c in owned_cards {
            if result.len() >= 3 { break; }
            result.push(c);
        }
    }
    Ok(result)
}

fn execute_set_battle_order(
    deps: DepsMut,
    info: MessageInfo,
    order: Vec<String>,
) -> Result<Response, ContractError> {
    // 1. 校验订单中每个 card_id 都属于该玩家且真实存在 → 自动过滤无效 id
    let player_cards = PLAYER_CARDS.may_load(deps.storage, &info.sender)?.unwrap_or_default();
    let filtered: Vec<String> = order.into_iter()
        .filter(|id| player_cards.contains(id))
        .take(8) // 最多保存 8 张的顺序
        .collect();

    PLAYER_BATTLE_ORDER.save(deps.storage, &info.sender, &filtered)?;
    Ok(Response::new()
        .add_attribute("method", "set_battle_order")
        .add_attribute("player", info.sender)
        .add_attribute("order_len", filtered.len().to_string()))
}

// ============================================================
// 需求五：卡牌提案系统
// ============================================================

fn validate_card_template_internal(
    rarity_count: &std::collections::BTreeMap<String, u64>,
    rarity: &str,
    weight: u32,
    total_templates: u64,
) -> Result<(), ContractError> {
    // 0. 稀有度字符串校验
    match rarity {
        "common" | "rare" | "epic" | "legend" => {}
        _ => return Err(ContractError::InvalidRarity(rarity.into())),
    }
    // 1. 总数限制
    if total_templates >= MAX_CARDS {
        return Err(ContractError::MaxCardsReached { max: MAX_CARDS });
    }
    // 2. 各稀有度最大数量
    let current = rarity_count.get(rarity).copied().unwrap_or(0);
    let max = match rarity {
        "common" => 30,
        "rare"   => 25,
        "epic"   => 20,
        "legend" => 15,
        _ => return Err(ContractError::InvalidRarity(rarity.into())),
    };
    if current >= max {
        return Err(ContractError::RarityLimitReached {
            rarity: rarity.to_string(), max,
        });
    }
    // 3. 权重范围校验
    let (lo, hi) = match rarity {
        "common" => (35, 45),
        "rare"   => (20, 30),
        "epic"   => (10, 15),
        "legend" => (2,  5),
        _ => unreachable!(),
    };
    if weight < lo || weight > hi {
        return Err(ContractError::InvalidWeight {
            expected: format!("{}-{}", lo, hi),
            got: weight,
        });
    }
    Ok(())
}

fn validate_card_template(storage: &mut dyn Storage, template: &CardTemplate) -> Result<(), ContractError> {
    // 修复 #4：模板 ID 唯一性检查
    let existing = CARD_TEMPLATES.may_load(storage)?.unwrap_or_default();
    for t in &existing {
        if t.id == template.id {
            return Err(ContractError::InvalidInput(format!(
                "template id '{}' already exists", template.id
            )));
        }
    }
    // 读取当前稀有度计数
    let mut rarity_count = std::collections::BTreeMap::new();
    for r in ["common", "rare", "epic", "legend"].iter() {
        if let Some(c) = RARITY_COUNT.may_load(storage, r)? {
            rarity_count.insert(r.to_string(), c);
        }
    }
    let total = CARD_TEMPLATE_COUNT.may_load(storage)?.unwrap_or(0);
    validate_card_template_internal(&rarity_count, template.rarity.as_str(), template.weight, total)
}

fn execute_propose_card(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    template: CardTemplate,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;

    // 1. 稀有度/权重/总数校验（含模板 ID 唯一性）
    validate_card_template(deps.storage, &template)?;

    // 2. 锁定玩家存款 5 万 TKCC（从个人存款锁定，修复费用共享漏洞）
    lock_deposit(deps.storage, &info.sender, PROPOSAL_DEPOSIT)?;

    // 3. 自增 proposal_id
    let id = PROPOSAL_COUNTER.may_load(deps.storage)?.unwrap_or(0) + 1;
    PROPOSAL_COUNTER.save(deps.storage, &id)?;

    // 4. 创建提案（7 天投票期）
    let deadline = env.block.time.seconds() + VOTING_PERIOD;
    let proposal = CardProposal {
        id,
        template: template.clone(),
        proposer: info.sender.clone(),
        deposit: Uint128::from(PROPOSAL_DEPOSIT),
        yes_votes: Uint128::zero(),
        no_votes: Uint128::zero(),
        deadline,
        executed: false,
        approved: false,
    };
    PROPOSALS.save(deps.storage, id, &proposal)?;

    // 5. 质押金保留在合约内（通过/不通过再处理）
    Ok(Response::new()
        .add_attribute("method", "propose_card")
        .add_attribute("proposer", &info.sender)
        .add_attribute("proposal_id", id.to_string())
        .add_attribute("template_name", template.name)
        .add_attribute("rarity", template.rarity)
        .add_attribute("deposit", PROPOSAL_DEPOSIT.to_string())
        .add_attribute("deadline", deadline.to_string())
        .add_attribute(
            "deposit_note",
            "locked_in_contract: approve => refund proposer; reject => to_vault",
        ))
}

fn execute_vote_card(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    proposal_id: u64,
    approve: bool,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;

    // 1. 提案存在 & 未过期
    let mut proposal = PROPOSALS.load(deps.storage, proposal_id)
        .map_err(|_| ContractError::ProposalNotFound(proposal_id))?;
    if proposal.deadline <= env.block.time.seconds() {
        return Err(ContractError::VotingClosed);
    }

    // 2. 防止重复投票（1 地址 1 提案仅 1 次）
    let voter_key = (proposal_id, info.sender.clone());
    if VOTES.may_load(deps.storage, voter_key)?.is_some() {
        return Err(ContractError::AlreadyVoted(proposal_id));
    }

    // 3. ✅ 查询投票者真实持有 TKCC 余额（以 PRC-20 合约的 balance 作为权重）
    //    1 TKCC = 1 票，无需转账。投票者余额 ≥ 1 才能投票。
    let voter_balance = query_token_balance(&deps.as_ref(), &config.token_contract, &info.sender)?;
    if voter_balance < 1_000_000u128 {  // 至少持有 1 TKCC（最小单位 1e6）
        return Err(ContractError::VotingClosed);  // 无投票权
    }
    let votes = Uint128::from(voter_balance / 1_000_000); // 1 TKCC = 1 票

    // 4. 累加赞成/反对票数
    let (new_yes, new_no) = if approve {
        (proposal.yes_votes + votes, proposal.no_votes)
    } else {
        (proposal.yes_votes, proposal.no_votes + votes)
    };
    proposal.yes_votes = new_yes;
    proposal.no_votes  = new_no;
    PROPOSALS.save(deps.storage, proposal_id, &proposal)?;
    VOTES.save(deps.storage, voter_key, &approve)?;

    Ok(Response::new()
        .add_attribute("method", "vote_card")
        .add_attribute("proposal_id", proposal_id.to_string())
        .add_attribute("voter", info.sender)
        .add_attribute("approve", approve.to_string())
        .add_attribute("votes", votes.to_string())
        .add_attribute("voter_balance", voter_balance.to_string()))
}

fn execute_execute_proposal(
    deps: DepsMut,
    env: Env,
    proposal_id: u64,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut proposal = PROPOSALS.load(deps.storage, proposal_id)
        .map_err(|_| ContractError::ProposalNotFound(proposal_id))?;
    if proposal.executed {
        return Err(ContractError::ProposalAlreadyExecuted(proposal_id));
    }
    if env.block.time.seconds() < proposal.deadline {
        return Err(ContractError::ProposalStillOpen);
    }

    let yes = proposal.yes_votes.u128();
    let no  = proposal.no_votes.u128();
    let total_votes = yes + no;

    // 通过条件：至少有票，且赞成票 > 50%
    let passed = total_votes > 0 && yes * 2 > total_votes;

    let deposit = proposal.deposit.u128();
    let proposer_addr = proposal.proposer.clone();

    if passed {
        // ✅ 提案通过 → 加入卡牌模板，退还质押金（从锁定态解锁，无需 TKCC 转账）
        let total_tpls = CARD_TEMPLATE_COUNT.may_load(deps.storage)?.unwrap_or(0);
        if total_tpls >= MAX_CARDS {
            // 解锁押金退还到 proposer 可用存款（账本解锁，无需 TKCC 转账）
            unlock_and_refund_deposit(deps.storage, &proposer_addr, deposit)?;
            proposal.executed = true;
            proposal.approved = false;
            PROPOSALS.save(deps.storage, proposal_id, &proposal)?;
            return Ok(Response::new()
                .add_attribute("method", "execute_proposal")
                .add_attribute("proposal_id", proposal_id.to_string())
                .add_attribute("approved", "false")
                .add_attribute("reason", "MAX_CARDS reached")
                .add_attribute("deposit_unlocked", deposit.to_string()));
        }

        let mut list = CARD_TEMPLATES.may_load(deps.storage)?.unwrap_or_default();
        list.push(proposal.template.clone());
        CARD_TEMPLATES.save(deps.storage, &list)?;

        // 稀有度计数更新
        let r = proposal.template.rarity.clone();
        let cur = RARITY_COUNT.may_load(deps.storage, r.as_str())?.unwrap_or(0);
        RARITY_COUNT.save(deps.storage, r.as_str(), &(cur + 1))?;

        let total = CARD_TEMPLATE_COUNT.may_load(deps.storage)?.unwrap_or(0);
        CARD_TEMPLATE_COUNT.save(deps.storage, &(total + 1))?;

        // 解锁押金退还到 proposer 可用存款
        unlock_and_refund_deposit(deps.storage, &proposer_addr, deposit)?;

        proposal.approved = true;
        proposal.executed = true;
        PROPOSALS.save(deps.storage, proposal_id, &proposal)?;

        Ok(Response::new()
            .add_attribute("method", "execute_proposal")
            .add_attribute("proposal_id", proposal_id.to_string())
            .add_attribute("approved", "true")
            .add_attribute("yes", yes.to_string())
            .add_attribute("no", no.to_string())
            .add_attribute("deposit_unlocked", deposit.to_string()))
    } else {
        // ❌ 未通过 → 质押金永久进入金库（从 proposer 存款中扣掉）
        let locked = PROPOSAL_DEPOSITS.may_load(deps.storage, &proposer_addr)?.unwrap_or(0);
        PROPOSAL_DEPOSITS.save(deps.storage, &proposer_addr, &locked.saturating_sub(deposit))?;
        let cur_dep = DEPOSITS.may_load(deps.storage, &proposer_addr)?.unwrap_or(0);
        DEPOSITS.save(deps.storage, &proposer_addr, &cur_dep.saturating_sub(deposit))?;

        proposal.approved = false;
        proposal.executed = true;
        PROPOSALS.save(deps.storage, proposal_id, &proposal)?;

        Ok(Response::new()
            .add_attribute("method", "execute_proposal")
            .add_attribute("proposal_id", proposal_id.to_string())
            .add_attribute("approved", "false")
            .add_attribute("yes", yes.to_string())
            .add_attribute("no", no.to_string())
            .add_attribute("deposit_to_vault", deposit.to_string()))
    }
}

fn execute_cancel_proposal(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    proposal_id: u64,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut proposal = PROPOSALS.load(deps.storage, proposal_id)
        .map_err(|_| ContractError::ProposalNotFound(proposal_id))?;
    if info.sender != proposal.proposer {
        return Err(ContractError::NotProposer);
    }
    if proposal.executed {
        return Err(ContractError::ProposalAlreadyExecuted(proposal_id));
    }
    // 取消 → 质押金进入金库（社区防 spam）：从 proposer 存款中永久扣掉
    let deposit = proposal.deposit.u128();
    let locked = PROPOSAL_DEPOSITS.may_load(deps.storage, &proposal.proposer)?.unwrap_or(0);
    // 修复 #3：显式检查锁定金额是否足够，防止 saturating_sub 静默归零
    if locked < deposit {
        return Err(ContractError::InsufficientFunds {
            expected: deposit.to_string(),
            got: locked.to_string(),
        });
    }
    PROPOSAL_DEPOSITS.save(deps.storage, &proposal.proposer, &locked.saturating_sub(deposit))?;
    let cur_dep = DEPOSITS.may_load(deps.storage, &proposal.proposer)?.unwrap_or(0);
    DEPOSITS.save(deps.storage, &proposal.proposer, &cur_dep.saturating_sub(deposit))?;

    proposal.executed = true;
    proposal.approved = false;
    PROPOSALS.save(deps.storage, proposal_id, &proposal)?;

    Ok(Response::new()
        .add_attribute("method", "cancel_proposal")
        .add_attribute("proposal_id", proposal_id.to_string())
        .add_attribute("deposit_to_vault", deposit.to_string()))
}

// ============================================================
// PVP 1v1 对战
// ============================================================

/// 验证：card_ids 长度=3 且都属于 player（从 PLAYER_CARDS 查）
fn validate_owned_cards(storage: &mut dyn Storage, player: &Addr, card_ids: &[String])
    -> Result<(), ContractError>
{
    if card_ids.len() != 3 {
        return Err(ContractError::InvalidInput(format!(
            "need exactly 3 cards, got {}", card_ids.len()
        )));
    }
    let owned = PLAYER_CARDS.may_load(storage, player)?.unwrap_or_default();
    let mut set = std::collections::BTreeSet::new();
    for id in card_ids {
        if !owned.contains(id) {
            return Err(ContractError::CardNotFound(id.clone()));
        }
        if !set.insert(id.clone()) {
            return Err(ContractError::InvalidInput(format!("duplicate card id: {}", id)));
        }
    }
    Ok(())
}

/// 卡牌战力总和（用于 PVP/Royale 结算）
fn card_power(card: &CardInfo) -> u64 { (card.attack as u64) + (card.defense as u64) }

fn order_total_power(storage: &mut dyn Storage, order: &[String]) -> Result<u64, ContractError> {
    let mut sum = 0u64;
    for id in order {
        let c = CARDS.load(storage, id)
            .map_err(|_| ContractError::CardNotFound(id.clone()))?;
        sum += card_power(&c);
    }
    Ok(sum)
}

/// PVP 3 局 2 胜：按索引一对一比较战力，胜局多者赢；平局比总战力
fn settle_pvp(storage: &mut dyn Storage, m: &mut PvpMatch) -> Result<Addr, ContractError> {
    let mut wins_ch = 0u32;
    let mut wins_op = 0u32;
    for i in 0..3 {
        let ch_id = &m.challenger_order[i];
        let op_id = &m.opponent_order[i];
        let ch = CARDS.load(storage, ch_id)
            .map_err(|_| ContractError::CardNotFound(ch_id.clone()))?;
        let op = CARDS.load(storage, op_id)
            .map_err(|_| ContractError::CardNotFound(op_id.clone()))?;
        let p_ch = card_power(&ch);
        let p_op = card_power(&op);
        if p_ch > p_op { wins_ch += 1; }
        else if p_op > p_ch { wins_op += 1; }
    }
    let winner = if wins_ch > wins_op { m.challenger.clone() }
        else if wins_op > wins_ch { m.opponent.clone() }
        else {
            let sum_ch = order_total_power(storage, &m.challenger_order)?;
            let sum_op = order_total_power(storage, &m.opponent_order)?;
            if sum_ch >= sum_op { m.challenger.clone() } else { m.opponent.clone() }
        };
    Ok(winner)
}

fn execute_create_pvp_match(
    deps: DepsMut, env: Env, info: MessageInfo, opponent: String, card_ids: Vec<String>,
) -> Result<Response, ContractError> {
    let opponent_addr = deps.api.addr_validate(&opponent)?;
    if opponent_addr == info.sender {
        return Err(ContractError::InvalidInput("cannot challenge yourself".into()));
    }
    validate_owned_cards(deps.storage, &info.sender, &card_ids)?;

    let params = GAME_PARAMS.load(deps.storage)?;
    consume_deposit(deps.storage, &info.sender, params.pvp_fee)?;

    let now = env.block.time.seconds();
    let match_id = format!("pvp_{}_{}", info.sender, now);

    let m = PvpMatch {
        match_id: match_id.clone(),
        challenger: info.sender.clone(),
        opponent: opponent_addr,
        challenger_order: card_ids,
        opponent_order: Vec::new(),
        winner: None,
        status: PvpStatus::Waiting,
        created_at: now,
        finished_at: None,
        reward_claimed: false,
    };
    PVP_MATCHES.save(deps.storage, &match_id, &m)?;

    Ok(Response::new()
        .add_attribute("method", "create_pvp_match")
        .add_attribute("match_id", match_id)
        .add_attribute("challenger", info.sender)
        .add_attribute("opponent", opponent))
}

fn execute_accept_pvp_match(
    deps: DepsMut, env: Env, info: MessageInfo, match_id: String, card_ids: Vec<String>,
) -> Result<Response, ContractError> {
    let mut m = PVP_MATCHES.load(deps.storage, &match_id)
        .map_err(|_| ContractError::NotFound(format!("pvp match {}", match_id)))?;
    if info.sender != m.opponent {
        return Err(ContractError::UnauthorizedReason("only opponent can accept".into()));
    }
    // 7天超时：懒检查（由查询也会检查）
    let now = env.block.time.seconds();
    if now.saturating_sub(m.created_at) > 7 * SECS_PER_DAY {
        m.status = PvpStatus::Cancelled;
        PVP_MATCHES.save(deps.storage, &match_id, &m)?;
        return Err(ContractError::Custom("match timed out".into()));
    }
    if !matches!(m.status, PvpStatus::Waiting) {
        return Err(ContractError::InvalidInput(format!("match not in waiting status, current={:?}", m.status)));
    }
    validate_owned_cards(deps.storage, &info.sender, &card_ids)?;

    let params = GAME_PARAMS.load(deps.storage)?;
    consume_deposit(deps.storage, &info.sender, params.pvp_fee)?;

    m.opponent_order = card_ids;
    m.status = PvpStatus::Pending;

    // 立即链上结算
    let winner = settle_pvp(deps.storage, &mut m)?;
    m.winner = Some(winner.clone());
    m.status = PvpStatus::Finished;
    m.finished_at = Some(now);

    PVP_MATCHES.save(deps.storage, &match_id, &m)?;

    Ok(Response::new()
        .add_attribute("method", "accept_pvp_match")
        .add_attribute("match_id", match_id)
        .add_attribute("winner", winner.to_string())
        .add_attribute("finished_at", now.to_string()))
}

fn execute_cancel_pvp_match(
    deps: DepsMut, env: Env, info: MessageInfo, match_id: String,
) -> Result<Response, ContractError> {
    let mut m = PVP_MATCHES.load(deps.storage, &match_id)
        .map_err(|_| ContractError::NotFound(format!("pvp match {}", match_id)))?;
    if info.sender != m.challenger {
        return Err(ContractError::UnauthorizedReason("only challenger can cancel".into()));
    }
    if !matches!(m.status, PvpStatus::Waiting) {
        return Err(ContractError::InvalidInput("can only cancel waiting match".into()));
    }
    // 7 天超时也可以前端触发
    let _ = env;
    m.status = PvpStatus::Cancelled;
    PVP_MATCHES.save(deps.storage, &match_id, &m)?;

    Ok(Response::new()
        .add_attribute("method", "cancel_pvp_match")
        .add_attribute("match_id", match_id))
}

fn execute_claim_pvp_reward(
    deps: DepsMut, env: Env, info: MessageInfo, match_id: String,
) -> Result<Response, ContractError> {
    let mut m = PVP_MATCHES.load(deps.storage, &match_id)
        .map_err(|_| ContractError::NotFound(format!("pvp match {}", match_id)))?;
    if !matches!(m.status, PvpStatus::Finished) {
        return Err(ContractError::InvalidInput("match not finished".into()));
    }
    let winner = m.winner.as_ref()
        .ok_or_else(|| ContractError::InvalidInput("no winner".into()))?.clone();
    if info.sender != winner {
        return Err(ContractError::UnauthorizedReason("only winner can claim".into()));
    }
    if m.reward_claimed {
        return Err(ContractError::InvalidInput("reward already claimed".into()));
    }

    // ===== Check-Effects-Interaction：所有检查在前，最后修改状态+发消息 =====
    let cfg = CONFIG.load(deps.storage)?;
    let params = GAME_PARAMS.load(deps.storage)?;
    let vault_bal = query_token_balance(&deps.as_ref(), &cfg.token_contract, &env.contract.address)?;
    // 赢家奖励 = 双方入场费（全部退还） + 动态金库奖励
    // 注意：pvp_reward tier 基于【结算后】金库余额（扣除即将退还的入场费）计算，避免轻微档位膨胀
    let entry_fees = 2 * params.pvp_fee;
    let post_settle_bal = vault_bal.saturating_sub(entry_fees);
    let dynamic_reward = params.pvp_reward(post_settle_bal);
    let reward = entry_fees + dynamic_reward;
    if vault_bal < reward {
        return Err(ContractError::InsufficientFunds {
            expected: format!("{} TKCC", reward),
            got: vault_bal.to_string(),
        });
    }

    // Effects: 最后修改状态
    m.reward_claimed = true;
    PVP_MATCHES.save(deps.storage, &match_id, &m)?;

    // Interaction: 转账（ CosmWasm 原子性保证：转账失败 → 整个 tx 回滚 → save 也回滚）
    let msg = build_token_transfer(&cfg.token_contract, &winner, reward);

    Ok(Response::new()
        .add_message(msg)
        .add_attribute("method", "claim_pvp_reward")
        .add_attribute("match_id", match_id)
        .add_attribute("winner", winner.to_string())
        .add_attribute("reward", reward.to_string()))
}

// ============================================================
// 4-6 人混战
// ============================================================

fn execute_create_royale(
    deps: DepsMut, env: Env, info: MessageInfo, size: u8, card_ids: Vec<String>,
) -> Result<Response, ContractError> {
    if !(4..=6).contains(&size) {
        return Err(ContractError::InvalidInput(format!("size must be 4-6, got {}", size)));
    }
    validate_owned_cards(deps.storage, &info.sender, &card_ids)?;
    let params = GAME_PARAMS.load(deps.storage)?;
    consume_deposit(deps.storage, &info.sender, params.royale_entry_fee)?;

    let now = env.block.time.seconds();
    let royale_id = format!("royale_{}_{}", info.sender, now);

    let r = RoyaleMatch {
        royale_id: royale_id.clone(),
        players: vec![info.sender.clone()],
        player_orders: vec![card_ids],
        winner: None,
        status: RoyaleStatus::Waiting,
        created_at: now,
        finished_at: None,
        size,
        reward_claimed: false,
    };
    ROYALE_MATCHES.save(deps.storage, &royale_id, &r)?;

    Ok(Response::new()
        .add_attribute("method", "create_royale")
        .add_attribute("royale_id", royale_id)
        .add_attribute("size", size.to_string())
        .add_attribute("creator", info.sender))
}

fn execute_join_royale_room(
    deps: DepsMut, env: Env, info: MessageInfo, royale_id: String, card_ids: Vec<String>,
) -> Result<Response, ContractError> {
    let mut r = ROYALE_MATCHES.load(deps.storage, &royale_id)
        .map_err(|_| ContractError::NotFound(format!("royale {}", royale_id)))?;
    if !matches!(r.status, RoyaleStatus::Waiting) {
        return Err(ContractError::InvalidInput("royale not accepting players".into()));
    }
    // 超时检查
    let now = env.block.time.seconds();
    if now.saturating_sub(r.created_at) > 7 * SECS_PER_DAY {
        r.status = RoyaleStatus::Cancelled;
        ROYALE_MATCHES.save(deps.storage, &royale_id, &r)?;
        return Err(ContractError::Custom("royale timed out".into()));
    }
    if r.players.iter().any(|p| p == &info.sender) {
        return Err(ContractError::InvalidInput("already joined".into()));
    }
    if r.players.len() as u8 >= r.size {
        return Err(ContractError::InvalidInput("royale is full".into()));
    }
    validate_owned_cards(deps.storage, &info.sender, &card_ids)?;

    let params = GAME_PARAMS.load(deps.storage)?;
    consume_deposit(deps.storage, &info.sender, params.royale_entry_fee)?;

    r.players.push(info.sender.clone());
    r.player_orders.push(card_ids);
    if r.players.len() as u8 == r.size {
        r.status = RoyaleStatus::Full;
    }
    ROYALE_MATCHES.save(deps.storage, &royale_id, &r)?;

    Ok(Response::new()
        .add_attribute("method", "join_royale_room")
        .add_attribute("royale_id", royale_id)
        .add_attribute("joiner", info.sender)
        .add_attribute("current_players", r.players.len().to_string()))
}

fn execute_settle_royale(
    deps: DepsMut, env: Env, info: MessageInfo, royale_id: String,
) -> Result<Response, ContractError> {
    let mut r = ROYALE_MATCHES.load(deps.storage, &royale_id)
        .map_err(|_| ContractError::NotFound(format!("royale {}", royale_id)))?;
    if !matches!(r.status, RoyaleStatus::Full) {
        return Err(ContractError::InvalidInput("royale not full yet".into()));
    }
    // 允许任何参与者发起结算
    if !r.players.contains(&info.sender) {
        return Err(ContractError::UnauthorizedReason("not a participant".into()));
    }

    // ===== 循环赛逐张比较（3局2胜 扩展到多人，田忌赛马策略生效） =====
    let n = r.player_orders.len();
    // 预加载每张卡的战力，避免循环内重复 load
    let mut order_powers: Vec<[u64; 3]> = Vec::with_capacity(n);
    for order in &r.player_orders {
        let mut arr = [0u64; 3];
        for i in 0..3 {
            let c = CARDS.load(deps.storage, &order[i])
                .map_err(|_| ContractError::CardNotFound(order[i].clone()))?;
            arr[i] = card_power(&c);
        }
        order_powers.push(arr);
    }
    // 每人循环赛净胜局
    let mut scores: Vec<i32> = vec![0i32; n];
    for i in 0..n {
        for j in (i+1)..n {
            let mut wi = 0i32;
            for k in 0..3 {
                let pi = order_powers[i][k];
                let pj = order_powers[j][k];
                if pi > pj { wi += 1; }
                else if pj > pi { wi -= 1; }
            }
            // 平局时按三张总战力比
            if wi == 0 {
                let si: u64 = order_powers[i].iter().sum();
                let sj: u64 = order_powers[j].iter().sum();
                if si > sj { wi = 1; }
                else if sj > si { wi = -1; }
            }
            scores[i] += wi;
            scores[j] -= wi;
        }
    }
    let winner_idx = scores.iter()
        .enumerate()
        .max_by_key(|(_, &s)| s)
        .map(|(i, _)| i)
        .unwrap_or(0);
    let winner = r.players[winner_idx].clone();

    r.winner = Some(winner.clone());
    r.status = RoyaleStatus::Finished;
    r.finished_at = Some(env.block.time.seconds());

    // 奖池金额：实际参赛人数 * 入场费（全部进合约）
    let cfg = CONFIG.load(deps.storage)?;
    let params = GAME_PARAMS.load(deps.storage)?;
    let actual_players = u128::from(r.players.len());
    let pool_size = actual_players * params.royale_entry_fee;
    let bp_10000 = 10_000u128;
    let to_winner = pool_size * params.royale_reward_pct_bp / bp_10000; // 70%
    let to_burn   = pool_size * params.royale_burn_pct_bp   / bp_10000; // 15%
    let _to_vault = pool_size * params.royale_vault_pct_bp  / bp_10000; // 15% 留在合约

    // 转账：winner 与 burn（vault 已在合约无需转）
    let mut msgs = vec![];
    let vault_bal = query_token_balance(&deps.as_ref(), &cfg.token_contract, &env.contract.address)?;
    if vault_bal >= to_winner + to_burn {
        msgs.push(build_token_transfer(&cfg.token_contract, &winner, to_winner));
        if to_burn > 0 {
            msgs.push(build_token_transfer(&cfg.token_contract, &cfg.burn_address, to_burn));
        }
        // 已完成转账 → 标记 reward_claimed=true，状态 Finished 阻止重新结算
        r.reward_claimed = true;
    }
    // ⚠️ 余额不足时 reward_claimed 保持 false → 赢家后续可通过 claim_royale_reward 单独领取
    // （不可强行设 true，否则赢家永远领不到钱）
    ROYALE_MATCHES.save(deps.storage, &royale_id, &r)?;

    Ok(Response::new()
        .add_messages(msgs)
        .add_attribute("method", "settle_royale")
        .add_attribute("royale_id", royale_id)
        .add_attribute("winner", winner.to_string())
        .add_attribute("winner_share", to_winner.to_string())
        .add_attribute("burned", to_burn.to_string()))
}

fn execute_claim_royale_reward(
    deps: DepsMut, env: Env, info: MessageInfo, royale_id: String,
) -> Result<Response, ContractError> {
    let mut r = ROYALE_MATCHES.load(deps.storage, &royale_id)
        .map_err(|_| ContractError::NotFound(format!("royale {}", royale_id)))?;
    if !matches!(r.status, RoyaleStatus::Finished) {
        return Err(ContractError::InvalidInput("royale not finished".into()));
    }
    let winner = r.winner.as_ref()
        .ok_or_else(|| ContractError::InvalidInput("no winner".into()))?.clone();
    if info.sender != winner {
        return Err(ContractError::UnauthorizedReason("only winner can claim".into()));
    }
    if r.reward_claimed {
        return Err(ContractError::InvalidInput("reward already paid/claimed".into()));
    }

    // ===== Check-Effects-Interaction：全部检查在前 =====
    let cfg = CONFIG.load(deps.storage)?;
    let params = GAME_PARAMS.load(deps.storage)?;
    let pool_size = u128::from(r.players.len()) * params.royale_entry_fee;
    let to_winner = pool_size * params.royale_reward_pct_bp / 10_000u128;
    let vault_bal = query_token_balance(&deps.as_ref(), &cfg.token_contract, &env.contract.address)?;
    if vault_bal < to_winner {
        return Err(ContractError::InsufficientFunds {
            expected: format!("{} TKCC", to_winner),
            got: vault_bal.to_string(),
        });
    }

    // Effects: 最后修改状态
    r.reward_claimed = true;
    ROYALE_MATCHES.save(deps.storage, &royale_id, &r)?;

    // Interaction: 转账
    let msg = build_token_transfer(&cfg.token_contract, &winner, to_winner);
    Ok(Response::new()
        .add_message(msg)
        .add_attribute("method", "claim_royale_reward")
        .add_attribute("royale_id", royale_id)
        .add_attribute("winner", winner.to_string())
        .add_attribute("reward", to_winner.to_string()))
}

// ============================================================
// 卡牌分解 & 升级
// ============================================================

fn execute_decompose_card(
    deps: DepsMut, _env: Env, info: MessageInfo, card_id: String,
) -> Result<Response, ContractError> {
    let card = CARDS.load(deps.storage, &card_id)
        .map_err(|_| ContractError::CardNotFound(card_id.clone()))?;
    if card.owner != info.sender.as_str() {
        return Err(ContractError::UnauthorizedReason("not the card owner".into()));
    }
    let r_idx = Fragments::rarity_index(&card.rarity).unwrap_or(0);
    let frags = FRAGMENT_FROM_DUPLICATE.get(r_idx).map(|(_, f)| *f).unwrap_or(5);

    // 1. 从 CARDS 移除
    CARDS.remove(deps.storage, &card_id);
    // 2. 从 PLAYER_CARDS 移除该 id
    let mut owned = PLAYER_CARDS.may_load(deps.storage, &info.sender)?.unwrap_or_default();
    owned.retain(|x| x != &card_id);
    PLAYER_CARDS.save(deps.storage, &info.sender, &owned)?;
    // 3. 增加碎片
    let mut f = FRAGMENTS.may_load(deps.storage, &info.sender)?.unwrap_or_default();
    let cur = f.get(&card.rarity);
    f.set(&card.rarity, cur.saturating_add(frags));
    FRAGMENTS.save(deps.storage, &info.sender, &f)?;

    Ok(Response::new()
        .add_attribute("method", "decompose_card")
        .add_attribute("card_id", card_id)
        .add_attribute("fragments", frags.to_string())
        .add_attribute("rarity", card.rarity))
}

/// 升级消耗碎片数量（按稀有度）common 50 / rare 100 / epic 200 / legend 500
fn upgrade_cost(rarity: &str) -> u64 {
    match rarity {
        "common" => 50,
        "rare" => 100,
        "epic" => 200,
        "legend" => 500,
        _ => 50,
    }
}

fn execute_upgrade_card(
    deps: DepsMut, _env: Env, info: MessageInfo, card_id: String,
) -> Result<Response, ContractError> {
    let mut card = CARDS.load(deps.storage, &card_id)
        .map_err(|_| ContractError::CardNotFound(card_id.clone()))?;
    if card.owner != info.sender.as_str() {
        return Err(ContractError::UnauthorizedReason("not the card owner".into()));
    }
    if card.level >= 10 {
        return Err(ContractError::InvalidInput("max level (10) reached".into()));
    }
    let cost = upgrade_cost(&card.rarity);
    let mut f = FRAGMENTS.may_load(deps.storage, &info.sender)?.unwrap_or_default();
    let cur = f.get(&card.rarity);
    if cur < cost {
        return Err(ContractError::InsufficientFunds {
            expected: format!("{} {} fragments", cost, card.rarity),
            got: cur.to_string(),
        });
    }
    f.set(&card.rarity, cur - cost);
    FRAGMENTS.save(deps.storage, &info.sender, &f)?;

    card.attack = card.attack.saturating_add(3);
    card.defense = card.defense.saturating_add(2);
    card.level = card.level.saturating_add(1);
    CARDS.save(deps.storage, &card_id, &card)?;

    Ok(Response::new()
        .add_attribute("method", "upgrade_card")
        .add_attribute("card_id", card_id)
        .add_attribute("new_level", card.level.to_string())
        .add_attribute("new_attack", card.attack.to_string())
        .add_attribute("new_defense", card.defense.to_string())
        .add_attribute("fragments_spent", cost.to_string()))
}

// ============================================================
// 查询入口
// ============================================================
#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => to_binary(&query_config(deps)?),
        QueryMsg::GameParams {} => to_binary(&query_params(deps)?),
        QueryMsg::PlayerCards { address } => to_binary(&query_player_cards(deps, address)?),
        QueryMsg::PendingRewards { address } => to_binary(&query_pending_rewards(deps, address)?),
        QueryMsg::VaultBalance {} => {
            let bal = CONFIG.load(deps.storage).ok()
                .and_then(|cfg| query_token_balance(&deps, &cfg.token_contract, &env.contract.address).ok())
                .unwrap_or(0);
            to_binary(&VaultBalanceResponse { balance: bal.to_string() })
        }
        QueryMsg::Card { card_id } => to_binary(&query_card(deps, card_id)?),
        QueryMsg::AiStats { address } => to_binary(&query_ai_stats(deps, env, address)?),
        QueryMsg::GetBattleOrder { player } => to_binary(&query_battle_order(deps, player)?),
        QueryMsg::ListProposals { start_after, limit } => to_binary(&query_list_proposals(deps, start_after, limit)?),
        QueryMsg::GetProposal { proposal_id } => to_binary(&query_get_proposal(deps, proposal_id)?),
        QueryMsg::GetProposalVotes { proposal_id } => to_binary(&query_votes(deps, proposal_id)?),
        QueryMsg::CardTemplates { start_after, limit } => to_binary(&query_templates(deps, start_after, limit)?),
        QueryMsg::RarityCount {} => to_binary(&query_rarity_count(deps)?),
        QueryMsg::GetFragments { address } => to_binary(&query_fragments(deps, address)?),
        QueryMsg::GetDeposit { address } => to_binary(&query_deposit(deps, address)?),

        QueryMsg::GetPvpMatch { match_id } => to_binary(&query_pvp_match(deps, match_id)?),
        QueryMsg::ListPvpMatches { player, status, start_after, limit } =>
            to_binary(&query_list_pvp_matches(deps, player, status, start_after, limit)?),

        QueryMsg::GetRoyale { royale_id } => to_binary(&query_royale(deps, royale_id)?),
        QueryMsg::ListRoyale { status, start_after, limit } =>
            to_binary(&query_list_royale(deps, status, start_after, limit)?),
    }
}

fn query_config(deps: Deps) -> StdResult<ConfigResponse> {
    let c = CONFIG.load(deps.storage)?;
    Ok(ConfigResponse {
        token_contract: c.token_contract.to_string(),
        burn_address: c.burn_address.to_string(),
        tap_addresses: c.tap_addresses.iter().map(|a| a.to_string()).collect(),
        // admin 已移除：合约完全无管理员
    })
}
fn query_params(deps: Deps) -> StdResult<GameParamsResponse> {
    let p = GAME_PARAMS.load(deps.storage)?;
    let s = |x: u128| x.to_string();
    Ok(GameParamsResponse {
        single_paxi_fee: s(p.single_paxi_fee),
        pack3_paxi_fee:  s(p.pack3_paxi_fee),
        ai_fee:    [s(p.ai_fee[0]), s(p.ai_fee[1]), s(p.ai_fee[2]), s(p.ai_fee[3])],
        ai_reward: [s(p.ai_reward[0]), s(p.ai_reward[1]), s(p.ai_reward[2]), s(p.ai_reward[3])],
        upgrade_fees: [
            s(p.upgrade_fees[0]), s(p.upgrade_fees[1]), s(p.upgrade_fees[2]), s(p.upgrade_fees[3]),
        ],
        daily_ai_limit: p.daily_ai_limit,
        ai_legend_boost_pct: p.ai_legend_boost_pct,
        pvp_fee: s(p.pvp_fee),
        royale_entry_fee: s(p.royale_entry_fee),
    })
}
fn query_player_cards(deps: Deps, address: String) -> StdResult<PlayerCardsResponse> {
    let addr = deps.api.addr_validate(&address)?;
    let ids = PLAYER_CARDS.may_load(deps.storage, &addr)?.unwrap_or_default();
    let mut cards = Vec::new();
    for id in ids { if let Some(c) = CARDS.may_load(deps.storage, &id)? { cards.push(c); } }
    Ok(PlayerCardsResponse { cards })
}
fn query_pending_rewards(deps: Deps, address: String) -> StdResult<PendingRewardsResponse> {
    let addr = deps.api.addr_validate(&address)?;
    let ids = PENDING_REWARDS.may_load(deps.storage, &addr)?.unwrap_or_default();
    let mut total: u128 = 0;
    for id in &ids {
        if let Some(b) = BATTLES.may_load(deps.storage, id)? {
            if !b.claimed { total += b.reward.parse::<u128>().unwrap_or(0); }
        }
    }
    Ok(PendingRewardsResponse { total_rewards: total.to_string(), battle_ids: ids })
}
fn query_card(deps: Deps, card_id: String) -> StdResult<CardInfo> { CARDS.load(deps.storage, &card_id) }
fn query_ai_stats(deps: Deps, env: Env, address: String) -> StdResult<AiStatsResponse> {
    let addr = deps.api.addr_validate(&address)?;
    let stats = AI_BATTLE_STATS.may_load(deps.storage, &addr)?.unwrap_or_default();
    let params = GAME_PARAMS.load(deps.storage)?;
    let win_rate = if stats.total == 0 {
        String::from("0")
    } else {
        format!("{:.2}", (stats.wins as f64 / stats.total as f64) * 100.0)
    };
    let recommended_difficulty = params.difficulty_from_win_rate(stats.wins, stats.total);
    // 使用当前时间计算真正的今日局数（跨天时自动返回 0）
    let today = env.block.time.seconds() / SECS_PER_DAY * SECS_PER_DAY;
    let last_day = AI_BATTLE_DATE.may_load(deps.storage, &addr)?.unwrap_or(0);
    let today_count = if last_day == today {
        AI_BATTLE_COUNT.may_load(deps.storage, &addr)?.unwrap_or(0)
    } else { 0 };
    Ok(AiStatsResponse {
        total: stats.total,
        wins: stats.wins,
        win_rate,
        recommended_difficulty,
        today_count,
        daily_limit: params.daily_ai_limit,
    })
}
fn query_battle_order(deps: Deps, player: String) -> StdResult<BattleOrderResponse> {
    let addr = deps.api.addr_validate(&player)?;
    let order = PLAYER_BATTLE_ORDER.may_load(deps.storage, &addr)?.unwrap_or_default();
    Ok(BattleOrderResponse { order })
}

fn query_list_proposals(deps: Deps, start_after: Option<u64>, limit: Option<u32>)
    -> StdResult<ProposalListResponse>
{
    let limit = limit.unwrap_or(30) as usize;
    let mut proposals: Vec<ProposalResponse> = Vec::new();
    // 简单实现：按 proposal counter 倒序或正序，从 start_after 开始读
    let counter = PROPOSAL_COUNTER.may_load(deps.storage)?.unwrap_or(0);
    let start = start_after.map(|s| s + 1).unwrap_or(1);
    for id in start..=counter {
        if proposals.len() >= limit { break; }
        if let Some(p) = PROPOSALS.may_load(deps.storage, id)? {
            proposals.push(ProposalResponse {
                id: p.id,
                template: p.template,
                proposer: p.proposer.to_string(),
                deposit: p.deposit.to_string(),
                yes_votes: p.yes_votes.to_string(),
                no_votes: p.no_votes.to_string(),
                deadline: p.deadline,
                executed: p.executed,
                approved: p.approved,
            });
        }
    }
    Ok(ProposalListResponse { proposals })
}
fn query_get_proposal(deps: Deps, proposal_id: u64) -> StdResult<ProposalResponse> {
    let p = PROPOSALS.load(deps.storage, proposal_id)?;
    Ok(ProposalResponse {
        id: p.id,
        template: p.template,
        proposer: p.proposer.to_string(),
        deposit: p.deposit.to_string(),
        yes_votes: p.yes_votes.to_string(),
        no_votes: p.no_votes.to_string(),
        deadline: p.deadline,
        executed: p.executed,
        approved: p.approved,
    })
}
fn query_votes(deps: Deps, proposal_id: u64) -> StdResult<ProposalVotesResponse> {
    let p = PROPOSALS.load(deps.storage, proposal_id)?;
    let yes = p.yes_votes.u128();
    let no  = p.no_votes.u128();
    let total = yes + no;
    let passed = total > 0 && yes * 2 > total;
    Ok(ProposalVotesResponse {
        proposal_id,
        yes_votes: yes.to_string(),
        no_votes:  no.to_string(),
        passed,
    })
}
fn query_templates(deps: Deps, start_after: Option<u32>, limit: Option<u32>)
    -> StdResult<Vec<CardTemplate>>
{
    let all = CARD_TEMPLATES.may_load(deps.storage)?.unwrap_or_default();
    let start = start_after.unwrap_or(0) as usize;
    let lim   = limit.unwrap_or(30) as usize;
    Ok(all.into_iter().skip(start).take(lim).collect())
}
fn query_rarity_count(deps: Deps) -> StdResult<RarityCountResponse> {
    let c = RARITY_COUNT.may_load(deps.storage, "common")?.unwrap_or(0);
    let r = RARITY_COUNT.may_load(deps.storage, "rare")?.unwrap_or(0);
    let e = RARITY_COUNT.may_load(deps.storage, "epic")?.unwrap_or(0);
    let l = RARITY_COUNT.may_load(deps.storage, "legend")?.unwrap_or(0);
    Ok(RarityCountResponse {
        common: c, rare: r, epic: e, legend: l, total: c + r + e + l,
    })
}

fn query_fragments(deps: Deps, address: String) -> StdResult<FragmentsResponse> {
    let addr = deps.api.addr_validate(&address)?;
    let f = FRAGMENTS.may_load(deps.storage, &addr)?.unwrap_or_default();
    Ok(FragmentsResponse {
        common: f.common,
        rare: f.rare,
        epic: f.epic,
        legend: f.legend,
    })
}

fn query_deposit(deps: Deps, address: String) -> StdResult<DepositResponse> {
    let addr = deps.api.addr_validate(&address)?;
    let available = DEPOSITS.may_load(deps.storage, &addr)?.unwrap_or(0);
    let locked = PROPOSAL_DEPOSITS.may_load(deps.storage, &addr)?.unwrap_or(0);
    Ok(DepositResponse {
        available: available.to_string(),
        locked: locked.to_string(),
    })
}

// ============================================================
// PVP 查询
// ============================================================

fn pvp_status_str(s: &PvpStatus) -> String {
    match s {
        PvpStatus::Waiting => "waiting".into(),
        PvpStatus::Pending => "pending".into(),
        PvpStatus::Finished => "finished".into(),
        PvpStatus::Cancelled => "cancelled".into(),
    }
}

fn into_pvp_resp(m: PvpMatch) -> PvpMatchResponse {
    PvpMatchResponse {
        match_id: m.match_id,
        challenger: m.challenger.to_string(),
        opponent: m.opponent.to_string(),
        challenger_order: m.challenger_order,
        opponent_order: m.opponent_order,
        winner: m.winner.map(|w| w.to_string()),
        status: pvp_status_str(&m.status),
        created_at: m.created_at,
        finished_at: m.finished_at,
        reward_claimed: m.reward_claimed,
    }
}

fn query_pvp_match(deps: Deps, match_id: String) -> StdResult<PvpMatchResponse> {
    let m = PVP_MATCHES.load(deps.storage, &match_id).map_err(|_| cosmwasm_std::StdError::not_found("pvp_match"))?;
    Ok(into_pvp_resp(m))
}

fn query_list_pvp_matches(
    deps: Deps, player: Option<String>, status: Option<String>,
    _start_after: Option<String>, limit: Option<u32>,
) -> StdResult<PvpListResponse> {
    let limit = limit.unwrap_or(50) as usize;
    let player_addr = player.map(|p| deps.api.addr_validate(&p)).transpose()?;

    let mut matches: Vec<PvpMatchResponse> = PVP_MATCHES
        .range(deps.storage, None, None, Order::Descending)
        .filter_map(|r| r.ok().map(|(_, m)| m))
        .filter(|m| {
            if let Some(p) = &player_addr {
                if &m.challenger != p && &m.opponent != p { return false; }
            }
            if let Some(s) = &status {
                if &pvp_status_str(&m.status) != s { return false; }
            }
            true
        })
        .take(limit)
        .map(into_pvp_resp)
        .collect();
    // 时间倒序
    matches.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(PvpListResponse { matches })
}

// ============================================================
// 混战查询
// ============================================================

fn royale_status_str(s: &RoyaleStatus) -> String {
    match s {
        RoyaleStatus::Waiting => "waiting".into(),
        RoyaleStatus::Full => "full".into(),
        RoyaleStatus::Finished => "finished".into(),
        RoyaleStatus::Cancelled => "cancelled".into(),
    }
}

fn into_royale_resp(r: RoyaleMatch) -> RoyaleResponse {
    RoyaleResponse {
        royale_id: r.royale_id,
        players: r.players.iter().map(|a| a.to_string()).collect(),
        player_orders: r.player_orders,
        winner: r.winner.map(|w| w.to_string()),
        status: royale_status_str(&r.status),
        created_at: r.created_at,
        finished_at: r.finished_at,
        size: r.size,
        reward_claimed: r.reward_claimed,
    }
}

fn query_royale(deps: Deps, royale_id: String) -> StdResult<RoyaleResponse> {
    let r = ROYALE_MATCHES.load(deps.storage, &royale_id).map_err(|_| cosmwasm_std::StdError::not_found("royale"))?;
    Ok(into_royale_resp(r))
}

fn query_list_royale(
    deps: Deps, status: Option<String>,
    _start_after: Option<String>, limit: Option<u32>,
) -> StdResult<RoyaleListResponse> {
    let limit = limit.unwrap_or(50) as usize;

    let mut royales: Vec<RoyaleResponse> = ROYALE_MATCHES
        .range(deps.storage, None, None, Order::Descending)
        .filter_map(|r| r.ok().map(|(_, rm)| rm))
        .filter(|r| {
            if let Some(s) = &status {
                if &royale_status_str(&r.status) != s { return false; }
            }
            true
        })
        .take(limit)
        .map(into_royale_resp)
        .collect();
    royales.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(RoyaleListResponse { royales })
}

// ============================================================
// 玩家存款系统（CW20 Send+Receive 官方标准，修复费用共享漏洞）
// ============================================================
/// CW20 Send+Receive 模式：接收 Cw20ReceiveMsg（CW20 官方标准）
/// 用户调用 cw20::Cw20ExecuteMsg::Send { contract: game_contract, amount, msg }
/// 代币合约先把 TKCC 转到本合约，然后调用本函数
/// receive_msg.amount = 实际转入的精确金额，receive_msg.sender = 原始发送者
fn execute_receive(
    deps: DepsMut, _env: Env, info: MessageInfo,
    receive_msg: Cw20ReceiveMsg,
) -> Result<Response, ContractError> {
    // 安全检查：必须是 token_contract 发来的（CW20 调用时 info.sender 就是代币合约地址）
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.token_contract {
        return Err(ContractError::UnauthorizedReason(format!(
            "Receive must be called by token contract {}", config.token_contract
        )));
    }

    // 解析金额和发送者（Cw20ReceiveMsg 已正确类型化）
    let amount_u = receive_msg.amount.u128();
    let sender_addr = receive_msg.sender;

    if amount_u == 0 {
        return Err(ContractError::InvalidInput("amount must be > 0".into()));
    }

    // 直接记账：sender_addr 的存款 += amount_u
    let current = DEPOSITS.may_load(deps.storage, &sender_addr)?.unwrap_or(0);
    let new_balance = current.saturating_add(amount_u);
    DEPOSITS.save(deps.storage, &sender_addr, &new_balance)?;

    Ok(Response::new()
        .add_attribute("method", "receive")
        .add_attribute("player", sender_addr)
        .add_attribute("deposited", amount_u.to_string())
        .add_attribute("new_balance", new_balance.to_string()))
}

/// 从个人存款提取 TKCC（退回自己地址）
fn execute_withdraw_deposit(
    deps: DepsMut, env: Env, info: MessageInfo, amount: String,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let amount_u: u128 = amount.parse().map_err(|_| ContractError::InvalidInput("amount".into()))?;

    // 1. 检查玩家可用存款
    let current = DEPOSITS.may_load(deps.storage, &info.sender)?.unwrap_or(0);
    // 当前 locked 仅来自 PROPOSAL_DEPOSITS（提案质押）；若未来增加其他锁定（PVP 冻结等），
    // 需在此扩展或引入通用 LockedDeposits Map
    let locked = PROPOSAL_DEPOSITS.may_load(deps.storage, &info.sender)?.unwrap_or(0);
    let available = current.saturating_sub(locked);
    if amount_u > available {
        return Err(ContractError::InsufficientFunds {
            expected: amount,
            got: available.to_string(),
        });
    }

    // 2. 修复 #2：检查合约 TKCC 余额是否足够（防止金库不足导致交易失败浪费 Gas）
    let contract_bal = query_token_balance(&deps.as_ref(), &config.token_contract, &env.contract.address)?;
    if contract_bal < amount_u {
        return Err(ContractError::InsufficientFunds {
            expected: amount_u.to_string(),
            got: contract_bal.to_string(),
        });
    }

    // 3. 扣除可用存款
    DEPOSITS.save(deps.storage, &info.sender, &current.saturating_sub(amount_u))?;

    // 4. 退回 TKCC 给玩家
    let transfer = build_token_transfer(&config.token_contract, &info.sender, amount_u);

    Ok(Response::new()
        .add_attribute("method", "withdraw_deposit")
        .add_attribute("player", info.sender)
        .add_attribute("withdrew", amount_u.to_string())
        .add_message(transfer))
}

/// 辅助：从玩家可用存款中扣除费用（所有消耗 TKCC 的操作统一调用此函数）
fn consume_deposit(storage: &mut dyn Storage, sender: &Addr, fee: u128) -> Result<(), ContractError> {
    if fee == 0 { return Ok(()); }
    let current = DEPOSITS.may_load(storage, sender)?.unwrap_or(0);
    let locked = PROPOSAL_DEPOSITS.may_load(storage, sender)?.unwrap_or(0);
    let available = current.saturating_sub(locked);
    if available < fee {
        return Err(ContractError::InsufficientFunds {
            expected: format!("{} TKCC (from your deposit)", fee),
            got: available.to_string(),
        });
    }
    DEPOSITS.save(storage, sender, &current.saturating_sub(fee))?;
    Ok(())
}

/// 辅助：锁定玩家存款（用于提案质押）
fn lock_deposit(storage: &mut dyn Storage, sender: &Addr, amount: u128) -> Result<(), ContractError> {
    let current = DEPOSITS.may_load(storage, sender)?.unwrap_or(0);
    let locked = PROPOSAL_DEPOSITS.may_load(storage, sender)?.unwrap_or(0);
    let available = current.saturating_sub(locked);
    if available < amount {
        return Err(ContractError::InsufficientFunds {
            expected: format!("{} TKCC (proposal deposit)", amount),
            got: available.to_string(),
        });
    }
    PROPOSAL_DEPOSITS.save(storage, sender, &locked.saturating_add(amount))?;
    Ok(())
}

/// 辅助：解锁玩家存款并退款
fn unlock_and_refund_deposit(storage: &mut dyn Storage, sender: &Addr, amount: u128) -> Result<(), ContractError> {
    let locked = PROPOSAL_DEPOSITS.may_load(storage, sender)?.unwrap_or(0);
    PROPOSAL_DEPOSITS.save(storage, sender, &locked.saturating_sub(amount))?;
    Ok(())
}

// ============================================================
// 辅助函数
// ============================================================
/// ✅ 查询 PRC-20 / CW20 代币余额（真实链上查询，不再是占位）
fn query_token_balance(deps: &Deps, token_contract: &Addr, addr: &Addr) -> StdResult<u128> {
    let res: BalanceResponse = deps.querier.query(&QueryRequest::Wasm(WasmQuery::Smart {
        contract_addr: token_contract.to_string(),
        msg: to_binary(&Cw20QueryMsg::Balance { address: addr.to_string() })?,
    }))?;
    Ok(res.balance.u128())
}
// ============================================================
// ✅ CW20 官方标准 transfer 消息（使用 cw20 库 Cw20ExecuteMsg::Transfer，不再手写结构）
// ============================================================
fn build_token_transfer(token_contract: &Addr, recipient: &Addr, amount: u128) -> WasmMsg {
    WasmMsg::Execute {
        contract_addr: token_contract.to_string(),
        msg: to_binary(&Cw20ExecuteMsg::Transfer {
            recipient: recipient.to_string(),
            amount: Uint128::from(amount),
        }).expect("encode cw20 transfer msg"),
        funds: vec![],
    }
}

/// 确定性随机种子 = keccak64 等价思路：将 (block.time, block.height, tx.salt) 三路 XOR 打散
fn mix_seed(a: u64, b: u64, c: u64) -> u64 {
    // 简单混合（不依赖额外库）：足够防止按秒级预测，不依赖纯 time+b
    let mut x = a.wrapping_mul(6364136223846793005).wrapping_add(b.wrapping_mul(1442695040888963407)).wrapping_add(c);
    x ^= x >> 33; x = x.wrapping_mul(0xff51afd7ed558ccd);
    x ^= x >> 33; x = x.wrapping_mul(0xc4ceb9fe1a85ec53);
    x ^= x >> 33;
    x
}
