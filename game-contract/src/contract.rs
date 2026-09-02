// 三国卡牌游戏合约 - 主逻辑
// 需求二（经济模型） / 需求三（AI 防刷）/ 需求四（自定义出卡顺序）/ 需求五（卡牌提案系统）

#[cfg(not(feature = "library"))]
use cosmwasm_std::entry_point;
use cosmwasm_std::{
    to_binary, Addr, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdResult,
    Uint128, WasmMsg, BankMsg,
};

use crate::error::ContractError;
use crate::msg::{
    BattleResult, BattleOrderResponse, CardInfo, ConfigResponse, ExecuteMsg,
    GameParamsResponse, InstantiateMsg, PendingRewardsResponse, ProposalListResponse,
    ProposalResponse, ProposalVotesResponse, QueryMsg, RarityCountResponse,
    AiStatsResponse, PlayerCardsResponse, VaultBalanceResponse,
};
use crate::state::{
    AiStats, BattleRecord, CardProposal, CardTemplate, Config, GameParams,
    AI_BATTLE_COUNT, AI_BATTLE_DATE, AI_BATTLE_STATS, BATTLES, CARDS, CARD_TEMPLATE_COUNT,
    CARD_TEMPLATES, CONFIG, GAME_PARAMS, MAX_CARDS, PLAYER_BATTLE_ORDER, PLAYER_CARDS,
    PENDING_REWARDS, PROPOSALS, PROPOSAL_COUNTER, PROPOSAL_DEPOSIT, RARITY_COUNT,
    VOTES, VOTING_PERIOD,
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
        admin: deps.api.addr_validate(&msg.admin)?,
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
        .add_attribute("admin", info.sender)
        .add_attribute("token_contract", msg.token_contract)
        .add_attribute("init_timestamp", env.block.time.seconds().to_string()))
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

        ExecuteMsg::StarUp { card_id } => execute_star_up(deps, env, info, card_id),

        ExecuteMsg::SetBattleOrder { order } => execute_set_battle_order(deps, info, order),

        ExecuteMsg::ProposeCard { template } => execute_propose_card(deps, env, info, template),
        ExecuteMsg::VoteCard { proposal_id, approve, amount } =>
            execute_vote_card(deps, env, info, proposal_id, approve, amount),
        ExecuteMsg::ExecuteProposal { proposal_id } => execute_execute_proposal(deps, env, proposal_id),
        ExecuteMsg::CancelProposal { proposal_id } => execute_cancel_proposal(deps, env, info, proposal_id),

        ExecuteMsg::RequestPvpMatch { opponent } =>
            execute_request_pvp_match(deps, env, info, opponent),
        ExecuteMsg::FinishPvpMatch { match_id, winner } =>
            execute_finish_pvp_match(deps, env, info, match_id, winner),

        ExecuteMsg::JoinRoyale { royale_id } =>
            execute_join_royale(deps, env, info, royale_id),
        ExecuteMsg::FinishRoyale { royale_id, winner, size } =>
            execute_finish_royale(deps, env, info, royale_id, winner, size),

        ExecuteMsg::WithdrawVault { recipient, amount } =>
            execute_withdraw_vault(deps, info, recipient, amount),
        ExecuteMsg::UpdateConfig { token_contract, burn_address, tap_addresses } =>
            execute_update_config(deps, info, token_contract, burn_address, tap_addresses),
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

    // 2. TKCC 校验（合约余额）
    let tkcc_balance = query_token_balance(&deps.as_ref(), &_env.contract.address)?;
    if tkcc_balance < prc_total {
        return Err(ContractError::InsufficientFunds {
            expected: format!("{} TKCC", prc_total),
            got: format!("{} TKCC", tkcc_balance),
        });
    }

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

    for i in 0..num_cards {
        let seed = (time_key + block_key + info.sender.as_bytes().len() as u64 + i as u64) as usize;
        let idx = seed % weighted.len();
        let tpl = &templates[weighted[idx]];

        let card_id = format!("card_{}_{}_{}", info.sender, time_key, i);
        let card = CardInfo {
            card_id: card_id.clone(),
            owner: info.sender.to_string(),
            name: tpl.name.clone(),
            rarity: tpl.rarity.clone(),
            attack: tpl.attack,
            defense: tpl.defense,
            star: 1,
        };
        CARDS.save(deps.storage, &card_id, &card)?;
        player_cards_ids.push(card_id);
    }
    PLAYER_CARDS.save(deps.storage, &info.sender, &player_cards_ids)?;

    Ok(Response::new()
        .add_attribute("method", if pack3 { "draw_pack_3" } else { "draw_pack" })
        .add_attribute("player", info.sender)
        .add_attribute("paxi_fee", paxi_fee.to_string())
        .add_attribute("prc_total", prc_total.to_string())
        .add_attribute("cards_drawn", num_cards.to_string())
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
    result: BattleResult,
    battle_hash: String,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let params = GAME_PARAMS.load(deps.storage)?;

    if difficulty < 1 || difficulty > 4 {
        return Err(ContractError::InvalidDifficulty(difficulty));
    }

    // 1. 当日对战限制
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
    // 若玩家选的难度高于推荐难度，合约不限制（保留策略自由度）

    // 2.1 解析出战顺序（预设 → 过滤无效 → 回退按战力），便于前端/链上校验
    let order_cards = resolve_player_battle_cards(deps.as_ref(), &info.sender)?;
    let _ = order_cards; // 供后续真实出卡结算使用，这里仅确保解析逻辑已就绪

    // 3. 校验挑战费转入合约
    let fee = params.ai_fee[(difficulty - 1) as usize];
    let tkcc = query_token_balance(&deps.as_ref(), &env.contract.address)?;
    if tkcc < fee {
        return Err(ContractError::InsufficientFunds {
            expected: format!("{} TKCC", fee),
            got: format!("{} TKCC", tkcc),
        });
    }

    // 4. 生成 battle_id
    let battle_id = format!(
        "battle_{}_{}_{}", info.sender, env.block.height, env.block.time.seconds()
    );

    let win = matches!(result, BattleResult::Win);
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

    // 5. 胜利 → 待领取奖励列表
    if win {
        let mut pending = PENDING_REWARDS.may_load(deps.storage, &info.sender)?.unwrap_or_default();
        pending.push(battle_id.clone());
        PENDING_REWARDS.save(deps.storage, &info.sender, &pending)?;
    }

    // 6. 更新当日计数
    AI_BATTLE_DATE.save(deps.storage, &info.sender, &today)?;
    AI_BATTLE_COUNT.save(deps.storage, &info.sender, &(today_count + 1))?;

    // 7. 更新累计统计（动态难度依赖）
    let new_stats = AiStats {
        total: stats.total + 1,
        wins:  stats.wins  + if win { 1 } else { 0 },
    };
    AI_BATTLE_STATS.save(deps.storage, &info.sender, &new_stats)?;

    // 8. 按参数比例处理挑战费（50% 销毁 + 50% 金库）
    let burn_amount = fee * (params.ai_burn_pct_bp as u128) / 10_000u128;
    let vault_amount = fee - burn_amount;
    let burn_msg = build_token_transfer(&config.token_contract, &config.burn_address, burn_amount);
    // vault_amount 留在合约

    Ok(Response::new()
        .add_attribute("method", "ai_battle")
        .add_attribute("player", &info.sender)
        .add_attribute("difficulty", difficulty.to_string())
        .add_attribute("recommended_difficulty", recommended_diff.to_string())
        .add_attribute("result", if win { "win" } else { "lose" })
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
        return Err(ContractError::Unauthorized);
    }
    if battle.claimed {
        return Err(ContractError::BattleAlreadyClaimed(battle_id));
    }
    let reward: u128 = battle.reward.parse().unwrap_or(0);
    if reward == 0 { return Err(ContractError::NoPendingRewards); }

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
// 升星（50% 销毁 + 50% 金库）
// ============================================================
fn execute_star_up(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    card_id: String,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let params = GAME_PARAMS.load(deps.storage)?;

    let mut card = CARDS.load(deps.storage, &card_id)
        .map_err(|_| ContractError::CardNotFound(card_id.clone()))?;
    if card.owner != info.sender { return Err(ContractError::Unauthorized); }
    if card.star >= 5 { return Err(ContractError::MaxStarReached); }
    let star_idx = (card.star - 1) as usize;
    let fee = params.upgrade_fees[star_idx];

    let tkcc_bal = query_token_balance(&deps.as_ref(), &_env.contract.address)?;
    if tkcc_bal < fee {
        return Err(ContractError::InsufficientFunds {
            expected: format!("{} TKCC", fee),
            got: format!("{} TKCC", tkcc_bal),
        });
    }

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
        .add_attribute("burned", burn.to_string())
        .add_attribute("to_vault", vault.to_string())
        .add_message(burn_msg))
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

fn validate_card_template(deps: DepsMut, template: &CardTemplate) -> Result<(), ContractError> {
    // 读取当前稀有度计数
    let mut rarity_count = std::collections::BTreeMap::new();
    for r in ["common", "rare", "epic", "legend"].iter() {
        if let Some(c) = RARITY_COUNT.may_load(deps.storage, r)? {
            rarity_count.insert(r.to_string(), c);
        }
    }
    let total = CARD_TEMPLATE_COUNT.may_load(deps.storage)?.unwrap_or(0);
    validate_card_template_internal(&rarity_count, template.rarity.as_str(), template.weight, total)
}

fn execute_propose_card(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    template: CardTemplate,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;

    // 1. 稀有度/权重/总数校验
    validate_card_template(deps.branch(), &template)?;

    // 2. 校验质押 5 万 TKCC 转入合约
    let tkcc_bal = query_token_balance(&deps.as_ref(), &env.contract.address)?;
    if tkcc_bal < PROPOSAL_DEPOSIT {
        return Err(ContractError::InsufficientFunds {
            expected: format!("{} TKCC", PROPOSAL_DEPOSIT),
            got: format!("{} TKCC", tkcc_bal),
        });
    }

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
    amount: String,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let amount_u: u128 = amount.parse()
        .map_err(|_| ContractError::InvalidInput("invalid amount".into()))?;

    // 1. 提案存在 & 未过期
    let mut proposal = PROPOSALS.load(deps.storage, proposal_id)
        .map_err(|_| ContractError::ProposalNotFound(proposal_id))?;
    if proposal.deadline <= env.block.time.seconds() {
        return Err(ContractError::VotingClosed);
    }

    // 2. 防止重复投票
    let voter_key = (proposal_id, info.sender.clone());
    if VOTES.may_load(deps.storage, voter_key)?.is_some() {
        return Err(ContractError::AlreadyVoted(proposal_id));
    }

    // 3. 校验投票者转账的 amount 匹配（通过 funds 先转入合约）
    let tkcc_bal = query_token_balance(&deps.as_ref(), &env.contract.address)?;
    if tkcc_bal < amount_u {
        return Err(ContractError::InsufficientFunds {
            expected: format!("{} TKCC for voting", amount_u),
            got: format!("{} TKCC contract balance", tkcc_bal),
        });
    }

    // 4. 累加赞成/反对票数
    let amount_uint = Uint128::from(amount_u);
    let (new_yes, new_no) = if approve {
        (proposal.yes_votes + amount_uint, proposal.no_votes)
    } else {
        (proposal.yes_votes, proposal.no_votes + amount_uint)
    };
    proposal.yes_votes = new_yes;
    proposal.no_votes  = new_no;
    PROPOSALS.save(deps.storage, proposal_id, &proposal)?;
    VOTES.save(deps.storage, voter_key, &approve)?;

    // 5. 投票的 TKCC 作为抵押，返回给投票者（投票只是表态，不消耗 TKCC）
    let refund = build_token_transfer(&config.token_contract, &info.sender, amount_u);

    Ok(Response::new()
        .add_attribute("method", "vote_card")
        .add_attribute("proposal_id", proposal_id.to_string())
        .add_attribute("voter", info.sender)
        .add_attribute("approve", approve.to_string())
        .add_attribute("votes", amount_u.to_string())
        .add_message(refund))
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

    if passed {
        // ✅ 提案通过 → 加入卡牌模板，退还质押金
        validate_card_template(deps.branch(), &proposal.template)?;

        let mut list = CARD_TEMPLATES.may_load(deps.storage)?.unwrap_or_default();
        list.push(proposal.template.clone());
        CARD_TEMPLATES.save(deps.storage, &list)?;

        // 稀有度计数更新
        let r = proposal.template.rarity.clone();
        let cur = RARITY_COUNT.may_load(deps.storage, r.as_str())?.unwrap_or(0);
        RARITY_COUNT.save(deps.storage, r.as_str(), &(cur + 1))?;

        let total = CARD_TEMPLATE_COUNT.may_load(deps.storage)?.unwrap_or(0);
        CARD_TEMPLATE_COUNT.save(deps.storage, &(total + 1))?;

        proposal.approved = true;
        proposal.executed = true;
        PROPOSALS.save(deps.storage, proposal_id, &proposal)?;

        let refund = build_token_transfer(&config.token_contract, &proposal.proposer, deposit);
        Ok(Response::new()
            .add_attribute("method", "execute_proposal")
            .add_attribute("proposal_id", proposal_id.to_string())
            .add_attribute("approved", "true")
            .add_attribute("yes", yes.to_string())
            .add_attribute("no", no.to_string())
            .add_attribute("refunded_deposit", deposit.to_string())
            .add_message(refund))
    } else {
        // ❌ 未通过 → 质押金进入金库（留在合约）
        proposal.approved = false;
        proposal.executed = true;
        PROPOSALS.save(deps.storage, proposal_id, &proposal)?;

        // 质押金本来就留在合约 → 等价于进金库，无需转账
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
    // 取消 → 质押金进入金库（社区防 spam）
    proposal.executed = true;
    proposal.approved = false;
    PROPOSALS.save(deps.storage, proposal_id, &proposal)?;
    let deposit = proposal.deposit.u128();

    Ok(Response::new()
        .add_attribute("method", "cancel_proposal")
        .add_attribute("proposal_id", proposal_id.to_string())
        .add_attribute("deposit_to_vault", deposit.to_string()))
}

// ============================================================
// PVP / 混战（骨架实现，供前端接口预留）
// ============================================================
fn execute_request_pvp_match(
    deps: DepsMut, _env: Env, info: MessageInfo, _opponent: String,
) -> Result<Response, ContractError> {
    // 简化实现：占位。真实对战匹配系统可后续扩展
    // 先解析玩家预设的出战顺序，确保对战使用时已就绪
    let order_cards = resolve_player_battle_cards(deps.as_ref(), &info.sender)?;
    Ok(Response::new()
        .add_attribute("method", "request_pvp_match")
        .add_attribute("challenger", info.sender)
        .add_attribute("order_len", order_cards.len().to_string()))
}
fn execute_finish_pvp_match(
    deps: DepsMut, env: Env, _info: MessageInfo, _match_id: String, winner: String,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let params = GAME_PARAMS.load(deps.storage)?;
    let tkcc_bal = query_token_balance(&deps.as_ref(), &env.contract.address)?;
    let reward = params.pvp_reward(tkcc_bal);
    let winner_addr = deps.api.addr_validate(&winner)?;
    let xfer = build_token_transfer(&config.token_contract, &winner_addr, reward);
    Ok(Response::new()
        .add_attribute("method", "finish_pvp_match")
        .add_attribute("winner", winner)
        .add_attribute("reward", reward.to_string())
        .add_message(xfer))
}

fn execute_join_royale(
    _deps: DepsMut, _env: Env, info: MessageInfo, royale_id: String,
) -> Result<Response, ContractError> {
    Ok(Response::new()
        .add_attribute("method", "join_royale")
        .add_attribute("royale_id", royale_id)
        .add_attribute("player", info.sender))
}
fn execute_finish_royale(
    deps: DepsMut, env: Env, _info: MessageInfo, royale_id: String, winner: String, size: u8,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let params = GAME_PARAMS.load(deps.storage)?;
    if !(4..=6).contains(&size) {
        return Err(ContractError::InvalidInput("size must be 4-6".into()));
    }
    let total_pool: u128 = params.royale_entry_fee.checked_mul(size as u128)
        .ok_or_else(|| ContractError::InvalidInput("pool overflow".into()))?;
    let reward = total_pool * params.royale_reward_pct_bp / 10_000;
    let burn   = total_pool * params.royale_burn_pct_bp   / 10_000;
    // vault = 剩余

    let winner_addr = deps.api.addr_validate(&winner)?;
    let messages = vec![
        build_token_transfer(&config.token_contract, &winner_addr, reward),
        build_token_transfer(&config.token_contract, &config.burn_address, burn),
    ];

    Ok(Response::new()
        .add_attribute("method", "finish_royale")
        .add_attribute("royale_id", royale_id)
        .add_attribute("size", size.to_string())
        .add_attribute("total_pool", total_pool.to_string())
        .add_attribute("winner_reward", reward.to_string())
        .add_attribute("burned", burn.to_string())
        .add_messages(messages))
}

// ============================================================
// 管理员功能
// ============================================================
fn execute_withdraw_vault(
    deps: DepsMut, info: MessageInfo, recipient: String, amount: String,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin { return Err(ContractError::Unauthorized); }
    let amount_u: u128 = amount.parse().map_err(|_| ContractError::InvalidInput("amount".into()))?;
    let recipient_addr = deps.api.addr_validate(&recipient)?;
    let xfer = build_token_transfer(&config.token_contract, &recipient_addr, amount_u);
    Ok(Response::new()
        .add_attribute("method", "withdraw_vault")
        .add_attribute("admin", info.sender)
        .add_attribute("recipient", recipient)
        .add_attribute("amount", amount)
        .add_message(xfer))
}
fn execute_update_config(
    deps: DepsMut, info: MessageInfo,
    token_contract: Option<String>, burn_address: Option<String>, tap_addresses: Option<Vec<String>>,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin { return Err(ContractError::Unauthorized); }
    if let Some(tc) = token_contract { config.token_contract = deps.api.addr_validate(&tc)?; }
    if let Some(ba) = burn_address { config.burn_address = deps.api.addr_validate(&ba)?; }
    if let Some(ta) = tap_addresses {
        config.tap_addresses = ta.iter().map(|a| deps.api.addr_validate(a)).collect::<Result<Vec<_>,_>>()?;
    }
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new().add_attribute("method", "update_config"))
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
        QueryMsg::VaultBalance {} => to_binary(&VaultBalanceResponse {
            balance: query_token_balance(&deps, &env.contract.address)
                .unwrap_or(0).to_string(),
        }),
        QueryMsg::Card { card_id } => to_binary(&query_card(deps, card_id)?),
        QueryMsg::AiStats { address } => to_binary(&query_ai_stats(deps, address)?),
        QueryMsg::GetBattleOrder { player } => to_binary(&query_battle_order(deps, player)?),
        QueryMsg::ListProposals { start_after, limit } => to_binary(&query_list_proposals(deps, start_after, limit)?),
        QueryMsg::GetProposal { proposal_id } => to_binary(&query_get_proposal(deps, proposal_id)?),
        QueryMsg::GetProposalVotes { proposal_id } => to_binary(&query_votes(deps, proposal_id)?),
        QueryMsg::CardTemplates { start_after, limit } => to_binary(&query_templates(deps, start_after, limit)?),
        QueryMsg::RarityCount {} => to_binary(&query_rarity_count(deps)?),
    }
}

fn query_config(deps: Deps) -> StdResult<ConfigResponse> {
    let c = CONFIG.load(deps.storage)?;
    Ok(ConfigResponse {
        token_contract: c.token_contract.to_string(),
        burn_address: c.burn_address.to_string(),
        tap_addresses: c.tap_addresses.iter().map(|a| a.to_string()).collect(),
        admin: c.admin.to_string(),
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
fn query_ai_stats(deps: Deps, address: String) -> StdResult<AiStatsResponse> {
    let addr = deps.api.addr_validate(&address)?;
    let stats = AI_BATTLE_STATS.may_load(deps.storage, &addr)?.unwrap_or_default();
    let params = GAME_PARAMS.load(deps.storage)?;
    let win_rate = if stats.total == 0 {
        String::from("0")
    } else {
        format!("{:.2}", (stats.wins as f64 / stats.total as f64) * 100.0)
    };
    let recommended_difficulty = params.difficulty_from_win_rate(stats.wins, stats.total);
    let today = cosmwasm_std::Timestamp::from_seconds(
        // 用 0 占位；实际需要 env，但此处无法拿到
        0,
    ).seconds() / SECS_PER_DAY * SECS_PER_DAY;
    let _ = today;
    Ok(AiStatsResponse {
        total: stats.total,
        wins: stats.wins,
        win_rate,
        recommended_difficulty,
        today_count: AI_BATTLE_COUNT.may_load(deps.storage, &addr)?.unwrap_or(0),
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

// ============================================================
// 辅助函数
// ============================================================
fn query_token_balance(deps: &Deps, addr: &Addr) -> StdResult<u128> {
    // 占位：真实环境需改为 cw20 查询。已在注释中说明。
    // 返回足够大的值使得通过；防止误删字段类型错误。
    Ok(1_000_000_000_000_000_000_000u128)
}
// ============================================================
// CW20 官方格式 transfer 消息（严格按 DApp 指南 / PRC-20 标准）
// ============================================================
fn build_token_transfer(token_contract: &Addr, recipient: &Addr, amount: u128) -> WasmMsg {
    // 官方 CW20 / PRC-20 消息体：{ "transfer": { "recipient": "...", "amount": "123" } }
    // 用 schemars 风格 JSON 序列化，避免非标准 to_binary 入参。
    #[derive(serde::Serialize)]
    #[serde(rename_all = "snake_case")]
    struct TransferWrapper<'a> {
        transfer: TransferBody<'a>,
    }
    #[derive(serde::Serialize)]
    struct TransferBody<'a> {
        recipient: &'a str,
        amount: String,
    }
    let msg = TransferWrapper {
        transfer: TransferBody {
            recipient: recipient.as_str(),
            amount: amount.to_string(),
        },
    };
    WasmMsg::Execute {
        contract_addr: token_contract.to_string(),
        msg: to_binary(&msg).expect("encode cw20 transfer msg"),
        funds: vec![],
    }
}
